#!/usr/bin/env bash
#
# pack-instance.sh —— 打包态「观察实例」（默认 CDP :9222）的启停 / 状态 / 一轮更新。
#
# 由来（用户 2026-09-13 定调）：
#   dev 态的 9222 跑的是 `scripts/dev.sh`（CORUM_DEV_HMR=500，host 插件直接吃仓库
#   `lib/`）—— 于是**改源码就可能热加载/重启宿主**，把正在观察的窗口打白（2026-09-13
#   真实发生过：一条 `pnpm install --filter` 剪掉 desktop 依赖，宿主下次重启即
#   ERR_MODULE_NOT_FOUND 白屏）。用户要求 9222 换成**与源码无关**的打包实例：
#   插件来自 .app 自带闭包（build/host），没有 HMR，改源码完全不影响它；
#   一轮调试做完重打一次即可（`pack-instance.sh update`）。
#
# 与另外两个实例的分工：
#   · :9222 本脚本 —— 打包态，稳定观察口（用户看会话用的那个窗口）
#   · :9333 `scripts/verify-instance.sh` —— dev 态验证口，给 corum 自验闭环用，可随便重启
#
# 清理安全：只按「PID 文件 + cmdline 必须含本仓库 dist/mac-arm64/Corum.app」双条件杀进程。
# 打包态与 dev 态的 cmdline 不同（前者 …/dist/mac-arm64/Corum.app/Contents/MacOS/Corum，
# 后者 …/packages/desktop/lib/main.js），所以**不会误杀 dev 实例或 :9333 验证实例**
# —— 这正是 2026-09-13 用宽路径 pgrep 误杀验证实例后定下的纪律。
#
# 用法：
#   ./scripts/pack-instance.sh start      # 启动打包实例（默认 :9222）
#   ./scripts/pack-instance.sh stop       # 停止（只杀自己记录的 PID）
#   ./scripts/pack-instance.sh stop --exclude-session <id>   # 飞行守卫排除自己的会话（可重复）
#   ./scripts/pack-instance.sh restart [--exclude-session <id> …]
#   ./scripts/pack-instance.sh status     # 存活 + CDP 可达性
#   ./scripts/pack-instance.sh update [--exclude-session <id> …]
#                                         # 一轮更新：构建改动包 → 重打 host+app → 重启
#
# 环境覆盖：
#   CORUM_HOME          默认 <repo>/packages/desktop/.corum-dev-home（沿用同一份会话/设置）
#   CORUM_PACK_PORT     默认 9222（CDP 端口）
#   CORUM_PACK_COMBO    默认 coding
#   CORUM_PACK_APP      默认 <repo>/packages/desktop/dist/mac-arm64/Corum.app
#   CORUM_PACK_EXCLUDE_SESSIONS    逗号/空白分隔的会话 id，与 --exclude-session 合并生效
#   CORUM_PACK_FORCE=1             无视飞行守卫强停（会显著警告并列出将被打断的会话）
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
DESKTOP="$REPO_ROOT/packages/desktop"

export CORUM_HOME="${CORUM_HOME:-$DESKTOP/.corum-dev-home}"
export CORUM_PACK_PORT="${CORUM_PACK_PORT:-9222}"
# ⚠️ 必须把端口导出成 CORUM_DEBUG_PORT：壳按 `corum-desktop-ud-${MODE}-${CORUM_DEBUG_PORT}`
# 命名 userData（main.ts:319），漏了它 CDP 根本不开 —— 2026-09-13 实测目录名是 `…-noport`、
# :9222 不可达。
export CORUM_DEBUG_PORT="$CORUM_PACK_PORT"
COMBO_ID="${CORUM_PACK_COMBO:-coding}"
APP_PATH="${CORUM_PACK_APP:-$DESKTOP/dist/mac-arm64/Corum.app}"
APP_BIN="$APP_PATH/Contents/MacOS/Corum"

RUN_DIR="$CORUM_HOME/run"
PID_FILE="$RUN_DIR/pack-$CORUM_PACK_PORT.pid"
LOG_FILE="$RUN_DIR/pack-$CORUM_PACK_PORT.log"
SELF_MARK="kkc-desktop/packages/desktop/dist/mac-arm64/Corum.app"

log() { printf '[pack-instance] %s\n' "$*"; }

