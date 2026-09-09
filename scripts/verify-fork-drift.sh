#!/usr/bin/env bash
#
# verify-fork-drift.sh —— fork 包与官方基线的机器校验（P2-9，.dbg/event-bus-audit-2026-09.md）
#
# 解决什么问题：fork 包（尤其 @corum/corum-api-remotes）与官方同名包共用「核心文件
# 逐字节一致 + 只在声明过的位置加增量」的维护纪律。人工 rebase 时最容易漏的是：
#   ① 官方核心文件被无意改动（下次升级 rebase 冲突面扩大）；
#   ② 新增 corum 事件只写了声明、忘了进转发 allowlist（renderer 永远收不到）；
#   ③ allowlist 里留了早已删除的死事件（或事件改名后两边不同步）；
#   ④ 领域事件（corum-agent/events.ts）与转发声明（corum-events.ts）名字漂移。
# 本脚本把这些变成可执行的断言，退出码非 0 即 drift。
#
# 用法：
#   scripts/verify-fork-drift.sh            # 用默认 dsh 检出路径
#   DSH_CHECKOUT=/path/to/dsh scripts/verify-fork-drift.sh
#
# 官方检出缺失时只跳过「逐字节一致」类断言（并明确提示），事件一致性断言仍然执行。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_CHECKOUT="${DSH_CHECKOUT:-/Users/kukucai/dsh}"
FORK_API_REMOTES="$REPO_ROOT/packages/plugins/agent/corum-api-remotes"
OFFICIAL_API_REMOTES="$DSH_CHECKOUT/packages/api/remotes"
AGENT_EVENTS="$REPO_ROOT/packages/plugins/agent/corum-agent/src/events.ts"

failures=0
skips=0

