#!/usr/bin/env bash
# corum CDP 实例一键维护：启动 / 重启 / 停止 IDE(coding) 桌面应用并开启 CDP。
#
# 设计目标：**精确清理、绝不误杀微信开发者工具等无关 Electron/Node 进程**。
#   - 只按「PID 文件记录 + 命令行必须含本仓库 packages/desktop 绝对路径」双保险杀进程。
#   - 全程不用 `electron` / `node` / `lib/main.js` 这类宽 pattern（它们会匹配微信等）。
#
# 用法：
#   ./scripts/cdp.sh start     # 清理旧实例 + 启动（CDP 9222），记录 PID
#   ./scripts/cdp.sh restart   # 同 start（等价；预留接 build 的位置）
#   ./scripts/cdp.sh stop      # 只精确清理本实例，不动其它进程
#   ./scripts/cdp.sh pid       # 打印当前记录的 Electron 主进程 PID
#   ./scripts/cdp.sh status    # 报告实例存活状态 + CDP 可达性
#
# 环境覆盖：
#   CORUM_HOME         默认 packages/desktop/.corum-dev-home
#   CORUM_DEBUG_PORT   默认 9222（CDP）
#   CORUM_DEV_HMR      默认 500
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 仓库根解析（与 verify-instance.sh / cdp.mjs / ui-verify.mjs 同口径）：本脚本有两个部署
# 位置（仓库 scripts/ 与技能包 $CORUM_HOME/skills/corum-cdp-verify/scripts/），也可能从
# 隔离 worktree 的 cwd 调用。优先级：CORUM_REPO > 脚本自身所在仓库 > cwd 的 git 主仓。
resolve_repo() {
  local candidate common
  if [[ -n "${CORUM_REPO:-}" && -d "$CORUM_REPO/packages/desktop" ]]; then printf '%s\n' "$CORUM_REPO"; return 0; fi
  candidate="$(dirname "$SCRIPT_DIR")"
  if [[ -d "$candidate/packages/desktop" ]]; then printf '%s\n' "$candidate"; return 0; fi
  common="$(git -C "$PWD" rev-parse --git-common-dir 2>/dev/null || git -C "$SCRIPT_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common" ]]; then
    candidate="$(cd "$(dirname "$common")" 2>/dev/null && pwd || true)"
    if [[ -n "$candidate" && -d "$candidate/packages/desktop" ]]; then printf '%s\n' "$candidate"; return 0; fi
  fi
  return 1
}
if ! ROOT="$(resolve_repo)"; then
  echo "[cdp] 错误：找不到主 checkout（本脚本在 ${SCRIPT_DIR}，cwd 是 ${PWD}）。" >&2
  echo "[cdp] 可执行下一步：cd 到含 packages/desktop/lib/cli.js 的主 checkout，或设 CORUM_REPO=<主 checkout 根> 后重试。" >&2
  exit 1
fi
DESKTOP="$ROOT/packages/desktop"
# 本仓库 desktop 的唯一标识子串：任何属于本实例的进程 cmdline 必含它；微信等绝无。
SELF_MARK="$DESKTOP"
COMBO_ID="coding"
export CORUM_HOME="${CORUM_HOME:-$DESKTOP/.corum-dev-home}"
# 注意：本脚本面向**用户主实例**（默认 9222）。Agent 的验证请改用技能里的
# verify-instance.sh（:9333）；不要用本脚本去起/停验证实例（口径见 SKILL.md）。
export CORUM_DEBUG_PORT="${CORUM_DEBUG_PORT:-9222}"
export CORUM_DEV_HMR="${CORUM_DEV_HMR:-500}"
RUN_DIR="$CORUM_HOME/run"
PID_FILE="$RUN_DIR/$COMBO_ID.cdp.pid"
CMD="${1:-start}"

mkdir -p "$RUN_DIR"
log() { printf '[cdp] %s\n' "$*"; }

