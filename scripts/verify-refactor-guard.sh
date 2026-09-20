#!/usr/bin/env bash
#
# verify-refactor-guard.sh —— corum-agent 架构拆分（2026-09-21 轮）的机器守卫
#
# ## 为什么需要它
#
# 本轮把 `agent-service.ts`（2877 行）里的 6/7/8 三簇抽成独立模块。这些簇**本来就在
# 测试盲区里**（全仓 278 个测试没有一个真的构造该服务跑这些方法），于是「测试绿」在
# 本轮**连参考价值都有限**。上场已经付过一次学费：
#
# > `findLaneAgent` 的 `return undefined` 被切掉后，**编译通过、测试全绿**
# > ——只有 `git diff` 对照 HEAD 才发现。
#
# `git diff` 是**人工**判据（每步都要看）。本脚本是它的**机器补充**：把「搬完不该发生的
# 事」写成断言，让它们在 CI / 收尾时自动响。
#
# ## 本脚本断言什么（4 组）
#
#   ① **RPC 面冻结**：28 个 `@Remote` 名字集合与 HEAD 完全一致（搬实现不动注册面）。
#      这是本轮「contract 与 UI 零改动」的机器证据。
#   ② **已知地雷不得复活**：`findLaneAgent` 的 `return undefined`、`agents.list` 的
#      「方法/可迭代属性」两形态兼容 —— 两条都是实机事故留下的修复。
#   ③ **状态表访问按阶段收敛**：每个状态表有一个「允许被 service 直访」的计数上限，
#      **只许降不许升**。降到位后会被要求「必须为 0」（见 EXPECTED_ABSENT）。
#   ④ **不得反向依赖**：抽出的模块不许 import `agent-service.ts`（只允许 type-only，
#      且必须在白名单里）——防止拆分变成循环依赖。
#
# ## 用法
#
#   ./scripts/verify-refactor-guard.sh                # 全量（验收用这一种）
#   ./scripts/verify-refactor-guard.sh --explain      # 附每组的判据说明
#   ./scripts/verify-refactor-guard.sh --baseline     # 打印当前实测计数（刷新阈值用）
#
# 退出码：0 = 全部通过；1 = 有断言失败。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/plugins/agent/corum-agent"
SERVICE="$PKG_DIR/src/agent-service.ts"

MODE="run"
case "${1:-}" in
  --explain) MODE="explain" ;;
  --baseline) MODE="baseline" ;;
  "") ;;
  *) echo "用法: $0 [--explain|--baseline]" >&2; exit 2 ;;
esac

FAILURES=0
CHECKS=0

