#!/usr/bin/env bash
#
# corum-instance.sh —— corum 桌面实例的**统一启停入口（唯一实现）**。
#
# ## 为什么有这个脚本（2026-09-25 用户定调「做一个统一的整合脚本」）
#
# 此前 scripts/ 下有 **5 个**各管一段的启动脚本，差异其实只有 5 个维度，但每个脚本都
# 自己重写了一遍「清理 / PID / 日志 / 秒回」：
#
#   | 旧脚本              | 形态     | home                | 端口 | 差异            |
#   |---------------------|----------|---------------------|------|-----------------|
#   | dev-ide.sh          | dev      | .corum-dev-home     | 9222 | 全量构建 + 前台 |
#   | cdp.sh              | dev      | .corum-dev-home     | 9222 | 后台秒回        |
#   | combo.sh            | dev      | .corum-dev-home     | 9222 | 多 combo        |
#   | verify-instance.sh  | dev      | .corum-verify-home  | 9333 | 隔离 + 沙箱守卫 |
#   | pack-instance.sh    | 打包态   | .corum-dev-home     | 9222 | 吃 .app 闭包    |
#
# 现在收敛为**一个脚本 + 参数**：
#
#   ./scripts/corum-instance.sh start --home=dev                # 主 dev 实例（:9222）
#   ./scripts/corum-instance.sh start --home=verify             # 隔离验证实例（:9333）
#   ./scripts/corum-instance.sh start --mode=packaged           # 打包态实例（:9222）
#   ./scripts/corum-instance.sh restart --home=verify           # 重启验证实例
#   ./scripts/corum-instance.sh update --mode=packaged          # 重打包 + 重启
#   ./scripts/corum-instance.sh status --port=9333              # 探测任意端口
#   ./scripts/corum-instance.sh list                            # 列出所有已知实例
#   ./scripts/corum-instance.sh list --combos                   # 列出可用 combo（原 combo.sh list）
#   ./scripts/corum-instance.sh build coding                    # 构建指定 combo
#
# ## 参数（长选项，`--k=v` 与 `--k v` 两种写法都支持）
#
#   --mode=dev|packaged     dev（默认，吃仓库 lib/）| packaged（吃 .app 闭包）
#   --home=dev|verify|<abs> dev→.corum-dev-home（默认）| verify→.corum-verify-home | 绝对路径
#   --port=<n>              CDP 端口；缺省按 home 推（verify→9333，其余→9222）
#   --combo=<id>            combo id（默认 coding）
#   --build                 start/restart 前**全量构建**（dev）
#   --foreground            前台阻塞运行（交互调试用；默认后台秒回）
#   --exclude-session=<id>  飞行守卫排除该会话（可重复）
#   --allow-sandboxed       显式放行「在沙箱内启动 verify 实例」（默认硬拒绝）
#   --force                 无视飞行守卫强停（会显著警告）
#
# ## 环境变量（与长选项等价，供既有调用方/技能无改迁移）
#
#   CORUM_HOME / CORUM_DEBUG_PORT / CORUM_PACK_COMBO / CORUM_VERIFY_HOME /
#   CORUM_VERIFY_PORT / CORUM_VERIFY_ALLOW_SANDBOXED / CORUM_PACK_EXCLUDE_SESSIONS /
#   CORUM_PACK_FORCE / CORUM_PACK_APP
#
# ## 三条不可动摇的安全不变式（都是**实测事故换来的**，改动前先读）
#
# 1. **绝不用宽 pattern 杀进程**。只用「PID 文件记录 + cmdline 必须含本仓库绝对路径」
#    双条件；`is_self` 用 `pgrep -f` 集合判定而**不是** `ps -p <pid> -o command=`
#    ——后者在 Agent 工具沙箱里被禁（Operation not permitted），cmdline 取空会让
#    is_self 永远 false、cleanup 静默全跳过（2026-08-28 四实例残留事故的根因）。
# 2. **dev 主实例的清理必须排除验证实例**（连子进程一起）。两者 cmdline 都含
#    `packages/desktop/lib`，兜底 kill 会顺手带走验证实例（2026-09-12 实测：起主实例后
#    验证实例静默消失、日志无报错）。
# 3. **spawn 必须切断与脚本的 fd 血缘**（独立子 shell + 三重 fd 重定向 + disown）。
#    后台进程若继承脚本的 stdout/stderr，脚本退出时 shell 会等该 fd 关闭而 hang，外层
#    「带超时的 bash 调用」随即 SIGTERM 整个进程组、连坐刚起的 Electron。
#
# 另有两条**环境级守卫**：
#   · 沙箱守卫：应用绝不能在 Agent 的文件沙箱内启动（功能残缺但不报错：bash 开不了 PTY、
#     隔离 worktree 建不起来、跨工作区写 EPERM）。verify 实例**硬拒绝**，其余告警放行。
#   · 飞行守卫：重启实例 = 重启它的 host = 打断正在跑的委派会话。packaged / dev 主实例
#     在 stop/restart/update 前核验「最近 2 分钟有无会话日志在写」；verify 实例**不设此
#     守卫**（「子 Agent 可以随便重启 9333」正是它存在的意义）。
#
set -euo pipefail

