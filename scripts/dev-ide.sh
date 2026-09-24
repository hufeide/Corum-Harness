#!/usr/bin/env bash
# IDE/coding combo 一键维护脚本：清残留 → 全量直编（.bin，不走 pnpm run）→ 记录 PID → 启动。
#
# 用法：
#   ./scripts/dev-ide.sh             # 默认 restart：清理旧实例 + 全编译 + 启动
#   ./scripts/dev-ide.sh restart     # 同上
#   ./scripts/dev-ide.sh build       # 只全编译
#   ./scripts/dev-ide.sh start       # 清理旧实例 + 启动（不编译；--no-build 等价）
#   ./scripts/dev-ide.sh stop        # 只清理旧实例（PID 记录 + 兜底模式）
#
# 环境覆盖：
#   CORUM_HOME         默认 packages/desktop/.corum-dev-home
#   CORUM_DEBUG_PORT   默认 9222（CDP）
#   CORUM_DEV_HMR      默认 500（dev.sh 内默认）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
DESKTOP="$ROOT/packages/desktop"
COMBO_ID="coding"
export CORUM_HOME="${CORUM_HOME:-$DESKTOP/.corum-dev-home}"
export CORUM_DEBUG_PORT="${CORUM_DEBUG_PORT:-9222}"
RUN_DIR="$CORUM_HOME/run"
PID_FILE="$RUN_DIR/$COMBO_ID.pid"
CMD="${1:-restart}"
if [[ "${1:-}" == "--no-build" ]]; then CMD="start"; fi

mkdir -p "$RUN_DIR"

log() { printf '[dev-ide] %s\n' "$*"; }

# 启动环境守卫：应用绝不能在 Agent 工具的文件沙箱内启动（那样会功能残缺但不报错：
# bash 开不了 PTY、隔离 worktree 建不起来、跨工作区写 EPERM）。详见脚本头部注释。
# 只告警、不阻止：确知后果时用 CORUM_ALLOW_SANDBOXED_LAUNCH=1 跳过。
bash "$SCRIPT_DIR/app-launch-guard.sh" "$ROOT"

# 递归杀进程树（macOS pgrep -P；先子后父）。
kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" || true
  done
  kill "$pid" 2>/dev/null || true
}

# 清理上一次实例：优先 PID 记录（校验命令仍属本仓库 desktop/combo，防 PID 复用误杀），
# 再兜底清本仓库 desktop 的 cli/main/bridge 残留（防孤儿 bridge 双派，见 docs/TODO.md）。
cleanup() {
  local killed=0
  if [[ -f "$PID_FILE" ]]; then
    local pid cmdline
    pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PID_FILE" | head -1)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      if [[ "$cmdline" == *"$ROOT/packages/desktop/lib/"* || "$cmdline" == *"lib/cli.js --combo=$COMBO_ID"* || "$cmdline" == *"packages/desktop/scripts/dev.sh"* ]]; then
        log "清理 PID 记录实例：${pid}"
        kill_tree "$pid" || true
        killed=1
      else
        log "PID ${pid} 已被复用（${cmdline}），不杀，仅移除记录"
      fi
    fi
    rm -f "$PID_FILE"
  fi

  # 兜底：只杀命令行含本仓库 packages/desktop/lib 或本 combo 相对 cli 的进程。
  # ⚠️ 验证实例（scripts/verify-instance.sh，CORUM_HOME=packages/desktop/.corum-verify-home）
  # 的命令行同样含本仓库 packages/desktop/lib，会被这条兜底误杀（2026-09-12 实测：起主实例
  # 后验证实例静默消失、日志无报错，排查了半天）。所以先读它的 PID 记录把它们排除——
  # 它是 agent 自己的实例，不该被主实例的清理带走。
  local pids pid verify_pids="" pids_filtered="" vpid k
  for vf in "$ROOT/packages/desktop/.corum-verify-home/run/"*.pid; do
    [ -f "$vf" ] || continue
    vpid="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['pid'])" "$vf" 2>/dev/null || true)"
    [ -n "$vpid" ] || continue
    # 连子进程一起排除：验证实例的主进程之下还挂着 Electron 渲染/GPU 与 host 子进程，
    # 只排除主进程的话兜底 kill 仍会把它们带走（2026-09-12 实测：主进程活着但界面已死）。
    verify_pids="$verify_pids $vpid $(descendants_of "$vpid" | tr '\n' ' ')"
  done
  pids="$( { pgrep -f "$ROOT/packages/desktop/lib" 2>/dev/null || true; pgrep -f "node lib/cli.js --combo=$COMBO_ID" 2>/dev/null || true; } | sort -u )"
  if [[ -n "$verify_pids" && -n "$pids" ]]; then
    local kept=""
    for pid in $pids; do
      if [[ " $verify_pids " == *" $pid "* ]]; then kept="$kept $pid"; continue; fi
      pids_filtered="$pids_filtered $pid"
    done
    if [[ -n "$kept" ]]; then log "跳过验证实例进程（不属于主实例）：$kept"; fi
    pids="${pids_filtered# }"
  fi
  if [[ -n "$pids" ]]; then
    log "兜底清理本仓库 desktop 残留进程：$(echo "$pids" | tr '\n' ' ')"
    for pid in $pids; do kill "$pid" 2>/dev/null || true; done
    sleep 1
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
    done
    killed=1
  fi
  if [[ "$killed" == "1" ]]; then sleep 1; fi
}

