# corum 会话域 fork 差异台账 + 升级 runbook

> 架构整改 **C4** 交付物。本文档把会话域 6 个 fork 包（fork 自官方 `@deepseek-ai/dsh-client-ui-*`）相对官方基线的**全部差异**登记成台账：逐文件分类（逐字节相同 / 仅 import 改名 / 实质修改 / corum 新增 / 官方有但 corum 删除）、每处实质差异的原因（从 `// fork（corum）：` / `CORUM-PATCH:` 注释与 git log 提取）、rebase 风险标注。官方版本升级时按第 5 节 runbook「按单执行」，不再考古。
>
> - 生成方式：`diff -r packages/plugins/session/<pkg>/src /Users/kukucai/dsh/packages/client/<官方包>/src` + 逐文件 diff 分类（脚本统计，非印象）。
> - 官方基线版本：`0.1.2-alpha.2`（`/Users/kukucai/dsh/packages/client/*/package.json` 的 `version`）。⚠️ corum 各 fork 的 `dependencies` 仍锁 `^0.1.2-alpha.1`——**源码对照的是 alpha.2、依赖锁 alpha.1，双向差一代**（审计 B 群 P1，见 §3.4）。
> - 参考：`.dbg/audit-B-session.md`（session 群逐文件审计）、`docs/audit/CODE-AUDIT-REPORT.md`（P0-6/11/12/13/15）。
> - 2026-09-07 增补：第 7 个 fork 包 `@corum/corum-credentials-local`（host 侧，fork 自官方 `@deepseek-ai/dsh-credentials-local`）登记于 **§7 host 域 fork**，升级时同样按 §5 runbook 处理。
> - 2026-09-07 增补：第 8 个 fork 包 `@corum/corum-api-remotes`（host+client 双面，fork 自官方 `@deepseek-ai/dsh-api-remotes`）登记于 **§8**，升级时同样按 §5 runbook 处理。
> - 2026-09-08 增补：子 Agent 召唤机制优化完整交付（fork #9 §10 / #10 §11 / #11 §12 + 全部 CDP 验证记录 §11.5-§11.11）。**交接文档：`docs/HANDOFF-subagent-isolation.md`**——下一个 session 先读它 + `docs/plan/PLAN-subagent-isolation.md`。
> - ⚠️ **方案 SUPERSEDED（2026-09-09）**：子 Agent 机制的**方案层面**已被
>   `docs/plan/PLAN-subagent-orchestration.md` 取代（fork #9 转正为完整 seam 服务 +
>   方案甲结构化编排；**双实例保留为两个 subagent 预设，orchestrate 是增强不取代**）。
>   **本章 §10/§11/§12 的文件台账与升级 runbook 仍有效**（fork
>   包升级仍按 §5 runbook 执行），但「provider-only 挂载」「fork #10 工具隔离层」
>   的架构形态不再作为实施基准。后续实施以新方案为准。
> - 2026-09-09 增补：第 12 个 fork 包 `@corum/corum-ui-trajectory`（client 侧，fork 自官方 `@deepseek-ai/dsh-client-ui-trajectory`）登记于 **§14**——轨迹视图注册点从 conversation.view 迁到 details 抽屉。
> - 2026-09-07 增补：**基线已升 `0.1.3-alpha.1`**（dsh 检出 `d347e70390`）——§9 登记本次 alpha.2→0.1.3-alpha.1 的**实测 rebase 全量结论**（已落地 commit + 三层 CDP 验证通过），后续升级仍以 §5 runbook 为纲、§9 为上一次实战参照。
> - ⚠️ **2026-09-09 回归修复（整文件覆盖事故）**：0.1.3 合并 commit `f09aa05b` 把
>   `corum-ui-chat/chat/TurnNavigator.module.css` **整文件拷成官方版**，把「左 gutter
>   8×8 圆点刻度」（设计稿 vESwF，commit `53b66a87`）静默还原成官方右侧横线刻度——
>   typecheck/build 全绿、console 零错误，**用户看 UI 才发现**（§4.2 此前未登记该
>   文件，故台账也没拦住）。已按「官方 0.1.3 结构 + 5 处 corum 增量」重新三方合并并
>   CDP 验证（左 gutter 圆点 + 当前点 brand + 预览卡右翻）。**纪律**：带 corum 定制的
>   文件禁止整文件覆盖，必须逐处合并；`scripts/verify-fork-drift.sh` 新增 §5
>   「定制面不得与官方逐字节一致 + 定制标记必须存在」断言（已负向测试）。

---

## 1. 总览表

> 统计口径：对每包 `src/` 与官方 `src/` 做 `diff -r` 后逐文件分类。「仅改名」= diff 行全部是把 `@deepseek-ai/dsh-client-ui-*` 改成 `@corum/corum-ui-*` 的 import 路径替换；「实质修改」= 存在任何其它 diff 行（含 CSS、locale、逻辑）。`invariant.ts` 在各包均属「实质修改」（包名+插件名改名），不重复列入下表明细。

| fork 包 | 官方对照包 | 官方基线 | 文件数(corum/官方) | 逐字节相同 | 仅改名 | 实质修改 | corum 新增 | 官方有但 corum 删 | rebase 风险 |
|---|---|---|---|---|---|---|---|---|---|
| corum-ui-conversation | ui-conversation | 0.1.2-alpha.2 | 67 / 65 | 45 | 0 | 20 | 2 | 0 | **高**（apply.ts 空态操作卡、ConversationRoot/EmptyHero/InputBar 重设计） |
| corum-ui-chat | ui-chat | 0.1.2-alpha.2 | 96 / 85 | 39 | 25 | 19 | 13 | 2 | **高**（ChatNodeSeat foldable、corum-reskin.css、TurnTail 重构、Review/Subagent 新增） |
| corum-ui-approval | ui-approval | 0.1.2-alpha.2 | 8 / 8 | 4 | 1 | 3 | 0 | 0 | **中**（ApprovalPanel 重设计 + lucide 依赖） |
| corum-ui-questions | ui-user-questions | 0.1.2-alpha.2 | 7 / 11 | 0 | 0 | 3 | 4 | 8 | **高**（渲染层整体重写，文件名全不同——按「新包替换」对待） |
| corum-ui-model-selection | ui-model-selection | 0.1.2-alpha.2 | 11 / 11 | 4 | 0 | 7 | 0 | 0 | **低**（教科书式最小 fork，仅 model-unavailable 语义 + 触发器文案） |
| corum-ui-settings-models | ui-settings-models | 0.1.2-alpha.2 | 24 / 25 | 10 | 0 | 10 | 12 | 1 | **中**（operations.ts 删除改直持 wire face；corum 自研模型页 12 个新文件，官方加回 operations 即冲突） |

合计：相同 103、仅改名 26、实质修改 65、新增 19、删除 11（`src/` 内文件；各包根 `index.ts`/`invariant.ts`/`css-modules.d.ts` 计入实质修改）。

**rebase 成本集中点**：实质修改的 65 个文件中，真正需要「三方合并」的高危文件约 20 个（见 §4 逐包详录的 🔴 标注）；其余是 locale 键增删、CSS 换肤变量替换这类机械合并。

---

## 2. 分类口径说明

| 分类 | 定义 | rebase 策略 |
|---|---|---|
| **逐字节相同** | `cmp -s` 一致（103 个） | 官方新版直接覆盖，零成本 |
| **仅 import 改名** | diff 行全部是 `@deepseek-ai/dsh-client-ui-*` → `@corum/corum-ui-*`（26 个） | 官方新版覆盖后机械替换包名（sed 一把梭） |
| **实质修改** | 有逻辑/文案/样式差异（65 个） | 逐处三方合并；🔴 标记的必冲突 |
| **corum 新增** | 官方没有的文件（19 个） | 官方升级不影响；注意其依赖的官方 API 是否变动 |
| **官方有但 corum 删** | corum 侧删除的文件（11 个） | 官方升级若改了这些文件，需确认 corum 是否仍要删（删除理由见详录） |

---

## 3. 跨包共性结论

### 3.1 会话域对 conversation 是 type-only 契约消费，与官方逐行对齐（不做抽包）

**实证（A3 整改项，主 Agent round 2）**：chat/approval/questions 对 `@corum/corum-ui-conversation` 的全部 import 都是 **type-only** 且来自 conversation 的 `contract/` 目录。本次台账复核（grep 全量 import）确认：

- chat 26 处 import，全部 `import type` 或 `import type {}`：`ConversationNodeDefinition`/`ConversationMatch`/`ConversationNodeContext`/`ConversationPromptSnapshot`/`KnownContextForm`/`MessageImageSource`/`ComposerChainProps` 等，全部来自 `corum-ui-conversation/client` 的 contract 导出。
- approval 1 处：`import type { ComposerChainProps }`（client/index.ts:5）。
- questions 1 处：`import type {} from '@corum/corum-ui-conversation/client'`（client/index.tsx:25，纯为拉入 SlotMap 模块合并声明让 `conversation.composer.dock` 槽过类型检查）。
- 官方对照**逐行相同**：官方 `ui-chat/conversation-nodes/tool.ts:3-4` 同样 `import type { ConversationMatch, ConversationNodeContext, ConversationNodeDefinition }` 自官方 ui-conversation。

**结论**：这是官方设计的「契约中心辐射」——feature 插件 type-only 消费 conversation 的 contract 类型，零实现层依赖。**不是需要解耦的问题，不做 contract 抽包**（抽包会让 corum 文件布局偏离官方，rebase 更痛，详见 §6）。

> ⚠️ 残留瑕疵（非契约问题，单列）：chat 的 `contract/slots.ts:128-131` 在 contract 层用 `import('../chat/review-source.ts').ReviewSource` inline import 了本包渲染层——契约反向依赖渲染层（审计 B 群 P1）。这是包内分层问题，与跨包契约无关。

### 3.2 核心数据通路与官方零漂移

chat 的 `conversation-nodes/` 15 个大文件（assistant/command/common/compaction/event-projection/fallback/inbox/message/request-prompt/retry/tool/turn-error/turn-max-tokens/turn-process/turn-tail + chat-snapshot-builder）全部**仅 import 改名**，逐行逻辑与官方一致；conversation 核心的 assembler/facade/location-index/machine **逐字节相同**；审批/提问 waterfall 生命周期逐行一致。fork 策略成立：定制集中在渲染层与空态。

### 3.3 新增 UI 系统性硬编码中文，绕过 locales 设施（审计 P1，已发现）

新增/重设计组件把产品文案硬编码为中文，不走 `t()`：`conversation/skeleton/EmptyStateHero.tsx`、`ConversationRoot.tsx`、`chat/MessageItem.tsx:182`（'You' + `toLocaleTimeString('zh-CN')` 时区硬编码）、`chat/AssistantMarkdown.tsx`（AgentHeader 'Corum Agent' + zh-CN）、`questions/QuestionCard.tsx`（注册了 `corum-question` 词典含全部键但 `t()` 一次未用，词典形同虚设）、`approval/ApprovalPanel.tsx:38,63,78-80`（'Corum Agent'/'始终允许'）。**rebase 注意**：官方 locale 键演进时 corum 的 `locales.ts` 差异里有相当一部分是「官方新增键 corum 未同步」（如 chat 的 `message.turnTime.*` 4 键、conversation 的 `access.preset.*` 3 键）——合并 locale 时要把官方新增键补回 corum 词典，而不是整文件覆盖。

### 3.4 依赖版本与源码基线错位（审计 B 群 P1）

全部 6 包 `dependencies` 把官方包从官方仓库的 `workspace:^` 改为 npm `^0.1.2-alpha.1`，且全部从 devDependencies 挪进 dependencies（官方规范：浏览器/类型关系只进 devDependencies）。而 fork 源码对照的是官方 `0.1.2-alpha.2`。**升级官方前必须先对齐这个错位**：要么依赖升 alpha.2，要么明确冻结在 alpha.1 基线重 diff。

### 3.5 官方错误码命名空间化是 alpha.1→alpha.2 的主要漂移

conversation 的 `service.ts:318`、`input/hub.ts:204`、`InputBar.tsx:95-97`、`image-labels.ts` 的 diff 全部是官方把裸错误码改为 `session/steer-unavailable`、`session/queue-item-not-found`、`session/attachment-invalid`、`subagent/attachment-unsupported`——corum 这 4 处仍停在 alpha.1 的裸码。**这是本次台账新确认的、审计未单独列出的 rebase 欠债**：corum 侧按裸码匹配，Host 端若已升 alpha.2 发带命名空间的码，这些匹配全部静默失效（附件错误不再显示友好文案、steer 冲突不再静默收敛）。升级 runbook 第 2 步必须优先核对此 4 处。

### 3.6 `invariant.ts` / 根 `index.ts` 为模板性修改

6 包 `invariant.ts` 均为包名（`@corum/*`）+ 插件名（`corum-ui-*-invariant`）改名的模板复制，rebase 时随包名机械处理。conversation/chat 根 `index.ts` 把官方 `import type {} from '@deepseek-ai/dsh-settings'` 改为值导入 `settingsNamespace` 并注册 `settingsNamespace(CONVERSATION_SETTINGS_NAMESPACE)`——官方 alpha.2 改为直接传命名空间字符串（settingsNamespace 调用已内联进官方），rebase 时向官方对齐（回退到官方写法）即可。

---

## 4. 逐包差异详录

> 每文件给「分类 + 差异点 + 原因 + rebase 风险」。🔴 = rebase 官方时必冲突或已确认的死代码/全局污染，需逐处人工三方合并；🟡 = 机械合并（locale 键、CSS 变量）；🟢 = 低危。

### 4.1 corum-ui-conversation（对照 ui-conversation）

相同 45 / 改名 0 / 实质 20 / 新增 2 / 删除 0。**rebase 风险：高**（骨架层是重设计主战场）。

**逐字节相同（45 个，直接覆盖）**：核心数据通路全在此列——`client/assembler/*`、`client/facade/*`、`client/location-index.ts`、`client/machine/*`、`client/contract/conversation.ts`、`request-inspection.ts`、`context-provenance.ts` 等 contract 三大件、`queue/*` 逻辑、`input/*` 大部分、`skeleton/` 其余组件。

**实质修改（20 个）**：

| 文件 | 差异点 | 原因（注释/git log） | 风险 |
|---|---|---|---|
| `client/apply.ts` | inject 去掉 `uiWorkspace` 加 `workspaces`；`workspaceNavigation` 改 `ctx.get` 可选获取+降级抛错（:105-107, :202-203）；新增 `emptyActions` 整块（:222-340，~119 行）含 pickDir/currentCwd/startTaskLane/listProjects/listAgents/listModels/listPermissions 等；新增 `makeCorumRpcCall`/`ConnectionHandle`/`setSidebarMode` import | `// fork（corum）：移除 'uiWorkspace'——kkc IDE 禁用官方 ui-workspace`（apply.ts:48-51）；空态操作卡是 2026-08-30 圆桌收敛产品需求 | 🔴 必冲突。官方 apply.ts 任何改动都要与此块三方合并。另 `ctx.get('connection')` 硬取未声明 inject（审计 P1，:222 注释自承「本插件的 inject 没有 connection」） |
| `client/contract/slots.ts` | 新增 `emptyActions` 槽类型 + `AgentOption`/`ModelProviderOption`/`PermissionOption`/`PermissionSelect`/`WorkspaceOption`/`NewTaskOptions` 六个导出接口（:221-308，~88 行） | 空态操作卡的契约面（2026-08-30 圆桌收敛） | 🔴 官方 contract/slots.ts 改动需与此增量合并；契约扩展方式正确（新增可选字段不改官方字段） |
| `client/skeleton/ConversationRoot.tsx` (+module.css 179 diff 行) | 重设计：HeroGlow 渲染位置、EmptyStateHero 接入、布局结构调整（260 diff 行） | corum 液态玻璃设计稿（git `e76f5a77`）；:12 有未使用 import HeroShell（审计 P1 死 import） | 🔴 重设计文件，官方改动逐处人工看 |
| `client/skeleton/EmptyHero.tsx` | 删官方 SMIL 游动鱼动画（HERO_SWIM_UP/DOWN_PATH 两大段 path），新增 `HeroGlow` 组件（figma 313:14109 蓝色光斑）；FishLogo 图标替换成 corum 版 | 设计稿替换（glow 由 owner ConversationRoot 渲染，注释 :64-97） | 🔴 |
| `client/skeleton/EmptyStateHero.tsx` + `.module.css` | **corum 新增**（465 行）：空态操作卡（最近项目/新建任务/新建项目表单） | 2026-08-30 圆桌收敛，产品需求 | 🟢 官方无此文件；注意其消费的 apply.ts emptyActions 与官方 contract 演进 |
| `client/skeleton/ConversationSession.tsx` | 删官方 titleRow 整块（ crumbs 面包屑 + lineage 槽 + headerActions，~58 行），保留 tabs+header | 注释 :86「标题行已移除（2026-08-29）：Agent 标题栏已显示会话标题，避免重复」 | 🔴 官方 header 演进（crumbs/lineage 槽）corum 全删，rebase 需确认是否仍全删 |
| `client/skeleton/InputBar.tsx` (+module.css 284 diff 行) | 新增 sparkle 提示词优化按钮（:430-450，aria-label 硬编码中文 + `console.log('优化提示词')` TODO 遗留）；toolbar 重排（tbtn-plus 26×26、PermissionSelect 常显）；**设计稿 tbtn-voice 语音按钮（26×26 r8 + mic 18×18 label-secondary，位置 = 模型选择 → 🎤 → 发送；design.pen 无 tbtn-context 节点）**；**提示词润色唯一入口 = 输入区右上角 sparkle**（`polishDraft` 经 `ComposerBarOwnerProps` 增量下发，2026-09-09 去重：ConversationRoot 的 Wand2 `.polishBtn` 已删）；附件错误码匹配停在 alpha.1 裸码 | 设计稿 qVHA8/htxWi（toolbar 顺序见 design.pen）；错误码见 §3.5 | 🔴（样式）+ 🟡（错误码 3 行）。⚠️ **回归史**：commit `523e7aca`「0.1.3 契约适配」把该按钮整块换成官方 `<ContextMeter/>`（上下文已用 % 环），2026-09-09 用户报障后按设计稿还原；上下文占用信息不受影响（状态栏详情 `AppFrame statusDetail` 另有归属）。`InputBar.module.css` 的 `.tbtn` 必须写 `padding: 0`（否则吃 UA 的 `button { padding: 1px 6px }`，26 宽剩 14px，图标被压扁） |
| `client/skeleton/PermissionSelect.tsx` (+css 3 行) | `permissionGlyphs` 对象改 Map；删官方 `BUILT_IN_PERMISSION_NAMES` locale 回退机制，改 `displayName(option.name)` + Full access 特判 | corum 把档位显示名交给官方配置名，不再内置英文艺名（locales.ts 同步删 `access.preset.*` 3 键） | 🟡 与 locales.ts 联动合并 |
| `client/locales.ts` | placeholder 文案改、删官方 `access.preset.readOnly/workspaceWrite/fullAccess` 3 键、`access.confirm.*` 文案改（'完全权限'→'Full access'） | 产品文案定调 | 🟡 |
| `client/input/hub.ts` | `steer-unavailable`→`session/steer-unavailable` 等错误码匹配（4 行注释+2 行代码） | 官方 alpha.2 命名空间化，corum 停在 alpha.1 | 🟡 见 §3.5，升 alpha.2 时向官方对齐 |
| `client/service.ts` | 同错误码 2 行（:318） | 同上 | 🟡 |
| `client/image-labels.ts` | 注释里错误码名 3 行 | 同上 | 🟡 |
| `client/skeleton/ContextMeter.module.css` / `TodoPanel.module.css` / `QueueDock.module.css` / `HeroShell.module.css` / `PermissionSelect.module.css` / `ConversationRoot.module.css` / `InputBar.module.css` | `background: var(--dsw-*)` → `var(--corum-glass-1/2)` + `backdrop-filter: blur(20px)` + `border: var(--corum-glass-border)` | `/* fork（corum 液态玻璃）*/`（git `e76f5a77` 全局换肤 14 张 module.css） | 🟡 机械换肤；官方改这些文件的布局/结构时需合并，纯变量替换可保留 corum 值 |
| `index.ts` | `import type {}` → 值导入 `settingsNamespace` + 注册调用 | 官方 alpha.2 已内联命名空间字符串 | 🟡 向官方对齐（回退官方写法） |
| `invariant.ts` | 包名/插件名改名 | 模板 | 🟢 |