# 校验一个 PID 的 cmdline 是否属于本仓库 desktop 实例（防 PID 复用误杀、防误伤微信）。
# 注意：不能用 `ps -p <pid> -o command=` ——Agent 工具 sandbox 里 /bin/ps 被禁
# （Operation not permitted），cmdline 取空会让 is_self 永远 false、cleanup 静默
# 全跳过（2026-08-28 四实例残留事故的根因）。改用 pgrep 集合判定：`pgrep -f
# "$SELF_MARK"` 列出所有 cmdline 含本仓库绝对路径的进程（macOS pgrep 的 -f 匹配
# 完整 cmdline；微信等进程的路径绝不含此子串），目标 pid 在集合内即 self。
is_self() {
  local pid="$1" match
  [[ -n "$pid" ]] || return 1
  match="$(pgrep -f "$SELF_MARK" 2>/dev/null || true)"
  [[ -n "$match" ]] || return 1
  # 精确匹配整行（pgrep 输出每行一个 pid）。
  while IFS= read -r line; do [[ "$line" == "$pid" ]] && return 0; done <<< "$match"
  return 1
}

# 递归杀进程树（先子后父），但每个 PID 都先过 is_self 校验。
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" || true
  done
  if is_self "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
}

# 精确清理：只用两类事实源，且都过 is_self 校验。
#   1) PID 文件记录的 Electron 主进程（连同其子进程树，含 bridge host）。
#   2) 兜底：pgrep 严格匹配「本仓库 desktop 绝对路径」的进程（绝不宽匹配 electron/node）。
cleanup() {
  local killed=0
  # 1) PID 文件
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PID_FILE" | head -1)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      if is_self "$pid"; then
        log "清理 PID 记录实例：${pid}（含子进程树）"
        kill_tree "$pid" || true
        killed=1
      else
        log "PID $pid 已被复用（非本仓库进程），不杀，仅移除记录"
      fi
    fi
    rm -f "$PID_FILE"
  fi
  # 2) 兜底：严格按本仓库绝对路径匹配（main.js / cli.js / bridge.js 的完整路径）。
  local pids pid
  pids="$(pgrep -f "$SELF_MARK/lib/" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      if is_self "$pid"; then
        log "兜底清理本仓库 desktop 残留：$pid"
        kill "$pid" 2>/dev/null || true
        killed=1
      fi
    done
    sleep 1
    for pid in $pids; do
      if is_self "$pid" && kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
    done
  fi
  if [[ "$killed" == "1" ]]; then sleep 1; fi
}

# 启动后定位并记录「Electron 主进程」PID：它是真正承载窗口/CDP 的进程，
# 杀它（+ 子进程树）即可整体重启；bridge host 是它的子进程，随树一起清。
record_pid() {
  # 等 Electron 主进程起来（main.js 在本仓库 desktop/lib 下）。
  local pid="" tries=0
  while [[ $tries -lt 40 ]]; do
    pid="$(pgrep -f "$SELF_MARK/lib/main.js" 2>/dev/null | head -1 || true)"
    [[ -n "$pid" ]] && break
    sleep 0.25; tries=$((tries+1))
  done
  if [[ -z "$pid" ]]; then
    log "警告：未找到 Electron 主进程（$SELF_MARK/lib/main.js），PID 未记录"
    return 1
  fi
  printf '{"pid":%s,"combo":"%s","home":"%s","debugPort":%s,"startedAt":%s,"mark":"%s"}\n' \
    "$pid" "$COMBO_ID" "$CORUM_HOME" "$CORUM_DEBUG_PORT" "$(date +%s)" "$SELF_MARK" \
    > "$PID_FILE"
  log "PID 记录 → ${PID_FILE}（Electron 主进程 ${pid}）"
}

cdp_ok() {
  curl -s --max-time 2 "http://127.0.0.1:$CORUM_DEBUG_PORT/json/version" 2>/dev/null | grep -q '"Browser"'
}