# ── 解析**主 checkout** ────────────────────────────────────────────────────
# 本脚本会被**逐字节复制**进 CORUM_HOME 的技能路径（skills/corum-cdp-verify/scripts/），
# 子 Agent 在隔离 worktree 里 cwd 没有构建产物，故必须能自己找到主 checkout。
# 口径（与 cdp.mjs / ui-verify.mjs 一致，2026-09-12 用户定调）：
#   ① CORUM_REPO=<主 checkout 根>（显式最优先）
#   ② 脚本自身所在仓库（仓库 scripts/ 版走这条）
#   ③ cwd 的 git 主仓（worktree 里指回主仓）
#   ④ 都不成立 → 快速失败并打印可执行下一步（绝不猜、不连环试探环境）
resolve_root() {
  # ⚠️ 判据必须是 `packages/desktop/package.json`（真 checkout 的标记），
  # **不能**只看 `-d packages/desktop` —— 技能目录下有一个**运行态 stub**
  # （`skills/corum-cdp-verify/packages/desktop/{.corum-dev-home,.corum-verify-home}/run`），
  # 它也有 `packages/desktop` 目录 ⇒ 只看目录存在会把技能目录当成仓库根，于是读不到
  # 真正的 PID 文件、status 谎报「未运行」（2026-09-25 实测：实例活着却报未运行）。
  _is_checkout() { [[ -f "$1/packages/desktop/package.json" ]]; }
  if [[ -n "${CORUM_REPO:-}" ]] && _is_checkout "$CORUM_REPO"; then
    printf '%s' "$CORUM_REPO"; return 0
  fi
  local self_dir parent
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  parent="$(dirname "$self_dir")"
  if _is_checkout "$parent"; then printf '%s' "$parent"; return 0; fi
  local common
  common="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common" ]]; then
    local top
    top="$(cd "$(dirname "$common")" && pwd)"
    if _is_checkout "$top"; then printf '%s' "$top"; return 0; fi
  fi
  cat >&2 <<'EOF'
[instance] ❌ 找不到主 checkout（包含 packages/desktop 的仓库根）。
[instance]    下一步（任选其一，只需一次）：
[instance]      · 显式指定：CORUM_REPO=/path/to/kkc-desktop ./scripts/corum-instance.sh …
[instance]      · 或 cd 到主 checkout 再跑
[instance]    技能副本（skills/corum-cdp-verify/scripts/）必须靠 CORUM_REPO 或 git 主仓定位。
EOF
  return 2
}
ROOT="$(resolve_root)" || exit 2
DESKTOP="$ROOT/packages/desktop"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 参数解析 ───────────────────────────────────────────────────────────────
# ⚠️ 必须在**路径派生之前**解析（首版把它放在底部分派处 ⇒ 派生 APP_BIN 时 --mode
# 还没生效，`--mode=packaged` 直接 unbound variable）。
CMD="${1:-status}"
shift || true

MODE="${CORUM_MODE:-dev}"
HOME_SEL="${CORUM_HOME_SEL:-}"
PORT="${CORUM_DEBUG_PORT:-}"
COMBO="${CORUM_PACK_COMBO:-coding}"
DO_BUILD=0
FOREGROUND=0
ALLOW_SANDBOXED="${CORUM_VERIFY_ALLOW_SANDBOXED:-0}"
FORCE="${CORUM_PACK_FORCE:-}"
EXCLUDE_SESSIONS=()
PASS_COMBOS=0

usage() { sed -n '3,58p' "${BASH_SOURCE[0]}"; }

