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
AGENT_CONTRACT="$REPO_ROOT/packages/plugins/agent/corum-agent/src/contract/agent.ts"
AGENT_SERVICE="$REPO_ROOT/packages/plugins/agent/corum-agent/src/agent-service.ts"

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
    corum/subagent/child)
      # spawn 精确父子映射（2026-09-09）：emit 在 fork #10 工具包的 corumEmitChildStarted。
      grep -rqF "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-tool-subagent/src" 2>/dev/null \
        && pass "${ev}：corum-tool-subagent 有 emit" \
        || fail "${ev}：corum-tool-subagent 无 emit"
      ;;
    corum/worktree-ledger)
      grep -rqF "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-orchestration/src" 2>/dev/null \
        && pass "${ev}：corum-orchestration 有 emit" \
        || fail "${ev}：corum-orchestration 无 emit"
      ;;
    corum/subagent/interrupted)
      # 「半途失去运行」在**发现点**（读进度 RPC 时判出）补发的一次性广播（2026-09-13）。
      grep -rqF "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-agent/src" 2>/dev/null \
        && pass "${ev}：corum-agent 有 emit" \
        || fail "${ev}：corum-agent 无 emit"
      ;;
    corum/artgen/*)
      grep -rqF "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-artgen/src" 2>/dev/null \
        && pass "${ev}：corum-artgen 有 emit" \
        || fail "${ev}：corum-artgen 无 emit"
      ;;
    corum/ollama/*)
      grep -rqF "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-ollama/src" 2>/dev/null \
        && pass "${ev}：corum-ollama 有 emit" \
        || fail "${ev}：corum-ollama 无 emit"
      ;;
    *)
      skip "${ev}：无 emit 面映射（新增事件请在脚本里登记归属）"
      ;;
  esac
done

# ── 5. fork 定制面不得被官方整文件覆盖（静默还原检测）──────────────────────
# 背景：2026-09-07 的 0.1.3 合并（commit f09aa05b）把
# corum-ui-chat/chat/TurnNavigator.module.css 整文件拷成官方版，把「左 gutter
# 8×8 圆点刻度」（设计稿 vESwF）静默还原成官方右侧横线刻度——typecheck/build
# 全绿、console 零错误，直到 2026-09-09 用户看 UI 才发现。
# 纪律：官方文件里凡带 corum 定制，合并时只能逐处三方合并，禁止整文件覆盖。
# 本节把这条纪律变成可执行断言；新增 fork 定制面时把文件登记进下面两张表。
section "[5] fork 定制面：不得与官方逐字节一致（静默覆盖检测）"

# (1) 必须与官方「有差异」的定制文件。格式：corum 相对路径::官方相对路径
MUST_DIFFER=(
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnNavigator.module.css::packages/client/ui-chat/src/client/chat/TurnNavigator.module.css"
  "packages/plugins/session/corum-ui-chat/src/client/chat/MessageItem.tsx::packages/client/ui-chat/src/client/chat/MessageItem.tsx"
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnTailNodeView.tsx::packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx"
  "packages/plugins/session/corum-ui-chat/src/client/chat/ChatNodeSeat.tsx::packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx"
  "packages/plugins/session/corum-ui-conversation/src/client/skeleton/InputBar.tsx::packages/client/ui-conversation/src/client/skeleton/InputBar.tsx"
  "packages/plugins/session/corum-ui-conversation/src/client/skeleton/ConversationRoot.tsx::packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx"
  "packages/plugins/session/corum-ui-conversation/src/client/apply.ts::packages/client/ui-conversation/src/client/apply.ts"
  "packages/plugins/session/corum-ui-approval/src/client/ApprovalPanel.tsx::packages/client/ui-approval/src/client/ApprovalPanel.tsx"
)
for entry in "${MUST_DIFFER[@]}"; do
  corum_rel="${entry%%::*}"
  off_rel="${entry##*::}"
  if [ ! -f "$REPO_ROOT/$corum_rel" ]; then
    fail "${corum_rel} 不存在（台账登记了定制，文件却没了）"
  elif [ ! -f "$DSH_CHECKOUT/$off_rel" ]; then
    skip "${corum_rel}：官方检出缺 ${off_rel}（官方改名？需人工核对台账）"
  elif cmp -s "$REPO_ROOT/$corum_rel" "$DSH_CHECKOUT/$off_rel"; then
    fail "${corum_rel} 与官方逐字节一致——corum 定制疑似被官方整文件覆盖（还原成原生了）"
  else
    pass "${corum_rel} 保留 corum 定制（与官方有差异）"
  fi
done

# (2) 必须含定制实现标记的文件（比 (1) 更强：防止只留注释、实现被覆盖）。
#     格式：相对路径::标记字面量（file 内 grep -F 命中即通过）
MUST_CONTAIN=(
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnNavigator.module.css::left: calc(12px - (var(--dsh-composer-side-clearance) + 16px))"
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnNavigator.module.css::border-radius: 50%;"
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnNavigator.module.css::background: var(--dsw-alias-brand-primary);"
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnNavigator.module.css::left: calc(100% + 10px);"
  # 设计稿 tbtn-voice：2026-09-09 曾被 commit 523e7aca 整块换成官方 <ContextMeter/>（用户报障）。
  "packages/plugins/session/corum-ui-conversation/src/client/skeleton/InputBar.tsx::aria-label=\"语音输入\""
  # .tbtn 必须显式 padding: 0（否则吃 UA 的 button padding 1px 6px，26 宽剩 14px，图标被压扁）。
  "packages/plugins/session/corum-ui-conversation/src/client/skeleton/InputBar.module.css::必须显式归零"
  # 提示词润色唯一入口 = 输入区右上角 sparkle（2026-09-09 去重：toolbar 里那个 Wand2 已删）。
  "packages/plugins/session/corum-ui-conversation/src/client/skeleton/InputBar.tsx::polishDraft"
  "packages/plugins/session/corum-ui-conversation/src/client/contract/slots.ts::polishDraft?: (sessionId: string, text: string) => Promise<string>"
)
for entry in "${MUST_CONTAIN[@]}"; do
  corum_rel="${entry%%::*}"
  marker="${entry##*::}"
  if [ ! -f "$REPO_ROOT/$corum_rel" ]; then
    fail "${corum_rel} 不存在（标记检查：${marker}）"
  elif grep -qF -- "$marker" "$REPO_ROOT/$corum_rel"; then
    pass "$(basename "$corum_rel") 含定制标记：${marker}"
  else
    fail "$(basename "$corum_rel") 缺定制标记「${marker}」——定制被覆盖或写法被改写"
  fi
done

# ── 6. inline-css 标记卫生（防「样式注入到错误标签 / 静默跳过注入」）────────
# 背景：corum-ide-plugin-manager-ui 的 scripts/inline-css.mjs 是从 explorer 包
# 拷贝的——id 写死成 `@corum/corum-ide-explorer-ui`，幂等判定用泛
# `client.includes('data-plugin')`；而该包源码里有 `data-plugin-manager-overlay`
# 属性，于是每次构建都误判「已注入」并删掉 lib/style.css → 插件中心面板长期
# 无样式（position:static、无圆角无底色），2026-09-09 CDP 实测才发现。
# 断言：① 禁用泛 'data-plugin' 判定；② 写死的 id 必须等于本包名（推荐从
# package.json 读，见 corum-ui-conversation / corum-ui-trajectory 的写法）。
section "[6] inline-css 标记卫生（id 归属 + 幂等判定）"
while IFS= read -r script; do
  pkg_dir="$(dirname "$(dirname "$script")")"
  pkg_name=$(node -e "try{console.log(require('$pkg_dir/package.json').name)}catch(e){console.log('?')}" 2>/dev/null)
  # 只看代码行：注释里出现该字符串（说明为什么禁止）不算违规。
  if grep -n "includes('data-plugin')" "$script" | grep -vE '^[0-9]+:[[:space:]]*(\*|//)' > /dev/null; then
    fail "$(echo "$script" | sed "s|$REPO_ROOT/||") 用泛 'data-plugin' 做幂等判定（业务源码含该字符串会误判，导致跳过注入）"
  fi
  hardcoded=$(grep -oE 'data-plugin="@[^"]*"' "$script" | head -1 | sed 's/data-plugin="//; s/"//')
  if [ -n "$hardcoded" ] && [ "$hardcoded" != "$pkg_name" ]; then
    fail "$(echo "$script" | sed "s|$REPO_ROOT/||") 写死的 id「${hardcoded}」≠ 本包名「${pkg_name}」（样式会注入到别人的标签下）"
  elif [ -n "$hardcoded" ]; then
    pass "$(basename "$pkg_dir") inline-css id 与包名一致"
  else
    pass "$(basename "$pkg_dir") inline-css 从 package.json 读 id"
  fi
done < <(find "$REPO_ROOT/packages" -path '*/scripts/inline-css.mjs' -not -path '*/node_modules/*' | sort)

# ── 7. 只写标准 backdrop-filter（-webkit- 别名在 Chromium 150 已被移除）────
# 背景：源码同时写两条时构建压缩只保留后一条（惯例是 -webkit- 在后），而
# Electron 43 / Chromium 150 的 CSS.supports('-webkit-backdrop-filter') === false
# → 全仓「液态玻璃」模糊静默失效（2026-09-09 清理 42 处后加此断言）。
section "[7] corum CSS 不含 -webkit-backdrop-filter 声明"
wb_hits=$(grep -rn --include='*.css' -e '^[[:space:]]*-webkit-backdrop-filter' \
  "$REPO_ROOT/packages/plugins" "$REPO_ROOT/packages/desktop/src" 2>/dev/null \
  | grep -v '/node_modules/' | grep -v '/lib/' | grep -v '/build/' | grep -v '/dist/')
if [ -n "$wb_hits" ]; then
  printf '%s\n' "$wb_hits" | while IFS= read -r line; do
    fail "含 -webkit-backdrop-filter 声明：$(echo "$line" | sed "s|$REPO_ROOT/||")"
  done
  failures=$((failures + $(printf '%s\n' "$wb_hits" | wc -l | tr -d ' ')))
else
  pass "源码 CSS 无 -webkit-backdrop-filter 声明（Chromium 150 已不支持该别名）"
fi

# ── 8. 客户端插件必须挂在某个组合里（防「挂载只存在于未提交的工作树」）──────
# 背景：@corum/corum-ollama / @corum/corum-artgen 的挂载（cordis.patch.yml 的
# insert 行 + desktop package.json 依赖）当时只写在**未提交的工作树**里，0.1.3
# 基座升级期间工作树被重置 → 两个插件的设置页一起消失（2026-09-09 用户报障）。
# 断言：凡带 dsh.client 的包，必须①出现在某个挂载点，②是 desktop 的 workspace
# 依赖（否则 host 解析不到包）。有意不挂的包登记在 ALLOW_UNMOUNTED 并写清原因。
section "[8] 客户端插件挂载点覆盖（dsh.client → 挂载行 + desktop 依赖）"
MOUNT_FILES=(
  "$REPO_ROOT/packages/desktop/cordis.patch.yml"
  "$REPO_ROOT/packages/desktop/cordis.ide.patch.yml"
  "$REPO_ROOT/cordis.patch.yml"
  "$REPO_ROOT/packages/desktop/src/electron/combos.ts"
)
# 有意不挂载（新增请写清原因，别默默放进来）
ALLOW_UNMOUNTED=(
  "@corum/corum-ide-test-conversation-ui"  # 测试插件：仅按需手工挂载
  "@corum/corum-ide-test-sidebar-ui"       # 同上
  "@corum/corum-ide-test-statusbar-ui"     # 同上
)
desktop_deps=$(node -e "console.log(Object.keys(require('$REPO_ROOT/packages/desktop/package.json').dependencies||{}).join('\n'))" 2>/dev/null)
for pkg_json in "$REPO_ROOT"/packages/plugins/*/*/package.json; do
  [ -f "$pkg_json" ] || continue
  pkg_name=$(node -e "try{const p=require('$pkg_json');console.log(p.dsh&&p.dsh.client?p.name:'')}catch(e){console.log('')}" 2>/dev/null)
  [ -z "$pkg_name" ] && continue
  allowed=''
  for a in "${ALLOW_UNMOUNTED[@]}"; do [ "$pkg_name" = "$a" ] && allowed='yes'; done
  if [ -n "$allowed" ]; then
    skip "${pkg_name} 有意不挂载（allowlist）"
    continue
  fi
  mount_hit=''
  for f in "${MOUNT_FILES[@]}"; do
    [ -f "$f" ] || continue
    if grep -qF "$pkg_name" "$f"; then mount_hit="$f"; break; fi
  done
  if [ -z "$mount_hit" ]; then
    fail "${pkg_name} 有 dsh.client 但没有任何挂载点——插件不会加载（设置页/功能整体消失）"
    continue
  fi
  if printf '%s\n' "$desktop_deps" | grep -qxF "$pkg_name"; then
    pass "${pkg_name} 已挂载（$(basename "$mount_hit")）+ desktop 依赖"
  else
    fail "${pkg_name} 挂在 $(basename "$mount_hit") 但不在 packages/desktop/package.json 依赖里——host 解析不到包（pnpm install 后仍 404）"
  fi