### 4.2 corum-ui-chat（对照 ui-chat）

相同 39 / 改名 25 / 实质 19 / 新增 13 / 删除 2。**rebase 风险：高**（含全仓两个 P0：foldable=false + corum-reskin 全局污染）。

**仅 import 改名（25 个，官方覆盖后 sed 包名）**：`conversation-nodes/` 全部 16 个（assistant/chat-snapshot-builder/command/common/compaction/event-projection/fallback/inbox/message/request-prompt/retry/tool/turn-error/turn-max-tokens/turn-process/turn-tail）、`contract/chat-nodes.ts`、`contract/snapshot.ts`、`model/conversation-context.ts`、`chat/ContextBody.tsx` 等。注意 `contract/snapshot.ts:70` 的 `declare module '@corum/corum-ui-conversation/client'` 也是改名产物——sed 时连 declare module 字符串一起换。

**实质修改（20 个）**：

| 文件 | 差异点 | 原因 | 风险 |
|---|---|---|---|
| `chat/ChatNodeSeat.tsx` | :152-153 官方 `foldable = processWindowReady && (processMember \|\| ...)` 逻辑删，改 `const foldable = false` | 注释「工具调用不再折叠（2026-08-29）：foldable 恒为 false，工具调用始终展开显示」（git `0607a76b`）；但折叠 UI 全套代码（:155-224）保留成死路径（审计 P0-12） | 🔴 **必冲突**。官方动 ChatNodeSeat 折叠逻辑时 corum 是「删逻辑留死代码」，三方合并前应先按 P0-12 整改（连 TurnProcessNodeView 折叠分支一起删，或做成 ChatSettings 开关） |
| `client/corum-reskin.css` | **corum 新增**（58 行）：`[data-slot=...] button[class*="primary"]` 等全局选择器换肤 | 液态玻璃全局换肤（git `e76f5a77`）；审计 P0-13：全局 CSS 污染，命中其它插件 DOM、官方类名 hash 变即失效、注入无卸载 | 🔴 **rebase 前必须按 P0-13 整改**（可挂类名的收回各 .module.css）；否则官方任何 DOM/类名变动都可能静默失效或误伤 |
| `client/apply.ts` | import corum-reskin.css；新增 `reviewSources` WeakMap + `reviewSource()`（:85-100）；binding 取出改两行；slots 注入加 `review` + `getAgentName`（:134, :167-195，~29 行 RPC 手搓） | fork 重设计注释（:25-26）；getAgentName 2026-08-31 用户定调显示 nickname；`ctx.get('connection') as` 两处硬取未声明 inject（审计 P0/P1，:93,174） | 🔴 getAgentName 整块是 corum 独有 RPC 逻辑（listTaskAgents/listProfiles），官方 apply.ts 改动需绕开此块合并 |
| `client/contract/slots.ts` | 新增 `review: ReviewSource` + `getAgentName` 两槽字段（:128-131）；**用 `import('../chat/review-source.ts')` inline import 渲染层** | fork 注释 :128 | 🟡 字段增量合并；⚠️ contract 反向依赖渲染层（§3.1 残留瑕疵） |
| `chat/ChatView.tsx` (+css 39 行) | 新增 agentName state+effect（:210-217）、reviewChanges uSES + revertAll（:235-245）、`<AgentNameContext.Provider>` 包裹（:594,703）、ReviewCard 挂载块（:677-691）；`useSyncExternalStore` import；`t as unknown as` 双断言（:688） | Review 卡 + Agent 昵称（fork 注释 :235, :677） | 🔴 ReviewCard/AgentNameContext 挂载点与官方 ChatView 布局演进需人工合并 |
| `chat/TurnNavigator.module.css` | **官方 0.1.3 结构 + 5 处 corum 增量**（文件头注释逐条列出，全部带 `fork（corum）` 标记）：① `.frame` `left:` 取代 `right:`（贴左缘）② `.mark` `inset:0` 全宽 + `::before` 改 8×8 圆点（`border-radius:50%`，水平+垂直居中）③ `markPreview/markActive/focus-visible` 换 secondary/brand + glass 光晕 ④ `.preview` `left:calc(100%+10px)` 右翻 + 玻璃化 ⑤ `previewResponse` 色 label-tertiary + 入场动画方向取反 | 设计稿 vESwF「左 gutter 竖列圆点刻度」（commit `53b66a87`，用户定调）；0.1.3 合并时被整文件覆盖，2026-09-09 重新贴回（见文首回归修复条） | 🔴 **禁止整文件覆盖**（已发生一次静默还原）。官方 0.1.3 的 scroller/fades/固定间距/`markUnloaded`/`markBusy` 结构保留，只把上述 5 处增量贴回；`scripts/verify-fork-drift.sh` §5 已加断言守护 |
| `chat/AssistantMarkdown.tsx` (+css 27 行) | 新增 `AgentHeader` 组件（:13-26，硬编码 'Corum Agent' + `new Date().toLocaleTimeString('zh-CN')`）+ `showAgentHeader` prop（:130-131） | 设计稿 x1mv8q head；⚠️ 渲染期 `new Date()` 流式重渲时间每秒变（审计 P1） | 🟡 增量合并；时区硬编码入 §3.3 i18n 整改 |
| `chat/AssistantNodeView.tsx` | 新增 `showAgentHeader = data.step <= 1` 计算并下传（:29-32,42） | 注释「Agent 头只在 turn 的第一个 step 显示」 | 🟡 |
| `chat/MessageItem.tsx` (+css 40 行) | 删官方 `reveal: 'always'/'hover'` 可达性设计（:151,164-166, :281-293 官方 isLatestUserRow 逻辑全删）；新增 userHeader（'You' + zh-CN time，:181-185）+ `time` prop | 设计稿 riOKX h；⚠️ 删了官方「无 hover 设备最新行常显」可达性（审计 P1） | 🔴 官方 MessageItem 的 actions-reveal 机制被整块删除，官方在此文件的任何改进都与之冲突 |
| `chat/MessageIconActions.tsx` (+css 46 行) | 删官方 `usageAction` 槽（:137 官方）改回 props 直传 `runMs/ttftMs/tokensPerSecond` 并在时钟后拼接 `· Ran for / · TTFT / · tok/s`（:78-107）；format* 三个函数 import 自 message-chrome | TurnUsage 展示重构（配合 TurnTailNodeView 重构） | 🔴 与官方「usageAction 槽」方向相反，官方此文件必冲突 |
| `chat/TurnTailNodeView.tsx` (+css 7 行) | 用 corum `TurnUsageDisclosure` 替官方 `TurnUsagePanel/TurnTimePanel`；删官方 `isLatestTurn` reveal 逻辑；footer 结构重排 | 重设计（TurnUsageDisclosure 取代官方，审计 B「有意重设计」） | 🔴 |
| `chat/register-node-renderers.ts` | 新增 SubagentCard 槽注册（:10, :47-49） | fork 注释「子 Agent 进度卡」 | 🟡 |
| `conversation-nodes/register.ts` | 新增 `registerSubagentConversationNode(ctx)`（:11, :35-36） | 同上 | 🟡 |
| `client/index.ts` | 删官方两组 `export type ... from ui-conversation/client` re-export（:44-49） | 注释 :44「chat 对 conversation 仅 type-only 引用，不再把对方类型 re-export 为本包公共 API（全仓无人从本包 import 这些类型）」——A3 整改成果 | 🟡 官方若新增 re-export 键，corum 有意不收 |
| `client/locale.ts` | 新增 review.* 5 键 + subagent.* 4 键（zh+en）；turnUsage 键集改（summaryWithCache 替 consumed+cacheHit，删 total，加 ttft）；**未同步官方新增 `message.turnTime.*` 4 键** | review/subagent 新 UI 文案；turnUsage 重设计 | 🟡 合并时补官方 turnTime.* 键（§3.3） |
| `index.ts` / `invariant.ts` | settingsNamespace 注册 / 包名改名 | 同 conversation | 🟢/🟡 |

**corum 新增（13 个，官方升级不影响其存在，但其依赖的官方 API 变动要核对）**：
`chat/ReviewCard.tsx`(111) + `.module.css`、`chat/SubagentCard.tsx`(59) + `.module.css`、`chat/TurnUsageDisclosure.tsx`(86) + `.module.css`、`chat/agent-name-context.ts`(9)、`chat/review-changes.ts`(199)、`chat/review-revert.ts`(105)、`chat/review-source.ts`(82)、`conversation-nodes/subagent.ts`(201)、`contract/subagent.ts`(114)、`corum-reskin.css`(58)。已知问题（审计 B）：SubagentCard `running` 写死 true + correlateChild 只按时间猜子会话；review-source 订阅永不退订；review-changes/review-revert 统计口径误导（write 整文件计 added、skipped 判定致「全部撤销」永报失败）。

**官方有但 corum 删除（2 个）**：`chat/TurnUsagePanel.tsx`(235 行官方) + `.module.css`——被 TurnUsageDisclosure 有意取代。**rebase 核对**：官方若更新 TurnUsagePanel（alpha.2 已含 TurnTimePanel TTFT/TPS），corum 的 TurnUsageDisclosure 要人工决定跟不跟（目前 corum 版键集已落后，见 locale.ts 行）。

### 4.3 corum-ui-approval（对照 ui-approval）

相同 4 / 改名 1 / 实质 3 / 新增 0 / 删除 0。**rebase 风险：中**。

- `client/ApprovalPanel.tsx`（45 diff 行）🔴：重设计为 corum 审批卡——轮头（avatar+'Corum Agent' 硬编码+waiting tag，:35-40）、拆分按钮「允许一次 + ▾ 浮层 menu」（:53-82，menu 无 click-outside/Escape）、「始终允许」菜单项永久 disabled 死 UI（注释自承「会话级始终允许暂未接入」）；`import { ChevronDown } from 'lucide-react'` 替官方 ui-primitives Button（:3，审计 P2 图标体系并存）。原因：对齐 corum 审批卡设计（注释 :35）。
- `client/ApprovalPanel.module.css`（180 diff 行）🔴：审批卡整套样式重写。
- `client/index.ts` 🟢：仅 `ComposerChainProps` import 改名（1 行）。
- `invariant.ts` 🟢：模板改名。

数据通路（pendingInteractions/waterfall）与官方逐行一致——定制全在渲染层。

### 4.4 corum-ui-questions（对照 ui-user-questions）

相同 0 / 改名 0 / 实质 3 / 新增 4 / 删除 8。**rebase 风险：高——渲染层整体重写，文件名全不同，按「新包替换官方渲染层」对待，无法逐文件合并**。