# 统一参数归一：同时接受 `--k=v` 与 `--k v`。未知参数**一律报错**（防拼写错误静默失效）。
parse_args() {
  local args=("$@") i=0 a
  while (( i < ${#args[@]} )); do
    a="${args[$i]}"
    case "$a" in
      --mode=*)        MODE="${a#--mode=}"; i=$((i + 1)) ;;
      --mode)          MODE="${args[$((i + 1))]:-}"; i=$((i + 2)) ;;
      --home=*)        HOME_SEL="${a#--home=}"; i=$((i + 1)) ;;
      --home)          HOME_SEL="${args[$((i + 1))]:-}"; i=$((i + 2)) ;;
      --port=*)        PORT="${a#--port=}"; i=$((i + 1)) ;;
      --port)          PORT="${args[$((i + 1))]:-}"; i=$((i + 2)) ;;
      --combo=*)       COMBO="${a#--combo=}"; i=$((i + 1)) ;;
      --combo)         COMBO="${args[$((i + 1))]:-}"; i=$((i + 2)) ;;
      --build)         DO_BUILD=1; i=$((i + 1)) ;;
      --foreground)    FOREGROUND=1; i=$((i + 1)) ;;
      --allow-sandboxed) ALLOW_SANDBOXED=1; i=$((i + 1)) ;;
      --force)         FORCE=1; i=$((i + 1)) ;;
      --exclude-session=*) EXCLUDE_SESSIONS+=("${a#--exclude-session=}"); i=$((i + 1)) ;;
      --exclude-session)
        if (( i + 1 >= ${#args[@]} )); then echo "[instance] 错误：--exclude-session 需要会话 id" >&2; return 2; fi
        EXCLUDE_SESSIONS+=("${args[$((i + 1))]}"); i=$((i + 2)) ;;
      -h|--help|help)  usage; exit 0 ;;
      # `list --combos` 的透传标记：不是本脚本的配置项，交给分派处处理。
      --combos)        PASS_COMBOS=1; i=$((i + 1)) ;;
      *)
        echo "[instance] 错误：未知参数 '$a'（-h 看用法）" >&2
        return 2 ;;
    esac
  done
  # 环境变量补充（逗号/空白分隔），与命令行合并生效
  if [[ -n "${CORUM_PACK_EXCLUDE_SESSIONS:-}" ]]; then
    local env_ids=() e
    read -r -a env_ids <<< "${CORUM_PACK_EXCLUDE_SESSIONS//,/ }"
    for e in ${env_ids[@]+"${env_ids[@]}"}; do [[ -n "$e" ]] && EXCLUDE_SESSIONS+=("$e"); done
  fi
  return 0
}

# ⚠️ 参数解析必须在**所有派生之前**（含 resolve_home / 端口 / APP_BIN）。
# 首版把它放在底部分派处 ⇒ `--home=verify`、`--mode=packaged` 在派生时都还是默认值
# （实测：`status --home=verify` 报 home=dev、`start --mode=packaged` 直接 unbound）。
case "$CMD" in
  -h|--help|help) usage; exit 0 ;;
esac
parse_args "$@" || exit 2

