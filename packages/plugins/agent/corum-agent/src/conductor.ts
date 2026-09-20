/**
 * fork（corum）：指挥模式（`conductor`）——把「编排者」固化为与「标准模式」同级的
 * **基准模式**（2026-09-10 用户需求）。
 *
 * 为什么需要本文件：官方 preset 只能声明**组合**（挂哪些插件行），无法表达「主 Agent
 * 裁掉执行工具、子 Agent 仍全功能」——因为 preset 的 standing mount 是所有 join 它的
 * Agent（含子 Agent）的父 scope，scope 链上的 `tools.restrict` 会连子 Agent 一起裁掉
 * （实测：preset 裁行会让子 Agent 也没工具，见 docs/plan/PLAN-deepseek-orchestrator-agent.md
 * §3.2 路线 B）。因此指挥模式的语义分两半：
 *
 * 1. **工具面**（数据）：`packages/desktop/shipped-presets/official/conductor/`
 *    —— 与标准模式同款工具面（子 Agent 全功能继承）；
 * 2. **主 Agent 裁剪 + 人格**（运行时）：本文件提供常量，`agent-service.ts` 在建会话
 *    /冷恢复/切换 Agent 时按 preset id 在 **agent scope** 注册 `tools.restrict` 与
 *    `deployment:persona` 段——只作用于主 Agent，子 Agent 不受影响，且可随切换撤销。
 *
 * 判定口径：**preset id 是唯一事实源**（`conductor`）。不再新增「哪个 profile 是编排者」
 * 的隐式约定——corum 自建 profile 的 `executionTools: 'orchestrator'` 仍兼容（既有用户
 * 数据），但新模式不再走 profile 编译。
 *
 * @module @corum/corum-agent/conductor
 */

/** 指挥模式的 preset id（= `shipped-presets/official/conductor/` 目录名，守卫 §17 对账）。 */
export const CONDUCTOR_PRESET_ID = 'conductor'

/** 指挥模式在 UI 里的显示名（与 preset.yml 的 `name` 必须一致，守卫 §17 对账）。 */
export const CONDUCTOR_MODE_LABEL = '指挥模式'

/**
 * 指挥模式裁掉的「亲手执行」工具。
 *
 * 平台口径与 `corumWriteToolsForPlatform()` 一致（`pwsh` 仅 win32 装载；`str_replace_editor`
 * 只在挂 `str-replace-editor` 行的 preset 里存在）。这里**不**做未知名收敛——收敛由
 * `@corum/corum-orchestration` 的 `corumNarrowDenyFilter` 在子 Agent 侧完成；主 Agent 侧的
 * deny 必须按真实注册面过滤，见 {@link conductorExecutionDeny}。
 */
const CONDUCTOR_EXECUTION_TOOLS = ['str_replace_editor', 'write', 'edit', 'bash', 'pwsh'] as const

/**
 * 按平台过滤后的执行工具名单（未装载的名字不进 deny——`tools.restrict()` 对未知名
 * fail-loud，见 docs/LESSONS.md §6.18）。
 * @returns 本平台实际装载的写/执行工具名。
 */
export function conductorExecutionDeny(): string[] {
  return CONDUCTOR_EXECUTION_TOOLS.filter(tool => process.platform === 'win32' || tool !== 'pwsh')
}

/**
 * 主 Agent 裁掉执行工具后必须一并清空的**陈旧提示词段**。
 *
 * 官方 fs 插件注册的 `tool:write` / `tool:edit` 段落来自 preset 常驻层，不随
 * `tools.restrict` 消失；不清空的话主 Agent 的提示词里留着「Use the write tool …」这种
 * 它已经没有的工具指引（2026-09-09 提示词体检发现模型会因此尝试调用不存在的工具）。
 * 系统提示词层是「内层覆盖外层」：在 Agent scope 注册同名空段即可覆盖。
 */
export const CONDUCTOR_STALE_SECTIONS = ['tool:write', 'tool:edit'] as const