- **corum 新增（4 个）**：`client/QuestionCard.tsx`(207) + `.module.css`、`client/contract.ts`(126，自实现 PendingQuestion 运行时类——官方 `./client` 只 `export type` 不导出运行时类，corum 无法 new，故同形复制 80 行结算生命周期，注释 :1-6；⚠️ 双事实源，官方修复不联动）、`client/index.tsx`(替官方 index.ts，dock 挂载 + PendingQuestion 注册 + composer block 拦截)。
- **官方有但 corum 删除（8 个）**：`QuestionComposer.tsx`(441) + css、`PlanReviewPanel.tsx`(87) + css、`draft-store.ts`(57)、`contract/slots.ts`(224)、`index.ts`(107)、`invariant.ts`。删除理由（index.tsx 头注 :1-12）：官方接管整个 composer 遮盖对话，corum 改挂 `conversation.composer.dock` 卡片不遮盖输入；**代价：官方 PlanReviewPanel（计划待审卡）功能在 corum 缺失**——官方 ui-user-questions 的 plan-review 种类 corum 未实现（PendingQuestion.kind 声明了 'plan-review' 但无渲染器）。rebase 时官方若增强 plan-review，corum 无法自动获得。
- **实质修改（3 个）**：`client/locales.ts`（69 diff 行：NS 从 'question' 改 'corum-question'，键集全换——⚠️ 但组件硬编码中文 t() 未用，词典形同虚设，审计 P1）；`index.ts`（host 半注释精简）；`css-modules.d.ts`（去掉 Readonly + 加 `declare module '*.css'`）。
- 数据通路复用官方 `user-questions/request` waterfall，answer/cancel/delegate 语义一致。⚠️ P0-11：QuestionCard「跳过本题」wired 到 `cancel()` 取消整组，与官方 skip 语义不符——修此 bug 时注意别被 rebase 覆盖回滚。

### 4.5 corum-ui-model-selection（对照 ui-model-selection）

相同 4 / 改名 0 / 实质 7 / 新增 1 / 删除 0。**rebase 风险：低**（审计 B「教科书式最小 fork」，package.json description 如实）。

- `client/directory.ts`（19 diff 行）🟡：新增 `errorKind: string | null` 字段（:36-42 注释说清用途）+ 三处置位/清空。零其它漂移。
- `client/ModelSelect.tsx`（+35 行，2026-09-08 换模型确认弹窗整改）🟡：`choose()` 由「一律 window.confirm」改为「新会话（`blank`）直接换 / 非空会话弹统一风格 ConfirmDialog」；新增 `blank` uSES 订阅 + `pending` state + `applySelection` 提取；渲染 `<ConfirmDialog>`（`@corum/corum-ui-base/client`，center 模态、tone=primary）。**新增 1 个组件依赖**：`@corum/corum-ui-base`（workspace:*）。
- `client/slots.ts`（+8 行）🟡：`ModelSelectInjected` 加 `blank: SnapshotStore<boolean>`（空会话镜像，host 摘要推导，决定是否弹确认）。
- `client/index.ts`（+15 行）🟡：inject 里构造 `blank` store（`createSnapshotStore` + `sessions.list` 订阅 `byId[sessionId].blank`），经 scope effect 解绑；import `createSnapshotStore`。
- `client/locales.ts`（+5 键）🟡：新增 `confirm.switchTitle/Message/Warning/Confirm/Cancel`（zh+en）——换模型确认弹窗文案。
- `client/ModelSelect.tsx`（22 diff 行）🟡：`state.errorKind === 'model-unavailable'` 时 Toast 从错误改 info 提示（:162-170，CORUM-PATCH 注释：图片会话切纯文本模型是「约束不是缺陷」）；toast state 加 `kind` 字段；触发器显示 `· {effortLabel}`（设计稿 htxWi，:209,246）；info 图标 `IconQuestionOutline14`。
- `client/catalog.ts`（12 diff 行）🟡：构造参数从 `ctx` 改为 `session: Pick<ClientRemote['session'],'modelCatalog'>`（窄化依赖，:25-26 注释）；service.ts 同步 2 行。
- `client/locales.ts`（2 diff 行）🟡：新增 `error.modelUnavailable` 键（zh+en）。
- `ModelSelect.module.css`（34 diff 行）🟡：触发器样式（triggerEffort 等）。
- `invariant.ts` 🟢 模板改名。

### 4.6 corum-ui-settings-models（对照 ui-settings-models）

相同 10 / 改名 0 / 实质 10 / 新增 12 / 删除 1。**rebase 风险：中**。

> 统计口径（2026-09-09 复核，`comm` + `cmp` 逐文件比对 `src/client`）：官方 21 个文件，corum
> 32 个；共享 20 个（10 逐字节相同、10 有实质差异），corum 独有 12 个，官方独有 1 个。旧表
> 「相同 11 / 实质 15 / 新增 0」与文件集不符（模型页重写新增的 12 个文件没进台账），已按实
> 复核修正。
>
> **corum 独有（12 个）**🟢：`AddModelSelectView.tsx`、`ConfigureWizard.tsx`、`ModelConfigView.tsx`、
> `ProviderDetailView.tsx`、`controls.tsx`、`brands.tsx`、`model-cards.ts`、`model-profile.ts`、
> `reasoning.ts`、`thinking-catalog.ts`、`useConnTest.ts`、`catalog-fallback.ts`（两页式模型页
> 自研渲染层：供应商卡/详情/模型配置/向导/添加模型 + 思考档位 catalog + 目录兜底）。官方
> 若重构 Models 页，这 12 个文件是**整包替换**而非合并对象。

- **官方有但 corum 删除（1 个）**🔴：`client/operations.ts`（官方 109 行封装层 `createModelsOperations`/`ModelsOperations`）。corum 删掉它，14 处改为组件直持 Remote wire face（`ModelsWire{settings,credentials,llm}`）。package.json description 自称「其余与官方逐行一致」**不实**（审计 P1，应如实更新）。改造质量良好（补了官方没有的传输失败 try/catch——store.ts `messageOf` + 各处 catch，修官方「transport reject 成未处理 rejection」的真实缺口），但**官方若更新 operations.ts 或其调用方，corum 全部 14 处调用点要逐处对齐**。
- **实质修改（10 个共享文件）**（下列条目同时记了 corum 独有文件里值得留意的行为：
  `reasoning.ts`/`ModelConfigView.tsx`/`ProviderDetailView.tsx`）：
  - `client/store.ts`（105 diff 行）🔴：`ModelsWire`/`ModelsCredentials`/`ModelsLlm` 类型定义内置（:24-87）、构造函数 `ctx` 改 `api: Pick<ModelsWire,...>`、加载链路加 try/catch + `messageOf`（:210-266）。
  - `client/ModelListEditor.tsx`（63 diff 行）🟡：`acceptsImage()` + **模型级「支持图片输入」开关**（:442-469，CORUM-PATCH 注释说清语义：勾选写 `input:['text','image']`、不勾删 `input` 键回退 route defaultInput/catalog——这是本包 fork 的**首要动机**，写进了 description）；`api.llm.discoverModels` 直调 + messageOf catch。⚠️ 裸 checkbox 无样式（审计 P1）。
  - `client/CustomProviderCard.tsx` / `ProviderEditor.tsx` / `ModelsSection.tsx` / `DeepSeekOnboardingDialog.tsx`（28/62/57/11 diff 行）🟡：`operations.*` → `api.{settings,credentials,llm}.*` 直调 + wire 结果（`response.ok/error.message`）替换官方 outcome 判别（`written.kind`）+ 传输失败 catch；JsonValue import 从 `dsh-util-values` 改 `dsh-api-remotes/client`。
  - `client/index.ts`（20 diff 行）🟡：删 `createModelsOperations` 调用，组装 `wire` 对象直传；不再 re-export operations 类型。
  - `client/reasoning.ts`（+30 行，方案 A）🟡：新增 `reasoningEffortsOf(levels, existing)`——把侦测到的思考档位集合落成 pi-ai schema 的 `reasoningEfforts` dict（off→null，其余→档位 id；用户已配 wire 值保留）。这是「能力集合落盘」的数据源，修复「模型设置写默认档单值、modelCatalog 读能力 dict」的 gap（HANDOFF-model-reasoning-gap.md）。
  - `client/ModelConfigView.tsx`（+7 行，方案 A）🟡：save 时对 pi-ai 族模型同步写 `reasoningEfforts`（`reasoningEffortsOf(modelThinking.levels, next.reasoningEfforts)`，undefined 则删键）；deepseek 族不动（其 catalog 投影走 deepseek 适配器自有链）。⚠️ 官方若改 save 的 writeModels mutate 块，此增量需随写。
  - `client/ModelConfigView.tsx` / `ProviderDetailView.tsx`（+18/+20 行，2026-09-08 弹窗统一整改）🟡：删除模型的原生 `window.confirm` 换统一 `<ConfirmDialog>`（`@corum/corum-ui-base/client`，danger tone，标题「删除模型」+ 警示 + 取消/删除，busy 态「删除中…」）。**新增 1 个组件依赖**：`@corum/corum-ui-base`（workspace:*）。
  - `client/locales.ts`（4 diff 行）🟡：新增 `modelImageInput`/`modelImageInputHint` 两键（zh+en）——图片开关文案，i18n 合规。
  - `client/welcome-store.ts`（4 diff 行）🟢：import 顺序/风格。
  - `onboarding-copy.ts`（14 diff 行）🟡：新增 `WELCOME_NOTICE_COPY`（⚠️ 死代码双事实源，审计 P1——若确认无引用应删）。
  - `index.ts`（4 diff 行）🟢：host 半注释（ui-onboarding 注册由 ide-shell 接管的说明）。
  - `invariant.ts` 🟢：模板改名（⚠️ exports 已删 `./invariant` 子路径但 invariant.ts 仍被打包成死代码，审计 P2）。

---

## 5. 升级 runbook（官方版本 bump 操作顺序）

> 场景：官方 dsh 从当前基线（0.1.2-alpha.2）升到新版本，需把 6 个 fork 逐文件合并。预估：零成本文件 103+26 个，人工合并约 20 个 🔴 文件。

### 第 0 步 · 前置对齐（不做这步后面全是错的）

1. 确认新官方版本号，更新 6 个 fork 包 `dependencies` 里的 `@deepseek-ai/*` 版本（当前锁 `^0.1.2-alpha.1`，源码对照 alpha.2——先消除 §3.4 错位）。
2. 把新官方源码 checkout 到对照路径（本文默认 `/Users/kukucai/dsh/packages/client/`，升级时换成新版路径），重跑 `diff -r` 刷新本台账统计。

### 第 1 步 · 机械合并（零人工判断）

3. **逐字节相同文件**（按 §1 各包「相同」列）：官方新版直接覆盖 corum 对应文件。
4. **仅 import 改名文件**（chat 25 个 + approval 1 个）：官方覆盖后执行机械替换：
   ```
   sed -i '' 's/@deepseek-ai\/dsh-client-ui-conversation/@corum\/corum-ui-conversation/g' <文件>
   ```
   注意连 `declare module '@deepseek-ai/dsh-client-ui-conversation/client'` 字符串一起换（chat/contract/snapshot.ts）。
5. **invariant.ts / 根 index.ts**：按 §3.6 模板处理；根 index.ts 向官方写法对齐（settingsNamespace 已内联）。

> ⚠️ **整文件覆盖禁令（2026-09-09 事故教训）**：上面第 3/4 步的「官方覆盖」**只对
> 「逐字节相同」与「仅 import 改名」两类文件成立**。凡在 §4 各包「实质修改」表里出现
> 过的文件，**禁止整文件拷贝官方版**——必须按台账逐处三方合并。反例：0.1.3 合并
> `f09aa05b` 把 `corum-ui-chat/chat/TurnNavigator.module.css` 整文件拷成官方版，左
> gutter 圆点刻度静默消失（编译全绿、console 干净，只能靠人眼看 UI 发现）。
> **合并完成后必跑 `scripts/verify-fork-drift.sh`**：其 §5 会直接报出「与官方逐字节
> 一致」的定制文件与缺失的定制标记。

### 第 2 步 · 优先核对的「语义地雷」（合并实质文件前先查）

6. **错误码命名空间**（§3.5）：conversation `service.ts:318`、`input/hub.ts:204`、`InputBar.tsx:95-97`、`image-labels.ts`——若官方新版本继续演进错误码，corum 必须同步，否则附件/steer 错误处理静默失效。
7. **官方新增 locale 键**：对比官方各包 `locales.ts`，把 corum 缺失键补回 corum 词典（已知欠账：chat `message.turnTime.*` 4 键、conversation `access.preset.*` 3 键——后者是 corum 有意删的，补不补看 PermissionSelect 合并结论）。**不要整文件覆盖 corum locales.ts**（会丢掉 review.*/subagent.*/modelImageInput 等 corum 键）。
8. **官方删除/改名 corum 正在 type-only 消费的 contract 类型**：chat/approval/questions 的 26+2 处 import 依赖 conversation contract 的 6 个类型——官方 contract/conversation.ts 等若改这些类型签名，消费侧全部要动（这是契约辐射的正当成本）。

### 第 3 步 · 实质修改文件三方合并（按 🔴 优先级）

9. 高危清单（必冲突，逐处人工）：
   - **chat/ChatNodeSeat.tsx:153**（foldable=false）——**先完成 P0-12 整改再 rebase**，否则把死代码合并进新版。
   - **chat/corum-reskin.css**——**先完成 P0-13 整改**（收回各 module.css），否则全局选择器对新 DOM 误伤/失效。
   - **chat/MessageItem.tsx / MessageIconActions.tsx / TurnTailNodeView.tsx**——corum 删了官方 reveal/usageAction 机制，官方在这三文件的任何演进都要决定「跟官方机制」还是「维持 corum 重设计」。
   - **chat/TurnNavigator.module.css**——左 gutter 8×8 圆点刻度（设计稿 vESwF）5 处增量，官方 0.1.3 结构演进时**只贴回增量、禁止整文件覆盖**（2026-09-09 已被覆盖过一次）。
   - **chat/apply.ts**（reviewSource + getAgentName 块）、**chat/ChatView.tsx**（ReviewCard/AgentNameContext 挂载点）。
   - **conversation/apply.ts**（emptyActions 119 行块 + uiWorkspace 降级）、**conversation/contract/slots.ts**（emptyActions 契约增量）。
   - **conversation/ConversationSession.tsx**（crumbs/lineage 整块删除）——官方 header 槽演进需确认 corum 是否仍全删。
   - **conversation/EmptyHero.tsx / ConversationRoot.tsx / InputBar.tsx / EmptyStateHero.tsx**——重设计文件，官方改动逐处看。
   - **approval/ApprovalPanel.tsx(+css)**——审批卡重设计 + lucide 依赖。
   - **settings-models/store.ts**（ModelsWire 直持改造）——**官方 operations.ts 若更新，14 个调用点全部重新对齐**。
10. 中低危（🟡 机械合并）：CSS 换肤文件保留 corum 变量值、locale 按第 2 步键级合并、model-selection 全包（errorKind 增量）、settings-models 的 api→operations 调用点。
11. **questions 整包**：不按文件合并。核对官方 `user-questions/request` waterfall 契约（Remote Event 形状、PendingQuestion 生命周期、ASK_CANCELLED/ASK_ABORTED 码）是否变动——变了改 `contract.ts` 同形复制与 `index.tsx` 应答逻辑；`QuestionCard.tsx` 渲染层独立演进。**特别核对官方 PlanReviewPanel 相关演进**（corum 缺失 plan-review 渲染）。
12. **corum 新增文件**（19 个）：不合并，但 grep 其 import 的官方 API 是否在官方新版变动（review-source 的 eventSource/connection RPC、subagent 的 contract 类型、EmptyStateHero 的 emptyActions）。
13. **官方有但 corum 删除文件**（11 个）：逐个确认删除理由仍成立（TurnUsagePanel→TurnUsageDisclosure 有意取代；QuestionComposer/PlanReviewPanel/draft-store→dock 重设计；operations.ts→直持 wire）。理由不成立就恢复官方文件。

### 第 4 步 · 验证

14. `pnpm -r typecheck`（6 个 fork 包 + 全仓）——重点看 contract 类型漂移与 locale 键缺失（`satisfies Record` 会编译器报 zh/en 不同构）。
15. `pnpm -r build`（含 tsdown + inline-css）。
16. 实机验证（corum-cdp-verify 技能）：会话骨架（空态操作卡新建任务/项目）、聊天渲染（工具调用展开、Review 卡撤销/保留、子 Agent 卡、Turn 用量）、审批卡（允许一次/拒绝）、提问卡（答题/跳过/放弃）、模型切换（含图片会话切纯文本模型的 info 提示）、模型设置页（图片输入开关读写 `input` 模态）。
17. 合并后刷新本台账：重跑 `diff -r` 更新 §1 统计与各包文件清单，把新引入的差异登记进 §4。

---

## 6. 「不做抽包」的实证记录（防反向优化）

**结论（A3 整改项，主 Agent round 2 实证，本次台账复核确认）：会话域 chat/approval/questions 对 conversation 的依赖是 type-only 契约消费，与官方逐行对齐，契约边界已成立，不抽独立 contract 包。**

- **事实**：§3.1 已列全量证据——26+2 处 import 全部 type-only、全部来自 conversation `contract/` 目录、与官方 ui-chat 对官方 ui-conversation 的消费逐行相同。
- **为何不该抽包**（A3 原文）：把官方就有的 contract 类型抽到独立包，会让 corum 文件布局偏离官方，rebase 官方时更痛（官方升级 contract/conversation.ts 需在两包间手动同步）。A1 已把依赖降为 type-only（dependencies→devDependencies），这正是官方做法，已足够。
- **历史背景**：审计 B 群曾把「chat→conversation 30+ 处非 type-only import + tsdown external + index.ts re-export」判为 P0-6 架构红线；A1/A3 整改后该红线已消除（tsdown external 移除、re-export 删除、import 全 type-only）。**任何后续 Agent 不要再提「抽 contract 包」或「解耦 chat→conversation」——那是反向优化。** 唯一残留的包内分层瑕疵是 chat/contract/slots.ts:129 inline import 本包渲染层（§3.1 末尾），如需处理那是包内整理，不是抽包。

---

## 附：本台账新发现的差异/风险（此前审计未覆盖）

1. **§3.5 错误码命名空间欠债**（conversation 4 处停在 alpha.1 裸码）——审计 B 群未单列；影响：Host 升 alpha.2 后附件错误友好文案与 steer 静默收敛失效。
2. **chat 未同步官方 `message.turnTime.*` 4 个 locale 键**——TurnUsage 重设计时键集换代未收官方新增，en/zh 均缺。
3. **questions 缺 plan-review 渲染器**——官方 PlanReviewPanel 整体删除后，corum PendingQuestion.kind 仍声明 'plan-review' 但无渲染路径；官方该能力演进 corum 无法获得（审计只记了「删文件」，未点出能力缺口）。
4. **chat/contract/slots.ts:129 contract 层 inline import 渲染层 review-source**——包内反向依赖，rebase 合并 slots.ts 时会被官方纯净 contract 文件掩盖，需单独记。
5. **settings-models invariant.ts 死文件仍打包 + exports 已删 ./invariant**（审计 P2 已记，台账复核确认仍存）；**onboarding-copy.ts WELCOME_NOTICE_COPY 死代码**（审计已记）。
6. 官方 ui-chat 的 `MessageItem` reveal/usageAction 机制与 `TurnUsagePanel/TurnTimePanel` 是 alpha.2 的演进方向，与 corum 的 TurnUsageDisclosure 重设计**方向相反**——这是 chat 包未来 rebase 最大的结构性冲突源（不只是行级冲突）。

---

## 7. host 域 fork：`@corum/corum-credentials-local`（API Key 加密落盘）

> 登记日期：2026-09-07。动机：TODO 安全项「API Key 本地加密存储（safeStorage）」——官方把凭证明文写 `$DSH_HOME/.credentials.yaml`（仅 0600 权限，官方注释明言 "the file's protection is skipped rather than faked"）。

| 项 | 内容 |
|---|---|
| fork 包 | `@corum/corum-credentials-local`（`packages/plugins/agent/corum-credentials-local`） |
| 官方对照包 | `@deepseek-ai/dsh-credentials-local`（`packages/credentials/credentials-local`） |
| 官方基线 | **0.1.2-alpha.2**（git diff `6c705be1ce..3f1b46a5db` 证实 alpha.1→alpha.2 该包 src **零变化**——仅版本号 bump；corum 运行时锁 alpha.1，故源码级完全兼容） |
| 文件数 | 3 / 2（`index.ts` 实质修改、`invariant.ts` 仅改名、`value-crypto.ts` corum 新增） |
| rebase 风险 | **低**：加密挂点集中在 durable 边界的 6 个函数（`parseRefs`/`parseRecord`/`parseRecordEnv`/`renderRef`/`renderRecord` + 新增 `encryptRecordSecrets`），每处都有 `// fork（corum）：` 注释锚点；官方这些函数是纯函数，演进概率低 |

**实质差异清单（index.ts 共 6 处挂点 + 1 个新增文件）**：

1. `value-crypto.ts`（corum 新增，139 行）：AES-256-GCM 逐条值加密。格式 `enc:v1:<b64 iv>:<b64 tag>:<b64 ct>`；主密钥读 `CORUM_CREDENTIALS_MASTER_KEY` env（base64，Electron main 注入）；`encryptValue`/`decryptValue`/`isEncryptedValue`/`encryptionAvailable`；双读兼容（无前缀 = 明文原样返回）；无密钥降级 = 写时拒绝 + 密文读抛错 + 明文读正常（**绝不静默退回明文写**）；篡改/密钥不匹配 = GCM 认证失败 loud 抛错。
2. `parseRefs`：ref 值落盘 → 内存时 `decryptValue(value)`。
3. `parseRecord`（api-key 分支）：`key` 字段 `decryptValue`；`env` 经 `parseRecordEnv` 同步处理；grant payload **不加密**（官方未承诺机密性，结构校验语义保留）。
4. `parseRecordEnv`：env 值 `decryptValue(value)`。
5. `renderRef`：写入一律 `encryptValue(value)`（删除路径不加密）。
6. `renderRecord` + 新增 `encryptRecordSecrets`：api-key 的 `key`/`env` 值加密落盘（readonly 字段用对象字面量展开构造，与官方 parseRecord 同形）；grant 原样。
7. `invariant.ts`：包名改 `@corum/corum-credentials-local`（模板性修改）。
8. 模块头注释：fork 基线声明 + 差异摘要。

**装配（cordis.patch.yml）**：`- id: credentials disabled: true` + insert 段 `- id: corum-credentials name: '@corum/corum-credentials-local'`。**注意**：行 id 必须不同名——cordis-plugin-loader 的 `EntryGroup.update` 对同层 config 数组做唯一 id 检查（`duplicate loader entry id`），disabled 的官方行仍占位；cordis **服务名**不受影响（插件代码内 `super(ctx, 'credentials')` 与官方一致），下游 llm 适配器 / Models 页 / credentials RPC 全部按服务名 inject，零感知。

**主密钥链路（desktop 包，非本 fork）**：`src/electron/credentials-key.ts`（Electron main）——32 字节随机主密钥，`safeStorage.encryptString`（macOS Keychain / Windows DPAPI）封装后落盘 `$CORUM_HOME/.master-key`（0600）；spawn host 时 `buildHostEnv` 注入 `CORUM_CREDENTIALS_MASTER_KEY`（base64）。safeStorage 不可用（headless Linux 等）→ 不生成密钥、不注入 env → fork 侧进入上述「拒绝写密文」降级。密钥文件解密失败（换机器/钥匙串条目丢失）→ 不覆盖文件、本次启动降级，既有密文凭证不失锁。

**升级注意**：
- 官方 alpha.1→alpha.2 该包零变化；未来升级先 `git diff <old>..<new> -- packages/credentials/credentials-local/src/index.ts` 确认漂移面，再核 6 处挂点是否仍对齐。
- 官方若将来内建加密（如 `enc:` 前缀冲突），以官方格式为准迁移；`enc:v1:` 前缀是 corum 私有命名空间。
- `Config` schema 未动（`path`/`dshHome`/`watch`/`debounceMs`），overlay 无需 config 行。

**验证记录**（CDP 三层，2026-09-07）：新 Key 写入 → 落盘 `enc:v1:` 密文（同文件存量明文条目原样保留）；重启应用 → 密文条目 `credentials/describe` 正常（解密成功）；存量明文条目重写 → 自动转密文（迁移语义）；`unset` 删除正常；UI 渲染正常 + 零 console 错误；单元级：明文双读 / 篡改检测 / 错误密钥 loud 失败 / 无密钥写拒绝，全部通过。

---

## 8. host 域 fork：`@corum/corum-agent`（skill 注入隔离 + AGENTS.md fs realm + select 编译顺序）

> 登记日期：2026-09-08。corum-agent 非对照官方单一包的 fork（无同名官方包），但以下三处是对**官方机制**（dsh-agent-instructions / dsh-skill-filesystem / dsh-agent-presets）的组合修正，登记备查。

| 项 | 内容 |
|---|---|
| 落点 | `packages/plugins/agent/corum-agent/src/compile.ts` / `agent-service.ts` / 新增 `workspace-agents.ts` / 新增 `task-model-selection.ts` |
| 关联官方机制 | dsh-agent-instructions（AGENTS.md 注入）、dsh-skill-filesystem（skill 发现）、dsh-agent-presets（select/mount）、dsh-agent 的 `installModelSelection`（模型选择 waterfall） |

**实质差异/修正清单**：

1. **AGENTS.md fs realm 断链修复**（compile.ts）：`agent-instructions` 从 standardRows 顶层移进 `filesystem` 组（与 `fs-local` 同 `isolate:{fs:true}` realm）。根因：`dsh-agent-instructions` 经 `ctx.get('fs')` 读 AGENTS.md 基线，此前 fs-local 隔离在组私有 realm、agent-instructions 在组外拿到 undefined → 静默不注入。fs-local 保持 realm 私有（不与 host 的 fs-sandbox 抢 root realm 的 `fs` 名，避免 mount 报 "service fs has been registered at <SandboxedFileSystem>"）。
2. **AGENTS.md 选定工作区即创建**（新增 workspace-agents.ts + 接线）：`ensureWorkspaceAgentsMd(cwd)` 幂等创建（`wx` 旗标不覆盖用户/历史内容，只读/并发失败静默容错），挂到 `createAgentForTask`（task 泳道 cwd 选定）与 `createProject`（项目带 cwd）。
3. **select 编译顺序修正**（agent-service.ts 两处：`createAgentForTask` reuse 块 + `selectTaskAgentProfileRemote`）：`writeAgentDir`（编译 agent.cordis.yml）**先于** `agentPresets.select`（mount 读该文件）。原顺序在产物缺失/陈旧时 select 报 "agent.cordis.yml is missing"、writeAgentDir 永远到不了。
4. **模型选择让位**（新增 task-model-selection.ts，2026-09-09）：官方 `installModelSelection` 的 `agent/request` 监听用安装时的选择覆盖 `next()` 结果；corum 在 create setup 里先装了自己的 ref，官方 ref 更晚更内层 → 用户 `session/selectModel` 换的模型被吞。本文件是官方实现的「用户显式选择优先」变体（读会话 `modelSelection` 投影，pending 与安装时不同即永久让位），agent-service.ts 五处调用点全部改用它。官方若改 `installModelSelection` 的装配语义（assemble 快照 / request 应用两段），本文件需同步。见 `docs/LESSONS.md` §8.11。

**设计事实（实测确认，非改动）**：skill 注入**按 Agent 隔离**——每个 Agent 的 `profile.skills` 独立编成 preset 的 `skill-filesystem.customSkillDirs`（`CORUM_HOME/skills/<name>`），`skill-filesystem` 是 preset（agent scope）级 provider，各 Agent 只见自己绑的 skill 目录。

**验证记录**（CDP 实机，2026-09-08）：
- 泳道 A（Task 助理，绑 testSkill）：skill-catalog 只含 `test-execution-skill`，命中 `test_skill` 全流程执行 ✅
- 泳道 B（资深硬件开发，skills 空）：无 skill-catalog 卡片（catalog 空不渲染），加载 `android_skill` 失败 ✅（隔离反证）
- 泳道 C（高级应用开发工程师-Android，绑 androidSkill）：skill-catalog 只含 `android-dev-skill`，命中 `android_skill` 输出 `【ANDROID_SKILL_LOADED】` ✅
- AGENTS.md：ai-lib 泳道首启自动创建 389B 模板并被注入（`agent-instructions` durable message + UI 卡片）✅
- select 顺序：资深硬件开发 → Android 切换成功（此前报 missing 失败）✅

**升级注意**：`dsh-agent-presets` 的 select/mount 语义（blank 限定、compose 文件读取）若演进，需复核 select 前的 writeAgentDir 是否仍必要；`dsh-agent-instructions` 的 `ctx.get('fs')` 解析路径若变，需复核 realm 归属。

4. **专用 Agent 域边界 + 技术栈信号**（2026-09-08，DESIGN-specialized-agent-domain-boundary.md）：
   - **L1 域边界条款**（compile.ts `composeStructuredPersona`）：`domain`/`title` 经 `domainToStack` 归类命中（真专业域）时注入「你的域严格是 X，越界任务不执行、声明越界 + 建议切通用/对应 Agent；读越界可参考、写/深析越界禁止」。判定用归类而非「title 非空」——否则 task 助理（title「单任务」）等通用角色会被误注（2026-09-08 实测）。
   - **L2 技术栈兑底信号**（新增 `tech-stack.ts` + agent-service `ctx.inject(['systemPrompt'])` 注册 `corum:tech-stack-signal` context，order 116）：启发式签名文件检测工作区技术栈（react→frontend / platformio→embedded / …），有信号时注入「工作区是 X 类项目（依据）」作 Agent 自判域的客观参考；空区/无信号出 `''`（section 丢弃，Agent 纯靠任务内容自判）。⚠️ `ctx.systemPrompt` 是独立服务，必须经 `ctx.inject` 装配——构造函数裸取报 "cannot get property systemPrompt without inject"（2026-09-08 启动崩溃实测）。
   - **L2.5 混合项目 + 项目级不匹配警示**（2026-09-08 二轮）：`detectTechStack` 下探**两层**子目录、聚合多栈（新增 `cpp` 类别——C/C++/CUDA 桌面引擎，ai-lib = `cpp`(engines/ds4 等 3 处) + `frontend`(studio/Electron) 混合）。preset 域归类与成分比对，**成分不含 Agent 域**时注入**指令式** IMPORTANT（「先一两句告知项目可能不适合你的专长，再决定动不动手」）。preset 来源 `sessionProjections.stateOf(agent.session,'agentPreset')`（泳道事件流无 `agent-preset/selected` 独立事件）；描述性 Note 会被模型当背景忽略，指令式才迫使表态（2026-09-08 实测对照）。新增依赖 `@deepseek-ai/dsh-session-projection`（Context 合并）。
   - **验证**：嵌入式工程师接前端任务 → 声明越界 + 建议切通用/前端 Agent，不产出代码 ✅；同泳道接 STM32 任务 → 正常产出 ✅；Task 助理接前端任务 → 正常产出（通用不受限，persona 无边界条款）✅；嵌入式工程师在 ai-lib（C/C++/前端 PC 项目）接 STM32 任务 → 先表态「当前工作区是 C/C++ 桌面/引擎 + 系统后端 + Electron 前端，并不是嵌入式工程」，再判断「独立代码片段仍属本域」后产出 ✅。
   - **后续（TODO）**：模块级责任边界（项目/AGENTS.md 约定模块→负责 Agent 映射，写权限按模块路径收敛）——配合项目制，本轮未做。

**升级注意**（补）：`domainToStack` 的关键词映射覆盖当前 builtin 角色 title；新增角色若引入新技术域，需同步关键词表，否则该角色不注入边界条款。

---

## 8. host+client 双面 fork：`@corum/corum-api-remotes`（统一事件中心一期）

> 登记日期：2026-09-07。动机：统一事件中心（`docs/agent-foundation/UNIFIED-EVENT-BUS.md`）——官方 `API_REMOTE_FORWARDED_EVENTS` allowlist 是编译期硬编码常量、`registerRemoteEvents` 是 singleton（重复注册抛错），零改动官方包无法把 corum 领域事件纳入「host→renderer forwarded Remote event」通道。fork 是「全仓库最轻的 fork」：核心 165 行转发循环 + 162 行 client contribution 挂载**整文件照抄**，实质 diff 仅「常量数组追加 13 个 corum 事件 + 自包含 corum-events.ts」。

| 项 | 内容 |
|---|---|
| fork 包 | `@corum/corum-api-remotes`（`packages/plugins/agent/corum-api-remotes`） |
| 官方对照包 | `@deepseek-ai/dsh-api-remotes`（`packages/api/remotes`） |
| 官方基线 | **0.1.2-alpha.2**（源码对照；corum 运行时锁 alpha.1，见 §3.4 同款错位——下方 client/index.ts 有一处按 alpha.1 对齐）。⚠️ 2026-09 三-4：dsh 检出已 **0.1.3-alpha.1**（`d347e70390`），本节下方「alpha.2→0.1.3-alpha.1 实测漂移面」已登记增量，**本节对照统计仍以 alpha.2 为基线未重 diff**（实际 rebase 是另一项工程） |
| 文件数 | 8（src/ 6 + package.json + tsdown.config.ts + tsconfig.json） |
| rebase 风险 | **低**：实质 diff 集中在 allowlist 数组追加段（数组合并级别）+ corum-events.ts（corum 新增，官方升级不影响）；转发循环/client 挂载零改动 |

**逐文件分类**：
- **逐字节相同（3 个，直接覆盖）**：`src/index.ts`（165 行转发循环）、`src/types.ts`、`src/client/index.ts` 的官方主体。
  - ⚠️ `src/client/index.ts` 有**一处**按 alpha.1 对齐：官方 alpha.2 末尾 re-export「收敛后的 Remote 失败词汇」（`RemoteErrorCode/RemoteErrorDetailsMap/RemoteFailure/RemoteResult` 自 dsh-typert-protocol、`RemoteHostFacts` 自 dsh-api-gateway/client），那批类型是官方 `804b1ffbfc` 在 alpha.2 引入的，corum 锁的 alpha.1 没有。fork 删掉该 4 行 re-export（文件内有 `// fork（corum）：` 注释锚点）。**升 alpha.2 时回退为官方写法**。另加 1 行 `export type {} from '../corum-events.ts'`（corum 增量，拉 $on 类型投影）。
- **实质修改（2 个）**：
  - `src/remote-events.ts`：`API_REMOTE_FORWARDED_EVENTS` 数组在官方 17 行后追加 13 行 corum 事件（每行 `{ event: 'corum/...', mode: 'emit' }`，官方行零改动）+ 顶部 `import type {} from './corum-events.ts'`。🔴 rebase 合并点：官方若加同名 `corum/` 前缀事件会重复 `ctx.on`（renderer 收两份）——升级时 diff 官方数组与 corum 追加段（UNIFIED-EVENT-BUS §5.3）。
  - `src/invariant.ts`：包名改 `@corum/corum-api-remotes`、插件名 `corum-api-remotes-invariant`（模板性修改，同 §3.6）。
- **corum 新增（1 个）**：`src/corum-events.ts`——13 个 corum 事件的 cordis `Events` 声明（自包含，**不 type-import host-only 的 corum-agent**，其 events.ts 有 node-only 值导入会拖进 client 编译面；载荷类型自包含重声明，以 corum-agent/events.ts 为事实源）+ `declare module '@deepseek-ai/dsh-typert-protocol' { interface TypertRemoteEventSelection extends Record<CorumForwardedEvent, true> {} }`（照 dsh-api-session-controller/src/remote-events.ts:9-12 写法，让 renderer `$on` 拿 key 面 + listener 签名）。官方升级不影响本文件存在，但其镜像的 corum-agent 载荷若演进需同步。
- **构建配置（3 个，corum 自立）**：`package.json`（`dsh.client` 段 `{ inject: ['@deepseek-ai/dsh-api-gateway'], platform: 'web', immediately: true }` **原样保留**——`ctx.remote` 服务装配的关键；dependencies 锁 alpha.1 同全部 fork）、`tsdown.config.ts`（自立 defineConfig 复刻官方 `clientBundle(..., { hostPhase: true })` 双 face，不 import dsh 私有 helper）、`tsconfig.json`（单文件 tsconfig，lib ES2024+DOM 同官方 host/client 双 face 合集）。

**装配（cordis.patch.yml）**：disable 段 `- id: api-remotes disabled: true` + insert 段 `- id: corum-api-remotes name: '@corum/corum-api-remotes'`（行 id 不同名——loader 同层 id 唯一性检查，同 corum-credentials 纪律；官方行在 base bundle `packages/bundle/web-app/cordis.patch.yml` insert 块内，行 id `api-remotes`）。cordis **服务名** `typertGateway`/`remote` 不变，renderer 各 ui-* 插件对 `ctx.remote` 的消费（$mount/$on）零感知。

**验证记录**（CDP 三层，2026-09-07）：fork 包 build/typecheck 通过；desktop 重启 console 零报错；**官方 17 事件仍通**（session/modelCatalog 默认模型 glm-5.2 + 2 提供商组、agentPresets/list ok）；**corum 事件到达 renderer**（corum/terminal/output 推送帧 + corum/task/assigned→started→completed 全生命周期载荷）；**终端轮询已消灭**（$on 推送主路径，pollStarts=0，输出实时）；截图 `.dbg/unified-event-bus/`。

**升级注意**：
- 官方 alpha.1→alpha.2 该包 src 有漂移（client/index.ts 失败词汇收敛、index.ts/remote-events.ts 微调）——升级时先 `git diff <old>..<new> -- packages/api/remotes/src` 刷新对照，重点核对 client/index.ts 那处 alpha.1 对齐段是否可回退官方写法。
- `dsh.client` 段的 `inject`/`platform`/`immediately` 是 `ctx.remote` 装配的开关，rebase 时**绝不可删**。
- corum-events.ts 的 13 个事件名与 allowlist 追加段一一对应；官方若将来内建 corum 同名事件，以官方为准去重。

### §8.1 alpha.2→0.1.3-alpha.1 实测漂移面（2026-09 三-4 登记；**仅台账登记，未实际 rebase**）

> 核实命令：`git -C /Users/kukucai/dsh diff 3f1b46a5db..HEAD -- packages/api/remotes/`（dsh 检出 `d347e70390` = 0.1.3-alpha.1 发布合并）。涉及提交：`15f2997bcb`（invariant 删除）、`8fc9a11c5e`+`3b8245afc3`（fileUploadsRemote）、`33b7123e96`（e2e zod 声明）。漂移面共 10 文件，其中对 fork 有意义的 4 处：

1. **新增 `fileUploadsRemote` 命名空间**（client 半，`8fc9a11c5e`「refactor(attachment): isolate file upload service」）：官方 client/index.ts 新增 `import fileUploadsRemote from '@deepseek-ai/dsh-client-file-upload/remote'` + contribution 数组挂载 + `export type {}`；package.json 新增 `dsh-client-file-upload` workspace 依赖；tsconfig.client.json 新增 file-upload project reference。**corum 全仓无消费方**（grep 无 `fileUploads`/`dsh-client-file-upload` 引用）——rebase 时**可选跟进**（不跟进则 fileUploads 命名空间在 corum renderer 缺席，官方若把附件上传改走该命名空间才需补）。
2. **删除 invariant companion 机制**（`15f2997bcb`「cleanup: omit unneeded invariant companions」）：官方删 `src/invariant.ts`（24 行）+ package.json `./invariant` export 与 `lib/invariant.js` files 条目 + `dsh-invariants` devDep + tsconfig.host.json files/references 两条 + tsdown.config.ts 入口 `'lib/types/invariant.js'`。**fork 仍全套保留**（src/invariant.ts + `./invariant` export + `dsh-invariants: ^0.1.2-alpha.1` devDep + tsdown node 入口）——rebase 时**随官方删**：invariant.ts、package.json 三处、tsdown.config.ts 入口数组。（另注意 §4 会话域 6 个 fork 的 invariant.ts 也受同一官方清理波及——官方基线升 0.1.3 后那些包的 invariant 模板同样应删。）
3. **package.json 新增 `zod: ^4.4.3` 依赖**（`33b7123e96`，tests/built-lib.e2e.ts 的 built-lib smoke 用 zod 校验 schema）——纯测试基建面，fork 无 tests 目录（见 P2-②），rebase 时**不需要跟**。
4. **README.i18n.yaml / README.md / README.zh.md 文案更新**（invariant 删除的连带）——fork 无 README 对照面，忽略。

**P2 记录（非阻塞，rebase 时一并评估）**：
- ① **tsconfig 双 face 取舍**：官方用 `tsconfig.host.json`（files 仅 index/remote-events/types，无 DOM lib——host 面无 DOM 隔离）+ `tsconfig.client.json` 双工程；fork 是单文件 tsconfig（lib ES2024+DOM 合集，host/client 同一编译面）。fork 写法削弱了「host 面误用 DOM API 编译期拦截」的官方隔离，rebase 时考虑恢复官方双 tsconfig。
- ② **缺 tests**：官方 `tests/remote-events.host.spec.ts`（232 行，host 半转发行为运行时守护）可移植到 fork——corum 追加的 13 个事件当前只有编译期校验，无运行时守护（审计 P2）。
- ③ **漂移核实习惯**：本节的漂移面是 `git diff` 实测而非印象——以后每次官方版本 bump 都先跑同样命令刷新本小节，再动 rebase。

---

## 9. 0.1.2-alpha.2 → 0.1.3-alpha.1 实测 rebase 全量结论（2026-09-07，已落地 + CDP 验证通过）

> 本次升级的**实战记录**（非预案）。范围：8 fork 包 + desktop + corum-subagent(第 9 fork) + 127 个 `@deepseek-ai/*` 依赖。结果：**全仓 31 包 typecheck 0 错、build 0 错、三层 CDP 实机验证通过**（boot 零报错 / UI 渲染 / 聊天全要素 / format v2 流式发送回答）。

### 9.0 基座落地链（npm 未发 0.1.3，走本地私服）

dsh 0.1.3 未上公共 registry（最新仍 0.1.2-rc.1）。落地路径沿用 0.1.2 机制：**dsh 单仓 `pnpm run build:official`（official client build profile + build record）→ `release:pack --family dsh`（248 tarball）→ `release:publish` 到本地私服 `localhost:4873`（dist-tag `alpha`，幂等）**。corum 侧：

- 127 个依赖 `^0.1.2-alpha.x → ^0.1.3-alpha.1`（301 + desktop 60 处，脚本批量）。
- `pnpm-workspace.yaml`：`minimumReleaseAge: 0`（私服新包发布时间 < pnpm 默认 1 天 cutoff，持久化放行）+ `overrides`（dsh-authorization/cordis 4.0.2 + vendor 6 件 include/loader/group/hmr/schemastery/timer）+ `minimumReleaseAgeExclude` 0.1.2→0.1.3 全量重写 + 补 53 新包。
- ⚠️ **环境坑**：shell 残留 dsh 仓 `npm_package_*`/PATH 污染会让 pnpm 行为异常——所有 corum pnpm 命令用 `env -i HOME=$HOME PATH=... pnpm`。
- ⚠️ **fs-ext**：session-persistence-jsonl 的 `fs-ext` native flock 硬需（无 JS 降级），node-gyp 9 因 Node 26 无 distutils 失败——`allowBuilds: fs-ext: true` + `npx node-gyp@13` 构建 `fs_ext.node`。

### 9.1 三条 0.1.3 主线对 corum 的穿透点（实测）

| 主线 | 穿透 corum | 处理 |
|---|---|---|
| **session format v2**（assistant 流内嵌 message/attempt；`session.events` 删→`eventAt`/`snapshotEvents`；persistence handle seam） | corum-agent（events ~19 处 + persistence.readFrom 4 处 + event-projection assistant/chunk）、corum-subagent（assistant-output/continuation）、ui-chat（conversation-nodes chunkrow） | corum 自有代码手工迁移（官方不替你改）；conversation-nodes 官方继承代码随换新自动消解 |
| **通用文件上传**（新包 dsh-client-file-upload + fileUploadsRemote + 附件泛化 image→file） | ui-conversation（InputBar/service/apply/contract）+ corum-api-remotes（client 挂载 3 行）+ cordis.patch（base bundle 0.1.3 已自带挂载） | InputBar 采纳官方 file-upload 全链路；api-remotes 补 fileUploadsRemote import/挂载 |
| **invariant companion 清除**（官方删 212 个空 invariant.ts） | corum 8 处空 companion（7 插件包 + desktop） | 全删；corum-subagent 92 行真实校验**保留**（官方保留同名文件） |

### 9.2 逐包 rebase 结果（全部落地）

| 包 | 评级→实际 | 关键改动 |
|---|---|---|
| corum-ui-conversation | XL→落地 | apply(emptyActions 190 行移植到官方 Config/fileUploads 骨架)/InputBar(file-upload 链路+sparkle)/ConversationRoot(**新增契约增量 `toolbarLeading`** 承载 corum 工具栏，因官方删 overlay/leftItems/rightItems/footer 槽)/slots(emptyActions 移植)/locales(补官方 20 键)/view-selection(官方新文件) |
| corum-ui-chat | L→落地 | conversation-nodes 19 文件官方换新+sed（82 错自动消解）+ contract(8 文件) + apply(chatRuntime/corumEditor/review/getAgentName 移植到 keyedHooks/loadThrough 骨架) + ChatView(官方 memo ChatNodeList/turn rail + AgentNameContext/ReviewCard 移植) + ChatNodeSeat(foldable=false 保留，P0 随官方投影器内聚缓解) + TurnNavigator/turn-rail-items(官方新线——⚠️ **TurnNavigator.module.css 整文件覆盖连带丢掉 corum 圆点刻度定制，2026-09-09 重新贴回，见文首与 §4.2**) |
| corum-ui-settings-models | M→落地 | JsonValue 5 处改 dsh-util-values + SettingsRemote→ClientRemote['settings'] + settings-conflict→settings/conflict + 合并官方候选模型搜索框(candidateQuery/visibleCandidates/toggleVisibleCandidates) + candidateToolbar CSS 改名 |
| corum-ui-approval / corum-ui-questions / corum-ui-model-selection / corum-credentials-local / corum-api-remotes | S→落地 | 编译即绿（0.1.3 契约兼容，官方这些包 corum 定制 tsx 均未动）；仅 invariant 清理 + api-remotes 补 fileUploadsRemote 3 行 |
| corum-subagent(第 9 fork) | M→落地 | driver/spawn 内部 import 改相对路径 + attachments.admitPromptContent 服务方法 + assistant-output expandAssistantStream + continuation persistence.stat |
| corum-agent | —→落地 | session.events→snapshotEvents(~19) + persistence.readFrom→readPersistedEvents helper(4) + assistant/chunk 死路径 as 窄化（Phase 4 ide-conversation-ui 流式渲染待迁移 expandAssistantStream，**遗留**） |
| desktop | —→落地 | boot.ts settingsNamespace 回退 + session-archive readRaw→readSessionLogText + invariant 清理 |
| corum-ide-explorer-ui | —→落地 | corum.explorer 槽本地 SlotMap 声明（已解挂备份代码自洽） |

### 9.3 运行时坑（typecheck/build 不暴露，CDP 才抓）

1. **file-upload 插件 boot 失败**：`ctx.commands.registerFileReceiptResolver is not a function`——host 模块根 `profiles/web/node_modules` 是 8月陈旧 heal 缓存（205 个 0.1.2 包）。**heal 只在缺失时建链接、不更新旧链接**——清除 dev home 的 `profiles/web/node_modules` + `profiles/node_modules` 后 heal 重建为 0.1.3 修复。**教训：基座升级后必须清 host 模块缓存重启**。
2. **fs_ext.node 缺失**：见 §9.0。

### 9.4 验证记录（三层 CDP，2026-09-07）

boot 零报错（host ready）→ UI 渲染（侧栏+空态操作卡+最近列表液态玻璃）→ 会话打开（标题+轮次/token 元数据）→ 聊天全要素渲染：userHeader(You+time)、思考卡、工具调用展开(foldable=false)、SubagentCard(Done/查看子会话)、TurnUsageDisclosure(用量/TTFT/tok/s)、**turn rail 轮次导航**、上下文注入卡、composer(sparkle/附件/权限/模型) → **format v2 流式实测**：发送「1+1」→ 流式 → 回答「2」+ TurnUsageDisclosure(9K tok/首token 1.8s/37 tok/s)。截图 `.dbg/`（phase5-boot-ok / chat-render-ok / stream-v2-ok）。

### 9.5 遗留（非阻塞，下轮处理）

- **ide-conversation-ui 流式渲染**：`ConversationArea.tsx` 深度消费 `assistant/chunk` 投影（0.1.3 已删，流内嵌 message/attempt）——corum-agent 侧已 as 窄化保留旧日志死路径，**ide 自主渲染链需迁移到 expandAssistantStream**（独立工程，主对话区 corum-ui-chat 已用官方新机制不受影响）。
- **minimumReleaseAge: 0**：待官方 0.1.3 上公共 registry 后删除该行。
- **settings-models CSS 预存缺失类**（modelField/input 等，非 0.1.3 新引入）：候选搜索框已补，其余另行。

### 9.6 追加完成项（2026-09-07 二轮，CDP 端到端验证通过）

- **file 附件卡样式（原 §9.5 遗留②）**：`MessageItem.module.css` 补 6 类（attachmentRow/fileCard/fileIcon/fileContent/fileName/fileMeta，corum glass 化）。**CDP 实测**：上传 `corum-upload-probe.txt` → fileCard 渲染 `display:flex / border-radius:16px / 玻璃背景` → Agent 读取附件内容回答。
- **skillNames 通路（原 §9.5 遗留③）**：UserStyleBubble 加 `skillNames` prop + `projectUserText` 3 参 + `UserMessageNodeView.data.skillNames` 透传。官方 skill chip 数据投影（chat-snapshot-builder SkillNameProjector）/类型/渲染三层已对齐，host skill-invocation 场景到达时自然呈现。
- **运行时坑③（新增）**：`corum-ui-conversation/apply.ts` inject **误删 `fileUpload`**（合并时沿用「空态操作卡不需上传」的旧假设）——官方 0.1.3 把它作为必需 inject，`createDrafts→beginFileUpload` 链经 `ctx.fileUpload.upload` 真上传，缺失致文件上传静默 fail（typecheck 不报，因 `ctx.fileUpload` 类型经 Context 合并存在但运行时 undefined）。**教训：fork inject 数组的「删减」必须逐一对照官方 0.1.3 新版，尤其新增必需服务**。已补回并 CDP 验证上传链路全通。

### 9.7 轨迹功能 + 流式渲染结论（2026-09-07 三轮）

- **轨迹功能（官方 ui-trajectory 启用，零自研）**：`cordis.ide.patch.yml` 的 `ui-trajectory` 从 `disabled: true` 改为启用——官方插件注册进 `conversation.view` 槽成为「对话/轨迹」选项卡（id `trajectory`），corum-ui-chat 的 ConversationSession 已渲染 tabs（tabs.length>1 时出现），点击即切官方轨迹时间线（过滤/搜索/轮次分组/工具调用行/上下文/附件标记）。数据通路官方 `uiConversation.binding(sessionId).target('trajectory')`，泳道会话在官方对象层可用。**教训：corum-ide-conversation-ui 已退役（B 方案由 corum-ui-chat fork 接管对话区），勿再向其投功能——先查包的激活状态再动手**（本次一度误把轨迹/流式做进退役包并引入 inject 死锁，CDP boot 才抓出）。
- **流式渲染（ide-conversation-ui 遗留①闭环）**：该包已退役不激活，主流式渲染由 corum-ui-chat 经官方 `assistant/live-chunk`（agent/assistant-stream→session.follow）承载——0.1.3 流式在主对话区**本就正常**，遗留①实质无需做。`corum-agent/event-projection.ts` 保留 `assistant/attempt` 投影补全 + `stream` 透传（0.1.3 format v2 数据通路补全，attempt 是合法终态事件，旧投影会丢）。
- **CDP 验证**：「对话/轨迹」tab 出现 → 点轨迹 → 官方轨迹时间线完整渲染 → 切回对话正常。截图 `.dbg/phase6-trajectory-view.png`。

---

## 10. 第 9 个 fork 包：`@corum/corum-subagent`（2026-09-07，子 Agent 隔离方案 fork #9）

> 方案：`docs/plan/PLAN-subagent-isolation.md`。fork 自官方 **0.1.3-alpha.1**（git HEAD，`/Users/kukucai/dsh`）三个包：`dsh-subagent`（seam 本体）+ `dsh-subagent-in-process-driver`（one-shot 驱动）+ `dsh-subagent-spawn-in-process`（spawn provider）——后两者以 `src/driver/`、`src/spawn/` 子目录并入同一 fork 包。**基线口径注意**：这是首个直接以 0.1.3 为基线的 fork（既有 §1-§8 fork 基线 0.1.2-alpha.2、依赖锁已随基座升级至 0.1.3）。

### 10.1 总览

| 项 | 值 |
|---|---|
| fork 包 | `@corum/corum-subagent`（host 域，`packages/plugins/agent/corum-subagent/`） |
| 官方对照 | `dsh-subagent` + `dsh-subagent-in-process-driver` + `dsh-subagent-spawn-in-process` @ 0.1.3-alpha.1 |
| 文件数 | 22（src/ 19 + driver/ 2 + spawn/ 1；0.1.3 HEAD 无 descriptor-seed.ts——format v2 重构 `f99b06eaed` 将其内联进 continuation） |
| 逐字节相同 | 15 |
| 实质修改 | 7（types/child-agent/continuation/depth/index/invariant + driver/index）+ spawn/index（改名+import 重定向） |

> ⚠️ **历史包袱说明**：本包在基座升级期曾被前一个会话以 alpha.4 基线 + 自适配
> 提交（`40bcd08f`/`099bf12f`，含自造 `descriptor-seed.ts` 与 `deliverSubagentPrompt`
> steer 扩展）。本轮以 **0.1.3 HEAD 完整重建**取代——三方 diff 证实 099 的全部
> "修复"本质是 alpha.4→0.1.3 的官方演进内容（expandAssistantStream/persistence.stat/
> deliverSubagentPrompt 均已进官方 HEAD），重建无损；`descriptor-seed.ts` 系 099
> 从 alpha.4 带来的残留，0.1.3 官方已删除该文件，随之移除。rebase 时以本表为准，
> 不要回溯 099 的适配注释。
| corum 新增 | 0（无新文件；`tests/cwd.spec.ts` 为测试资产不计入 src 对照） |

### 10.2 实质 diff 逐处登记

| 文件 | diff 行 | 内容 | rebase 风险 |
|---|---|---|---|
| `types.ts` | +7 | `SubagentStartRequest.cwd?: string`（jsdoc 注明硬隔离轴心语义） | 低（纯增量字段，官方未占用该键） |
| `child-agent.ts` | ±6 | `childSessionMeta` 增第 4 参 `cwd?: string`；`effectiveCwd = cwd ?? parentHeader.cwd` | **中**（官方若改签名/增参需三方合并；调用点 3 处） |
| `continuation.ts` | ±5 | startContinuable 透传 `request.cwd` + `assertChildCwd(request.cwd)` 校验 + depth import | 低 |
| `driver/index.ts` | ±6 | one-shot 透传 `request.cwd` + import 重定向 `'@deepseek-ai/dsh-subagent'` → `'../index.ts'` | 低 |
| `depth.ts` | +17 | `assertChildCwd`（绝对路径 + 已存在校验，`INVALID_CWD`；node:fs/path import） | 低（纯增量函数） |
| `index.ts` | ±3 | one-shot `start()` 校验调用 + depth import | 低 |
| `invariant.ts` | ±4 | PACKAGE_NAME → `@corum/corum-subagent`、插件名 → `corum-subagent-invariant` | 低（机械） |
| `spawn/index.ts` | ±12 | 插件名 `corum-subagent-spawn-in-process`、默认 provider 名 **`corum-spawn`**（与官方 spawn 并存不抢名）、import 重定向（`../index.ts` + `../driver/index.ts`）、文件头 fork 注释 | 低 |

### 10.3 设计要点（升级 runbook 必读）

1. **cwd 透传双路径**：one-shot（driver `agents.create` meta）与 continuable（continuation `materialize` meta）都必须透传——漏任一路径则对应召唤模式丢失隔离。官方若重构这两条路径（如 0.1.2→0.1.3 的 lineageSeedLength→isSeeded 签名变化），对照本表 §10.2 逐处重挂。
2. **校验时机**：`assertChildCwd` 在 `SubagentRuntime.start` / `ContinuationManager.startContinuable` 入口（fail fast），provider 侧不重复校验。
3. **官方测试资产**：官方 `tests/`（13 个 spec）未随 fork 拷贝——corum 侧以 `tests/cwd.spec.ts`（7 例：cwd 透传 3 + assertChildCwd 4）覆盖 fork diff；官方行为回归依赖基座自身测试。升级 rebase 后应跑一次官方 tests 目录对 fork src 的适配验证（手动）。
4. **依赖锁**：全部 `^0.1.3-alpha.1`（与基座同代，无双向差）。

### 10.4 验证记录

`pnpm --filter @corum/corum-subagent run typecheck` 零错误；`run build` 产物 4 文件（lib/index.js + lib/spawn/index.js + lib/invariant.js + types chunk）；`npx vitest run tests/cwd.spec.ts` 7/7 通过（2026-09-07）。

### 10.5 fork #9 转正为完整 seam 服务（2026-09-09，Phase 0 落地）

> 方案：`docs/plan/PLAN-subagent-orchestration.md` §4。**架构形态变更**：本包从
> 「只挂 `/spawn` provider 的半身」升格为「完整 seam 服务」——desktop
> `cordis.patch.yml` 禁用官方 `id: subagent` 服务行，insert 段挂
> `@corum/corum-subagent`（完整包，非 `/spawn`），服务名 `subagents` 不变。这使
> fork #9 的 `childSessionMeta(4 参)` cwd 透传 + `assertChildCwd` 在运行时真正生效，
> 消除 REVIEW 报告的「SEAM 死代码」硬伤（continuable 路径隔离从此生效）。

**挂载改法**（`packages/desktop/cordis.patch.yml`）：
- 顶层 disabled 段：`- id: subagent` `disabled: true`（禁用 base bundle insert 块内
  的官方 seam 行，同 credentials/api-remotes 先例）。
- insert 段：`- id: corum-subagent` `name: '@corum/corum-subagent'`（完整服务）+
  保留 `- id: corum-subagent-spawn` `name: '@corum/corum-subagent/spawn'`（provider）。

**下游零感知**（服务名 `subagents` 不变）：
- 官方 provider 行（spawn/fork）`inject: ['subagents']` → 注册进 fork #9 服务。
- `tool-subagent-control`（send_message/interrupt/list_agents）`inject: ['subagents']`
  → 调 fork #9 的 sendMessage/interrupt/listChildren/listDescendants。
- renderer `subagentsRemote`（官方 `/remote` client）按服务名 `subagents` + 方法名
  `list`/`prompt`/`interruptByParent` 寻址，fork #9 的 `@Remote` 方法面与官方逐字节
  一致，零感知。

**官方 11 spec 移植回归**（转正验收门槛）：官方 `tests/` 的 11 spec + 2 helper
移植到 fork `tests/`（+ 1 个 `mock-adapter.ts` 测试基建），**301 测试全通过（exit
code 0）**。补 8 个测试 devDeps（dsh-agent-loop / dsh-agent-loop-testkit /
dsh-session-persistence-jsonl / dsh-storage / dsh-storage-json / dsh-storage-domain /
dsh-subagent-fork-in-process / dsh-subagent-spawn-in-process）。新增
`vitest.config.ts`（decorator 预处理插件 + `pool: 'forks'` +
`dangerouslyIgnoreUnhandledErrors: true`）。

**测试基建瑕疵（非阻塞，已记录）**：`list-children.spec.ts` 的 19 个 FileHandle GC
unhandled error（`session.lock` lease 句柄未 release，官方 spec 固有瑕疵）在 Node 26
下从 deprecation warning 升级为 ERR_INVALID_STATE（官方 CI Node 24 无此问题）。已用
`dangerouslyIgnoreUnhandledErrors: true` 让 exit code 归 0，spec 与官方逐字一致
（未来 rebase 零冲突）。

**CDP 验证**（2026-09-09）：`./scripts/cdp.sh start` → `combo "coding" host ready` +
零 console 错误 + 无 loader 警告（duplicate/missing/waiting 全无）——证明 fork #9 完整
服务成功注册（若服务缺失，tool-subagent-control 会报 "waiting for service:
subagents"，host 不会 ready）。

**升级注意（补）**：本包从「provider-only fork」升格为「完整 seam 服务 fork」，
rebase 风险从**中**上调为**高**——官方 `dsh-subagent` 每次版本 bump，fork 的
continuation（1728 行）+ child-agent/depth/types/driver/spawn 都要三方合并，且 11
spec 需每版本重跑等价验证。

---

## 11. 第 10 个 fork 包：`@corum/corum-tool-subagent`（2026-09-07，子 Agent 隔离方案 fork #10）

> 方案：`docs/plan/PLAN-subagent-isolation.md`。fork 自官方 `dsh-tool-subagent` **0.1.3-alpha.1**（git HEAD）。与 fork #9（§10）配套：#9 提供 `SubagentStartRequest.cwd` 轴心，#10 在其上实现「召唤即隔离」的完整编排。

### 11.1 总览

| 项 | 值 |
|---|---|
| fork 包 | `@corum/corum-tool-subagent`（host 域，`packages/plugins/agent/corum-tool-subagent/`） |
| 官方对照 | `dsh-tool-subagent` @ 0.1.3-alpha.1（6 个 src 文件） |
| 逐字节相同 | 4（list-models / model-selection-settings / model-selection-state / model-selection） |
| 实质修改 | 2（index.ts 41 处 fork 注释块；invariant.ts 仅包名/插件名 2 行） |
| corum 新增 | 0（tests/isolation.spec.ts 为测试资产） |

### 11.2 index.ts 实质 diff 分区登记

| 分区 | 内容 | rebase 风险 |
|---|---|---|
| Config schema | `isolation{mode,worktreeRoot,branchPrefix,autoCleanup,denyDirectFs}` / `readonlyResearch` / `maxParallelChildren` / `integrateChecks` / `merger` / `model{provider,model,reasoningEffort?}`——全部 `.default(undefined as unknown as T)` 保留 omission | **中**（官方 Config 演进需三方合并；schema 段与官方同文件） |
| 模型锁 | config.model 存在时 agentOptions 终值注入、官方 selection/preflight 块整体跳过；parameters 删 provider/model/reasoning_effort 条件展开（LLM 无选模型参数面） | **中**（官方若改模型解析链需重挂） |
| 隔离 execute 层 | `CORUM_WRITE_TOOLS` 常量、写工具判定（`corumIsWriteTask`/`corumEffectiveToolFilter`/`corumShouldIsolate` 导出纯函数）、worktree 创建（slug=wt-+randomBytes(3)、git worktree add+失败回滚）、request.cwd 注入、toolFilter deny str_replace_editor 合并 | 低（插入式，官方流程不变） |
| 会话级台账 | `CorumWorktreeEntry`（slug/branch/path/status/runId）、Map<SessionId>、maxParallelChildren 强制（active 口径）、ctx.effect dispose 清理（worktree remove + branch -D，autoCleanup） | 低 |
| settle 联动 | `ctx.on('subagent/end' as never, (info, parent) => …)` 按 parent.session.id 定位台账；`corumMarkSettled`（runId 精确 + childId 唯一回退）；`as never` 原因注释（Events 合并声明在 corum-subagent 包，类型实例不匹配） | **中**（官方若改 subagent/end payload 签名需跟随） |
| integrate 编排 | schema `integrate` 参数、准入 `corumPendingIntegration`（active∪settled，空拒绝）、前台限定（background/continuable 拒绝）、cwd=主干、persona+prompt 机制拼装（分支清单+Checks+汇报指令按 merger 分档）、settle 后标 integrated + autoCleanup | 低 |
| 描述/exports | 工具描述头部隔离语义句；package.json exports 仅 `.` + `./invariant` | 低 |

### 11.3 组合接入（cordis.patch.yml）

- fork #9 provider 行：`- id: corum-subagent-spawn / name: '@corum/corum-subagent/spawn'`（desktop insert 段）——注册 `corum-spawn` 进官方 seam；官方 spawn/spawn-in-process 行**不禁用**（官方 tool-subagent 的 fork/codex/claude-code 实例 + workflow 只读 fan-out 继续走官方 spawn）。
- fork #10 **无 host 行**：工具实例由 corum preset 的 delegation 组双实例行（compile.ts `corumSubagentConfig` 生成：`tool-subagent` + `tool-subagent-research`，name `@corum/corum-tool-subagent`）按会话挂载；preset 行裸包名经 agent-presets mount 的 harnessBase 解析（desktop deps 已 workspace 链）。
- invariant 均不挂（官方组合未挂 subagent-invariant，对齐同纪律）。
- **依赖锁**：全部 `^0.1.3-alpha.1`。

### 11.4 验证记录

`npx tsc --noEmit` 零错误；`pnpm run build` 产物 3 文件（lib/index.js 33.78 kB + lib/invariant.js + 共享 chunk）；`npx vitest run` 17/17 通过（写工具判定 5 / 隔离触发 3 / 临时 git 仓库 worktree add-remove 2 / maxParallel 口径 1 / integrate 准入 2 / settle 联动 4）；4 文件与官方逐字节一致复核为空（2026-09-07，经两阶段子 Agent 实现 + 父 Agent 独立复核）。**CDP 实机验证待 §12 实施单第 10-11 步**。

### 11.5 CDP 实机验证记录（2026-09-07 晚，三层全过）

| 验证项 | 结果 | 证据 |
|---|---|---|
| research 只读实例 | ✓ 工具面 24 个无 write/edit/bash/str_replace_editor/pwsh；30 次调用全 glob/grep；模型锁 flash（父 GLM） | 子会话 46b4ef3f request/header |
| {{model}}/{{cwd}} 插值 | ✓ "powered by the deepseek-v4-flash model. Your working directory is /Users/kukucai/work/ai-lib." | 同上 |
| worker 隔离触发 | ✓ write 任务 → isolation=true → worktree wt-xxx 自动创建（slug/分支 LLM 不可见） | host log（探针期） |
| **沙箱硬隔离** | ✓ 子 Agent 尝试写主干绝对路径被 workspace-write 沙箱拒（"仅覆盖该 worktree"） | 子会话 1db7b126 assistant 消息 |
| 文件落点 | ✓ probe5.txt 落 worktree 内、主干无；子 Agent 经 isolation notice 用相对路径直接写成功 | fs 实证 + 父会话 32_29 |
| 父 Agent 闭环 | ✓ 正确转述 worktree 路径并提示落盘位置差异 | UI 快照 uid=32_26-32_40 |
| 平台 fail-loud 修复 | research deny 名单 pwsh 仅 win32（compile + fork #10 判定同步修，单测更新 5/5、17/17） | tests 全绿 |

**isolation notice（新增，fork #10 prompt 注入）**：隔离召唤的 prompt 前缀 `[corum isolation]` 段（分支名 + 相对路径纪律 + commit 指引）——解决"子 Agent 按父 prompt 的主干绝对路径写文件撞沙箱"的实机缺陷（probe4 暴露，probe5 修复验证）。

### 11.6 integrate 编排 CDP 端到端验证（2026-09-07 晚，全链路通过）

| 阶段 | 结果 | 证据 |
|---|---|---|
| fan-out 双并行 | ✓ 同消息两 subagent 调用 → wt-962c0f / wt-d300ad 双 worktree 自动建立 | git worktree list |
| 隔离提交 | ✓ A=2eae000 `feat: part a probe`、B=196f369 `feat: part b probe`（各在自分支，主干 HEAD 不变） | 双 worktree git log |
| 沙箱异常自愈 | ✓ B 曾误闯主干提交（6726322）→ 子 Agent 自己 reset+清理回滚（主干回 1382367）后继续——隔离违规被沙箱拦住后 LLM 正确恢复 | 父会话 42_188 思考段 |
| integrate 准入 | ✓ 双 settle 后前台 `integrate:true` 放行；集成者 cwd=主干、无 str_replace_editor deny、persona+prompt 机制拼装 | 子会话 35a4ce0c |
| **核查门禁** | ✓ 合并无冲突入主干工作树并暂存，但默认核查 `pnpm -r typecheck` 在测试仓库（非 pnpm workspace）失败→**按"核查不过不提交"约束保留脏树未提交**——门禁语义正确（配置与仓库不匹配属基线问题，非机制缺陷） | git status staged + 父会话 42_219 |
| autoCleanup | ✓ integrate settle 后台账标 integrated、双 worktree+分支全部清理（worktree list 回 1） | fs 实证 |
| 手动收尾 | ✓ 父 Agent 提交 ad2dc0e `feat: parallel integration probe`（并行集成探针保留于主干作验证存档） | git log |

**结论**：PLAN §1.2 拓扑 B（并行开发 fan-out → integrate fan-in）全链路机制验证通过。遗留产品化项：① integrateChecks 的默认 `pnpm -r typecheck` 对非 pnpm 仓库不友好——Agent 预设可覆盖，全局默认是否改成探测式（存在 pnpm-workspace.yaml 才加该 check）待产品决策；② continuable 背景下 integrate 仍拒绝（骨架边界）。

### 11.7 P0-3「并行工作区」chip（2026-09-07 深夜，CDP 验证通过）

**数据链**：fork #10 台账变更点（创建/settle 翻转/integrate 结算）发射 `corum/worktree-ledger` 帧（cordis 根上下文 emit）→ corum-api-remotes 转发 allowlist +1（`corum-events.ts` 自包含声明 + `CorumForwardedEvent` 并入）→ renderer `worktreeLedgerSubscribe`（chat-runtime，与 subagentProgressSubscribe 同构）→ `WorktreeLedgerChip`（SubagentCard 组末尾，按当前会话 id 过滤）。

**验证**：帧统计表（`__corumEventStats`）证实 `corum/worktree-ledger` frames≥1/listeners=1；chip 渲染「N 个隔离工作区 · 待集成」，点击展开面板显示分支名+状态（active=进行中/settled=待集成/integrated=已集成）。截图 `.dbg/`（展开态 `wt/wt-acf83f · 进行中`）。

**两个 React #310 修复**（hooks 顺序恒定）：① SubagentCard 的 sessionId useState/useEffect 必须在 early return 前且防御 chatRuntime 晚挂载；② WorktreeLedgerChip 的 expanded useState 同样前置。**教训：fork/自研组件新增 hooks 时，任何条件渲染（含 `if (x === undefined) return null`）后的 hooks 声明都是 #310 炸弹——CDP console 才抓得到，typecheck 不报。**

### 11.8 P0-1 探测式默认 integrateChecks（2026-09-07 深夜，单测+手工验证）

**实现**（fork #10，`corumDetectIntegrateChecks`）：integrate 执行点未显式配置时按父 cwd 仓库形态探测——① `pnpm-workspace.yaml` → `pnpm -r typecheck`；② `package.json scripts.typecheck` → `npm run typecheck`；③ 仅 `scripts.test` → `npm test`；④ 均无 → `git diff --check`（保守兜底，永不误拦）。显式 config（preset 的 integrateChecks）恒优先。

**验证**：单测 4 例（探测矩阵全覆盖，22/22 全绿）；ai-lib（无 pnpm-workspace、package.json 仅 scripts.test 于 studio 子目录）探测落 `git diff --check`——手工对 4 个孤儿分支（重启致台账丢失，见 §11.9 遗留）执行 merge + `git diff --check` exit=0，验证保守兜底在当前仓库形态下可用且不误拦。

**遗留**：① ai-lib 的 test script 在 `studio/package.json`（子目录），根探测未下钻——下钻规则（monorepo 子包探测）待产品决策；② 台账持久化（重启/会话恢复后孤儿 worktree 识别，§11.9）。

### 11.9 已知遗留：台账易失性与会话恢复（产品决策待定）

CDP 验证中暴露：fork #10 的 worktree 台账是**模块级内存 Map**——应用重启后丢失，磁盘上的 worktree 成为"孤儿"（harness 无法对它们发起 integrate，报 "no isolated worktrees to integrate"）。本次 5 个 chip 探针 worktree 即如此，最终手工 merge+cleanup。

候选方向：① 台账落盘（会话 meta 或独立 json，恢复时重建并允许对孤儿 integrate）；② integrate 准入放宽为"台账空但 .corum-worktrees 下有本前缀分支时也允许"（牺牲精确性换鲁棒性）；③ 维持现状，文档化"重启前请 integrate 或手工清理"。**影响面：项目模式（团队并行开发是常态，重启恢复必须处理）vs TASK 模式（短会话，影响小）——建议项目模式落地前必须解决①或②。**

### 11.10 P1-4「子 Agent」设置 section（2026-09-07 深夜，CDP 全链路验证通过）

**三级配置第一级（全局默认）落地**：fork #10 注册 host settings namespace `corum-subagent`（schema 全键可选保持 omission；双实例共享模块级单例 scope，防同 namespace 重复注册）；实例解析改为「preset config > 全局设置文档值 > 内置默认」（`corumGlobal()` 每次执行时读，文档更新即时生效）。模型锁同链路（worker←defaultModel、research←defaultResearchModel）。

**设置 UI**（corum 自研设置中心，SECTION_DEFS 新增 `subagent`，order 115）：隔离与并行（隔离模式/并行上限/自动清理）、集成（合并者/核查命令——标注自动探测规则）、默认模型（worker/research 模型对）、research 实例只读标注。写路径 = `remote.settings.mutate`（revision 防并发覆盖）+ describe 镜像 acceptView 折叠；读路径 = describe 镜像 uSES 订阅。ide-ui inject 增 `remote`/`remote.settings`/`settingsScope`，经 `CorumSettingsContext` 下发（与 CorumRpcContext 同构，红线 1/4 合规）。

**CDP 验证**：① 写入落盘 settings.yaml（`isolationMode: always`）；② **三级覆盖实证**——全局 always 时只读调查任务也被强制隔离（wt-c5d437 建成），证明全局设置覆盖 preset 缺省 write-tasks；③ unset 回落（`corum-subagent: {}`）；④ chip 在 always 模式下正确显示「1 个隔离工作区 · 待集成」。**关键机制事实**：namespace 注册在 Agent mount（preset 实例 apply）时触发，非 boot 时——设置 section 的写入在任何 Agent mount 前会报 "namespace not registered"（首次 mount 后正常），属预期行为。

---

## 12. 第 11 个 fork 包：`@corum/corum-ui-settings-plugins`（2026-09-07 深夜，P1-5）

> fork 自官方 `dsh-client-ui-settings-plugins` **0.1.3-alpha.1**（git HEAD）。会话域第 7 个 fork、总第 11 个。

| 项 | 值 |
|---|---|
| 文件数 | 22（src/client/ 20 + src/ 2） |
| 逐字节相同 | 21（含全部 controller/卡组件/样式） |
| 实质修改 | 1（`client/index.ts`：文件头 fork 注释 + 移除 SubagentModelSelectionCard 注册） |
| 组合接入 | cordis.patch.yml 禁用官方 `ui-settings-plugins` 行 + insert 段挂 `corum-ui-settings-plugins`（同 Models 接管先例） |

**语义**：官方卡「允许 Agent 为 Subagent 选择模型」开关与 fork #10 模型锁互斥（config.model 机制固定路由、LLM 无参数面）——保留会误导用户。controller 实例保留（host namespace `subagent-model-selection` 仍可读写，存量设置文档不出现未注册段），仅 UI 卡不渲染。固定路由配置由 corum「子 Agent」section（§11.10）承载。

**验证**：「插件配置」tab 只剩终端/Agent 循环/网页搜索三卡，Subagent 卡消失；CDP console 零错误（2026-09-07）。

### 11.11 声明式验证（2026-09-08 定调落地，CDP 全链路验证通过）

**语义转变**（用户定调）：静态穷举（pnpm/typecheck/test/diff--check 四档猜）对千奇百怪的项目不可能完全准确。正确做法 = **主 Agent 在 integrate prompt 的 `verify` 参数里声明本仓库的编译/运行/验证方式**（它最懂这个仓库），机制原样注入并强制执行；**功能性验收由主 Agent 基于原始目标最终裁决**——机制只把「声明的失败」挡在提交前，不臆测验收标准。

**实现**（fork #10）：① schema 增 `verify` 参数（LLM 可见，integrate 时声明）；② `corumIntegratorPersona` 第 4 参 `declared`——有声明则原样注入「How to build, run, and verify（declared by the delegating agent — follow it exactly）」，无声明则标注「minimum bar only」语义；③ 硬约束保留：声明的验证失败 → 不提交、保留现场、报告失败详情。探测式默认（§11.8）降级为未声明时的兜底。「子 Agent」section 的核查命令字段文案同步改为「兜底」定位。

**验证**（CDP）：子 Agent 隔离分支 wt/wt-e4da17（52789a7）→ integrate `verify="node --check studio/main.js"` → 声明的验证执行 exit 0 + 兜底 `git diff --check` exit 0 → 无冲突合并自动提交 `22891e6`。主 Agent 复核报告完整。单测 25/25（persona 声明/未声明/汇报语义 3 例新增）。

**React 19 类型漂移修复**（顺路）：corum-ui-settings-plugins 初版误用 `@types/react@^19.2.2`——pnpm peer 解析把 lucide-react 的 react 类型链到 19.2.18，与 workspace 统一的 18.3.31 冲突（lucide 组件类型不兼容）。已对齐 ^18.2.0 / ~18.3.31 / ^18.3.7；ide-ui 历史 implicit-any 13 处补标注归零（AppFrame/SettingsShell/index/SettingsSections）。

### 11.12 编排器下沉 + orchestrate 工具（2026-09-09，Phase 1/2 落地）

> 方案：`docs/plan/PLAN-subagent-orchestration.md` §5/§6。**架构形态变更**：隔离编排
> 从「寄生在 fork #10 工具 execute 里」重构为「cordis service + 结构化工具」。

**Phase 1 编排器下沉**（`src/orchestration.ts` 新建）：
- `CorumOrchestration extends Service`：继承 cordis `Service`（`super(ctx, 'corumOrchestration')`
  自动 provide + 随 owning fiber 注销），持有会话级隔离台账（实例字段，**非模块级单例**——
  红线 1 合规，也是 §11.9 台账持久化的前置）。
- 挂载位置：fork #10 apply 在 agent scope（preset delegation 组）运行，台账语义是会话级，
  故在**根上下文** provide（`ctx.root.get('corumOrchestration', false)` 幂等复用 + `new
  CorumOrchestration(ctx.root)` 首次 provide）。关键验证：cordis `reflect.provide` 实现是
  `this.ctx.fiber.effect(...)`，disposer 绑定**根 fiber**（非 agent scope fiber），故 service
  跨会话稳定单例、台账不因单个 Agent dispose 丢失。
- 10 个隔离纯函数收编进 orchestration.ts（`corumGit`/`corumEffectiveToolFilter`/
  `corumIsWriteTask`/`corumShouldIsolate`/`corumPendingIntegration`/`corumMarkSettled`/
  `corumCleanupWorktree`/`corumCleanupLedgerEntries`/`corumDetectIntegrateChecks`/
  `corumIntegratorPersona`），index.ts 从 orchestration.ts import + re-export（对外 API 兼容）。
- 台账操作（worktree 创建/清理/settle 联动/integrate 结算/帧发射）改为 service 方法
  （`addActiveEntry`/`entriesOf`/`settleFromEnd`/`cleanupOnDispose`/`emitFrame`）；模块级
  `corumWorktreeLedger`/`corumLedgerCwds`/`emitLedgerFrame` 彻底删除。

**Phase 2 orchestrate 工具**（`src/index.ts` mount 内新增）：
- `spawnOne` 抽取：单任务隔离 spawn（模型锁/worktree/台账/notice）从 execute 内联抽成
  install 作用域闭包，subagent（单发）与 orchestrate（多任务 fan-out）共用。
- `orchestrate` 工具（方案甲任务清单 schema）：`tasks[]`（每任务 prompt/label/isolation/
  research/model/background）+ `merge{verify, autoIntegrate}`；execute 里 `Promise.all`
  并发 fan-out → 汇合结果 → `merge.autoIntegrate` 时触发 integrate（fan-in）。
- 任务级覆盖：`tasks[i].isolation/research` 优先于实例配置终值（`effIsolationMode`/
  `effReadonlyResearch`）。
- 注册位置：worker 实例（`subagent` 工具）mount 内额外注册；research 只读实例
  （`corumReadonlyResearch`）跳过 orchestrate 入口。

**验证**（2026-09-09）：25 单测全绿 + typecheck 零错误 + build 成功（lib/index.js 49.40 kB）；
CDP boot 零 console 错误。**端到端 LLM 验证（orchestrate fan-out 隔离）待泳道场景**：
orchestrate 工具经 corum preset 的 worker 实例挂载，真实 fan-out 需 IDE 泳道 + corum
编译 preset + LLM 召唤（coding combo 主窗口用官方 standard preset，不含此工具）。

**端到端验证补记（2026-09-09，IDE 泳道实机）**：在 corum IDE「新建任务」泳道
（Corum-编程助手 + ai-lib 工作区）发「用 orchestrate 并行创建两个探针」任务，
LLM 正确调用 orchestrate 工具（任务清单 `isolation:off` + `autoIntegrate:false`），
两个任务正确并发 fan-out + 汇合。**发现并修复 2 个真实 bug**：
1. **orchestrate 任务默认后台 bug**：continuable 实例下 `run_in_background` 未显式
   指定时默认 true，任务落入 continuable 路径无法前台汇合（报「task ran in continuable
   mode」）。修复：`run_in_background: task.background === true`（显式默认前台）。
2. **autoIntegrate 空台账报错 bug**：任务均 `isolation:off` 时，`autoIntegrate:true`
   触发 integrate 报「no isolated worktrees to integrate」。修复：integrate 前检查
   台账待集成条目，空则静默跳过。
验证环境限制（非代码 bug）：测试工作区 `/Users/kukucai/work/ai-lib` 在当前沙箱会话
EPERM 拒绝写入（主 Agent 自身 write/bash 同样 EPERM），是文件沙箱配置问题，与
orchestrate 工具无关。

### 11.13 Phase 4 台账持久化（2026-09-09，§11.9 决策项①落盘）

> 解决 §11.9 遗留：worktree 台账从「纯内存易失」改为「storageDomain 落盘」，应用
> 重启后恢复待集成条目（孤儿 worktree 识别），允许对孤儿发起 integrate。

**实现**（`orchestration.ts`）：
- 台账 domain spec `corumOrchestrationDomainSpec`（name `corum_orchestration`，version 1，
  `layout: 'per-record'`，单表 `ledger`，key=sessionId，value=`{cwd, entries}`）。
- `CorumOrchestration` 构造时经 `ctx.get('storageDomain')` 可选获取（缺省/未装配回落
  纯内存，行为与下沉前一致）；打开 domain 后启动恢复台账（`domain.table('ledger').entries()`
  遍历重建 active/settled 条目）+ `ctx.effect` 关闭句柄。
- 台账变更（`addActiveEntry`/`settleFromEnd`/`cleanupOnDispose`）异步 `persist(sessionId)`
  落盘：只落盘待集成条目（active/settled），空则删记录；fire-and-forget，失败仅 warn。
- 依赖补 `@deepseek-ai/dsh-storage-domain`（devDependencies + tsdown external）。

**验证**（2026-09-09）：25 单测全绿 + typecheck 零错误 + build 成功（lib/index.js 51.84 kB）。
单测走「无 storageDomain 回落纯内存」路径（`new Context()` 无 storageDomain），持久化
路径依赖实机验证（storageDomain 装配 + 重启恢复，见 §11.9 候选方向①的 CDP 验证待补）。

### 11.14 Phase 5 退役收尾（2026-09-09，官方 workflow 全家移除）

> 方案：`docs/plan/PLAN-subagent-orchestration.md` §7 退役清单。方案甲用 `orchestrate`
> 工具（任务清单结构化编排）取代官方 workflow 的通用 JS 脚本引擎 + ralph 循环。

**移除**（`corum-agent/src/compile.ts` standardRows delegation 组）：
- `workflow-worker-thread`（`@deepseek-ai/dsh-workflow-worker-thread`，workflowEngine provider）
- `tool-workflow`（`@deepseek-ai/dsh-tool-workflow`）
- `tool-ralph`（`@deepseek-ai/dsh-tool-ralph`）

**保留**：`tool-subagent-control`（send_message/interrupt）+ `tool-subagent-list-agents`
（list_agents）——用户决策「保留后台续接能力」，二者 `inject: ['tools','subagents']`
（不依赖 workflowEngine），转正后的 fork #9 服务满足其依赖。`isolate: { workflowEngine:
true }` 保留（空 realm 无害，移除 realm 隔离会连带改 delegation 组其他行的 realm 归属，
属无谓风险）。

**⚠️ 澄清（纠正此前错误理解）**：此前把「彻底移除 subagent 只留 orchestrate」当作
待决策方向，这是**错误的**。用户设想是「fork 官方 subagent 包继承全部能力 → 双实例
（两个 subagent 预设）默认配置所有 Agent → 之上叠加 orchestrate 增强」。**subagent
双实例（worker + research）是基础，永不退役；orchestrate 是增强，两者并存。** 当前
实现（subagent + subagent_research 双实例 + worker 内 orchestrate）正是最终形态，
不存在「彻底移除」的后续工作。

**验证**（2026-09-09）：corum-agent typecheck 零错误 + compile-subagent.spec 5 例全绿。

### 11.15 Phase 3 编排结果面板（2026-09-09）

> 方案：`docs/plan/PLAN-subagent-orchestration.md` §8 Phase 3。orchestrate 工具的
> 结果展示从 generic 文本升级为结构化卡（presentCall/presentResult）。

**实现**（`src/index.ts` orchestrate 工具）：
- `presentCall`：标题 `orchestrate · N 任务`，rawInput = 任务清单 `[i] label`。
- `presentResult`：标题 `orchestrate · X 成功 / Y 失败`，content = 每任务结果行
  `[task i] ✓ done / ✗ error`。
- 台账 chip 复用：`corum/worktree-ledger` 事件契约端到端不变（service emitFrame →
  api-remotes 转发 → ui-chat WorktreeLedgerChip 订阅），编排器下沉不破坏既有 chip。

**验证**（2026-09-09）：25 单测全绿 + typecheck 零错误 + build 成功（lib/index.js 62.97 kB）。

### 11.16 实机测试遗留问题登记（2026-09-09，CDP 实机验证发现，待解决）

> 来源：用户验收 orchestrate 编排框架时的 CDP 实机测试（ai-lab 无 git 仓库工作区 +
> kkc-desktop git 仓库工作区对照）。以下为**已确认的行为边界 / 待办问题**，后续解决，
> 不属于本次编排框架的回归 bug。

**P-A · orchestrate 任务无子 Agent 卡片（用户反馈，可见性问题）**
- 现象：调用 orchestrate 后，对话流里**不出现子 Agent 卡片**，用户无法看每个子 Agent
  的工作过程（只有 orchestrate 一张结果卡）。
- 根因（精确定位，双重）：① SubagentCard 由 `subagent-call` 节点渲染
  （`conversation-nodes/subagent.ts`），其 `isSubagentDelegationTool(name)`
  （`contract/turn-process.ts:59`）**只认 `subagent` / `subagent_*`，不含 `orchestrate`**；
  ② orchestrate 任务被 `run_in_background: task.background === true` 强制**前台 one-shot**
  （fan-in 汇合要求），前台 one-shot 不落 continuable 持久子会话 → 也无 `subagent-call`
  节点数据源。现状 orchestrate 的 presentCall/presentResult 是 `card:'generic'` 静态文本卡
  （标题 + rawInput 任务标签 + 结果行），无进度、不可点进子 Agent。
- 影响：用户看不到 orchestrate 各任务的执行细节，只有最终汇总。

**→ 设计已完成（2026-09-09，design.pen，待实施）**：
- **产物**：`doc/UXDesign/design.pen` 组件库新增可复用组件 **`orchestrate-flow-card`**
  （并行工作流卡）+ 3 状态形态（运行中 / 全部完成 / 部分失败）+ **goto 钻取交互**
  （指向 hover → 过渡箭头 → 复用现有「子Agent会话视图」稿② hGy32）。
- **卡片结构**（经多轮用户反馈定稿）：
  - **head（折叠态起点行，恒定）**：layers 图标 +「编排工作流 · N 任务并行」+ 进度 chip
    （青 running / 绿 done / 红 fail）+ **箭头（查看工作流详情）** + **展开/收起按钮**。
    （注：曾有 card-start 起点卡，因与 head 重复已删——head 即折叠态起点。）
  - **3 条并行支路**（真 `Promise.all` 并发，**无"待处理"串行语义**——3 任务同时启动全
    running）：起点节点（青 halo）→ 主干 → 每支路 = 状态节点（done 绿 check / running 橙
    双层 halo / fail 红 x）+ 状态连线（绿/橙/红）+ 任务卡（label + worktree/research 副信息
    + 状态 chip + **goto 子会话按钮**）。
  - **集成者子 Agent 卡（底部，串行汇总）**：git-merge 图标 +「集成者 · 合并+验证+提交」+
    「全部并行任务完成后 · 串行启动」+ 状态 chip（待集成/已集成/未启动）+ goto。失败时正确
    显示「存在失败任务 · 集成未启动」。
  - **goto 钻取**：点支路箭头 → **复用现有「子Agent会话视图」**（浅色，`#5B21F5` 紫底返回
    父会话条 + 只读消息流），**不新造卡片**（子 Agent 会话保持单一呈现；曾画深色卡片版已删）。