pass() { printf '  ✓ %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*"; failures=$((failures + 1)); }
skip() { printf '  – %s\n' "$*"; skips=$((skips + 1)); }

section() { printf '\n%s\n' "$*"; }

# ── 1. 核心文件逐字节一致（官方检出存在时）─────────────────────────────────
section "[1] @corum/corum-api-remotes 核心文件与官方逐字节一致"
if [ -d "$OFFICIAL_API_REMOTES/src" ]; then
  for f in index.ts types.ts; do
    if [ ! -f "$FORK_API_REMOTES/src/$f" ]; then
      fail "fork 缺文件 src/$f"
    elif [ ! -f "$OFFICIAL_API_REMOTES/src/$f" ]; then
      skip "官方无 src/$f（官方改名？需人工核对台账）"
    elif cmp -s "$FORK_API_REMOTES/src/$f" "$OFFICIAL_API_REMOTES/src/$f"; then
      pass "src/$f 逐字节一致"
    else
      fail "src/$f 与官方有差异（fork 纪律：核心文件不加增量，增量放 corum-events.ts / remote-events.ts）"
    fi
  done
  # 官方基线版本提示（升级时对照台账 §8/§9）。
  ver=$(python3 -c "import json;print(json.load(open('$OFFICIAL_API_REMOTES/package.json'))['version'])" 2>/dev/null || echo '?')
  printf '  i 官方基线版本：%s\n' "$ver"
else
  skip "官方检出不存在（$OFFICIAL_API_REMOTES）——跳过逐字节断言"
fi

# ── 2. corum 事件：声明 ↔ 转发 allowlist 双向一致 ──────────────────────────
section "[2] corum 事件：声明（corum-events.ts）↔ 转发（remote-events.ts）"
declared=$(grep -oE "'corum/[a-z/-]+'" "$FORK_API_REMOTES/src/corum-events.ts" | tr -d "'" | sort -u)
forwarded=$(grep -oE "event: 'corum/[a-z/-]+'" "$FORK_API_REMOTES/src/remote-events.ts" | sed "s/event: //; s/'//g" | sort -u)

if [ -z "$declared" ]; then
  fail "corum-events.ts 未解析到任何 corum 事件（正则失配？）"
else
  pass "声明 $(printf '%s\n' "$declared" | wc -l | tr -d ' ') 个事件"
fi

missing_forward=$(comm -23 <(printf '%s\n' "$declared") <(printf '%s\n' "$forwarded"))
if [ -n "$missing_forward" ]; then
  fail "已声明但未转发（renderer 收不到）：$(printf '%s ' $missing_forward)"
else
  pass "每个声明事件都有转发条目"
fi

dead_forward=$(comm -13 <(printf '%s\n' "$declared") <(printf '%s\n' "$forwarded"))
if [ -n "$dead_forward" ]; then
  fail "allowlist 里的死事件（无声明）：$(printf '%s ' $dead_forward)"
else
  pass "allowlist 无死事件"
fi

# ── 3. 领域事件（corum-agent/events.ts）↔ 转发声明名字对齐 ──────────────────
section "[3] 领域事件（corum-agent/events.ts）↔ corum-events.ts 名字对齐"
if [ -f "$AGENT_EVENTS" ]; then
  domain=$(grep -oE "'corum/(task|group)/[a-z-]+'" "$AGENT_EVENTS" | tr -d "'" | sort -u)
  if [ -z "$domain" ]; then
    fail "corum-agent/events.ts 未解析到 corum/task|group 事件（正则失配？）"
  else
    domain_missing=$(comm -23 <(printf '%s\n' "$domain") <(printf '%s\n' "$declared"))
    if [ -n "$domain_missing" ]; then
      fail "领域事件未在 corum-events.ts 声明：$(printf '%s ' $domain_missing)"
    else
      pass "领域事件全部有转发声明（$(printf '%s\n' "$domain" | wc -l | tr -d ' ') 个）"
    fi
  fi
else
  skip "找不到 $AGENT_EVENTS"
fi

# ── 4. 宿主 emit 面 ↔ 声明（防「声明了但 host 从不 emit」）──────────────────
section "[4] host emit 面：声明的事件是否真有人 emit"
emit_scope="$REPO_ROOT/packages"
for ev in $declared; do
  case "$ev" in
    corum/task/*|corum/group/*)
      # 领域事件由 AgentRuntime.record 统一 emit（事件名以字符串字面量出现）。
      if ! grep -rqF "'$ev'" "$emit_scope/plugins/agent/corum-agent/src" 2>/dev/null; then
        fail "${ev}：corum-agent 源码中无 emit 字面量"
      fi
      ;;
    corum/terminal/output)
      grep -rqF "'$ev'" "$REPO_ROOT/packages/desktop/src/host/corum-terminal.ts" 2>/dev/null \
        && pass "${ev}：host corum-terminal 有 emit" \
        || fail "${ev}：corum-terminal.ts 无 emit"
      ;;
    corum/file/changed)
      grep -rqF "'$ev'" "$REPO_ROOT/packages/desktop/src/host/corum-fs.ts" 2>/dev/null \
        && pass "${ev}：host corum-fs 有 emit" \
        || fail "${ev}：corum-fs.ts 无 emit"
      ;;
    corum/subagent/progress)
      grep -rqF "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-agent/src" 2>/dev/null \
        && pass "${ev}：corum-agent 有 emit" \
        || fail "${ev}：corum-agent 无 emit"
      ;;
    corum/worktree-ledger)
      grep -rqF "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-orchestration/src" 2>/dev/null \
        && pass "${ev}：corum-orchestration 有 emit" \
        || fail "${ev}：corum-orchestration 无 emit"
      ;;
    *)
      skip "${ev}：无 emit 面映射（新增事件请在脚本里登记归属）"
      ;;
  esac
done

# ── 汇总 ───────────────────────────────────────────────────────────────────
printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'fork drift 校验失败：%d 项\n' "$failures"
  exit 1
fi
printf 'fork drift 校验通过（跳过 %d 项）\n' "$skips"