# 用 **dev 身份**的 Electron 解开 $CORUM_HOME/.master-key，把明文 base64 打到 stdout。
# 明文不落盘（主密钥纪律：文件里只有 safeStorage 密文）；调用方按需注入本次启动。
resolve_master_key() {
  ELECTRON_BIN="$REPO_ROOT/node_modules/.pnpm/electron@43.4.1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  [[ -x "$ELECTRON_BIN" ]] || { log "找不到 Electron 二进制：$ELECTRON_BIN" >&2; return 1; }
  local helper
  helper="$(mktemp -t corum-decrypt-master-key).cjs"
  cat > "$helper" <<'HELPER_JS'
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const file = process.argv[2]
app.whenReady().then(() => {
  try {
    const stored = fs.readFileSync(file, 'utf8').trim()
    process.stdout.write(safeStorage.decryptString(Buffer.from(stored, 'base64')) + '\n')
    app.exit(0)
  } catch (error) {
    process.stderr.write('decrypt failed: ' + String(error) + '\n')
    app.exit(4)
  }
})
HELPER_JS
  "$ELECTRON_BIN" "$helper" "$CORUM_HOME/.master-key"
  local rc=$?
  rm -f "$helper"
  return $rc
}

pid_of() {
  [[ -f "$PID_FILE" ]] || return 1
  sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PID_FILE" | head -1
}

# 目标 pid 是否确实是本打包实例（cmdline 含 dist/mac-arm64/Corum.app）。
is_self() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  pgrep -f "$SELF_MARK" 2>/dev/null | grep -qx "$pid"
}

cdp_ok() {
  curl -s --max-time 2 "http://127.0.0.1:$CORUM_PACK_PORT/json/version" 2>/dev/null | grep -q '"Browser"'
}