- **实现路径（待实施）**：
  1. `isSubagentDelegationTool`（turn-process.ts:59）纳入 `orchestrate`，或新建
     `orchestrate-flow` 节点类型（定义于 `conversation-nodes/`），数据源 = orchestrate 调用的
     tasks[] + 每任务的 spawn/settle/fail 实时事件。
  2. 任务级进度事件源：orchestrate fan-out 的每个 spawnOne 的 run（start → settle/fail）
     推送到卡片（参考 `corum/subagent/progress` 推送 + `corum/worktree-ledger` 帧的既有通道）。
  3. goto 跳子会话桥：复用 `chatRuntimeRef.current?.openSession(childSessionId)`
     （SubagentCard.tsx:243 已有）——orchestrate 任务虽是前台 one-shot，但子 Agent 会话仍有
     sessionId 可跳（需确认 one-shot 子会话是否留可查的 session 摘要）。
  4. 集成者节点状态 = integrate 调用的实时状态（待集成/运行/已集成/未启动）。
- **待决策（实施前）**：orchestrate 前台 one-shot 任务的子 Agent **是否有可跳转的持久子会话**
  （continuable 有，one-shot 待查）；若无，goto 改为「展开该任务的执行细节」而非跳独立会话。

**P-B · 无 git 仓库时 `isolation:always` 整任务失败 → 已解决（2026-09-09 自动降级）**
- 原现象：ai-lab（无 `.git`）下任务C（`isolation:always`）报 `fatal: not a git repository`，
  `git worktree add` 失败，任务直接失败。