done

# ── 9. corumAgent 契约方法 ↔ 宿主 @Remote 实现（防「声明了但没实现」）────────
# 背景：AI 润色的 5 个方法（getPolishConfig/setPolishConfig/polishPrompt/
# polishConversation/translatePrompt）契约、配置存储、客户端按钮都在，宿主端
# 实现在基座升级重置未提交工作树时丢失 → 点按钮 404（2026-09-09，PROGRESS 第 50/51 轮）。
# 断言：contract/agent.ts 的 CORUM_AGENT_METHODS 里每个方法，agent-service.ts 必须有
# 对应的 `@Remote('<method>')`。
section "[9] corumAgent 契约方法 ↔ 宿主 @Remote 实现"
if [ ! -f "$AGENT_CONTRACT" ] || [ ! -f "$AGENT_SERVICE" ]; then
  skip "找不到 contract/agent.ts 或 agent-service.ts"
else
  methods=$(grep -oE "^  [a-zA-Z]+: '[a-zA-Z]+'," "$AGENT_CONTRACT" | sed "s/.*: '//; s/',//" | sort -u)
  if [ -z "$methods" ]; then
    fail "contract/agent.ts 未解析到 CORUM_AGENT_METHODS（正则失配？）"
  else
    for method in $methods; do
      if grep -qF "@Remote('$method')" "$AGENT_SERVICE"; then
        pass "corumAgent/$method 有宿主实现"
      else
        fail "corumAgent/$method 在契约里声明了，但 agent-service.ts 没有 @Remote 实现（调用必 404）"
      fi
    done
  fi