# 归一 home：dev→.corum-dev-home / verify→.corum-verify-home / 绝对路径原样。
# 兼容 CORUM_HOME 直接指定（既有调用方与技能都这么用）。
resolve_home() {
  local sel="$HOME_SEL"
  if [[ -z "$sel" && -n "${CORUM_HOME:-}" ]]; then
    # 显式 CORUM_HOME 优先；但若它恰好等于两个标准 home，仍按标准语义识别
    if [[ "$CORUM_HOME" == "$DESKTOP/.corum-verify-home" ]]; then sel=verify; else printf '%s' "$CORUM_HOME"; return 0; fi
  fi
  case "$sel" in
    ""|dev)   printf '%s' "$DESKTOP/.corum-dev-home" ;;
    verify)   printf '%s' "$DESKTOP/.corum-verify-home" ;;
    /*)       printf '%s' "$sel" ;;
    *)        printf '%s' "$DESKTOP/$sel" ;;
  esac
}

CORUM_HOME_RESOLVED="$(resolve_home)"
export CORUM_HOME="$CORUM_HOME_RESOLVED"
export CORUM_HOME_SEL="${HOME_SEL:-$([[ "$CORUM_HOME_RESOLVED" == *".corum-verify-home" ]] && echo verify || echo dev)}"

# 端口缺省：verify → 9333；其余 → 9222。CORUM_VERIFY_PORT 兼容旧调用。
if [[ -z "$PORT" ]]; then
  if [[ "$CORUM_HOME_SEL" == "verify" ]]; then PORT="${CORUM_VERIFY_PORT:-9333}"; else PORT="${CORUM_VERIFY_PORT:-9222}"; fi
fi
export CORUM_DEBUG_PORT="$PORT"

# 派生路径
RUN_DIR="$CORUM_HOME/run"
case "$CORUM_HOME_SEL" in
  verify) PID_FILE="$RUN_DIR/verify-$COMBO.pid"; LOG_FILE="$RUN_DIR/verify-$COMBO.log" ;;
  *)      PID_FILE="$RUN_DIR/$COMBO.pid";        LOG_FILE="$RUN_DIR/$COMBO.log" ;;
esac
if [[ "$MODE" == "packaged" ]]; then
  APP_PATH="${CORUM_PACK_APP:-$DESKTOP/dist/mac-arm64/Corum.app}"
  APP_BIN="$APP_PATH/Contents/MacOS/Corum"
  PID_FILE="$RUN_DIR/pack-$PORT.pid"
  LOG_FILE="$RUN_DIR/pack-$PORT.log"
  SELF_MARK="$ROOT/packages/desktop/dist/mac-arm64/Corum.app"
else
  SELF_MARK="$ROOT/packages/desktop"
fi
mkdir -p "$RUN_DIR"

log() { printf '[instance] %s\n' "$*"; }

# ── 校验/清理（安全不变式 1、2）────────────────────────────────────────────

# 目标 pid 是否确实是**本实例**（cmdline 含本仓库标记）——防 PID 复用误杀、防误伤微信等
# 无关 Electron。**必须用 pgrep 集合判定**，理由见文件头不变式 1。
is_self() {
  local pid="$1" match
  [[ -n "$pid" ]] || return 1
  match="$(pgrep -f "$SELF_MARK" 2>/dev/null || true)"
  [[ -n "$match" ]] || return 1
  while IFS= read -r line; do [[ "$line" == "$pid" ]] && return 0; done <<< "$match"
  return 1
}

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child" || true; done
  if is_self "$pid"; then kill "$pid" 2>/dev/null || true; fi
}

descendants_of() {
  local root="$1" kids k
  kids="$(pgrep -P "$root" 2>/dev/null || true)"
  for k in $kids; do printf '%s\n' "$k"; descendants_of "$k"; done
}

pid_of() {
  [[ -f "$PID_FILE" ]] || return 1
  sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PID_FILE" | head -1
}

cdp_ok() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; }
alive()  { local p; p="$(pid_of || true)"; [[ -n "${p:-}" ]] && kill -0 "$p" 2>/dev/null; }

# dev 主实例的兜底清理必须**排除验证实例**（连子孙）：两者 cmdline 都含 packages/desktop/lib。
verify_exclude_pids() {
  local vf vpid
  for vf in "$DESKTOP/.corum-verify-home/run/"*.pid; do
    [[ -f "$vf" ]] || continue
    vpid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$vf" | head -1)"
    [[ -n "${vpid:-}" ]] || continue
    printf '%s\n' "$vpid"
    descendants_of "$vpid"
  done
}

cleanup() {
  local killed=0 pid
  # 1) PID 记录（唯一权威）
  if [[ -f "$PID_FILE" ]]; then
    pid="$(pid_of || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      if is_self "$pid"; then
        log "清理 PID 记录实例：${pid}（含子进程树）"
        kill_tree "$pid" || true; killed=1
      else
        log "PID $pid 已被复用（非本仓库进程），不杀，仅移除记录"
      fi
    fi
    rm -f "$PID_FILE"
  fi
  # 2) 兜底：严格按本仓库绝对路径匹配（绝不宽匹配 electron/node）
  local pids
  if [[ "$MODE" == "packaged" ]]; then
    pids="$(pgrep -f "$SELF_MARK" 2>/dev/null || true)"
  else
    pids="$( { pgrep -f "$ROOT/packages/desktop/lib" 2>/dev/null || true; pgrep -f "node lib/cli.js --combo=$COMBO" 2>/dev/null || true; } | sort -u )"
    # 不变式 2：dev 主实例排除验证实例（含子孙）
    if [[ "$CORUM_HOME_SEL" != "verify" && -n "$pids" ]]; then
      local ex keep="" filtered="" p
      ex="$(verify_exclude_pids | sort -u | tr '\n' ' ')"
      for p in $pids; do
        if [[ " $ex " == *" $p "* ]]; then keep="$keep $p"; continue; fi
        filtered="$filtered $p"
      done
      [[ -n "$keep" ]] && log "跳过验证实例进程（不属于本实例）：$keep"
      pids="${filtered# }"
    fi
  fi
  if [[ -n "${pids// /}" ]]; then
    for p in $pids; do
      if is_self "$p"; then log "兜底清理本仓库残留：$p"; kill "$p" 2>/dev/null || true; killed=1; fi
    done
    sleep 1
    for p in $pids; do is_self "$p" && kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true; done
  fi
  [[ "$killed" == "1" ]] && sleep 1
  return 0
}

wait_port_free() {
  local _ ; for _ in $(seq 1 30); do cdp_ok || return 0; sleep 0.5; done
  log "警告：端口 $PORT 仍被占用，继续尝试启动"
}

# ── 飞行守卫（packaged / dev 主实例；verify 不设，见文件头）─────────────────

session_id_of_file() {
  local path="$1" base
  base="$(basename "$path")"
  if [[ "$base" == session*.jsonl* ]]; then basename "$(dirname "$path")"
  else base="${base%.jsonl.zstd}"; base="${base%.jsonl}"; printf '%s' "$base"; fi
}

is_excluded_session() {
  local sid="$1" ex
  for ex in ${EXCLUDE_SESSIONS[@]+"${EXCLUDE_SESSIONS[@]}"}; do
    [[ -n "$ex" && "$sid" == *"$ex"* ]] && return 0
  done
  return 1
}

# 飞行会话 = 最近 2 分钟内有会话日志在写（活跃会话每几秒写一次事件，mtime 判据够用）。
# 2026-09-13 实测事故：update 重启 9222 打断了跑在该实例上的卡片任务（turn/end
# reason=interrupted）。此后 stop/restart/update 前一律核验。
assert_no_active_turns() {
  [[ "$CORUM_HOME_SEL" == "verify" ]] && return 0
  local hot_files path sid found i
  local -a sid_order=() sid_blob=() excluded_ids=() excluded_files=() remaining=()
  local force=0
  [[ "$FORCE" == "1" ]] && force=1

  hot_files="$(find "$CORUM_HOME/sessions" -name 'session*.jsonl*' -mmin -2 2>/dev/null || true)"
  if [[ -n "$hot_files" ]]; then
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      sid="$(session_id_of_file "$path")"
      found=-1
      for ((i = 0; i < ${#sid_order[@]}; i++)); do
        [[ "${sid_order[$i]}" == "$sid" ]] && { found=$i; break; }
      done
      if (( found < 0 )); then sid_order+=("$sid"); sid_blob+=("$path")
      else sid_blob[$found]="${sid_blob[$found]}"$'\n'"$path"; fi
    done <<< "$hot_files"
  fi

  local n=${#sid_order[@]}
  if (( n == 0 )); then
    log "飞行守卫：核验到 0 个飞行会话（最近 2 分钟无会话日志写入），放行"
    return 0
  fi
  log "飞行守卫：核验到 $n 个飞行会话（最近 2 分钟内有会话日志写入）："
  for ((i = 0; i < ${#sid_order[@]}; i++)); do
    log "   · ${sid_order[$i]}"
    while IFS= read -r path; do [[ -n "$path" ]] && log "       $path"; done <<< "${sid_blob[$i]}"
  done
  local ex matches
  for ex in ${EXCLUDE_SESSIONS[@]+"${EXCLUDE_SESSIONS[@]}"}; do
    matches=0
    for sid in ${sid_order[@]+"${sid_order[@]}"}; do [[ "$sid" == *"$ex"* ]] && matches=$((matches + 1)); done
    if (( matches > 1 )); then
      log "⚠️ 排除项 '$ex' 按子串命中了 $matches 个不同会话（可能过宽，请核对）"
    elif (( matches == 0 )); then
      log "注：排除项 '$ex' 未命中任何飞行会话（拼写错误会静默失效，特此提示）"
    fi
  done
  if (( force )); then
    log "⚠️⚠️ --force：正在无视飞行守卫！以上 $n 个飞行会话将全部被强行打断："
    for sid in ${sid_order[@]+"${sid_order[@]}"}; do log "   · $sid"; done
    return 0
  fi
  for ((i = 0; i < ${#sid_order[@]}; i++)); do
    sid="${sid_order[$i]}"
    if is_excluded_session "$sid"; then excluded_ids+=("$sid"); excluded_files+=("${sid_blob[$i]}")
    else remaining+=("$sid"); fi
  done
  local m=${#excluded_ids[@]}
  log "其中 $m 个被显式排除（--exclude-session）"
  for ((i = 0; i < m; i++)); do log "   · 已排除 ${excluded_ids[$i]}"; done
  local r=${#remaining[@]}
  if (( r > 0 )); then
    log "⚠️ 拒绝 stop/restart/update：仍有 $r 个未被排除的飞行会话（很可能有 Agent 正在跑）："
    for sid in ${remaining[@]+"${remaining[@]}"}; do log "   · $sid"; done
    log "  重启会打断它们（host 随实例重启）。等它跑完，或用 --exclude-session <id> 排除你自己的会话；"
    log "  确认可全部打断时才用 --force。"
    return 1
  fi
  log "飞行守卫：所有飞行会话均已被显式排除，放行"
  return 0
}

# ── 沙箱守卫（应用绝不能在 Agent 文件沙箱内启动）───────────────────────────
assert_not_sandboxed() {
  sandbox-exec -p '(version 1)(allow default)' /usr/bin/true >/dev/null 2>&1 && return 0
  if [[ "$ALLOW_SANDBOXED" == "1" ]]; then
    log "⚠️ 检测到**沙箱内启动**，但已显式放行（--allow-sandboxed）。"
    log "   后果自负：实例内子 Agent 的 bash 会全部失败（sandbox_apply: Operation not permitted），"
    log "   隔离/子 Agent 类断言必然假失败；只有纯 UI 断言可用。"
    return 0
  fi
  if [[ "$CORUM_HOME_SEL" == "verify" ]]; then
    log "❌ 拒绝在**沙箱内**启动验证实例（sandbox-exec 探针失败）。"
    log "   原因：实例进程树会继承当前沙箱 ⇒ 实例内**子 Agent 的 bash 全部失败**"
    log "        （嵌套 sandbox-exec 无法应用 profile：sandbox_apply: Operation not permitted）。"
    log "   处置：请在**沙箱外**执行（用户终端 / 监督侧会话）。"
    log "        确需在沙箱内起（**仅**做 UI 断言）请显式加：--allow-sandboxed"
    log "   证据与判据：docs/tasks/log.jsonl → key tooling.sandbox.verify-instance-launch"
    return 3
  fi
  log "⚠️ 检测到**沙箱内启动**：应用功能会残缺但不报错（bash 开不了 PTY、隔离 worktree 建不起来）。"
  log "   确知后果并要继续：--allow-sandboxed（或 CORUM_ALLOW_SANDBOXED_LAUNCH=1）"
  [[ "${CORUM_ALLOW_SANDBOXED_LAUNCH:-0}" == "1" ]] && return 0
  return 0
}

# ── 构建（dev；build_all 口径见 docs/LESSONS.md「只建 5 个 ui 包」那课）─────
run_step() { ( cd "$1" && shift && "$@" ); }

build_ui_pkg() {
  run_step "$1" ./node_modules/.bin/tsc -b --pretty false
  run_step "$1" ./node_modules/.bin/tsdown
  run_step "$1" node scripts/inline-css.mjs
}

build_plugin_pkg() {
  [[ -f "$1/tsdown.config.ts" ]] || return 0
  run_step "$1" ./node_modules/.bin/tsc -b --pretty false
  run_step "$1" ./node_modules/.bin/tsdown
  [[ -f "$1/scripts/inline-css.mjs" ]] && run_step "$1" node scripts/inline-css.mjs
  return 0
}

# 全量构建。为什么不能只建 desktop 的 bundle：各插件包的 package.json `exports` 指向
# 自己的 lib/*，**运行时按包名加载的就是这份产物**（不是 src）。原先只建 5 个 ui-* 包
# ⇒ 改了 host 插件后 `tsc` 通过、应用重启后行为没变（2026-09-12 实测踩到）。
build_all() {
  # 直调各包 .bin，避开 pnpm run 的 verify-deps 自动 install。
  build_ui_pkg "$ROOT/packages/plugins/ui/corum-ui-base"
  build_ui_pkg "$ROOT/packages/plugins/ui/corum-ide-ui"
  build_ui_pkg "$ROOT/packages/plugins/ui/corum-ide-sidebar-ui"
  build_ui_pkg "$ROOT/packages/plugins/ui/corum-ide-explorer-ui"
  build_ui_pkg "$ROOT/packages/plugins/ui/corum-ide-panel-bottom-ui"
  local pkg
  for pkg in "$ROOT"/packages/plugins/*/*; do
    [[ -f "$pkg/package.json" && -d "$pkg/src" && -d "$pkg/lib" ]] || continue
    case "$pkg" in
      */ui/corum-ui-base|*/ui/corum-ide-ui|*/ui/corum-ide-sidebar-ui|*/ui/corum-ide-explorer-ui|*/ui/corum-ide-panel-bottom-ui) continue ;;
    esac
    build_plugin_pkg "$pkg"
  done
  run_step "$DESKTOP" ./node_modules/.bin/tsc -b tsconfig.host.json --pretty false
  run_step "$DESKTOP" ./node_modules/.bin/tsc -b tsconfig.client.json --pretty false
  run_step "$DESKTOP" ./node_modules/.bin/tsdown --config tsdown.config.ts
  run_step "$DESKTOP" node scripts/inline-monaco-css.mjs
}

