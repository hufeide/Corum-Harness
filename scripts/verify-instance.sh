#!/usr/bin/env bash
# 验证实例（verify instance）：给 Agent 一个**它自己可以随便重启/杀**的应用实例，
# 与用户正在用的主实例（默认 :9222 / .corum-dev-home）完全隔离。
#
# 为什么需要它（2026-09-12）：
#   ① 主实例跑的是**启动期 bundle 快照**：Agent 改了 client 插件、build 完，主实例不会加载，
#      于是它永远无法端到端自验 UI（实测它为此烧了 12 轮 CDP 探针，最后只能写「请用户重启」）。
#   ② 反过来说，让 Agent 去重启**主实例**是灾难：2026-09-11 它 kill launcher/host，
#      把用户正在用的应用整死（`app.quit()`）。
#   结论：给 Agent 一个专属实例 —— 自由重启 + 自己的 CDP 端口，主实例一根汗毛都不碰。
#
# 隔离面（都已由现有代码保证，本脚本不再另造）：
#   · CORUM_HOME      独立会话/设置/存储（默认 <repo>/packages/desktop/.corum-verify-home）
#   · CORUM_DEBUG_PORT 独立 CDP 端口（默认 9333）
#   · Electron userData 按端口分目录（main.ts: `corum-desktop-ud-<mode>-<port>`），
#     所以 requestSingleInstanceLock() 不会和主实例互斥。
#   · PID 文件写在**自己的 CORUM_HOME/run 下**，stop 只杀自己记录的那棵树。
#
# **绝不用 `dev-ide.sh start` 来起验证实例**：它的兜底清理是
# `pgrep -f "$ROOT/packages/desktop/lib"` —— 会把主实例一起杀掉。本脚本只做
# 「按自己的 PID 文件杀自己的树」，没有任何按仓库路径的宽匹配。
#
# 用法：
#   scripts/verify-instance.sh start     # 起（先清掉自己上一次的残留）
#   scripts/verify-instance.sh stop      # 停（只杀自己）
#   scripts/verify-instance.sh status    # 状态 + CDP 可达性 + 端口
#   scripts/verify-instance.sh restart   # 停 + 起（Agent 改完代码后重建前端产物再调用）
#
# 环境覆盖：CORUM_VERIFY_HOME、CORUM_VERIFY_PORT、COMBO_ID
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 解析**主 checkout**（2026-09-12 用户定调：脚本与技能原文打包进 CORUM_HOME 技能路径，
# 而且要「不存在无法使用的问题」）──────────────────────────────────────────────
# 本脚本有两个部署位置、三种调用场景，都必须指向同一个主 checkout：
#   ① 仓库内 `scripts/verify-instance.sh`（日常/主实例侧调用）；
#   ② 技能包 `<CORUM_HOME>/skills/corum-cdp-verify/scripts/verify-instance.sh`
#      ——此时 `dirname(SCRIPT_DIR)` 是技能目录，**不是仓库**（旧实现直接取它 → 找不到
#      `packages/desktop/lib/cli.js`，隔离 worktree 里的子 Agent 一用就失败）；
#   ③ 从隔离 worktree 的 cwd 调用（子 Agent 的常态）——worktree 里没有构建产物，
#      必须回到主 checkout。
# 优先级：显式 CORUM_REPO > 脚本自身在仓库里 > cwd 的 git 主仓 > 失败即报（不猜）。
resolve_repo() {
  local candidate
  if [[ -n "${CORUM_REPO:-}" && -f "$CORUM_REPO/packages/desktop/lib/cli.js" ]]; then
    printf '%s\n' "$(cd "$CORUM_REPO" && pwd)"; return 0
  fi
  candidate="$(dirname "$SCRIPT_DIR")"
  if [[ -f "$candidate/packages/desktop/package.json" ]]; then
    printf '%s\n' "$candidate"; return 0
  fi
  # cwd 或 SCRIPT_DIR 所在仓库：worktree 里 --git-common-dir 指回主仓的 .git
  local common
  common="$(git -C "$PWD" rev-parse --git-common-dir 2>/dev/null || git -C "$SCRIPT_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common" ]]; then
    candidate="$(cd "$(dirname "$common")" 2>/dev/null && pwd || true)"
    if [[ -n "$candidate" && -f "$candidate/packages/desktop/package.json" ]]; then
      printf '%s\n' "$candidate"; return 0
    fi
  fi
  return 1
}