fi

# ── 10. 目录型 provider 的 discoverModels 兜底（防「换个入口又弹 NO_DISCOVERY」）──
# 背景：官方 llm-deepseek 不注册 model discovery，discoverModels 必抛 NO_DISCOVERY；
# corum 模型页把它当硬错误显示 → 正式包「添加 DeepSeek 供应商」直接失败（2026-09-09，
# PROGRESS 第 56 轮）。修复抽成 catalog-fallback.ts，但**四处调用点**必须都接兜底——
# 只修用户报的那一处，下次换入口（添加模型/连通性测试）还会撞。
# 断言：client 下每个调用 discoverModels 的文件都必须 import 兜底模块。
section "[10] 目录型 provider 的 discoverModels 兜底（catalog-fallback）"
MODELS_CLIENT="$REPO_ROOT/packages/plugins/session/corum-ui-settings-models/src/client"
if [ ! -d "$MODELS_CLIENT" ]; then
  skip "找不到 corum-ui-settings-models/src/client"
elif [ ! -f "$MODELS_CLIENT/catalog-fallback.ts" ]; then
  fail "缺少 catalog-fallback.ts（目录型 provider 的 NO_DISCOVERY 兜底单一事实源）"
else
  call_sites=$(grep -l 'discoverModels(' "$MODELS_CLIENT"/*.ts "$MODELS_CLIENT"/*.tsx 2>/dev/null | grep -v 'catalog-fallback.ts' || true)
  if [ -z "$call_sites" ]; then
    fail "未找到任何 discoverModels 调用点（正则失配？）"
  else
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      if grep -q "from './catalog-fallback.ts'" "$file"; then
        pass "$(basename "$file") 接了 catalog 兜底"
      else
        fail "$(basename "$file") 调 discoverModels 但没接 catalog 兜底——NO_DISCOVERY 会当错误弹给用户"
      fi
    done <<< "$call_sites"
  fi
fi

# ── 11. 模型选择单一 owner（防「用户换模型被吞」回归）──────────────────────
# 背景：官方 installModelSelection 的 agent/request 监听用安装时的选择覆盖结果，且
# waterfall 先注册的是外层——corum 在 create setup 里装自己的 ref 会让官方
# session/selectModel 永远失效（2026-09-09 用户实测，PROGRESS 第 57 轮）。
# 断言：agent-service.ts 只用 corum 的 installTaskModelSelection，不得再出现官方
# 包里的 installModelSelection 调用。
section "[11] 模型选择单一 owner（corum-agent 用 installTaskModelSelection）"
if [ ! -f "$AGENT_SERVICE" ]; then
  skip "找不到 agent-service.ts"
else
  if grep -q "installTaskModelSelection(" "$AGENT_SERVICE"; then
    pass "agent-service.ts 使用 installTaskModelSelection"
  else
    fail "agent-service.ts 未使用 installTaskModelSelection——模型选择会退回被官方 ref 覆盖的老毛病"
  fi
  if grep -qE "^import \{[^}]*installModelSelection[^}]*\} from '@deepseek-ai/dsh-agent'" "$AGENT_SERVICE"; then
    fail "agent-service.ts 仍导入官方 installModelSelection（同一机制两个 owner，用户换模型会被吞）"
  else
    pass "未导入官方 installModelSelection"
  fi
fi

# ── 12. GPU 合成不得被无条件关闭（防「设置页卡成 7 FPS」回归）──────────────
# 背景：main.ts 曾无条件 appendSwitch('disable-gpu')，而 corum 的玻璃皮肤到处是
# backdrop-filter：设置面板打开时整屏 mask blur(8px) + 面板 blur(16px) 每帧重算，
# 串流对话下实测从 44 FPS 掉到 7 FPS（2026-09-09 用户报障，PROGRESS 第 58 轮）。
# 断言：禁用 GPU 必须走 CORUM_DISABLE_GPU 显式开关（默认开启 GPU）。
section "[12] GPU 合成默认开启（CORUM_DISABLE_GPU 显式回退）"
DESKTOP_MAIN="$REPO_ROOT/packages/desktop/src/electron/main.ts"
if [ ! -f "$DESKTOP_MAIN" ]; then
  skip "找不到 packages/desktop/src/electron/main.ts"
else
  if grep -qE "^  app\.commandLine\.appendSwitch\('disable-gpu'\)" "$DESKTOP_MAIN"; then
    fail "main.ts 仍无条件 appendSwitch('disable-gpu')——玻璃 UI 会退回软件光栅，设置页打开即掉帧"
  else
    pass "未无条件禁用 GPU"
  fi
  if grep -q "CORUM_DISABLE_GPU" "$DESKTOP_MAIN"; then
    pass "保留 CORUM_DISABLE_GPU 显式回退开关"
  else
    fail "缺少 CORUM_DISABLE_GPU 回退开关（需要软件渲染时无路可走）"
  fi
fi

# ── 13. 打包闭包版本一致性（防「混版闭包」回归）────────────────────────────
# 背景：pnpm deploy --legacy 忽略 lockfile 重新解析，`^0.1.3-alpha.1` 漂到 registry 上的
# alpha.2 → 正式包闭包 131 个 dsh 包是 alpha.2、session 核心是 alpha.1，冷读历史日志报
# 「events is not iterable」（2026-09-09，PROGRESS 第 58 轮）。修复：pnpm-workspace.yaml
# 逐个钉死（pnpm 11 的 override 不支持 glob，实测通配无效）+ pack 时硬断言。
section "[13] 打包闭包版本一致性（pnpm overrides 逐个钉 + pack 时断言）"
WORKSPACE_YAML="$REPO_ROOT/pnpm-workspace.yaml"
PACK_SCRIPT="$REPO_ROOT/packages/desktop/scripts/pack-macos.mjs"
if [ ! -f "$WORKSPACE_YAML" ]; then
  skip "找不到 pnpm-workspace.yaml"
else
  if grep -q "'@deepseek-ai/dsh-\*'" "$WORKSPACE_YAML"; then
    fail "pnpm-workspace.yaml 里用了 glob override '@deepseek-ai/dsh-*'——pnpm 11 不支持，实测无效（会静默漂版）"
  else
    pass "overrides 未使用无效的 glob 写法"
  fi
  pinned=$(grep -c "^  '@deepseek-ai/dsh-.*': '0.1.3-alpha.1'$" "$WORKSPACE_YAML" || true)
  if [ "$pinned" -ge 150 ]; then
    pass "逐个钉定 $pinned 个 dsh 包到 0.1.3-alpha.1"
  else
    fail "只钉了 $pinned 个 dsh 包（预期 ≥150）——deploy 会重新解析出 alpha.2"
  fi
fi
if [ -f "$PACK_SCRIPT" ] && grep -q "assertUniformDshVersions" "$PACK_SCRIPT"; then
  pass "pack-macos.mjs 含闭包版本一致性硬断言"
else
  fail "pack-macos.mjs 缺少闭包版本一致性断言（混版闭包会静默打进 .app）"
fi

# ── 14. host 子进程不得变成孤儿（防「模型选择失败 / 历史打不开」回归）──────────
# 背景：before-quit 只 app.exit(0) 不杀子进程，子进程 stdin EOF 后又被 webserver
# 句柄吊着 → 每次退出留一个孤儿 host，攥着 session.lock；下一代启动读不到那些会话
# （2026-09-09 用户报「模型选择失败」，PROGRESS 第 60 轮）。三条断言：父进程退出杀
# 子进程、子进程 stdin EOF 自杀、启动时回收上一代孤儿。
section "[14] host 子进程生命周期（防孤儿）"
BRIDGE_SRC="$REPO_ROOT/packages/desktop/src/host/bridge.ts"
if [ ! -f "$BRIDGE_SRC" ]; then
  skip "找不到 packages/desktop/src/host/bridge.ts"
else
  if grep -q "parent gone (stdin EOF)" "$BRIDGE_SRC"; then
    pass "bridge.ts 在父进程 stdin EOF 时主动退出"
  else
    fail "bridge.ts 缺 stdin EOF 自杀路径——父进程崩溃/被强杀时会留下孤儿 host"
  fi
  if grep -q "reapStaleHost" "$BRIDGE_SRC"; then
    pass "bridge.ts 启动时回收上一代孤儿 host"
  else
    fail "bridge.ts 缺 reapStaleHost——老版本留下的孤儿会一直攥着 session.lock"
  fi
  if grep -q "watchParent" "$BRIDGE_SRC" && grep -q "CORUM_PARENT_PID" "$BRIDGE_SRC"; then
    pass "bridge.ts 有父进程探活看门狗（stdin EOF 会被继承的写端吞掉）"
  else
    fail "bridge.ts 缺父进程探活看门狗——打包版 kill -9 主进程后 host 会变孤儿"
  fi
fi
if [ -f "$DESKTOP_MAIN" ]; then
  if grep -q "bridge?.dispose()" "$DESKTOP_MAIN"; then
    pass "main.ts before-quit 显式杀掉 host 子进程"
  else
    fail "main.ts before-quit 未调用 bridge?.dispose()——每次退出都会留下孤儿 host"
  fi
else
  skip "找不到 packages/desktop/src/electron/main.ts"
fi

# ── 15. 沙箱 fork：git 元数据可写根（隔离子 Agent 能不能提交）──────────────
# 背景（2026-09-09 用户实机复现）：官方 sandbox-local 的可写根 = workspaceRoot +
# /tmp + tmpdir；隔离 worktree 的 git 状态在主仓 .git（在 workspace 之外）→
# `git add` 报 index.lock: Operation not permitted，子 Agent 永远提交不了。
# 断言：① index.ts 与官方逐字节一致（增量只能在 profiles/git-write-roots）；
#       ② profiles.ts 确实含并集标记；③ git 探测模块在位；④ 装配面完整
#       （禁官方行 + 挂 fork 行 + desktop 依赖）。
section "[15] 沙箱 fork（@corum/corum-sandbox-local）：git 元数据可写根"
SANDBOX_FORK="$REPO_ROOT/packages/plugins/agent/corum-sandbox-local"
OFFICIAL_SANDBOX_LOCAL="$DSH_CHECKOUT/packages/sandbox/sandbox-local"
if [ -f "$OFFICIAL_SANDBOX_LOCAL/src/index.ts" ]; then
  if cmp -s "$SANDBOX_FORK/src/index.ts" "$OFFICIAL_SANDBOX_LOCAL/src/index.ts"; then
    pass "src/index.ts 与官方逐字节一致"
  else
    fail "src/index.ts 与官方有差异——增量必须只在 profiles.ts / git-write-roots.ts（否则每次升级三方合并面扩大）"
  fi
else
  skip "官方检出缺 packages/sandbox/sandbox-local/src/index.ts（跳过逐字节断言）"
fi
if grep -qF 'corumGitWriteRoots' "$SANDBOX_FORK/src/profiles.ts"; then
  pass "profiles.ts 三个平台 builder 都并集 git 元数据可写根"
else
  fail "profiles.ts 未接 corumGitWriteRoots——隔离子 Agent 的 git 提交会退回 EPERM"
fi
if grep -qF -- "--git-common-dir" "$SANDBOX_FORK/src/git-write-roots.ts"; then
  pass "git-write-roots.ts 用 git rev-parse 探测 gitdir + common dir"
else
  fail "git-write-roots.ts 缺 git rev-parse 探测（拿不到主仓 .git）"
fi
if grep -qE '^- id: sandbox$' "$REPO_ROOT/packages/desktop/cordis.patch.yml" && grep -qE "name: '@corum/corum-sandbox-local'" "$REPO_ROOT/packages/desktop/cordis.patch.yml"; then
  pass "desktop patch 禁官方 sandbox 行 + 挂 fork 行"
else
  fail "desktop patch 缺「禁官方 sandbox 行 + 挂 fork 行」——fork 不会生效"
fi
if grep -qF '"@corum/corum-sandbox-local"' "$REPO_ROOT/packages/desktop/package.json"; then
  pass "desktop package.json 已链 fork 包"
else
  fail "desktop package.json 未链 @corum/corum-sandbox-local——打包闭包缺包"
fi
if grep -qF '"@corum/corum-sandbox-local"' "$REPO_ROOT/packages/desktop/desktop-host/package.json"; then
  pass "desktop-host deploy 清单已含 fork 包（打包闭包）"
else
  fail "desktop-host/package.json 缺 @corum/corum-sandbox-local——正式包 host 闭包会缺包（本轮教训：新插件必须同时进 desktop 与 desktop-host 依赖）"
fi

# ── 16. fork #9（subagent seam）增量必须「opt-in」────────────────────────────
# 用户 2026-09-09 提问：官方 preset（standard/ptc/cordis）仍挂官方 dsh-tool-subagent，
# 而服务层已被 fork #9 取代——两者会不会行为不一致？答案取决于 fork #9 的增量是否
# **只在调用方显式传 cwd 时生效**（官方工具从不传 cwd）。本节把这条不变量机器化：
#   ① 官方 src 的每个文件，除下表登记的文件外必须逐字节一致；
#   ② 登记文件必须确实有差异（防静默回退成官方）；
#   ③ cwd 缺省路径必须仍是「继承父会话 cwd」（官方语义）；
#   ④ 两个入口（one-shot start / continuable）都必须做 assertChildCwd。
section "[16] fork #9（corum-subagent）：增量 opt-in（官方 preset 行为等价）"
SUBAGENT_FORK="$REPO_ROOT/packages/plugins/agent/corum-subagent"
OFFICIAL_SUBAGENT="$DSH_CHECKOUT/packages/subagent/subagent"
# 允许有差异的文件（全部围绕 cwd 透传；invariant 是模板改名）
SUBAGENT_DELTA_FILES="types.ts child-agent.ts continuation.ts depth.ts index.ts invariant.ts"
if [ -d "$OFFICIAL_SUBAGENT/src" ]; then
  drift=0
  for official_file in "$OFFICIAL_SUBAGENT"/src/*.ts; do
    base="$(basename "$official_file")"
    fork_file="$SUBAGENT_FORK/src/$base"
    if [ ! -f "$fork_file" ]; then
      fail "fork #9 缺官方文件 src/$base"
      drift=1
      continue
    fi
    case " $SUBAGENT_DELTA_FILES " in
      *" $base "*)
        if cmp -s "$official_file" "$fork_file"; then
          fail "src/$base 与官方逐字节一致——登记为增量文件却无差异（cwd 透传被静默回退？）"
          drift=1
        fi
        ;;
      *)
        if ! cmp -s "$official_file" "$fork_file"; then
          fail "src/$base 与官方有差异——未登记的增量（opt-in 不变量被破坏，官方 preset 行为可能偏移）"
          drift=1
        fi
        ;;
    esac
  done
  [ "$drift" = 0 ] && pass "官方 src 文件：登记文件有差异、其余逐字节一致"
  for extra in "$SUBAGENT_FORK"/src/*.ts; do
    base="$(basename "$extra")"
    [ -f "$OFFICIAL_SUBAGENT/src/$base" ] || fail "fork #9 新增 src/$base 未登记（请同步本节台账与 fork-delta §10）"
  done
else
  skip "官方检出缺 packages/subagent/subagent/src（跳过 fork #9 逐字节断言）"
fi
if grep -qF 'cwd ?? parentHeader.cwd' "$SUBAGENT_FORK/src/child-agent.ts"; then
  pass "cwd 缺省仍继承父会话 cwd（官方语义）"
else
  fail "child-agent.ts 的 cwd 缺省路径被改——官方工具不传 cwd，会偏离官方行为"
fi
if grep -qF 'assertChildCwd(request.cwd)' "$SUBAGENT_FORK/src/index.ts" && grep -qF 'assertChildCwd(request.cwd)' "$SUBAGENT_FORK/src/continuation.ts"; then
  pass "两个入口（start / continuable）都做 cwd 校验"
else
  fail "缺 assertChildCwd 入口（one-shot 或 continuable 之一漏校验）"
fi

# ── 17. 官方 preset 本地副本（shipped-presets/official）──────────────────────
# 用户 2026-09-09 拍板「给官方换上」：官方四模式（standard/ptc/cordis/minimal）
# 也必须走 corum 编排（并发感知隔离 / 模型锁 / settlement notice / orchestrate），
# 因此本仓 `shipped-presets/official/` 是官方 preset 的**本地副本**，standard/
# ptc/cordis/conductor 的 subagent 行被替换为 @corum/corum-tool-subagent **三实例**
# （worker + research + fork）；官方 workflow/ralph 恢复挂载但子 Agent 走 corum provider
# （2026-09-10 用户要求「三个工具按 corum 机制改造，保证官方能力被包含」）。
# 三条静默失效路径必须机器化守住：
#   ① `agent-presets` 服务把**包内置** `presets/` 根无条件排在最前，本仓副本会被
#      遮蔽 → 运行时毫无变化（2026-09-09 实机踩过）。故 boot.ts 必须带
#      `includeShippedRoot: false`；
#   ② 官方升级后本地副本与新版官方漂移（新行/改行没跟）→ 本节断言「官方行 id
#      一个不少、新增行在登记表内」；
#   ③ 恢复的三个官方能力必须走 corum provider（fork → corum-fork、workflow/ralph →
#      corum-spawn），否则子 Agent 绕过 fork #9 的 cwd 透传（台账说隔离、实际没隔离）。
section "[17] 官方 preset 本地副本：corum 编排替换 + 官方能力经 corum provider 恢复"
VENDORED_PRESETS="$REPO_ROOT/packages/desktop/shipped-presets/official"
OFFICIAL_PRESETS="$DSH_CHECKOUT/packages/preset/agent-presets/presets"
# 本仓副本允许出现的「官方没有的行」（新增 corum 实例）。
PRESET_EXTRA_ROWS="tool-subagent-research"
# 恢复挂载的官方能力行（必须启用且走 corum provider）。workflow **工具行** 2026-09-10
# 起在四个 preset 一律 disabled（设计语义并入 orchestrate 的 script 模式，引擎保留）；
# 引擎行（workflow-worker-thread）与 ralph 仍恢复挂载。
PRESET_RESTORED_ROWS="tool-subagent-fork workflow-worker-thread tool-ralph"
if [ -f "$REPO_ROOT/packages/desktop/src/host/boot.ts" ]; then
  if grep -qE '^[[:space:]]*includeShippedRoot: false,?[[:space:]]*$' "$REPO_ROOT/packages/desktop/src/host/boot.ts"; then
    pass "boot.ts 关闭包内置 preset 根（否则 shipped-presets/official 被遮蔽、改动无效）"
  else
    fail "boot.ts 缺 includeShippedRoot: false——本仓 official 副本会被包内置版本静默遮蔽"
  fi
else
  fail "缺 packages/desktop/src/host/boot.ts（无法校验 preset 根注入）"
fi
if grep -qF "join(DESKTOP_ROOT, 'shipped-presets', 'official')" "$REPO_ROOT/packages/desktop/scripts/pack-macos.mjs" \
  && grep -qF 'SHIPPED_PRESETS_DIR' "$REPO_ROOT/packages/desktop/scripts/pack-macos.mjs"; then
  pass "pack-macos.mjs 把本仓 official 副本物化进打包闭包"
else
  fail "pack-macos.mjs 未物化 shipped-presets/official——正式包会退回包内置 preset"
fi
# 退役行是否显式 disabled（读该行到下一个 `- id:` 之间的内容）。
row_disabled() {
  awk -v id="$2" '
    $0 ~ ("^[[:space:]]*- id: " id "[[:space:]]*$") { hit=1; next }
    hit && $0 ~ /^[[:space:]]*- id: / { exit }
    hit && /disabled: true/ { found=1 }
    END { exit found ? 0 : 1 }
  ' "$1"
}
# 行 id 列表（顺序保留）。
preset_row_ids() { grep -oE '^[[:space:]]*- id: [A-Za-z0-9._-]+' "$1" | sed -E 's/.*- id: //'; }
if [ -d "$VENDORED_PRESETS" ]; then
  # conductor（指挥模式）与 standard 共用同一份 corum 编排替换，但语义不同：
  # 主 Agent 的执行工具由 corum-agent 运行时裁剪（agent scope），preset 工具面
  # 必须与 standard 完全一致（否则子 Agent 也失去执行工具）。下面额外断言二者
  # 行面逐字节一致 + 代码常量与目录/显示名对账。
  CONDUCTOR_SRC="$REPO_ROOT/packages/plugins/agent/corum-agent/src/conductor.ts"
  if [ -f "$CONDUCTOR_SRC" ] && grep -qF "CONDUCTOR_PRESET_ID = 'conductor'" "$CONDUCTOR_SRC"; then
    pass "指挥模式常量 CONDUCTOR_PRESET_ID = 'conductor'"
  else
    fail "conductor.ts 缺 CONDUCTOR_PRESET_ID = 'conductor'（指挥模式判定失效）"
  fi
  # 指挥模式是三处联动：preset 目录 / corum profile 的 baseMode / UI 下拉。任一处漏改
  # 都会让「继承指挥模式」静默失效（profile 编译出普通工具面、或编辑器里选不到）。
  PROFILE_SRC="$REPO_ROOT/packages/plugins/agent/corum-agent/src/profile.ts"
  BUILTIN_SRC="$REPO_ROOT/packages/plugins/agent/corum-agent/src/builtin-profiles.ts"
  UI_PRESET_SRC="$REPO_ROOT/packages/plugins/ui/corum-ide-ui/src/client/settings/sections/SettingsAgentPresetsSection.tsx"
  if grep -qE "^export type BaseMode = .*'conductor'" "$PROFILE_SRC"; then
    pass "BaseMode 含 'conductor'（corum 角色可继承指挥模式）"
  else
    fail "profile.ts 的 BaseMode 缺 'conductor'——corum 角色无法继承指挥模式"
  fi
  if grep -qF "id: 'conductor-lead'" "$BUILTIN_SRC" && grep -qF "baseMode: 'conductor'" "$BUILTIN_SRC"; then
    pass "内置角色「指挥者」（conductor-lead）继承指挥模式"
  else
    fail "builtin-profiles.ts 缺 conductor-lead 角色或未用 baseMode: 'conductor'"
  fi
  # 全能/通用助手（2026-09-10 用户需求「岗位要有全能/通用助手，不能只限于编程」）：
  # 岗位 + 新增「通用」维度必须在后端联合类型、后端校验、UI 下拉三处同步。
  if grep -qF "id: 'general-assistant'" "$BUILTIN_SRC" && grep -qF "dimension: '通用'" "$BUILTIN_SRC"; then
    pass "内置岗位「全能助手」（general-assistant，通用维度）存在"
  else
    fail "builtin-profiles.ts 缺 general-assistant 岗位或未用 dimension: '通用'"
  fi
  if grep -qE "^export type AgentDimension = .*'通用'" "$PROFILE_SRC" \
    && grep -qE "v === '通用'" "$PROFILE_SRC" \
    && grep -qE "AGENT_DIMENSIONS = \[[^]]*'通用'" "$UI_PRESET_SRC"; then
    pass "「通用」维度在后端类型/校验/UI 下拉三处同步"
  else
    fail "「通用」维度三处未同步（AgentDimension / isValidAgentDimension / AGENT_DIMENSIONS）"
  fi
  # 只读搜索子 Agent 的指引必须与 orchestrate 可见性解耦（2026-09-10 用户需求
  # 「每个 Agent 都配备了 search Agent，所有模式都应该提到这一点」）。
  SUBAGENT_TOOL_SRC="$REPO_ROOT/packages/plugins/agent/corum-tool-subagent/src/index.ts"
  if grep -qF 'hasResearch' "$SUBAGENT_TOOL_SRC" \
    && grep -qF 'ANY read-only work' "$SUBAGENT_TOOL_SRC" \
    && grep -qF 'subagent_research' "$SUBAGENT_TOOL_SRC"; then
    pass "只读搜索子 Agent 指引与 orchestrate 可见性解耦（所有带 worker 的模式都会提到）"
  else
    fail "机制段缺「只读搜索子 Agent」指引或仍绑在 orchestrate 可见性上"
  fi
  if grep -qF "'deepseek-orchestrator'" "$BUILTIN_SRC"; then
    if grep -qF "RETIRED_BUILTIN_ROLE_IDS" "$BUILTIN_SRC"; then
      pass "旧「Deepseek 编排者」已退役（仅在 RETIRED_BUILTIN_ROLE_IDS 里作清理项）"
    else
      fail "builtin-profiles.ts 仍以内置角色形式保留 deepseek-orchestrator（应改为退役清理项）"
    fi
  else
    fail "builtin-profiles.ts 缺 RETIRED_BUILTIN_ROLE_IDS 的退役项（升级用户的家目录副本不会被清理）"
  fi
  if grep -qF "id: 'conductor', label: BASE_MODE_LABELS.conductor" "$UI_PRESET_SRC"; then
    pass "Agent 预设编辑器的基础模式下拉含指挥模式"
  else
    fail "SettingsAgentPresetsSection 的基础模式下拉缺 conductor——用户无法在编辑器里选指挥模式"
  fi
  if [ -f "$VENDORED_PRESETS/conductor/agent.cordis.yml" ] && [ -f "$VENDORED_PRESETS/standard/agent.cordis.yml" ]; then
    if [ "$(sed -n '/^- id: /,$p' "$VENDORED_PRESETS/conductor/agent.cordis.yml")"       = "$(sed -n '/^- id: /,$p' "$VENDORED_PRESETS/standard/agent.cordis.yml")" ]; then
      pass "指挥模式工具面与标准模式逐行一致（裁剪只在运行时 agent scope）"
    else
      fail "指挥模式 agent.cordis.yml 行面与标准模式不一致——preset 裁行会连子 Agent 一起裁掉"
    fi
    if grep -qF 'name: 指挥模式' "$VENDORED_PRESETS/conductor/preset.yml" \
      && grep -qF "CONDUCTOR_MODE_LABEL = '指挥模式'" "$CONDUCTOR_SRC"; then
      pass "指挥模式显示名（preset.yml ↔ 代码常量）一致"
    else
      fail "指挥模式显示名漂移（preset.yml name 与 CONDUCTOR_MODE_LABEL 必须同为「指挥模式」）"
    fi
  else
    fail "缺 shipped-presets/official/conductor（指挥模式基准 preset）"
  fi
  for preset in standard ptc cordis minimal conductor; do
    vendored="$VENDORED_PRESETS/$preset/agent.cordis.yml"
    if [ ! -f "$vendored" ]; then
      fail "shipped-presets/official/$preset/agent.cordis.yml 缺失"
      continue
    fi
    if [ "$preset" = "minimal" ]; then
      # minimal 不做 corum 替换（双工具极简面，无编排语义）——必须与官方逐字节一致。
      if [ -f "$OFFICIAL_PRESETS/minimal/agent.cordis.yml" ]; then
        if cmp -s "$vendored" "$OFFICIAL_PRESETS/minimal/agent.cordis.yml"; then
          pass "minimal 副本与官方逐字节一致（未替换，无编排面）"
        else
          fail "minimal 副本与官方有差异——本仓未计划替换 minimal，请同步或登记为替换 preset"
        fi
      else
        skip "官方检出缺 minimal preset（跳过逐字节断言）"
      fi
      continue
    fi
    # ① corum 编排替换：三实例（worker + research + fork）+ provider + 只读研究实例。
    if [ "$(grep -cF "name: '@corum/corum-tool-subagent'" "$vendored")" -eq 3 ]; then
      pass "${preset}：corum 三实例（worker + research + fork）指向 @corum/corum-tool-subagent"
    else
      fail "${preset}：corum subagent 实例数不是 3（worker + research + fork）"
    fi
    grep -qF 'provider: corum-spawn' "$vendored" \
      && pass "${preset}：provider corum-spawn" \
      || fail "${preset}：缺 provider: corum-spawn（子 Agent 会走官方 spawn provider，无 corum 机制）"
    grep -qF 'readonlyResearch: true' "$vendored" \
      && pass "${preset}：research 只读实例已挂" \
      || fail "${preset}：缺 readonlyResearch: true（subagent_research 只读语义丢失）"
    # ② 官方 subagent 工具行不得仍处于启用态（按行块判定：同一 `- id:` 块内
    #    `name: '@deepseek-ai/dsh-tool-subagent'` 必须伴随 disabled: true）。
    if awk '
      /^[[:space:]]*- id: / { if (index(blk, OFFICIAL_SUBAGENT_ROW) > 0 && index(blk, "disabled: true") == 0) bad=1; blk="" }
      { blk = blk $0 "\n" }
      END { if (index(blk, OFFICIAL_SUBAGENT_ROW) > 0 && index(blk, "disabled: true") == 0) bad=1; exit bad ? 0 : 1 }
    ' OFFICIAL_SUBAGENT_ROW="name: '@deepseek-ai/dsh-tool-subagent'" "$vendored"; then
      fail "${preset}：官方 subagent 工具行仍启用（与 corum 工具重复，提示词/机制双份）"
    else
      pass "${preset}：官方 subagent 工具行已退役（disabled 或改挂 corum 实例）"
    fi
    # ③ 恢复挂载的官方能力行必须启用且走 corum provider（2026-09-10）。
    for restored in $PRESET_RESTORED_ROWS; do
      if ! grep -qE "^[[:space:]]*- id: $restored[[:space:]]*$" "$vendored"; then
        fail "${preset}：恢复行 $restored 消失（官方能力被丢掉）"
      elif row_disabled "$vendored" "$restored"; then
        fail "${preset}：恢复行 $restored 仍是 disabled: true"
      fi
    done
    if ! row_disabled "$vendored" tool-subagent-fork && ! grep -qF 'provider: corum-fork' "$vendored"; then
      fail "${preset}：subagent_fork 未走 corum-fork provider（子会话会绕过 fork #9 的 cwd 透传）"
    fi
    if ! row_disabled "$vendored" workflow-worker-thread && ! grep -qF 'provider: corum-spawn' "$vendored"; then
      fail "${preset}：workflow 引擎未走 corum-spawn provider"
    fi
    if ! row_disabled "$vendored" tool-ralph && ! grep -qF 'subagentProvider: corum-tracked' "$vendored"; then
      fail "${preset}：ralph 未走 corum-tracked provider（子 Agent 不计数）"
    fi
    # workflow 工具行：四个 preset 一律 disabled（语义并入 orchestrate script 模式）；
    # 引擎行必须保留启用，否则 orchestrate script 模式与 ralph 都没有引擎。
    if row_disabled "$vendored" tool-workflow; then
      pass "${preset}：tool-workflow 已退役（语义并入 orchestrate script 模式）"
    else
      fail "${preset}：tool-workflow 仍启用——模型面出现第二个自撰编排语言"
    fi
    if row_disabled "$vendored" workflow-worker-thread; then
      fail "${preset}：workflow 引擎行被禁用——orchestrate script 模式/ralph 失去引擎"
    fi
    # codex / claude-code 保持官方默认（provider 未安装）。
    for optional in tool-subagent-codex tool-subagent-claude-code; do
      if grep -qE "^[[:space:]]*- id: $optional[[:space:]]*$" "$vendored" && ! row_disabled "$vendored" "$optional"; then
        fail "${preset}：可选 provider 行 $optional 被启用（官方默认 disabled）"
      fi
    done
    # ④ 官方行 id 一个不少（升级漂移检测）+ 新增行在登记表内。
    if [ -f "$OFFICIAL_PRESETS/$preset/agent.cordis.yml" ]; then
      missing=0
      while IFS= read -r official_id; do
        grep -qE "^[[:space:]]*- id: $official_id[[:space:]]*$" "$vendored" || { missing=1; fail "${preset}：官方行 $official_id 在本地副本中消失（升级漂移）"; }
      done < <(preset_row_ids "$OFFICIAL_PRESETS/$preset/agent.cordis.yml")
      [ "$missing" = 0 ] && pass "${preset}：官方行 id 全部保留"
      extra=0
      while IFS= read -r vendored_id; do
        grep -qE "^[[:space:]]*- id: $vendored_id[[:space:]]*$" "$OFFICIAL_PRESETS/$preset/agent.cordis.yml" && continue
        case " $PRESET_EXTRA_ROWS " in
          *" $vendored_id "*) ;;
          *) extra=1; fail "${preset}：新增行 $vendored_id 未登记（请同步本节 PRESET_EXTRA_ROWS 与 fork-delta §4.1）" ;;
        esac
      done < <(preset_row_ids "$vendored")
      [ "$extra" = 0 ] && pass "${preset}：新增行均在登记表内"
    else
      skip "官方检出缺 $preset preset（跳过行 id 对账）"
    fi
  done
  # ⑥ fork #9 的 corum fork provider：官方语义（completed-turn seed）保留，driver 换成
  # corum 的（cwd 透传），provider 名不与官方 'fork' 抢名；host patch 必须挂它。
  CORUM_FORK_PROVIDER="$REPO_ROOT/packages/plugins/agent/corum-subagent/src/fork/index.ts"
  if [ -f "$CORUM_FORK_PROVIDER" ] \
    && grep -qF "providerName: z.string().default('corum-fork')" "$CORUM_FORK_PROVIDER" \
    && grep -qF "from '../driver/index.ts'" "$CORUM_FORK_PROVIDER" \
    && grep -qF 'completedTurnPrefix' "$CORUM_FORK_PROVIDER" \
    && grep -qF 'inheritsParentContext = true' "$CORUM_FORK_PROVIDER"; then
    pass "corum fork provider：官方 seed 语义 + corum driver（cwd 透传）"
  else
    fail "corum-subagent/src/fork/index.ts 缺 corum-fork provider 或偏离官方语义"
  fi
  if grep -qF "name: '@corum/corum-subagent/fork'" "$REPO_ROOT/packages/desktop/cordis.patch.yml"; then
    pass "host patch 挂载 @corum/corum-subagent/fork"
  else
    fail "desktop/cordis.patch.yml 未挂载 corum-fork provider"
  fi
  # ⑦ isolated provider（workflow 语义并入 orchestrate 的隔离机制）：provider 文件保留
  # worktree/台账/通知三件事，host patch 必须挂它，orchestrate 必须按 run 指定它。
  CORUM_ISOLATED_PROVIDER="$REPO_ROOT/packages/plugins/agent/corum-subagent/src/isolated/index.ts"
  if [ -f "$CORUM_ISOLATED_PROVIDER" ] \
    && grep -qF "providerName: z.string().default('corum-isolated')" "$CORUM_ISOLATED_PROVIDER" \
    && grep -qF 'createWorktreeChild' "$CORUM_ISOLATED_PROVIDER" \
    && grep -qF 'bindRunId' "$CORUM_ISOLATED_PROVIDER" \
    && grep -qF 'discardEntry' "$CORUM_ISOLATED_PROVIDER" \
    && grep -qF '[corum isolation]' "$CORUM_ISOLATED_PROVIDER"; then
    pass "corum isolated provider：worktree + 台账绑定 + 失败回滚 + 隔离通知"
  else
    fail "corum-subagent/src/isolated/index.ts 缺隔离三件事（worktree/绑定/回滚）或通知文本"
  fi
  if grep -qF "name: '@corum/corum-subagent/isolated'" "$REPO_ROOT/packages/desktop/cordis.patch.yml"; then
    pass "host patch 挂载 @corum/corum-subagent/isolated"
  else
    fail "desktop/cordis.patch.yml 未挂载 corum-isolated provider"
  fi
  # tracked provider（ralph 纳入并发计数）：同一 provider 的 track 模式行必须存在，
  # 且实现里保留「计数 + 直连纪律 + 幂等注销」三件事。
  if grep -qF "providerName: corum-tracked" "$REPO_ROOT/packages/desktop/cordis.patch.yml" \
    && grep -qF "mode: track" "$REPO_ROOT/packages/desktop/cordis.patch.yml"; then
    pass "host patch 挂载 corum-tracked provider（mode: track）"
  else
    fail "desktop/cordis.patch.yml 缺 corum-tracked provider 行"
  fi
  if grep -qF 'export function prepareTrackedChild' "$CORUM_ISOLATED_PROVIDER" \
    && grep -qF 'beginWriteChild' "$CORUM_ISOLATED_PROVIDER" \
    && grep -qF 'endWriteChild' "$CORUM_ISOLATED_PROVIDER" \
    && grep -qF 'corumDirectWriteNotice' "$CORUM_ISOLATED_PROVIDER"; then
    pass "track 模式：登记/注销在跑写子 Agent + 注入直连纪律"
  else
    fail "isolated provider 缺 track 模式（计数 + 直连纪律）"
  fi
  if grep -qF "subagentProvider: scriptProvider" "$SUBAGENT_TOOL_SRC" \
    && grep -qF "isolate === 'off' ? 'corum-spawn' : 'corum-isolated'" "$SUBAGENT_TOOL_SRC" \
    && grep -qF "runtimeCtx.get('workflowEngine'" "$SUBAGENT_TOOL_SRC"; then
    pass "orchestrate script 模式：引擎 + 按 isolate 选 provider（默认隔离）"
  else
    fail "orchestrate 缺 script 模式接线（引擎/隔离 provider 选择）"
  fi
  # ⑤ 改名残留（mode: code）目录不得存在——它会与 mode 枚举冲突、挂载即失败。
  for stale in "$VENDORED_PRESETS"/*/; do
    [ -d "$stale" ] || continue
    case "$(basename "$stale")" in
      standard|ptc|cordis|minimal|conductor) ;;
      *) fail "shipped-presets/official/$(basename "$stale") 不是官方 preset id（改名残留会让 agent-presets 挂载失败）" ;;
    esac
  done