- **已解决（本次「新建工作区 git 自动初始化 + 非 git 降级」特性的一部分）**：`spawnOne`
  在隔离判定前用 `corumIsGitRepo(parentCwd)`（orchestration.ts 新增，带 Map 缓存）侦测
  父 cwd，**非 git 仓库时强制 `corumIsolate=false`**——git 依赖能力（worktree 隔离 /
  声明式 verify / integrate）自动关闭而非报错。
- 实机验证（ai-lab 非 git）：`isolation:always` 写任务**不再报错**，文件直接写主树成功，
  不创建 `.corum-worktrees/`；`corumIsGitRepo` 5/5 验证（仓库/子目录 true，非 git/不存在
  目录 false 不抛错）；30 单测全绿无回归。
- **⚠️ 新观察（LLM 实测提出，待决策）**：降级是**静默**的——`isolation:always` 在 git
  缺失时退化为直接写主树而不告警，用户可能「以为隔离了实际改了主树」。是否需要在降级
  时向主 Agent / 用户显式提示「本任务因非 git 仓库未隔离」（用户决策，记入 §11.17）。

**P-C · research 只读子代理连带无 bash，无法枚举目录（只读口径连带效果）**
- 现象：ai-lab 任务A（`research:true`）想用 `ls` 列目录，但 research 实例「预 deny 写工具」
  名单含 `bash`（`CORUM_WRITE_TOOLS` 含 bash），子代理无 shell → 只能 glob（glob 只返回
  文件、不返回纯目录名），列不出目录结构。
