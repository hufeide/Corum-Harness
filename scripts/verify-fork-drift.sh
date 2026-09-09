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
    corum/worktree-ledger)
      grep -rqF "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-orchestration/src" 2>/dev/null \
        && pass "${ev}：corum-orchestration 有 emit" \
        || fail "${ev}：corum-orchestration 无 emit"
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

# ── 汇总 ───────────────────────────────────────────────────────────────────
printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'fork drift 校验失败：%d 项\n' "$failures"
  exit 1
fi
printf 'fork drift 校验通过（跳过 %d 项）\n' "$skips"