if ! ROOT="$(resolve_repo)"; then
  printf '[verify-instance] 找不到主 checkout：本脚本在 %s，cwd 是 %s。\n' "$SCRIPT_DIR" "$PWD" >&2
  printf '[verify-instance] 可执行下一步：cd 到主 checkout（含 packages/desktop/lib/cli.js 的那份），或设 CORUM_REPO=/abs/path 后重跑。\n' >&2
  printf '[verify-instance] 注意：隔离 worktree 里没有构建产物，验证实例必须在主 checkout 上跑（不要自己 debug 环境）。\n' >&2
  exit 2
fi

DESKTOP="$ROOT/packages/desktop"
COMBO_ID="${COMBO_ID:-coding}"
export CORUM_HOME="${CORUM_VERIFY_HOME:-$DESKTOP/.corum-verify-home}"
export CORUM_DEBUG_PORT="${CORUM_VERIFY_PORT:-9333}"
RUN_DIR="$CORUM_HOME/run"
PID_FILE="$RUN_DIR/verify-$COMBO_ID.pid"
LOG_FILE="$RUN_DIR/verify-$COMBO_ID.log"

log() { printf '[verify-instance] %s\n' "$*"; }

mkdir -p "$RUN_DIR"

recorded_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PID_FILE" | head -1
}

# 只杀自己记录的那棵树（先子后父）——不 pgrep 仓库路径，绝不碰主实例。
kill_own_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_own_tree "$child" || true; done
  kill "$pid" 2>/dev/null || true
}

stop_own() {
  local pid
  if pid="$(recorded_pid)"; then
    if kill -0 "$pid" 2>/dev/null; then
      log "停止验证实例 PID ${pid}（含子进程树）"
      kill_own_tree "$pid" || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    else
      log "PID $pid 已不在"
    fi
  else
    log "无 PID 记录（${PID_FILE}）"
  fi
  rm -f "$PID_FILE"
}

cdp_ok() {
  curl -s --max-time 2 "http://127.0.0.1:$CORUM_DEBUG_PORT/json/version" 2>/dev/null | grep -q '"Browser"'
}

# 等端口空闲：Electron 的实例锁在 userData 上，进程退出到锁释放之间有间隙；
# 不等就立刻 start 会命中 `another instance already owns the lock; handing over and exiting`
# （2026-09-12 实测把自己坑了一次）。最多等 15 秒。
wait_port_free() {
  local i=0
  while [[ $i -lt 30 ]]; do
    if ! curl -s --max-time 1 "http://127.0.0.1:$CORUM_DEBUG_PORT/json/version" >/dev/null 2>&1; then return 0; fi
    sleep 0.5; i=$((i+1))
  done
  log "警告：端口 $CORUM_DEBUG_PORT 仍被占用，继续尝试启动"
  return 0
}

case "${1:-status}" in
  start)
    stop_own
    wait_port_free
    log "启动验证实例：CORUM_HOME=$CORUM_HOME CDP=:$CORUM_DEBUG_PORT"
    # 后台 + 三重 fd 重定向：与调用方（Agent 的 bash 工具）彻底脱钩，脚本秒回。
    (
      cd "$DESKTOP" || exit 1
      nohup bash scripts/dev.sh "--combo=$COMBO_ID" > "$LOG_FILE" 2>&1 < /dev/null &
      printf '{"pid":%s,"combo":"%s","home":"%s","debugPort":%s,"startedAt":%s}\n' \
        "$!" "$COMBO_ID" "$CORUM_HOME" "$CORUM_DEBUG_PORT" "$(date +%s)" > "$PID_FILE"
      disown
    )
    sleep 3
    log "PID 记录 → ${PID_FILE}"
    log "日志 → ${LOG_FILE}"
    ;;
  stop)
    stop_own
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    if pid="$(recorded_pid)" && kill -0 "$pid" 2>/dev/null; then
      log "验证实例存活：PID ${pid}（CDP :${CORUM_DEBUG_PORT}）"
    else
      log "验证实例未运行"
    fi
    if cdp_ok; then log "CDP 可达 → http://127.0.0.1:$CORUM_DEBUG_PORT"; else log "CDP 不可达"; fi
    log "用 CDP_PORT=$CORUM_DEBUG_PORT node scripts/cdp.mjs … 驱动它"
    ;;
  *)
    echo "用法: $0 start|stop|restart|status" >&2
    exit 2
    ;;
esac