- 定性：research 只读口径的连带效果（deny bash 是为了防写，但也挡住了只读 `ls`/`find`）。
- 待解决方向（未实施）：是否为 research 实例保留**只读 shell**（如白名单 `ls`/`cat`/`find`/
  `grep`），或提供只读目录枚举工具（用户决策，涉及只读口径的边界划定）。

**实机测试通过项（对照，确认无回归）**：
- orchestrate 任务默认**前台** fan-out 汇合（`run_in_background: task.background===true`，
  修复「默认后台」bug 生效，无历史 "continuable mode" 报错）。
- 空台账 `autoIntegrate:true` 静默跳过（`pending.length>0` 才 integrate，修复生效）。
- 任务级 `research:true` 预 deny 写工具（corumResearchToolFilter，kkc-desktop + ai-lab 双双
  验证只读生效）。
- 任务级 `isolation` 覆盖优先于实例配置；`autoIntegrate:false` 时隔离分支留待手动合并。
- 336 单测全绿（301 corum-subagent + 30 corum-tool-subagent + 5 corum-agent）+ 3 包 typecheck
  零错误 + CDP boot 零 console 错误。

### 11.17 新建工作区 git 自动初始化 + 非 git 降级（2026-09-09，用户需求完整实现）

> 需求：新建工作区后自动侦测/初始化 git 仓库，使子 Agent 编排的 git 依赖能力
> （隔离/verify/integrate）开箱可用；非 git 则这些功能关闭。用户拍板：完整实现
> （host 服务 + 设置开关 + 两处接入 + 降级 + UI）+ 正常添加仅降级 off + git init
> 带空初始 commit + 不生成 .gitignore。