case "$CMD" in
  stop)
    cleanup
    ;;
  pid)
    if [[ -f "$PID_FILE" ]]; then sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PID_FILE" | head -1; else echo ""; fi
    ;;
  status)
    if [[ -f "$PID_FILE" ]]; then
      pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PID_FILE" | head -1)"
      if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null && is_self "$pid"; then
        log "实例存活：Electron 主进程 $pid"
      else
        log "PID 记录存在但进程已死/被复用"
        rm -f "$PID_FILE"
      fi
    fi
    # PID 文件缺失/失效但 Electron 在跑 → 重新定位并补记（start 秒回不记 PID）。
    if [[ ! -f "$PID_FILE" ]]; then
      live="$(pgrep -f "$SELF_MARK/lib/main.js" 2>/dev/null | head -1 || true)"
      if [[ -n "$live" ]] && is_self "$live"; then
        printf '{"pid":%s,"combo":"%s","home":"%s","debugPort":%s,"startedAt":%s,"mark":"%s"}\n' \
          "$live" "$COMBO_ID" "$CORUM_HOME" "$CORUM_DEBUG_PORT" "$(date +%s)" "$SELF_MARK" > "$PID_FILE"
        log "补记 PID → ${PID_FILE}（Electron 主进程 ${live}）"
      fi
    fi
    if cdp_ok; then log "CDP :${CORUM_DEBUG_PORT} 可达"; else log "CDP :${CORUM_DEBUG_PORT} 不可达"; fi
    ;;
  start|restart)
    cleanup
    # 启动环境守卫（同 dev-ide.sh）：沙箱内启动的应用会功能残缺但不报错。
    # 注意 nohup/disown 甩不掉 seatbelt —— 沙箱是进程级属性，会被整棵进程树继承。
    bash "$SCRIPT_DIR/app-launch-guard.sh" "$ROOT"
    log "启动 combo=${COMBO_ID}（CDP :${CORUM_DEBUG_PORT}）…"
    # 后台启动并立即返回（不在脚本内等 CDP）——关键：本脚本常被 Agent 工具以
    # 「带超时的 bash 调用」执行，若脚本内长时间等待，外层超时会 SIGTERM 整个
    # 进程组、连带刚起的 Electron（GPU/network 崩溃）。改为：nohup + 子 shell
    # 后台 + disown 脱离 job 控制、忽略 HUP；脚本启动后立刻 exit 0，让外层调用
    # 秒回、不触发超时连坐。CDP 就绪用 status / 后续命令单独探测。
    # 关键：spawn 必须彻底切断与脚本的血缘——后台 Electron 若继承脚本的 stdout/
    # stderr fd，脚本退出时 shell 会等该 fd 关闭而 hang（外层超时连坐杀 Electron）。
    # 用一个独立子 shell 包裹，内部 nohup + 三重 fd 重定向（stdin<-/dev/null、
    # stdout/stderr->log）+ disown，使 Electron 与脚本完全无关，脚本即可秒回。
    (
      cd "$DESKTOP" || exit 1
      nohup bash scripts/dev.sh "--combo=$COMBO_ID" > "/tmp/corum-cdp-$COMBO_ID.log" 2>&1 < /dev/null &
      disown
    ) > /dev/null 2>&1
    # 不在此处 record_pid（它内部要等 Electron 起来、会拖住脚本导致外层超时连坐）。
    # start 秒回；PID 由 status/ensure 在 Electron 就绪后补记。
    log "已在后台启动（Electron 就绪需数秒；用 ./scripts/cdp.sh status 探测并补记 PID）"
    ;;
  -h|--help|help)
    sed -n '2,22p' "${BASH_SOURCE[0]}"
    ;;
  *)
    echo "未知命令: ${CMD}（支持 start/restart/stop/pid/status）" >&2
    exit 2
    ;;
esac