run_step() {
  log "$*"
  ( cd "$1" && shift && "$@" )
}

# 一个进程的全部后代 PID（递归；验证实例的排除集要用）。
descendants_of() {
  local root="$1" kids k
  kids="$(pgrep -P "$root" 2>/dev/null || true)"
  for k in $kids; do
    printf '%s\n' "$k"
    descendants_of "$k"
  done
}

build_ui_pkg() {
  run_step "$1" ./node_modules/.bin/tsc -b --pretty false
  run_step "$1" ./node_modules/.bin/tsdown
  run_step "$1" node scripts/inline-css.mjs
}

# 其余插件包（host 半 lib/index.js + client 半 lib/client.js）的通用构建。
# 为什么必须建：这些包的 package.json `exports` 指向自己的 lib/*，**运行时按包名
# 加载的就是这份产物**（不是 src，也不是 desktop 的 bundle）。原先 dev-ide.sh 只建
# 5 个 ui-* 包 → 改了 host 插件后 `tsc` 通过、应用重启后行为没变
# （2026-09-12 实测踩到：corum-agent 的 baseMode 工具面与内置 Agent 播种都改了，
# lib/index.js 却停在旧时间戳，新 Agent 一个都没出现）。
build_plugin_pkg() {
  [ -f "$1/tsdown.config.ts" ] || return 0
  run_step "$1" ./node_modules/.bin/tsc -b --pretty false
  run_step "$1" ./node_modules/.bin/tsdown
  if [ -f "$1/scripts/inline-css.mjs" ]; then
    run_step "$1" node scripts/inline-css.mjs
  fi
}

build_all() {
  # 直调各包 .bin，避开 pnpm run 的 verify-deps 自动 install（见 docs/TODO.md 工程约束）。
  # UI 包按依赖顺序显式列出（corum-ui-base 是其余 UI 包的依赖，必须最先建）。
  build_ui_pkg "$ROOT/packages/plugins/ui/corum-ui-base"
  build_ui_pkg "$ROOT/packages/plugins/ui/corum-ide-ui"
  build_ui_pkg "$ROOT/packages/plugins/ui/corum-ide-sidebar-ui"
  build_ui_pkg "$ROOT/packages/plugins/ui/corum-ide-explorer-ui"
  build_ui_pkg "$ROOT/packages/plugins/ui/corum-ide-panel-bottom-ui"

  for pkg in "$ROOT"/packages/plugins/*/*; do
    [ -f "$pkg/package.json" ] && [ -d "$pkg/src" ] && [ -d "$pkg/lib" ] || continue
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

write_pid() {
  # exec 后脚本进程即被 dev.sh/node 替换，$$ 就是最终 cli 进程 PID。
  printf '{"pid":%s,"combo":"%s","home":"%s","debugPort":%s,"startedAt":%s,"command":"%s"}\n' \
    "$$" "$COMBO_ID" "$CORUM_HOME" "$CORUM_DEBUG_PORT" "$(date +%s)" "$ROOT/packages/desktop/scripts/dev.sh --combo=$COMBO_ID" \
    > "$PID_FILE"
  log "PID 记录 → $PID_FILE"
}

case "$CMD" in
  stop)
    cleanup
    ;;
  build)
    build_all
    ;;
  start)
    cleanup
    write_pid
    exec bash "$DESKTOP/scripts/dev.sh" "--combo=$COMBO_ID"
    ;;
  restart)
    cleanup
    build_all
    write_pid
    exec bash "$DESKTOP/scripts/dev.sh" "--combo=$COMBO_ID"
    ;;
  -h|--help|help)
    sed -n '2,22p' "${BASH_SOURCE[0]}"
    ;;
  *)
    echo "未知命令: ${CMD}（支持 restart/build/start/stop）" >&2
    exit 2
    ;;
esac