**实现（5 个文件改动）**：
1. **host `corum-git.ts`（新建）**：`CorumGitService`（Typert Remote，service 名
   `corumGit`）——`@Remote('status')(path)→{isRepo}`（`git rev-parse --git-dir` 侦测，
   含 worktree/子目录）、`@Remote('init')(path)→{initialized,alreadyRepo}`（`git init`
   + 空初始 commit `--allow-empty`，身份用 `-c user.name/email` 一次性传入不污染用户
   config；幂等——已是仓库直接返回）。同时注册 `corum-workspace` settings namespace
   （「新工作区始终初始化 git」开关的持久化面，与 ui-onboarding 同款 boot 轮询注册）。
   与 corumFs 差异：接受任意绝对路径（用户工作区可在任意位置），不做项目根校验。
   `boot.ts` 注册 `new CorumGitService(hostCtx)`（与 corumFs 同时机）。
2. **隔离降级（orchestration.ts + index.ts）**：新增纯函数 `corumIsGitRepo(cwd)`
   （带 Map 缓存）；`spawnOne` 隔离判定后，若 `corumIsolate` 为真但父 cwd 非 git →
   强制 `corumIsolate=false`（需求第 4 点「git 依赖功能设为 false」的机制实现）。
3. **renderer `corum-ide-sidebar-ui`**：SessionsPane「添加工作区」流程改为
   「pickDirectory → `corumGit/status` 侦测 → 非 git 时『始终初始化』开关开则直接
   `corumGit/init` / 开关关则弹 `ConfirmDialog` 询问 → 确认 init 或拒绝（隔离降级由
   spawnOne 兜底）→ `workspaces.create`」。inject 加 `settingsScope`，新增
   `gitWorkspaceStatus`/`gitWorkspaceInit`/`autoInitGitEnabled` 三个动作（走
   `connection.rpc.call` 打 `corumGit/*`，与 directoryPicker 同通道）。
4. **renderer `corum-ui-conversation`**：空态「新建任务」无 cwd 选目录隐式建工作区时，
   「始终初始化」开关开则静默 `corumGit/init`（不插确认框打断建任务流程）；开关关则
   不初始化（降级兜底）。
5. **「通用」设置面板 `SettingsGeneralSection.tsx`**：新增「工作区」组 + 真实 Switch
   「新工作区始终初始化 git」（默认开），照 SubagentSection.autoCleanup 的
   `useCorumSettings`+`mutate` 模式（本组件原是纯静态占位，这是第一个真实持久化项）。
   **关键修复**：`index.tsx` 的 GeneralSection 注册原未包 `CorumSettingsContext.Provider`
   （纯静态时代不需要），导致开关 `useContext` 拿 null 降级隐藏——已补包 Provider。

**验证（2026-09-09，CDP 实机）**：
- 设置面板：「通用」section 底部「工作区」组 + 开关**默认开启**渲染正确，文案完整。
- 降级：ai-lab（非 git）`isolation:always` 写任务**不再报错**，文件写主树成功，不建
  `.corum-worktrees/`（对比此前任务C `fatal: not a git repository` 失败）。
- `corumIsGitRepo` 5/5；host git init 命令序列（init + 空 commit）实测初始化后
  `git worktree add` 可创建（隔离前置满足）。
- 5 包 typecheck 零错误 + build 成功 + 30 单测全绿 + CDP boot 零 console 错误。

**遗留（待决策）**：降级静默无提示（见 §11.16 P-B 的新观察）；「添加工作区」的
native 目录选择器无法被 CDP 驱动，ConfirmDialog 的 UI 链路（开关关时弹询问）未做实机
点击验证（逻辑已经 typecheck + 与 ModelSelect 同款 ConfirmDialog 用法）。

### 11.18 Deepseek 编排专用 Agent（2026-09-09，主 Agent 极简规划 + 子 Agent 全权执行）

> 需求（用户定调）：「单独设计一个 Deepseek 专用 Agent，主 Agent 采用极简模式只负责
> 思考规划，所有执行都给子 Agent 执行。」PLAN：`docs/plan/PLAN-deepseek-orchestrator-agent.md`。

**核心架构矛盾与路线修正（实机暴露，关键教训）**：
- 初版路线 A（preset 编译裁行）：orchestrator 模式在 compile.ts 把 `filesystem`/`tool-fs`/
  `persistent-shell` 从 preset 裁掉。**实机失败**——fork #9 `applyChildComposition` 让
  子 Agent `composeFrom(parent.ctx)` **复用父 preset**，preset 裁了什么子 Agent 也没什么
  → 子 Agent 没写工具无法执行；且 worker 子 Agent `denyDirectFs` 要 restrict
  `str_replace_editor`，父 preset 已裁则 fail-loud。
- **修正为路线 B**：preset **恒全量编译**（子 Agent join 后全功能），主 Agent 的裁剪走
  运行时 `agentCtx.tools.restrict`（agent-service `createAgentForTask` 的 orchestrator
  分支），**只作用于主 Agent 自己的 scope**，deny `['str_replace_editor','write','edit',
  'bash',...]`（保留 read/read_image/glob/grep/编排全家/规划辅助）。子 Agent 不受影响。
- **再踩一坑**：deny 名单初版写死含 `pwsh`，但 macOS 不装载 pwsh → `tools.restrict` 对
  未知名 fail-loud（console 报「names unknown global tool pwsh」）。修为平台口径
  （`...process.platform === 'win32' ? ['pwsh'] : []`，与 corumWriteToolsForPlatform 同款）。

**实现**：
1. `profile.ts`：`AgentProfile` 加 `executionTools?: 'full' | 'orchestrator'`。
2. `agent-service.ts`：`createAgentForTask` 的 setup 加 orchestrator 分支 `tools.restrict`
   （deny 执行工具，平台口径 pwsh）。
3. `compile.ts`：`corumSubagentConfig` orchestrator 收紧 worker `maxDepth: 1`（子 Agent
   只执行不再派活，编排收归主 Agent）。
4. `builtin-profiles.ts`：`BuiltinRoleSpec` 加 executionTools/subagentModel/researchModel/
   parallelWork/model 字段；`BUILTIN_ROLES` 加 `deepseek-orchestrator`（编排者 persona：
   绝不亲手执行 + 理解→拆解→派活→裁决工作循环）；`ensureBuiltinRoleProfiles` 透传 +
   system profile 幂等刷新新字段。
5. 模型锁：主 Agent localhost deepseek-v4-pro、子 Agent/research localhost flash。

**验证（2026-09-09 CDP 实机）**：
- 「Deepseek 编排者」出现在 Agent 列表（Corum 内置 27→28）；profile 持久化正确
  （executionTools/模型锁/parallelWork）。
- 编排者**不亲手写文件**：发自然语言并行任务，主树无产出，两个文件写在**两个独立
  worktree**（wt-1b3dcf 的 ORCH-NOTE-1、wt-cca323 的 ORCH-NOTE-2，内容质量高）。
- 子 Agent **有写工具能执行**（路线 B 生效，能建 worktree）；隔离生效（两文件两分支）。
- 编排者 persona 思考体现铁律：「My role is orchestration; I shouldn't do the research
  myself — I delegate research to subagent_research」。
- 6+5 单测全绿（compile-orchestrator 6 例：preset 全量 + maxDepth=1 + full/缺省无回归）。
- **P-D → 已解决（2026-09-09，方案一：integrate 恒前台，删 throw）**：编排者用 continuable
  （background 默认 true），调 integrate 曾撞「integrate must run in foreground」。根因：
  integrate 分支用 `runSpec.runInBackground` 时抛错，要求模型显式 `run_in_background:false`
  压过 continuable 默认后台——把机制成本转嫁模型。且 `integrate` 是 **corum 自研**（官方
  `dsh-tool-subagent` 无此参数、无 worktree/隔离/台账概念），「强制前台」本是 corum 自己
  的阶段性权宜（注释「骨架阶段仅前台路径」）。修正（`index.ts` integrate 分支）：删 throw
  + `runSpec` 读取，integrate **恒由机制强制前台**（fan-in 汇合本质是同步等待点，主 Agent
  须等 merge+verify 结果才能裁决，后台路径拿不到结果无意义），既保 fan-in 语义又消掉
  一类报错。**实机验证**：编排者 `autoIntegrate:true`（continuable 默认后台）完整闭环——
  fan-out 两个 `isolation:always` 写任务（各自 worktree 产出 int-one/int-two）→ integrate
  强制前台顺利合并回主树（ORCH-INT-1/2.txt 落主树）→ verify 通过 → autoCleanup 清理
  worktree，**全程无 integrate 报错**；30 单测全绿 + CDP 零 console 错误。

### 11.19 integrate 机制真值门禁 + 清理安全阀（2026-09-09，数据丢失类缺陷修复）

> 来源：`docs/TODO.md` 高优先项「orchestrate autoIntegrate 合并回主树不可靠」。用户选定
> 「编排器 integrate 可靠化」方向；两项行为决策由用户拍板：① dispose 清理保留未合并分支、
> worktree 无未提交改动才移除目录；② 声明的 `merge.verify` 仍由集成者执行并回报，机制只做
> git 真值校验（不复跑 verify）。

**根因（4 条）**：① 集成成功判定 = 集成者 LLM 的 `stopReason==='completed'`，机制从不看 git；
② 集成分支无条件写 `entry.status='integrated'` 并 `corumCleanupLedgerEntries` →
`worktree remove --force` + `branch -D`（未合并提交变 unreachable，git 级复现过）；
③ `cleanupOnDispose(['active','settled'])` 同一强删路径，且集成路径翻转后不 `persist`
（落盘台账 4 条 `active` 而 worktree 已空、分支已无 = 状态漂移实证）；
④ orchestrate 的 `autoIntegrate` 丢弃 `spawnOne` 返回值，未落地也报 `[task N] done`。

**修复落点**（`packages/plugins/agent/corum-orchestration/src/orchestration.ts` +
`corum-tool-subagent/src/index.ts`）：

| 面 | 内容 |
|---|---|
| 新增纯函数 | `corumGitHead` / `corumGitStatusPorcelain` / `corumBranchMerged`（祖先）/ `corumBranchIntegrated`（祖先 ∪ `git cherry` patch 等价）/ `corumWorktreeHasUncommitted` / `corumIntegrationTruth`（真值门禁）/ `corumIntegrationFailure`（失败报告） |
| 集成分支 | 集成前快照 HEAD + 脏基线 → 集成者 settle 后按 git 实况判定；未达标 **抛错 + 保留 worktree/分支 + 台账保持 settled**；达标才 `orchestration.markIntegrated`（翻转 + `persist` + 可选强清理 = 唯一合法 force 点） |
| 清理安全阀 | `corumCleanupWorktree(cwd, entry, { force })`：非 force 时未合并分支不删、脏 worktree 保留目录；`corumCleanupLedgerEntries` 仅完整清理才标 `discarded`；`cleanupOnDispose` 改非 force |
| persona | `corumIntegratorPersona` 加破坏性 git 命令禁令（`reset --hard` / `checkout .` / `clean -fd` / `stash`）+ 声明机制会独立复核 |
| orchestrate | `autoIntegrate` 分支检查 integrate 结果（非 foreground 抛错），不再把失败当 done |

**验证（真实 git 仓库 + 三层 CDP）**：
- 单测 **48/48**（新增 `corum-tool-subagent/tests/integrate.spec.ts` 18 例，真实临时 git
  仓库驱动，含「写了没提交 → integrated=false」「非 force 保留分支」「force 才删」「台账
  如实」「失败报告含自述 vs 实况」）。
- **CDP 正向**（`/tmp/corum-int-verify` scratch 仓库 + 编排者会话）：单任务 `isolation:always`
  + `autoIntegrate:true` → 主树 `git log` 出现 `Merge wt/wt-a787a0` + `POSITIVE-1.txt`，
  `git branch` 仅 main（门禁通过后才清理）。
- **CDP 负向**（子任务写文件但**不提交**）：orchestrate 返回 `isError`——「integrate did not
  persist into the main tree… worktrees with UNCOMMITTED changes… Worktrees and branches are
  PRESERVED」；主树无新 commit、`wt/wt-82138b` 分支与 worktree（含未提交 `NEGATIVE-1.txt`）
  保留、台账落盘 `active`（如实）；集成者自述被标注「NOT trusted as evidence」。
- **CDP 第三路**（UI 探针同构）：主树无 `UI-PROBE.txt`，worktree `wt-385509` 保留。
- 两包 typecheck + build 绿；console 零报错；无 renderer 改动（宿主侧，重启应用生效）。

**顺带发现（已单独立项 `docs/TODO.md`）**：`subagent/end` 监听签名错误——fork #9 声明父
Agent 是 dispatch 的 `this`（scope carrier）而非第二参数，`settleFromEnd` 恒收 `undefined`
并抛错（被 emitter 吞掉）→ **settle 联动实机从未生效**（子 Agent 结束后台账仍 `active`，
`maxParallelChildren` 因此把已结束的子 Agent 计入额度）。修法：`carrierKeyOf(this)` +
spawn 后绑定 `entry.runId` 精确 settle。

---

### 11.20 台账 settle 联动修复 + 死条目剔除（2026-09-09）

> 来源：§11.19 实机验证中顺带暴露（落盘台账条目在子 Agent 结束后仍为 `active`）。用户
> 选定「继续」后落地。缺陷性质：台账状态不实 + `maxParallelChildren` 被已结束的子 Agent
> 长期占用。

**根因（两半）**：
1. **监听签名错误**：`ctx.on('subagent/end', (info, parentAgent) => …)` —— fork #9 的声明
   是 `'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo)`，**父 Agent
   是 dispatch 的 `this`（scope carrier）**，发射端只 `callback(info)`（`lifecycle.ts`）。
   `parentAgent` 恒 `undefined` → `settleFromEnd` 抛错 → 被 emitter 的 per-listener 容错
   吞掉 → settle 永不发生。
2. **匹配面过窄**：条目先于 `subagents.start` 创建（request 需 worktree 路径），`runId`
   恒空，只能靠「唯一 active 回退」——≥2 个并行隔离任务必然失败。

**修复落点**：

| 面 | 内容 |
|---|---|
| 监听 | 改普通函数取 `this`，`carrierKeyOf(this)`（`@deepseek-ai/dsh-scope`；tsdown 已 external，与 corum-subagent 同实例）解出父 Agent |
| `settleFromEnd` | `parentAgent?` 可选 + 绝不抛错；缺失时 `info.id` 经 `agents` 服务反查 `session.header.parentSession` 兜底（局部能力接口收窄，红线 3） |
| `bindRunId` | 新增 service 方法：spawn 返回后绑定 run/child id（前台绑 `run.id`、continuable 绑 `childId`、后台 job 在 start 解析时绑）；幂等 |
| `corumMarkSettled` | 先按 runId 再按 childId 精确匹配（并行安全），回退分支仅留给未绑定 id 的存量条目 |
| 死条目剔除 | 新增 `corumEntryDead(cwd, entry)`（worktree 目录与分支都不存在 = 彻底失效）；`entriesOf` 读取时剔除并落盘——旧强删清理遗留的 `active` 条目会永久占用并发额度 |

**验证（三层 CDP + 单测）**：
- 单测 **58/58**（新增 10 例：并行精确匹配 3 / bindRunId+carrier 兜底 4 / 死条目 3）。
- **CDP 多轮**：scratch 仓库会话 3 轮 × 2 个并行隔离任务（无 autoIntegrate）→ 6 条台账
  条目全部 `settled` 且各带独立 `runId`（修复前恒 `active`）；无 `limit reached`、console 零报错。
- **CDP 死条目实证**：修复前 `corum-task-7cebf463`（3 条死条目）跑 2 任务 → 第 2 个撞
  `parallel child limit reached`；prune 修复后同会话再跑 2 任务 → **两个都 done**，落盘
  台账的死条目已剔除。
- 两包 typecheck + build 绿；无 renderer 改动（chip 的数据面即台账条目，帧发射路径未改）。