# ── 凭据主密钥（打包态）：`.master-key` 由 **dev 身份**的 safeStorage 加密，打包 app 的
# 钥匙串身份不同解不开 ⇒ 自动用 dev Electron 解出并只注入本次启动（明文不落盘）──────
resolve_master_key() {
  local bin="$ROOT/node_modules/.pnpm/electron@43.4.1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  [[ -x "$bin" ]] || { log "找不到 Electron 二进制：$bin"; return 1; }
  local helper; helper="$(mktemp -t corum-decrypt-master-key).cjs"
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
  "$bin" "$helper" "$CORUM_HOME/.master-key"
  local rc=$?
  rm -f "$helper"
  return $rc
}

write_pid() {
  local tag="$1" pid="$2"
  if [[ "$MODE" == "packaged" ]]; then
    printf '{"pid":%s,"combo":"%s","home":"%s","debugPort":%s,"startedAt":%s,"kind":"packaged"}\n' \
      "$pid" "$COMBO" "$CORUM_HOME" "$PORT" "$(date +%s)" > "$PID_FILE"
  else
    printf '{"pid":%s,"combo":"%s","home":"%s","debugPort":%s,"startedAt":%s,"mode":"%s","tag":"%s"}\n' \
      "$pid" "$COMBO" "$CORUM_HOME" "$PORT" "$(date +%s)" "$MODE" "$tag" > "$PID_FILE"
  fi
}