pass() { CHECKS=$((CHECKS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
group() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ ! -f "$SERVICE" ]; then
  echo "找不到 $SERVICE —— 本脚本必须在 corum 仓库内运行。" >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 权威基线：28 个 RPC 名字（冻结，来自 2026-09-20 拆分开始前的 HEAD）
# ─────────────────────────────────────────────────────────────────────────────
RPC_NAMES_FROZEN="createAgent createAgentForType createTaskAgent deleteProfile getChildSessionProgress getEvents getImageCompatibility getPolishConfig getSessionEventsForType getSubagentSessionMeta getTaskSessionEvents getWorktreeLedger listAgents listModels listPermissionPresets listProfiles listSkills listTaskAgents polishConversation polishPrompt runPrompt runPromptForTask runPromptForType saveProfile selectTaskAgentProfile setPolishConfig translatePrompt verify"

# ─────────────────────────────────────────────────────────────────────────────
# 状态表直访预算（第 ③ 组）
#
# 语义：`agent-service.ts` 里 `this.<表>` 的**出现次数**上限（按出现次数、不按行数——
# `a.foo() ?? a.foo()` 写在一行里是两个写入者，`grep -c` 只会数成 1）。**只许降**。
# 「必须为 0」的表列在 EXPECTED_ABSENT：一旦某阶段搬完，把它从下面删掉、加到这里，
# 脚本就会在该表重新出现时立刻报错（防止搬运回退）。
#
# 刷新方式：`./scripts/verify-refactor-guard.sh --baseline`
# ─────────────────────────────────────────────────────────────────────────────
# 格式：每行 `表名 预算 用途说明`（用普通字符串而非关联数组——macOS 自带 bash 3.2
# **不支持 `declare -A`**，本仓脚本一律要能在系统 bash 下跑）。
STATE_BUDGET="\
agents 8 profileId → root Agent
typeAgents 5 泳道会话表
sessionLaneIndex 2 sessionId → 泳道归属
taskAgents 10 sessionId → task 会话
taskSelections 5 sessionId → 模型选择 ref
pendingPermissions 3 待兑现权限档位
conductor 6 指挥模式运行时
agentCreationsInFlight 3 在飞创建去重
agentCreationTimes 2 重建风暴记账
laneSetupHooks 2 泳道装配钩子"

# 已经收走的表：必须出现 **0** 次（格式同上，预算恒为 0）。
EXPECTED_ABSENT="\
subagentProgress 子会话进度折叠表（P1-b 收进 SubagentProgressTracker）
subagentRoles 委派角色（P1-b 收进 SubagentProgressTracker）
subagentParents 子会话父会话（P1-b 收进 SubagentProgressTracker）
notifiedInterrupted 中断广播去重（P1-b 收进 SubagentProgressTracker）"

# 允许 import agent-service.ts 的**包内其他模块**。格式：`文件名|理由`。
BACKREF_ALLOW="\
index.ts|插件入口：导出 CorumAgentService（这是它的公开面，不是反向依赖）
runtime.ts|AgentRuntime 注入服务类型 + 复用 simplifyEventData（跨关注点共享纯函数）
project-service.ts|复用 ensurePmProfile / PM_PROFILE_ID（builtin profile 播种）
project-data-service.ts|type-only 引用服务类型（能力接口，红线 3 的合法形态）"

# ─────────────────────────────────────────────────────────────────────────────
if [ "$MODE" = "baseline" ]; then
  printf '\033[1m当前实测计数（可直接粘贴进 STATE_BUDGET）\033[0m\n'
  while read -r table _rest; do
    [ -z "$table" ] && continue
    n=$(grep -o "this\.${table}\b" "$SERVICE" | wc -l | tr -d ' ')
    printf '  %s %s\n' "$table" "${n:-0}"
  done <<< "$STATE_BUDGET"
  exit 0
fi

if [ "$MODE" = "explain" ]; then
  cat <<'EOF'
判据说明
────────
① RPC 面冻结
   本轮的硬约束：实现搬走、`@Remote` 留在 CorumAgentService。若某次改动让 RPC 名字
   集合变了，UI 侧 `/api/corumAgent/*` 就断了——这是「零改动」承诺的机器证据。

② 已知地雷不得复活
   · findLaneAgent 的 `return undefined`：返回类型本是 `| undefined`，falling off the
     end 语义相同 ⇒ 删掉它编译过、测试全绿（上场实测）。
   · agents.list 的两形态兼容：官方 registry 上 `list` 是**方法**，按属性 for...of 会抛
     `function is not iterable`，曾被 try/catch 吞掉导致「隔离」徽标与 integrated 标记
     长期静默失效（2026-09-12）。兼容写法删掉即复活。

③ 状态表直访预算
   与上一轮「收成单一写入者」同源：每张表最终应归一个所有者模块持有，服务只经窄接口
   访问。预算是**收敛轨迹**——只许降。降到 0 的表移入 EXPECTED_ABSENT，永久钉死。

④ 不得反向依赖
   抽出的模块 import 回 agent-service 会把「按关注点拆分」变成循环依赖（本仓红线 1/3
   的同族风险：模块实例与可见性都会变）。
EOF
  exit 0
fi

printf '\033[1mcorum-agent 拆分守卫\033[0m  (%s)\n' "$(basename "$SERVICE")"

# ── ① RPC 面冻结 ────────────────────────────────────────────────────────────
group "① RPC 面冻结（28 个 @Remote 名字集合）"
ACTUAL_RPC="$(grep -o "@Remote('[a-zA-Z]*')" "$SERVICE" | sed "s/@Remote('//;s/')//" | sort | tr '\n' ' ' | sed 's/ $//')"
FROZEN_SORTED="$(printf '%s\n' $RPC_NAMES_FROZEN | sort | tr '\n' ' ' | sed 's/ $//')"
RPC_COUNT="$(printf '%s\n' $RPC_NAMES_FROZEN | wc -w | tr -d ' ')"
if [ "$ACTUAL_RPC" = "$FROZEN_SORTED" ]; then
  pass "@Remote 名字集合与冻结基线一致（${RPC_COUNT} 个）"
else
  fail "@Remote 名字集合与冻结基线不一致"
  info "冻结: $FROZEN_SORTED"
  info "实测: $ACTUAL_RPC"
  info "差集（实测多出/缺失）:"
  diff <(printf '%s\n' $FROZEN_SORTED | tr ' ' '\n') <(printf '%s\n' $ACTUAL_RPC | tr ' ' '\n') | sed 's/^/      /'
fi

# 若在 git 仓库内，再与 HEAD 对照（防「只改了基线忘了实现」）
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  HEAD_RPC="$(git -C "$REPO_ROOT" show HEAD:packages/plugins/agent/corum-agent/src/agent-service.ts 2>/dev/null \
    | grep -o "@Remote('[a-zA-Z]*')" | sed "s/@Remote('//;s/')//" | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ -n "$HEAD_RPC" ]; then
    if [ "$ACTUAL_RPC" = "$HEAD_RPC" ]; then
      pass "与 HEAD 的 @Remote 集合一致（本场未动 RPC 面）"
    else
      fail "与 HEAD 的 @Remote 集合不同（RPC 面被改动）"
      diff <(printf '%s\n' $HEAD_RPC | tr ' ' '\n') <(printf '%s\n' $ACTUAL_RPC | tr ' ' '\n') | sed 's/^/      /'
    fi
  else
    info "跳过 HEAD 对照（读不到 HEAD 版本的文件）"
  fi
fi

# ── ② 已知地雷不得复活 ───────────────────────────────────────────────────────
group "② 已知地雷不得复活"

# ② -a findLaneAgent 必须有显式 return undefined
LANE_BODY="$(awk '/private findLaneAgent\(/,/^  }$/' "$SERVICE")"
if printf '%s' "$LANE_BODY" | grep -q 'return undefined'; then
  pass "findLaneAgent 保留显式 return undefined（上场被误删过的那个）"
else
  fail "findLaneAgent 缺少 return undefined（返回类型是 | undefined，编译与测试都发现不了！）"
fi

# ② -b agents.list 两形态兼容（三处独立实现）。
#
# ⚠️ 按**文件分别**断言而不是算总数（2026-09-21）：本轮 P2 把 buildChangeSummary 搬进
# change-summary.ts 后，总数从 3 掉到 2、本组变红——**红得对**，但若图省事改成「总数 ≥ 2」
# 就废掉了这条判据。按文件断言既容忍搬家，又能指出**哪一处**丢了兼容。
# 三处各自的位置：agent-service 的 agentRunning / childWorktreeIsolation，change-summary 的反查父会话。
COMPAT_FILES="\
agent-service.ts|2|agentRunning + childWorktreeIsolation
change-summary.ts|1|buildChangeSummary 反查父会话"
while IFS='|' read -r file want why; do
  [ -z "$file" ] && continue
  f="$PKG_DIR/src/$file"
  if [ ! -f "$f" ]; then
    fail "agents.list 兼容检查：找不到 $file（搬家后请更新本清单，别删条目）"
    continue
  fi
  # ⚠️ 排除**注释行**：这几个模块的头注里会引用该兼容写法作为说明（实测就这样把 1 处
  # 数成 2 处）。数注释会让判据既可能假绿也可能假红——两边都不可接受。
  n1=$(grep -v '^\s*\*' "$f" | grep -v '^\s*//' | grep -o "typeof raw === 'function' ? raw() : raw" | wc -l | tr -d ' ')
  n2=$(grep -v '^\s*\*' "$f" | grep -v '^\s*//' | grep -o "typeof rawList === 'function' ? rawList() : rawList" | wc -l | tr -d ' ')
  got=$((n1 + n2))
  if [ "$got" -eq "$want" ]; then
    pass "agents.list 两形态兼容：$file 有 ${got} 处（${why}）"
  else
    fail "agents.list 两形态兼容：$file 应有 ${want} 处、实测 ${got}（${why}）"
    info "删掉兼容写法会让 by-property for...of 抛 function is not iterable，并被 try/catch 吞掉"
  fi
done <<< "$COMPAT_FILES"

# ② -c 服务取用纪律：可选服务必须走 ctx.get
if awk '/applySubagentModelForSession\(/,/^  \}$/' "$SERVICE" | grep -q "this\.ctx\.get('sessionProjections'"; then
  pass "applySubagentModelForSession 走 ctx.get('sessionProjections')（不走属性访问）"
else
  fail "applySubagentModelForSession 未走 ctx.get('sessionProjections')（未 inject 时属性访问会抛）"
fi

# ── ③ 状态表直访预算（只许降） ────────────────────────────────────────────────
group "③ 状态表直访预算（只许降不许升）"
while read -r table budget _rest; do
  [ -z "$table" ] && continue
  actual="$(grep -o "this\.${table}\b" "$SERVICE" | wc -l | tr -d ' ')"
  if [ "$actual" -le "$budget" ]; then
    pass "this.${table}: ${actual} ≤ 预算 ${budget}"
  else
    fail "this.${table}: ${actual} > 预算 ${budget}（拆分在回退，或该表又新增写入者）"
  fi
done <<< "$STATE_BUDGET"
# 已收走的表：必须为 0（EXPECTED_ABSENT 为空时本组自动跳过）
if [ -n "$EXPECTED_ABSENT" ]; then
  while read -r table _rest; do
    [ -z "$table" ] && continue
    actual="$(grep -o "this\.${table}\b" "$SERVICE" | wc -l | tr -d ' ')"
    if [ "$actual" -eq 0 ]; then
      pass "this.${table}: 已收走（0 次，钉死）"
    else
      fail "this.${table}: 应为 0 次，实测 ${actual}（已收走的状态表又回来了）"
    fi
  done <<< "$EXPECTED_ABSENT"
fi

# ── ④ 反面依赖 ──────────────────────────────────────────────────────────────
group "④ 抽出的模块不得反向依赖 agent-service"
BACKREF_BAD=0
while IFS= read -r file; do
  base="$(basename "$file")"
  [ "$base" = "agent-service.ts" ] && continue
  # 只看真正的 import 语句（注释里提到 agent-service.ts 是合法的——大量模块头注都提到）
  imports="$(grep -nE "^import .*'\./agent-service\.ts'" "$file" || true)"
  if [ -n "$imports" ]; then
    reason="$(printf '%s\n' "$BACKREF_ALLOW" | awk -F'|' -v b="$base" '$1 == b { print $2 }')"
    if [ -n "$reason" ]; then
      pass "$base 引用 agent-service（已白名单：${reason}）"
    else
      fail "$base 反向 import agent-service.ts，且不在白名单"
      printf '%s\n' "$imports" | sed 's/^/      /'
      BACKREF_BAD=$((BACKREF_BAD + 1))
    fi
  fi
done < <(find "$PKG_DIR/src" -maxdepth 1 -name '*.ts' -print | sort | uniq)
if [ "$BACKREF_BAD" -eq 0 ]; then
  pass "无未白名单的反向依赖"
fi

# ── ⑤ 进度观测（不算失败，只报数） ──────────────────────────────────────────
group "⑤ 拆分进度（观测值，不参与判定）"
SERVICE_LINES="$(wc -l < "$SERVICE" | tr -d ' ')"
printf '  agent-service.ts: %s 行（本轮起点 2877，目标 ≈750）\n' "$SERVICE_LINES"
printf '  已抽出模块:\n'
for m in permission-policy polish-service conductor-runtime profile-compiler lane-registry \
         child-progress subagent-progress change-summary agent-registry task-lane; do
  f="$PKG_DIR/src/$m.ts"
  if [ -f "$f" ]; then
    printf '    ✓ %-24s %5s 行\n' "$m.ts" "$(wc -l < "$f" | tr -d ' ')"
  else
    printf '    · %-24s (未抽)\n' "$m.ts"
  fi
done

# ── 汇总 ────────────────────────────────────────────────────────────────────
# ── ⑥ 断言计数器自检（防「判据跑了但计数被 subshell 吞掉」） ────────────────
# 这条不是洁癖：本脚本第一版把状态表循环写成 `printf … | while read`，循环体在**子 shell**
# 里跑 ⇒ pass/fail 的计数全部丢失，于是「超预算」这类失败**悄悄不报**（实测踩到）。
if [ "$CHECKS" -lt 10 ]; then
  fail "断言计数器只记录了 ${CHECKS} 项（< 10）—— 有判据被 subshell 吞掉，本脚本的结论不可信"
fi

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32m全部通过\033[0m（%s 项断言）\n' "$CHECKS"
  exit 0
fi
printf '\033[31m%s / %s 项断言失败\033[0m\n' "$FAILURES" "$CHECKS"
exit 1