**遗留（未做，非阻塞）**：chip 的实机截图本轮未重拍（帧为瞬态、非回放；renderer 零改动）。
「app 重启后旧死条目在下次 spawn 才被剔除」是设计如此（读取时 prune，不额外扫盘）。

---

## 13. 待执行重构（2026-09-09 盘点定调，PLAN 已就绪，放新会话执行）

> 来源：架构盘点（用户问「目前的功能分布在哪些插件上，切得是否合理」）后的两项
> 重构决策。完整执行依据：`docs/plan/PLAN-refactor-orchestration-package-and-settings-center.md`。
> **状态：已执行（2026-09-09 新会话按 PLAN 落地，见 §13.1 / §13.2 验证记录）。**

**盘点结论**：corum 插件切分整体合理（seam `corum-subagent` / 工具 `corum-tool-subagent` /
UI / host 四层边界清晰，符合红线与官方 fork 继承纪律）。唯二优化点即下两项重构。

**重构 1 · 拆出 `@corum/corum-orchestration`（编排器独立包）**
- 现状：`CorumOrchestration`（台账 service + 10 个隔离纯函数 + storage domain）住在
  `corum-tool-subagent/orchestration.ts`（工具包）。编排器更像 seam 与工具间的独立
  「编排层」，应拆出。
- 影响面（已查证，很小）：运行时耦合仅 tool-subagent 自身 + 单测；其它消费方
  （corum-api-remotes / ui-chat / sidebar / conversation）均 type-only，经
  `corum-api-remotes/corum-events` 自包含同构声明解耦，不直接 import orchestration.ts。
- 决策：**新包自己挂 cordis 行 provide**（cordis.patch.yml insert，行序在 tool-subagent
  双实例前；tool-subagent 改「只读不建」）；服务名 `corumOrchestration` 不变；
  `corum-tool-subagent/orchestration.ts` 改 re-export（单测/下游零破坏）。

**重构 2 · 设置中心统一 section 扩展机制 + 拆文件**
- 现状：`SettingsSections.tsx`（3038 行）19 个 section 塞一处 + `SECTION_DEFS` 硬编码 +
  `SettingsShell` 的 `NAV_GROUPS` 硬编码 id→分组映射（「插件」「子 Agent」落「其他」组）。
- 目标（用户定调）：设置中心面板提供统一 section 扩展机制（cordis slot `settings.section`，
  已存在）；每个 section 独立成文件统一注册；**归属分组由 section 自声明**（`SectionDef`
  加 `navGroup` 字段），**没声明的统一放「扩展」**。
- 分组（保持 5 组）：通用 / AGENT / 数据与隐私 / 扩展 / 高级；**「插件」入口去掉**；
  **「插件管理 / skill / MCP」归「扩展」**（Agent 的扩展）；**「子 Agent」归「AGENT」**；
  「其他」组消失（所有 section 有归属）。
- 全拆：19 个 section → `settings/sections/<Name>Section.tsx`，`SettingsSections.tsx`
  瘦身为共享面（CorumSettingsContext/useCorumSettings/共享组件）+ 聚合注册。

**执行约定**：新会话按 PLAN 文档自驱动——先重构 1 后重构 2，每个各自
「typecheck → 单测 → build → CDP 实机三层验证（UI 渲染 + 行为 + 零 console 错误）」，
全部通过再进下一个；完成后回本文件登记 §13 为「已执行」并补验证记录。

### 13.1 重构 1 执行记录（已交付）

**拆包**：
- 新包 `packages/plugins/agent/corum-orchestration/`（name `@corum/corum-orchestration`，
  cordis 插件）：`src/orchestration.ts`（从 tool-subagent 整体迁入，含 `CorumOrchestration`
  service + 10 个纯函数 + `corumOrchestrationDomainSpec` + 台账类型 + `'corum/worktree-ledger'`
  事件声明）；`src/index.ts` 挂 cordis 行（`apply` 在根上下文幂等 provide `corumOrchestration`）
  + re-export 全部纯函数/类型/domain；`package.json` / `tsconfig.json` / `tsdown.config.ts`
  （照 tool-subagent 模板，deps：cordis/dsh-agent/dsh-storage-domain/dsh-subagent/zod）。
- `corum-tool-subagent/src/orchestration.ts` 改为 re-export 垫片（从新包 re-export，
  保持 `index.ts` 内部 import 路径与单测 `from '../src/orchestration.ts'` 不变，零破坏）。
- `corum-tool-subagent/src/index.ts` 的 apply 由「幂等自建兜底」改为「只读不建」：
  `ctx.root.get('corumOrchestration')`，缺则抛装配错误（顺序由 patch.yml 行序承担）。
- `packages/desktop/cordis.patch.yml` insert 段在 `corum-tool-subagent` 双实例行之前挂
  `- id: corum-orchestration`（name `@corum/corum-orchestration`）。
- `packages/desktop/package.json` + `corum-tool-subagent/package.json` 加 workspace 依赖，
  `pnpm install --no-frozen-lockfile` 链接。

**验证**：新包 + tool-subagent typecheck ✓；单测 isolation.spec 30 例全绿 ✓；新包 +
tool-subagent build ✓；desktop typecheck + build ✓（顺带修复 desktop 侧 pre-existing
WIP 的 `corum-git.ts` `this.logger`→`this.ctx.logger` 3 处，使 desktop typecheck 恢复
可跑）。**CDP 实机**：boot 零 console 错误 + orchestrate 写任务隔离建 worktree 正常
（`wt-b8303c` 创建 + 台账落盘 `corum_orchestration/ledger`）+ 台账 chip 渲染 +
`corumOrchestrationDomainSpec` 落盘（存量 `version:1` record 完好）+ 挂载顺序正确
（tool-subagent apply 读 `corumOrchestration` 不抛）。

### 13.2 重构 2 执行记录（已交付）

**拆文件**：
- `SettingsSections.tsx`（3038 行）拆为 19 个 `settings/sections/Settings*Section.tsx`
  独立文件 + `settings/shared.tsx`（共享面：CorumRpcContext/CorumSettingsContext/
  SectionNavContext/useCorumRpc/useCorumSettings/useSectionNav/GlassButton/InfoCard）+
  `settings/types.ts`（跨 section 共享的 skill/MCP 投影类型）。`SettingsSections.tsx`
  瘦身为 `SECTION_DEFS` 聚合 + `NAV_GROUP_BY_ID` 分组数据源 + 共享面 re-export。
- `SectionDef` 加 `navGroup?: SettingsNavGroup` 自声明分组；19 个 section 全量映射
  （subagent→agent、mcp/skills/extensions→extensions、models→agent 等，见 PLAN 表）。
- `SettingsShell.tsx`：删除硬编码 `NAV_GROUPS` id 列表，改为读 `NAV_GROUP_BY_ID`
  （section 自声明），缺省归 `extensions`；「其他」桶删除（所有 section 有归属）。
- 去掉「插件」入口：`corum-ui-settings-plugins` 不再注册 `settings.section`（id=plugins），
  其「插件配置」tab（含 Bash/Agent Loop/Web Search 三卡）与官方 plugin-inventory「插件
  列表」tab 经共享槽 `settings.plugins.tab` 并入 `corum-ide-ui` 的「插件管理」扩展
  section（ExtensionsSection 声明并渲染 `settings.plugins.tab`）。
- 顺带修复 corum-ide-ui pre-existing 的 4 处 dsh 0.1.3 类型漂移（`(s: unknown)=>s`
  选择器模式 + `SessionListState` 结构漂移，见 AppFrame.tsx `panels`、SettingsShell.tsx
  三处 useSections/useOnboardingSteps/useSessions），使 corum-ide-ui typecheck 恢复可跑。

**验证**：corum-ide-ui + corum-ui-settings-plugins typecheck ✓；两包 build ✓。
**CDP 实机**：设置面板 5 组渲染正确（通用/AGENT/数据与隐私/扩展/高级）；「子 Agent」
在 AGENT 组；「插件管理/技能/MCP」在扩展组；无「其他」组；无「插件」入口；「插件管理」
内三张配置卡 + 插件列表（含 `@corum/corum-orchestration`）渲染；「工作区」git 开关在
通用组可读写（settings.mutate 落盘）；console 零错误。

---

## 14. 第 12 个 fork 包：`@corum/corum-ui-trajectory`（2026-09-09，轨迹按钮 → 右侧区域 `corum.trajectory`）

> 来源：`docs/HANDOFF-0.1.3-upgrade.md` §5「唯一未完项」——轨迹功能形态从
> conversation.view 的「对话 / 轨迹」tab 改为「右上角轨迹按钮 → details 独立抽屉」
> （2026-09-07 用户定调）。交接文档的续做路径（在 details 槽手工装配官方
> `TrajectoryView` 的 props）经核实有**框架硬约束**：官方组件内部调
> `renderSlot('conversation.trajectory.images', …)`，而槽位系统规定一个槽只能被声明一次
> （`ui-slots/src/index.ts:860`），该槽已被官方 ui-trajectory 在其 conversation.view
> 条目下声明；且 `renderSlot` 对未声明键抛 `SlotOwnershipError`。据此用户拍板方案 C：
> **fork 官方包、把注册点迁到 details 形态**。

**包**：`packages/plugins/session/corum-ui-trajectory`（name `@corum/corum-ui-trajectory`，
fork 自 `@deepseek-ai/dsh-client-ui-trajectory` 0.1.3-alpha.1）。

**差异面（39 文件 vs 官方 37 文件）**：

| 分类 | 内容 |
|---|---|
| 仅 import 改名（13 文件） | `@deepseek-ai/dsh-client-ui-conversation/client` → `@corum/corum-ui-conversation/client`（每文件 2-4 行；官方 ui-conversation 在 IDE 模式被 fork 取代） |
| 实质修改（2 文件） | `src/client/index.ts`：**不注册 conversation.view**（保留全部 ctx 级注册：轨迹节点定义 / request-header / assistant / tool / compaction 定义、conversation view 构建器、locale 字典、`uiSession.provide` trajectory hook）；`src/index.ts`：host 半注释 |
| corum 新增（1 文件） | `src/client/TrajectoryRegion.tsx`（+ `.module.css`）：注册 `corum.trajectory` 区域 occupant。**二轮修正**：抽屉形态下曾用 `src/client/view.ts`（`exports["./view"] → TS 源码`）把组件暴露给 chat 的 details 槽；改为区域后该出口与文件已删除——组件与 occupant 同包，不需要跨 bundle 值导出 |
| 其余 | 逐字节相同 |

**rebase 风险：低**。升级官方时：`sed` 一把梭改 import 路径 + 重放 `index.ts` 的
「删 conversation.view 注册」补丁（两处，已用 `// fork（corum）：` 注释锚定）。

**接线（2026-09-09 二轮：抽屉 → 独立区域，用户定调「抽屉不好用，做成类似编辑器/资源管理器的区域，整个右边弹出」）**：

| 面 | 改动 |
|---|---|
| `cordis.ide.patch.yml` | 顶层 `- id: ui-trajectory disabled: true`（与 fork 互斥：槽声明唯一）+ insert 块 `- id: corum-ui-trajectory` |
| `corum-ide-ui`（壳） | `IDE_GRID_SLOTS` + `registerSlot('corum.trajectory', {label:'轨迹', minWidth:320, visibility:'fixed'})` + 默认网格右列 `[编辑器, 轨迹, 终端]`；SlotMap + root children 声明 `'corum.trajectory': { kind:'single', scope:'session-maybe' }`；`DEFAULT_HIDDEN` 加该槽；右上角轨迹按钮 → `toggleRegionVisibility(['corum.trajectory'])`，且**仅开发者模式可见**（`useDeveloperMode()`；关闭时按钮消失并自动收起区域） |
| `corum-ui-trajectory`（fork） | `apply` 注册 `corum.trajectory` occupant（`session-maybe`：无当前会话时空态），声明 `conversation.trajectory.images` 子槽（ui-attachment 经 inject 跟进注册），按会话解析轨迹快照源 + duration store |
| `corum-ui-chat` | **零改动**（抽屉方案的 DetailsPanel tabs / inject 面 / details 子槽全部回退；`details/trajectory-details.ts` 骨架一并删除） |

**关键教训（实机两处，都已修）**：
1. **依赖方向**：初版把视图状态服务放 chat 侧、壳 inject → chat inject `layout`（壳 provide）
   ↔ 壳 inject `trajectoryDetails`（chat provide）**循环等待**，boot 报 7 插件 pending。
   抽屉方案废弃后该服务随之删除（区域形态不需要壳↔chat 通信）。
2. **样式注入的插件 id 必须动态取**：`scripts/inline-css.mjs` 从 corum-ui-chat 拷贝时把
   `data-plugin` 写死成 `@corum/corum-ui-chat`，轨迹区域的 CSS 被注入到错误的标签下 →
   区域样式全无、内容被卡片 `overflow:hidden` 裁掉（实测 region 高 10372px vs 卡片 860px）。
   已改为从 `package.json` 的 `name` 读取。
3. **区域 occupant 的根节点不要写 `height:100%`**：网格 occupant 的父节点是
   `display:contents`（无盒子），百分比高度退化成 auto；用 `flex:1 1 auto; min-height:0`
   让区域撑满并内部滚动（实测修复后 region 858px、内部 tablePane 776/1578 可滚）。

**验证（三层 CDP）**：
- 全仓 35 包 typecheck 绿；三包（fork / chat / corum-ide-ui）build 绿。
- boot：fork 在 client entries 内、无插件 pending、console 零报错。
- 行为：点右上角轨迹按钮 → **右侧区域点亮**（`corum.trajectory` 叶子 x=809/w=471/h=860，
  与编辑器/终端同列同构；默认隐藏），官方轨迹视图完整渲染——工具条「时长/轮次/调用」+
  列头「输入/模型/工具」+ 真实轮次（第 1 轮 / 上下文 / 用户 / 助手 / 初始系统提示词），
  内部滚动容器 776/1578 可滚，文案全部走 trajectory 字典。
- details 抽屉回到纯工具详情（无「轨迹」tab）；官方「对话 / 轨迹」tab 已随
  `ui-trajectory` 禁用而消失；console 全程零报错。
- **开发者模式门禁**（2026-09-09 用户要求「轨迹按钮只在开发者选项开启时才看得到」）：
  开发者模式关 → 按钮不渲染（会话已打开也不渲染）；开 → 按钮出现、点击点亮区域；
  开着区域时再关 → 按钮消失**且区域自动收起**（按钮是唯一开关，避免区域无法关闭）。
  开关读 `settings/developer-mode.ts` 的 `useDeveloperMode()`（同 bundle，localStorage
  `corum.settings.developerMode` + 同 bundle 事件）。CDP 三条路径全部验证通过。

---

### 11.21 编排四项实机问题修复（2026-09-09，用户实机反馈 + 子 Agent 自述限制）

用户一条消息报四项（单任务无谓隔离 / 进不去子会话 / 隔离子 Agent 提交不了 / 汇报不可见）。
完整根因、验证与踩坑见 `docs/TODO.md`「子 Agent 编排四项实机问题」；此处只登记 fork #10
（本包）的实质 diff 增量，供升级 rebase 对照。

**`src/index.ts` 增量（fork 分区之外新增三处）**：

| 位置 | 增量 | 说明 |
|---|---|---|
| `spawnOne` 入参 | `fanoutCount?: number`、`notifyParent?: boolean` | 并发信号① / 通知开关（orchestrate 任务与 integrate 传 false） |
| 隔离判定 | `corumShouldIsolate(..., concurrent)` | 四个并发信号（fan-out ≥2 / 后台 / 台账 active / 在跑非隔离开写子 Agent） |
| 非隔离写任务 | `[corum orchestration]` prompt 前缀 | 主工作区直连时禁止 git 操作（父可能有无关联改动） |
| `corumEmitChildStarted` | 新事件 `corum/subagent/child` | 按父侧 `callId` 广播 `childSessionId`（前台/continuable/后台三路径） |
| `corumNotifyForegroundResult` | settlement notice 注入 | 前台 settle 后 `parent.inject()` 一条 `subagent-settled` notice |
| 写子 Agent 计数 | `orchestration.beginWriteChild/endWriteChild`（finally 释放） | 并发信号④ |

**跨包配套**：`corum-orchestration` 纯函数签名 + 计数方法；`corum-api-remotes`
（事件声明 + allowlist 第 20 条）；`corum-ui-chat`（`subagentChildSubscribe` +
`subagentChildOf` 缓存 + 卡片 `useLiveChildSessionId` + apply 预热订阅 + fold 精确优先）。

**验证**：`docs/TODO.md` 同条（CDP 三层 + 真内核 + 单测 62 例）；`verify-fork-drift.sh`
§4 已登记本事件 emit 面映射。

---

## 15. 第 13 个 fork 包：`@corum/corum-sandbox-local`（2026-09-09，隔离子 Agent 的 git 提交）

| 项 | 值 |
|---|---|
| 官方对照包 | `@deepseek-ai/dsh-sandbox-local` |
| 官方基线 | 0.1.3-alpha.1（源码基线 = dsh 检出 `packages/sandbox/sandbox-local`） |
| 文件数 | 2 官方文件 + 1 corum 新增模块 |
| 逐字节相同 | `src/index.ts`（**完整官方文件，零增量**） |
| 实质修改 | `src/profiles.ts`（3 个 builder 并集可写根 + 1 行 import） |
| corum 新增 | `src/git-write-roots.ts`（git 元数据根探测 + 缓存） |
| rebase 风险 | **低**（增量集中在 60 行的 profiles.ts + 独立新模块；官方改 profiles 时按 §5 第 3 步三方合并） |

**动机（2026-09-09 用户实机复现）**：官方可写根 = `writableRoots(policy)` =
`[workspaceRoot, /tmp, tmpdir()]`；隔离 worktree 的 cwd 是
`<repo>/.corum-worktrees/wt-xxxx`，而 `git add/commit` 要写的是**主仓** `.git`：
`worktrees/<slug>/index.lock`、`objects/**`、`refs/heads/<branch>`、`logs/**`——全部在
workspace 之外。Seatbelt 直接 EPERM（实测 `fatal: Unable to create
'.../index.lock': Operation not permitted`），子 Agent 永远提交不了，「子 Agent 提交 →
集成者合并」的隔离语义整条断裂。

**修复**：`corumGitWriteRoots(policy)` 在 `workspace-write` 下按 `policy.workspaceRoot`
跑一次 `git rev-parse --git-dir --git-common-dir`（2s 超时 + 进程内缓存），把两个目录
canonical 化后并集进 Seatbelt `(subpath …)` / bwrap `--bind` / Landlock `readWrite`。
非 git 目录 / git 缺失 / 超时 → 空数组（能力自动关闭，绝不抛错）。

**边界（有意为之）**：授予整个 common dir（含 config/hooks）——一次 commit 会触碰
objects/refs/logs 多处，逐文件白名单既脆又慢；DSH 沙箱定位是 containment 不是安全边界。
**父工作区仍写不进去**（实测：worktree 文件 OK / `.git` OK / 主树文件与 tracked 文件 EPERM）。
Windows 的 windows-acl runner 只接受单个 `--workspace` 根（runner 协议），本函数对它无效，
Windows 上隔离子 Agent 的 git 提交仍不可用（登记为已知限制）。

**装配**：desktop overlay 禁官方 `sandbox` 行 + insert `corum-sandbox`
（`name: '@corum/corum-sandbox-local'`）；服务名 `sandbox` 不变 →
`dsh-bash-sandbox` / `dsh-terminal-bash` / `dsh-pwsh-sandbox` 对 `ctx.sandbox` 的消费零感知。
`packages/desktop/package.json` 加 workspace 依赖。

**验证**：
- 真内核（`sandbox-exec`，repo 不在 /tmp）：官方 profile `git add` EPERM；corum profile
  `git add && git commit` 成功；主树写入仍 EPERM。
- 单测 8 例（worktree gitdir+common、主仓、非 git、read-only、缓存、三平台 profile 参数）。
- CDP：orchestrate 2 任务的两个子 Agent 均成功 commit 并被集成合并；后台委托正确隔离。
- 守卫：`scripts/verify-fork-drift.sh` §15（index.ts 逐字节一致 / profiles 含标记 /
  git-write-roots 有探测 / 装配行与 desktop 依赖在位）。