alive() {
  local pid
  pid="$(pid_of || true)"
  [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null
}

# 飞行护栏（2026-09-13 教训）：重启本实例 = 重启它的 host = **打断正在跑的委派会话**。
# 实测事故：`update` 重启 9222 时，跑在该实例上的卡片任务被 `turn/end reason=interrupted`
# 打断（那轮 48 次调用全是勘察、0 次落文件，才没丢工作）。此后 stop/restart/update
# 前先看「最近 2 分钟内有没有会话日志在写」——活跃会话每几秒就写事件，mtime 判据够用。
# 确认无人在跑时可以照常；确实要强停时设 CORUM_PACK_FORCE=1（会列出将被打断的会话）。
#
# 2026-09-14 修复「守卫拦住自己」：判据只看 mtime、不区分会话，调用者自己的会话
# （worker 回合末尾重编交付时正在写事件）也会被当成飞行会话 → 必然被自己拒掉。
# 新增 --exclude-session <id>（可重复）与 CORUM_PACK_EXCLUDE_SESSIONS（逗号/空白分隔），
# 把「自己」从飞行会话集合里剔除；被排除的会话与命中文件会显式打印（不允许静默放行），
# 未被排除的飞行会话仍然一律拒绝（守护目的不放宽）。
EXCLUDE_SESSIONS=()
fwd=()      # restart/update → stop/start 的排除参数透传（case 分支是顶层作用域，不能用 local）
_sid=""     # 同上

# 飞行会话 = 最近 2 分钟内有会话日志在写（活跃会话每几秒写一次事件，mtime 判据够用）。
active_sessions() {
  find "$CORUM_HOME/sessions" -name 'session*.jsonl*' -mmin -2 2>/dev/null
}

# 解析 stop/restart/update/start（四个子命令都要先过一遍护栏）共用的参数。
# 识别 --exclude-session <id> / --exclude-session=<id>（可重复）；其余参数一律报错，
# 防止拼写错误（如 --exclude-sesion）静默失效、守卫被无声绕过。
parse_guard_args() {
  local args=("$@") i=0
  while (( i < ${#args[@]} )); do
    case "${args[$i]}" in
      --exclude-session)
        if (( i + 1 >= ${#args[@]} )); then
          log "错误：--exclude-session 需要一个会话 id 参数"
          return 1
        fi
        EXCLUDE_SESSIONS+=("${args[$((i + 1))]}")
        i=$((i + 2))
        ;;
      --exclude-session=*)
        EXCLUDE_SESSIONS+=("${args[$i]#--exclude-session=}")
        i=$((i + 1))
        ;;
      *)
        log "错误：未知参数 ${args[$i]}（本子命令仅支持 --exclude-session <id>，可重复）"
        return 1
        ;;
    esac
  done
  # 环境变量 CORUM_PACK_EXCLUDE_SESSIONS：逗号/空白分隔，与命令行参数合并生效
  if [[ -n "${CORUM_PACK_EXCLUDE_SESSIONS:-}" ]]; then
    local env_ids=() e
    read -r -a env_ids <<< "${CORUM_PACK_EXCLUDE_SESSIONS//,/ }"
    for e in ${env_ids[@]+"${env_ids[@]}"}; do
      [[ -n "$e" ]] && EXCLUDE_SESSIONS+=("$e")
    done
  fi
  return 0
}

# 从命中的日志路径解析会话 id：
#   · 真实布局  sessions/<project>/<session-id>/session.v2.jsonl(.zstd) → 取父目录名
#   · 平铺布局  sessions/<project>/<session-id>.jsonl                    → 取文件名去 .jsonl 后缀
session_id_of_file() {
  local path="$1" base
  base="$(basename "$path")"
  if [[ "$base" == session*.jsonl* ]]; then
    basename "$(dirname "$path")"
  else
    base="${base%.jsonl.zstd}"
    base="${base%.jsonl}"
    printf '%s' "$base"
  fi
}

# 会话 id 是否命中某个排除项（完整 id 或唯一子串）。
is_excluded_session() {
  local sid="$1" ex
  for ex in ${EXCLUDE_SESSIONS[@]+"${EXCLUDE_SESSIONS[@]}"}; do
    [[ -n "$ex" && "$sid" == *"$ex"* ]] && return 0
  done
  return 1
}

assert_no_active_turns() {
  local hot_files line path sid found i
  local -a sid_order=() sid_blob=() excluded_ids=() excluded_files=() remaining=()
  local force=0
  [[ "${CORUM_PACK_FORCE:-}" == "1" ]] && force=1

  hot_files="$(active_sessions || true)"

  # 归并：会话 id → 命中文件列表（bash 3.2 兼容，不用关联数组）
  if [[ -n "$hot_files" ]]; then
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      sid="$(session_id_of_file "$path")"
      found=-1
      for ((i = 0; i < ${#sid_order[@]}; i++)); do
        [[ "${sid_order[$i]}" == "$sid" ]] && { found=$i; break; }
      done
      if (( found < 0 )); then
        sid_order+=("$sid")
        sid_blob+=("$path")
      else
        sid_blob[$found]="${sid_blob[$found]}"$'\n'"$path"
      fi
    done <<< "$hot_files"
  fi

  local n=${#sid_order[@]}
  if (( n == 0 )); then
    log "飞行守卫：核验到 0 个飞行会话（最近 2 分钟无会话日志写入），放行"
    return 0
  fi

  # 决策过程第一步：核验到 N 个飞行会话，逐个列出（含命中文件，可复核）
  log "飞行守卫：核验到 $n 个飞行会话（最近 2 分钟内有会话日志写入）："
  for ((i = 0; i < ${#sid_order[@]}; i++)); do
    log "   · ${sid_order[$i]}"
    while IFS= read -r line; do [[ -n "$line" ]] && log "       $line"; done <<< "${sid_blob[$i]}"
  done

  # 子串排除项若命中多个不同会话，提示可能过宽（排除面看得见）
  local ex matches
  for ex in ${EXCLUDE_SESSIONS[@]+"${EXCLUDE_SESSIONS[@]}"}; do
    matches=0
    for sid in ${sid_order[@]+"${sid_order[@]}"}; do
      [[ "$sid" == *"$ex"* ]] && matches=$((matches + 1))
    done
    if (( matches > 1 )); then
      log "⚠️ 排除项 '$ex' 按子串命中了 $matches 个不同会话（可能过宽，请核对）："
      for sid in ${sid_order[@]+"${sid_order[@]}"}; do
        [[ "$sid" == *"$ex"* ]] && log "       · $sid"
      done
    elif (( matches == 0 )); then
      log "注：排除项 '$ex' 未命中任何飞行会话（拼写错误会静默失效，特此提示）"
    fi
  done

  if (( force )); then
    log "⚠️⚠️ CORUM_PACK_FORCE=1：正在无视飞行守卫！以上 $n 个飞行会话将全部被强行打断（host 随实例重启）："
    for sid in ${sid_order[@]+"${sid_order[@]}"}; do log "   · $sid"; done
    return 0
  fi

  # 决策过程第二步：其中 M 个被显式排除，逐个列出 id 与命中文件（不允许静默放行）
  for ((i = 0; i < ${#sid_order[@]}; i++)); do
    sid="${sid_order[$i]}"
    if is_excluded_session "$sid"; then
      excluded_ids+=("$sid")
      excluded_files+=("${sid_blob[$i]}")
    else
      remaining+=("$sid")
    fi
  done
  local m=${#excluded_ids[@]}
  if (( m > 0 )); then
    log "其中 $m 个被显式排除（--exclude-session / CORUM_PACK_EXCLUDE_SESSIONS）："
    for ((i = 0; i < ${#excluded_ids[@]}; i++)); do
      log "   · 已排除 ${excluded_ids[$i]}"
      while IFS= read -r line; do [[ -n "$line" ]] && log "       $line"; done <<< "${excluded_files[$i]}"
    done
  else
    log "其中 0 个被显式排除"
  fi

  # 不变式：任何未被排除的飞行会话仍然必须导致拒绝
  local r=${#remaining[@]}
  if (( r > 0 )); then
    log "⚠️ 拒绝 stop/restart/update：仍有 $r 个未被排除的飞行会话（很可能有 Agent 正在跑）："
    for sid in ${remaining[@]+"${remaining[@]}"}; do log "   · $sid"; done
    log "  重启会打断它们（host 随实例重启）。等它跑完，或用 --exclude-session <id> 排除你自己的会话；"
    log "  确认可全部打断时才用 CORUM_PACK_FORCE=1 强制执行。"
    return 1
  fi
  log "飞行守卫：所有飞行会话均已被显式排除，放行"
  return 0
}

stop_own() {
  assert_no_active_turns || return 1
  local pid
  pid="$(pid_of || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    if is_self "$pid"; then
      log "停止打包实例：$pid"
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    else
      log "PID $pid 不是本打包实例（可能被复用），不杀，仅移除记录"
    fi
  fi
  rm -f "$PID_FILE"
}

wait_port_free() {
  for _ in $(seq 1 30); do
    cdp_ok || return 0
    sleep 0.5
  done
  log "警告：端口 $CORUM_PACK_PORT 仍被占用，继续尝试启动"
}

# 拒绝与 dev 态的 9222 抢同一个 home/端口：两个宿主共享一个 CORUM_HOME 会双派发。
assert_no_dev_instance() {
  local dev_pids
  dev_pids="$(pgrep -f "$REPO_ROOT/packages/desktop/lib/main.js" 2>/dev/null || true)"
  for pid in $dev_pids; do
    local cmd
    cmd="$(pgrep -fl "$REPO_ROOT/packages/desktop/lib/main.js" 2>/dev/null | grep "^$pid " || true)"
    # dev 实例的 userData 里带端口（-9222/-9333），据此判断是否占着本端口
    if [[ "$cmd" == *"-${CORUM_PACK_PORT}"* ]]; then
      log "拒绝启动：dev 态实例（pid $pid）正占用端口 $CORUM_PACK_PORT 与同一个 CORUM_HOME。"
      log "先停它（例如 ./scripts/cdp.sh stop 或 ./scripts/verify-instance.sh stop），再跑本脚本。"
      return 1
    fi
  done
  return 0
}

case "${1:-status}" in
  start)
    parse_guard_args "${@:2}" || exit 2
    if [[ ! -x "$APP_BIN" ]]; then
      log "打包实例不存在：$APP_BIN"
      log "先跑：cd packages/desktop && node scripts/pack-macos.mjs && ./node_modules/.bin/electron-builder --mac --arm64"
      exit 2
    fi
    assert_no_dev_instance
    stop_own
    wait_port_free
    log "启动打包实例：CORUM_HOME=$CORUM_HOME CDP=:$CORUM_PACK_PORT APP=$APP_PATH"
    # 凭据主密钥：`.master-key` 是 **dev 版 Electron 的 safeStorage** 加密的，打包 app 的
    # 钥匙串身份不同 → 它解不开，若不注入 CORUM_CREDENTIALS_MASTER_KEY，宿主遇到密文凭据会
    # fail-loud（安全性设计，文件不会被破坏）。这里**自动**用 dev 身份的 Electron 解出同一把
    # 密钥并注入本次启动（明文只在管道里，不落盘），使 `update` 成为真正的一条命令。
    if [[ -z "${CORUM_CREDENTIALS_MASTER_KEY:-}" ]]; then
      if [[ -f "$CORUM_HOME/.master-key" ]]; then
        CORUM_CREDENTIALS_MASTER_KEY="$(resolve_master_key || true)"
        export CORUM_CREDENTIALS_MASTER_KEY
        if [[ -n "${CORUM_CREDENTIALS_MASTER_KEY:-}" ]]; then
          log "已自动解出并注入 CORUM_CREDENTIALS_MASTER_KEY（长度 ${#CORUM_CREDENTIALS_MASTER_KEY}，明文未落盘）"
        else
          log "⚠️ 自动解主密钥失败：若该 home 存在密文凭据，宿主会 fail-loud"
        fi
      else
        log "该 home 无 .master-key（首次启动会生成），无需注入"
      fi
    else
      log "沿用外部注入的 CORUM_CREDENTIALS_MASTER_KEY（长度 ${#CORUM_CREDENTIALS_MASTER_KEY}）"
    fi
    # 后台 + 三重 fd 重定向：与调用方（Agent 的 bash 工具）彻底脱钩，脚本秒回。
    (
      nohup "$APP_BIN" "--combo=$COMBO_ID" > "$LOG_FILE" 2>&1 < /dev/null &
      printf '{"pid":%s,"combo":"%s","home":"%s","debugPort":%s,"startedAt":%s,"kind":"packaged"}\n' \
        "$!" "$COMBO_ID" "$CORUM_HOME" "$CORUM_PACK_PORT" "$(date +%s)" > "$PID_FILE"
      disown
    )
    sleep 3
    log "PID 记录 → $PID_FILE"
    log "日志 → $LOG_FILE"
    ;;
  master-key)
    # 需要手工取密钥时用它（`start` 已能自动注入，一般不必手动调）。
    resolve_master_key
    ;;
  stop)
    parse_guard_args "${@:2}" || exit 2
    stop_own
    ;;
  restart)
    # EXCLUDE_SESSIONS 重建成参数透传给 stop 与 start，两段守卫决策一致
    parse_guard_args "${@:2}" || exit 2
    fwd=()
    for _sid in ${EXCLUDE_SESSIONS[@]+"${EXCLUDE_SESSIONS[@]}"}; do fwd+=(--exclude-session "$_sid"); done
    "$0" stop ${fwd[@]+"${fwd[@]}"}
    "$0" start ${fwd[@]+"${fwd[@]}"}
    ;;
  status)
    if alive; then
      log "打包实例存活：PID $(pid_of)"
      if cdp_ok; then log "CDP 可达 → http://127.0.0.1:$CORUM_PACK_PORT"; else log "CDP 不可达（应用可能还在启动）"; fi
    else
      log "打包实例未运行"
      cdp_ok && log "但端口 $CORUM_PACK_PORT 有应答（可能是 dev 实例）" || true
    fi
    ;;
  update)
    # 一轮调试做完调这个：构建「改动过的包」→ 重打 host 闭包 + .app → 重启打包实例。
    # 注意：**不要**在这里跑 `pnpm install`（本仓库裸装会挂；带 --filter 会剪掉别的项目依赖）。
    parse_guard_args "${@:2}" || exit 2
    log "1/3 构建 desktop 壳与 client 插件产物"
    ( cd "$DESKTOP" && ./node_modules/.bin/tsc -b >/dev/null && ./node_modules/.bin/tsdown --config tsdown.config.ts >/dev/null && node scripts/inline-monaco-css.mjs >/dev/null )
    log "2/3 重打 host 闭包 + .app（pack-macos.mjs 失败即整体失败）"
    ( cd "$DESKTOP" && node scripts/pack-macos.mjs ) || { log "pack-macos.mjs 失败，未产出新包，保持旧实例运行"; exit 1; }
    ( cd "$DESKTOP" && ./node_modules/.bin/electron-builder --mac --arm64 >/dev/null ) || { log "electron-builder 失败，保持旧实例运行"; exit 1; }
    log "3/3 重启打包实例"
    fwd=()
    for _sid in ${EXCLUDE_SESSIONS[@]+"${EXCLUDE_SESSIONS[@]}"}; do fwd+=(--exclude-session "$_sid"); done
    "$0" restart ${fwd[@]+"${fwd[@]}"}
    log "完成。改了 client 源码的插件需要在 update 前先各自 build（如 packages/plugins/**/run build）"
    ;;
  *)
    log "未知子命令：${1:-}（可用 start|stop|restart|status|update）"
    exit 2
    ;;
esac