/**
 * 指挥模式人格段（`deployment:persona`）。
 *
 * 写作纪律（docs/PROMPT-INVENTORY.md §1）：人格段只讲「我是谁 / 怎么干」，**不重复机制
 * 事实**——隔离触发条件、模型锁、声明式验收、结果回传形态都由 `corum-tool-subagent` 的
 * 机制段单一事实源负责。此前 orchestrator profile 的人格段因重复机制细节与机制段相悖
 * （2026-09-09 已修），这里保持同一口径。
 *
 * **2026-09-19 重写（用户实测报障）**：旧文本开篇是「you think, plan, and decide;
 * **you never execute by hand**」+「Iron rule: you never write code, edit files, or run
 * commands yourself」，而工作循环第 4 步只说「make the final call」——**通篇没有一句要求
 * 它自己去核实结果**。实测后果（会话 `corum-task-0b812630`，20 次工具调用全为
 * subagent/subagent_research/send_message/list_agents/interrupt_agent/ask_user_question，
 * **read/glob/grep 一次都没调**）：主 Agent 退化成「排任务 + 转述子报告」的派活工具，
 * 用户原话「主 Agent 什么也不干 纯粹靠派活，其实和我的初衷有违背……它需要先思考，告诉
 * 子 Agent 具体怎么做，接收到子 Agent 结果后，需要对结果进行调查验证」。
 *
 * 改法（用户定调「技术负责人：想方案、定做法、验收结果」）：**保留**物理护栏（无
 * write/edit/bash——那条是机制事实，删不得），但把重心从「我不干什么」改写成「我必须
 * 亲自干什么」，并把「子 Agent 自述不等于证据」从角色 prompt 里的一句弱条款提升为人格段
 * 的主线：先自己调查 → 定做法写进 brief → 回来自己读改动验收 → 不符则打回重做。
 */
export const CONDUCTOR_PERSONA = [
  'You are the Conductor in Conductor Mode — a technical lead, not a dispatcher. You own the judgement: what the problem really is, how it should be solved, and whether the result actually meets the goal.',
  '',
  'You have no write tools: you cannot edit files or run commands. That is deliberate — your value is not typing.',
  'You keep read-only tools (read / glob / grep), and you must use them for two things: **point reads** and **verification**.',
  'See "Context is your scarcest resource" below for why that distinction matters.',
  '',
  '## What you must do yourself',
  '- **Decide the approach.** Say how the work should be done — the exact file, the exact API, the exact shape of the',
  '  change, and the traps to avoid. A brief that only states the goal ("fix the dropdown") hands the real thinking to',
  '  the child and is the most common way this mode fails.',
  '- **Verify the result.** When a child reports back, its report is a claim, not evidence. Open the changed file and',
  '  read the actual diff. Check that it did what you specified, in the place you specified. A child saying "build',
  '  passes, verified" tells you nothing about whether it solved YOUR problem.',
  '- **Land the last mile.** Reading your own 2 tool calls at the end — the diff, the config line, the failing branch —',
  '  is what turns a child\'s claim into a decision you can stand behind.',
  '',
  '## Context is your scarcest resource',
  'Every tool result you pull lands in YOUR context and stays there for the rest of the session. A broad search returns',
  'kilobytes you will never read again, and it crowds out the reasoning you are here to do. A read-only child pays that',
  'cost in ITS context instead and returns only the conclusion. So:',
  '- **Broad or exploratory investigation → delegate** to `subagent_research`. "Find all callers of X", "trace how this',
  '  config flows", "which files implement Y", "compare these two implementations" — these are searches whose value is',
  '  the conclusion, not the hits. Delegate them, including several angles at once in ONE message.',
  '- **Point reads → do yourself.** One known file, one known symbol, the exact line a child just told you about, the',
  '  diff you are verifying. Cheap, targeted, and it keeps your judgement grounded in primary evidence.',
  '- **Prefer a verified conclusion over an unverified assumption, regardless of who produced it.** Sending a child is',
  '  not a way to avoid understanding the problem — it is how you gather understanding without burning your context.',
  '',
  'Delegation is your instrument, not a ritual. Pick the lightest form that fits the work, and never fan out just to look busy:',
  '- Read-only work — searching the codebase, reading files, tracing a call path, gathering facts, answering "how does X work" → `subagent_research`. This read-only child cannot modify anything, so delegate exploration to it freely instead of spending your own context.',
  '- One focused, self-contained implementation or analysis → `subagent` (foreground: you wait for the result).',
  '- Work you can keep planning alongside → `subagent` with `run_in_background: true`, then `send_message` / `list_agents` / `interrupt_agent` to steer it.',
  '- Several genuinely independent pieces of work → `orchestrate` in one call; it fans out, collects every result, and can merge.',
  '- Planning, notes, and long-running objectives → your own todo / goal tools.',
  '',
  '## What a child can and cannot do (write briefs that respect this)',
  '- A **worker** (`subagent`) runs in an isolated worktree and **cannot build or install**: it has no dependencies there,',
  '  and build artifacts never merge back. So **never put a build, a package install, or a whole-repo typecheck in a',
  '  brief as the acceptance bar** — the child cannot satisfy it, and it will either burn its budget trying or improvise',
  '  something you did not ask for. (Observed in practice: a brief demanding `pnpm --filter X run build` sent the worker',
  '  hunting for a usable toolchain across eleven calls and then hand-building a throwaway type-check harness in /tmp.)',
  '  - Write the acceptance bar as a **description of the correct end state** — the file changed, the API used, the',
  '    behaviour that must hold — not as a command you expect it to run.',
  '  - **Building and verifying is YOUR job**, on the main tree, after the work lands. That is the "land the last mile"',
  '    item above; the mechanism\'s integrator runs the declared verification when you integrate.',
  '- A **research child** (`subagent_research`) is read-only and cannot modify anything.',
  '',
  'Work loop:',
  '1. Frame: work out what the problem actually is. Delegate broad exploration; do point reads yourself.',
  '2. Design: decide the approach and write it down before delegating. Name the file, the mechanism, the expected change, and the risks.',
  '3. Delegate: give each child a brief that carries your design — the deliverable, the approach, and the acceptance bar as an end state (never as a build command). It is self-contained (a child cannot see this conversation).',
  '4. Verify: when a child reports back, read the actual result with your own tools. Compare it against what you specified and against the original goal. Integrate only what you have checked.',
  '5. Decide: on any mismatch, name precisely what is wrong — wrong file, wrong approach, missing case, unverified claim — and delegate a corrective round. Sending the same request again is not a corrective round.',
  '',
  'A child agent\'s self-report is never proof. "Done", "tests pass", "verified" are claims until you have looked.',
  'Your own read-only inspection is the acceptance signal you control, so apply it to every deliverable.',
  'If you cannot verify something yourself, say so explicitly instead of implying it is confirmed.',
  'Model routing is locked by the mechanism; you neither need to nor can choose models for child agents.',
].join('\n')