else
  fail "缺 packages/desktop/shipped-presets/official——官方 preset 的 corum 编排替换不存在"
fi

# ── 18. 技能打包副本与仓库脚本一致（2026-09-12 用户定调）────────────────────
# 用户定调：**脚本和 skill 原文打包进 CORUM_HOME 的技能路径**，技能要自带全套脚本
# （隔离 worktree 里的子 Agent 也要能用）。仓库 `scripts/*` 是源，技能里的 `scripts/*`
# 是打包副本——两处漂移就等于「技能里那份是旧的」，而这类失效在实机上极难发现。
section "[18] corum-cdp-verify 技能：打包副本 == 仓库脚本（逐字节）"
SKILL_DIR="${CORUM_HOME:-$REPO_ROOT/packages/desktop/.corum-dev-home}/skills/corum-cdp-verify"
if [ -d "$SKILL_DIR/scripts" ]; then
  SKILL_ASSETS="cdp.mjs cdp.sh rpc-helper.js ui-verify.mjs verify-instance.sh app-launch-guard.sh"
  skill_bad=0
  for asset in $SKILL_ASSETS; do
    if [ ! -f "$REPO_ROOT/scripts/$asset" ]; then
      fail "仓库缺 scripts/$asset（技能打包的源）"
      skill_bad=1
      continue
    fi
    if [ ! -f "$SKILL_DIR/scripts/$asset" ]; then
      fail "技能缺 scripts/$asset —— 打包：cp scripts/$asset \"$SKILL_DIR/scripts/\""
      skill_bad=1
      continue
    fi
    if ! cmp -s "$REPO_ROOT/scripts/$asset" "$SKILL_DIR/scripts/$asset"; then
      fail "技能副本 scripts/$asset 与仓库不一致 —— 同步：cp scripts/$asset \"$SKILL_DIR/scripts/\""
      skill_bad=1
    fi
  done
  [ "$skill_bad" = "0" ] && pass "6 个验证脚本：技能副本与仓库逐字节一致（$SKILL_DIR/scripts）"
  [ -f "$SKILL_DIR/SKILL.md" ] && pass "技能自带 SKILL.md" || fail "技能缺 SKILL.md"
else
  skip "未安装 corum-cdp-verify 技能（$SKILL_DIR 不存在）——跳过打包副本对账"
fi

# ── 汇总 ───────────────────────────────────────────────────────────────────
printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'fork drift 校验失败：%d 项\n' "$failures"
  exit 1
fi
printf 'fork drift 校验通过（跳过 %d 项）\n' "$skips"