# ── 启动 ───────────────────────────────────────────────────────────────────
do_start() {
  assert_not_sandboxed || return $?
  if [[ "$MODE" == "packaged" && ! -x "$APP_BIN" ]]; then
    log "打包实例不存在：$APP_BIN"
    log "先跑：./scripts/corum-instance.sh update --mode=packaged"
    return 2
  fi
  cleanup
  wait_port_free

  if [[ "$MODE" == "packaged" ]]; then
    # 拒绝与 dev 实例抢同一个 home/端口（两个宿主共享一个 CORUM_HOME 会双派发）
    local dev_pids pid cmd
    dev_pids="$(pgrep -f "$ROOT/packages/desktop/lib/main.js" 2>/dev/null || true)"
    for pid in $dev_pids; do
      cmd="$(pgrep -fl "$ROOT/packages/desktop/lib/main.js" 2>/dev/null | grep "^$pid " || true)"
      if [[ "$cmd" == *"-$PORT"* ]]; then
        log "拒绝启动：dev 态实例（pid ${pid}）正占用端口 ${PORT} 与同一个 CORUM_HOME。"
        log "先停它（./scripts/corum-instance.sh stop --home=dev，或 --home=verify），再跑本命令。"
        return 1
      fi
    done
    if [[ -z "${CORUM_CREDENTIALS_MASTER_KEY:-}" && -f "$CORUM_HOME/.master-key" ]]; then
      CORUM_CREDENTIALS_MASTER_KEY="$(resolve_master_key || true)"
      export CORUM_CREDENTIALS_MASTER_KEY
      if [[ -n "${CORUM_CREDENTIALS_MASTER_KEY:-}" ]]; then
        log "已自动解出并注入 CORUM_CREDENTIALS_MASTER_KEY（长度 ${#CORUM_CREDENTIALS_MASTER_KEY}，明文未落盘）"
      else
        log "⚠️ 自动解主密钥失败：若该 home 存在密文凭据，宿主会 fail-loud"
      fi
    fi
    log "启动打包实例：CORUM_HOME=$CORUM_HOME CDP=:$PORT APP=$APP_PATH"
    if [[ "$FOREGROUND" == "1" ]]; then
      write_pid foreground "$$"
      exec "$APP_BIN" "--combo=$COMBO"
    fi
    # 不变式 3：独立子 shell + 三重 fd 重定向 + disown ⇒ 脚本秒回，不受外层超时连坐
    (
      nohup "$APP_BIN" "--combo=$COMBO" > "$LOG_FILE" 2>&1 < /dev/null &
      write_pid background "$!"
      disown
    )
  else
    log "启动 dev 实例：CORUM_HOME=$CORUM_HOME CDP=:$PORT combo=$COMBO"
    if [[ "$FOREGROUND" == "1" ]]; then
      write_pid foreground "$$"
      cd "$DESKTOP"
      exec bash scripts/dev.sh "--combo=$COMBO"
    fi
    (
      cd "$DESKTOP" || exit 1
      nohup bash scripts/dev.sh "--combo=$COMBO" > "$LOG_FILE" 2>&1 < /dev/null &
      write_pid background "$!"
      disown
    )
  fi
  sleep 3
  log "PID 记录 → $PID_FILE"
  log "日志 → $LOG_FILE"
  return 0
}