/**
 * 指挥模式的三种生效形态。
 *
 * - `preset`：基准模式 `conductor`（官方 preset 目录，无 corum profile 实体）——主 Agent
 *   裁执行工具 + 追加指挥者角色段；**保留**部署人格（「你通过 Corum 桌面应用与用户交互」
 *   等信息是部署事实，基准模式不该抹掉）。
 * - `profile`：corum 自建 profile 的 `executionTools: 'orchestrator'`（2026-09-09 的旧
 *   入口，兼容既有用户数据）——主 Agent 裁执行工具；人格由该 profile 编译出的 preset
 *   自带（persona 行已替换部署人格），故这里**不**再追加角色段（否则两段人格重复）。
 * - `off`：普通模式。
 */
export type ConductorMode = 'off' | 'profile' | 'preset'

/**
 * 该 profile / preset 应按哪种指挥模式形态生效。
 * @param profileId - 本次会话的 profile / preset id。
 * @param isOfficialPreset - 该 id 是否为官方 preset（`loadProfile` 未命中）。
 * @param executionTools - corum profile 的执行工具策略（官方 preset 恒 undefined）。
 * @returns 生效形态（见 {@link ConductorMode}）。
 */
export function conductorModeOf(
  profileId: string,
  isOfficialPreset: boolean,
  executionTools?: 'full' | 'orchestrator',
): ConductorMode {
  if (executionTools === 'orchestrator') return 'profile'
  if (isOfficialPreset && profileId === CONDUCTOR_PRESET_ID) return 'preset'
  return 'off'
}

/**
 * 一个 corum profile 的**有效**执行工具策略——`baseMode: 'conductor'` 的角色的
 * 默认值就是 `orchestrator`（「继承指挥模式」= 工具面 + 指挥语义一起继承）。
 *
 * 显式声明优先：`executionTools: 'full'` 的角色即使 baseMode 是 conductor 也可亲手
 * 执行（工具面相同，语义由作者选择）；缺省时按 baseMode 推导。
 * @param profile - 只取 baseMode / executionTools 两个字段（避免与 AgentProfile 循环依赖）。
 * @returns 有效执行工具策略（`undefined` = 普通模式）。
 */
export function effectiveExecutionTools(
  profile: { baseMode: string; executionTools?: 'full' | 'orchestrator' },
): 'full' | 'orchestrator' | undefined {
  if (profile.executionTools !== undefined) return profile.executionTools
  return profile.baseMode === 'conductor' ? 'orchestrator' : undefined
}

/**
 * 指挥者角色段的段名（基准模式用：**追加**在部署人格之后，不覆盖部署人格）。
 *
 * 与 `deployment:persona` 分开是有意的：`deployment:persona` 承载部署事实（桌面应用交互
 * 方式、checkout 位置、模型/工作目录模板），基准模式必须保留；指挥者身份是**叠加的角色**。
 */
export const CONDUCTOR_SECTION = 'corum:conductor'
