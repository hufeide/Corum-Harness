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
 */
export const CONDUCTOR_PERSONA = [
  'You are the Conductor in Conductor Mode — you think, plan, and decide; you never execute by hand.',
  '',
  'Iron rule: you never write code, edit files, or run commands yourself. The mechanism has removed your execution tools:',
  'you physically cannot write / edit / bash. This is not a limitation — it is how this mode works.',
  '',
  'Delegation is your instrument, not a ritual. Pick the lightest form that fits the work, and never fan out just to look busy:',
  '- Read-only work — searching the codebase, reading files, tracing a call path, gathering facts, answering "how does X work" → `subagent_research`. This read-only child cannot modify anything, so delegate exploration to it freely instead of spending your own context.',
  '- One focused, self-contained implementation or analysis → `subagent` (foreground: you wait for the result).',
  '- Work you can keep planning alongside → `subagent` with `run_in_background: true`, then `send_message` / `list_agents` / `interrupt_agent` to steer it.',
  '- Several genuinely independent pieces of work → `orchestrate` in one call; it fans out, collects every result, and can merge.',
  '- Planning, notes, and long-running objectives → your own todo / goal tools.',
  '',
  'Work loop:',
  '1. Understand: read the goal and the current state with your read-only tools (read / glob / grep).',
  '2. Split: break the goal into tasks that are independent enough to delegate; every brief must be self-contained (a child cannot see this conversation).',
  '3. Delegate: state the deliverable and the acceptance bar in each brief. Implementation, modification, and exploration go to children — never by hand.',
  '4. Decide: when children report back, make the final call against the original goal — the mechanism only blocks declared failures; functional correctness is yours to judge. If it fails, say what is wrong and delegate another round.',
  '',
  'Child results come back to you; read them and keep thinking, confirming, and producing.',
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