do_stop() {
  assert_no_active_turns || return 1
  local pid
  pid="$(pid_of || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    if is_self "$pid"; then
      log "停止实例：${pid}（${MODE} / ${CORUM_HOME_SEL}）"
      kill "$pid" 2>/dev/null || true
      local _ ; for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    else
      log "PID $pid 不是本实例（可能被复用），不杀，仅移除记录"
    fi
  else
    log "无 PID 记录或进程已退出"
  fi
  cleanup
  return 0
}

do_status() {
  # 先按 PID 记录
  if alive; then
    log "实例存活：PID $(pid_of)（mode=${MODE} home=${CORUM_HOME_SEL}）"
    if cdp_ok; then log "CDP 可达 → http://127.0.0.1:$PORT"; else log "CDP 不可达（应用可能还在启动）"; fi
    return 0
  fi
  # PID 记录失效但端口有应答 ⇒ 可能是别的实例（或残留）
  if cdp_ok; then
    log "未运行（无有效 PID 记录），但端口 $PORT 有应答 —— 可能是其它实例/残留进程"
    return 1
  fi
  log "未运行（home=${CORUM_HOME_SEL} mode=${MODE} port=${PORT}）"
  return 1
}

# 列出所有已知实例（两个 home × 两种形态），并标注谁在跑、谁占着端口。
do_list() {
  local homes=("dev:$DESKTOP/.corum-dev-home" "verify:$DESKTOP/.corum-verify-home")
  local entry sel dir f pid port state line
  printf '[instance] 已知实例：\n'
  for entry in "${homes[@]}"; do
    sel="${entry%%:*}"; dir="${entry#*:}"
    [[ -d "$dir/run" ]] || continue
    for f in "$dir/run"/*.pid; do
      [[ -f "$f" ]] || continue
      pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$f" | head -1)"
      port="$(sed -n 's/.*"debugPort":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$f" | head -1)"
      state="已退出"
      if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then state="运行中"; fi
      line="$(basename "$f")  pid=${pid:-?}  port=${port:-?}  home=$sel  → $state"
      printf '  %s\n' "$line"
    done
  done
  printf '[instance] 当前监听中的 CDP 端口：\n'
  local p
  for p in 9222 9333; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN -t >/dev/null 2>&1; then printf '  :%s 有应答\n' "$p"; fi
  done
  return 0
}

# ── 命令分派 ───────────────────────────────────────────────────────────────
case "$CMD" in
  start)
    [[ "$DO_BUILD" == "1" ]] && { log "1/1 全量构建（--build）"; build_all; }
    do_start
    ;;
  stop)
    do_stop
    ;;
  restart)
    assert_no_active_turns || exit 1
    if [[ "$DO_BUILD" == "1" ]]; then log "全量构建（--build）"; build_all; fi
    do_stop || exit 1
    do_start
    ;;
  status)
    do_status
    ;;
  list)
    # `--combos` 列出可用 combo（原 combo.sh list 的能力）；否则列实例。
    if [[ "$PASS_COMBOS" == "1" ]]; then exec node "$SELF_DIR/combos.mjs" list; fi
    do_list
    ;;
  build)
    # 构建指定 combo（原 combo.sh build <id>）。coding 走全量构建；其余交给 combos.mjs。
    local cid="${1:-}"
    [[ -n "$cid" ]] || { echo "[instance] 错误：build 需要 combo id（或 --all-combos 列可用）" >&2; exit 2; }
    if [[ "$cid" == "coding" ]]; then build_all; else exec node "$SELF_DIR/combos.mjs" build "$cid"; fi
    ;;
  update)
    # 打包态一轮更新：构建改动包 → 重打 host 闭包 + .app → 重启。
    # ⚠️ 这里**不要**跑 `pnpm install`（本仓库裸装会挂；带 --filter 会剪掉别的项目依赖）。
    assert_no_active_turns || exit 1
    log "1/3 构建 desktop 壳与 client 插件产物"
    ( cd "$DESKTOP" && ./node_modules/.bin/tsc -b >/dev/null && ./node_modules/.bin/tsdown --config tsdown.config.ts >/dev/null && node scripts/inline-monaco-css.mjs >/dev/null )
    log "2/3 重打 host 闭包 + .app（pack-macos.mjs 失败即整体失败）"
    ( cd "$DESKTOP" && node scripts/pack-macos.mjs ) || { log "pack-macos.mjs 失败，未产出新包，保持旧实例运行"; exit 1; }
    ( cd "$DESKTOP" && ./node_modules/.bin/electron-builder --mac --arm64 >/dev/null ) || { log "electron-builder 失败，保持旧实例运行"; exit 1; }
    log "3/3 重启打包实例"
    MODE=packaged
    do_stop >/dev/null || true
    do_start
    log "完成。改了 client 源码的插件需要在 update 前先各自 build"
    ;;
  master-key)
    resolve_master_key
    ;;
  *)
    echo "[instance] 未知子命令：${CMD}（可用 start|stop|restart|status|list|build|update|master-key）" >&2
    exit 2
    ;;
esac
