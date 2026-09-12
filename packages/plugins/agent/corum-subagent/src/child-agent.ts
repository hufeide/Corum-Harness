/**
 * Shared in-process child composition: the delegation-depth budget, the
 * durable session metadata, the resolved child `AgentOptions`, the delegated
 * policy seed, and the scoped setup a child agent needs. Both the one-shot
 * provider driver and the continuation manager compose children this way, so
 * depth accounting, lineage stamping, and delegation policy have one home.
 *
 * @module @deepseek-ai/dsh-subagent/child-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
// Type-only: make `ctx.get('sandboxPolicy')` / `ctx.get('approval')` resolve
// to the policy services when composed — delegation consumes both
// opportunistically (the documented `ctx.get` pattern), never as a hard dep —
// and merge the `sandbox/mode` / `approval/policy` session-event payloads.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: make `ctx.get('agentPresets')` resolve to the preset roster when
// composed — a child inherits its parent's composition opportunistically (the
// documented `ctx.get` pattern), never as a hard dep. A rosterless deployment
// keeps its model-facing rows on the host plane, where the child already sees
// them through the tool registry's global layer.
import type {} from '@deepseek-ai/dsh-agent-presets'
import { corumNarrowDenyFilter, corumVisibleToolNames } from '@corum/corum-orchestration'
import { delegationDepthOf } from './depth.ts'

/** Thrown when starting a child would exceed the requested depth cap. */
export class SubagentDepthError extends Error {
  constructor(public readonly attemptedDepth: number, public readonly maxDepth: number) {
    super(`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`)
    this.name = 'SubagentDepthError'
  }
}

/**
 * Resolve the child's delegation depth from its parent and enforce an optional
 * cap. The persisted parent header is the monotone floor, so a resumed parent
 * cannot delegate as if it were top-level.
 * @param parent - the delegating parent agent.
 * @param maxDepth - optional absolute cap the resolved depth must not exceed.
 * @returns the child's non-negative safe-integer depth.
 * @throws {SubagentDepthError} when the resolved depth exceeds `maxDepth`.
 * @throws {RangeError} when the resolved depth leaves the safe-integer range.
 */
export function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range')
  }
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new SubagentDepthError(childDepth, maxDepth)
  }
  return childDepth
}

/**
 * Resolve the parent values inherited by a child. The latest request header
 * owns provider, model, and reasoning effort after request-time selection;
 * creation options remain the fallback before the first request and retain
 * the configured output-token limit.
 * @param parent - delegating parent Agent.
 * @returns detached Agent options for child-option merging.
 */
export function parentAgentOptionsForDelegation(parent: Agent): AgentOptions {
  const requestConfig = parent.session.requestHeader()?.config
  if (requestConfig === undefined) return { ...parent.options }
  const {
    provider: _createdProvider,
    model: _createdModel,
    reasoningEffort: _createdReasoningEffort,
    ...createdOptions
  } = parent.options
  return {
    ...createdOptions,
    provider: requestConfig.provider,
    model: requestConfig.model,
    ...requestConfig.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: requestConfig.reasoningEffort },
  }
}

/**
 * Resolve the child's `AgentOptions`: the parent's provider/model,
 * reasoning-effort, and maxTokens values unless the request overrides them,
 * stamped with the child's own delegation depth. Changing the route without
 * naming an effort clears the parent's route-owned effort so the selected
 * model resolves its own default.
 * @param parent - the delegating parent whose route the child inherits.
 * @param requested - per-child overrides, if any.
 * @param childDepth - the resolved delegation depth to stamp.
 * @returns the resolved options for `ctx.agents.create()`.
 */
export function resolveChildAgentOptions(
  parent: Agent,
  requested: AgentOptions | undefined,
  childDepth: number,
): AgentOptions {
  const parentOptions = parentAgentOptionsForDelegation(parent)
  const parentProvider = parentOptions.provider
  const parentModel = parentOptions.model
  const parentReasoningEffort = parentOptions.reasoningEffort
  const parentMaxTokens = parentOptions.maxTokens
  const resolved: AgentOptions = {
    ...parentProvider !== undefined ? { provider: parentProvider } : {},
    ...parentModel !== undefined ? { model: parentModel } : {},
    ...parentReasoningEffort !== undefined ? { reasoningEffort: parentReasoningEffort } : {},
    ...parentMaxTokens !== undefined ? { maxTokens: parentMaxTokens } : {},
    ...requested,
    subagentDepth: childDepth,
  }
  const routeChanged = resolved.provider !== parentProvider || resolved.model !== parentModel
  if (routeChanged && requested?.reasoningEffort === undefined) delete resolved.reasoningEffort
  return resolved
}

/**
 * Build the child session's durable creation metadata: the parent's workspace,
 * its direct lineage, coarse product origin, the recursion budget that must
 * survive persistence, the seed boundary that separates inherited parent
 * history from child work, and the composition the child runs under.
 *
 * The preset is read from the parent's LIVE scope chain rather than from its
 * header, because a parent that switched preset while blank runs on the newer
 * composition and its header still names the older one. Recording it is what
 * makes a child's history reconstructable: without it a cold read of the child
 * resolves the deployment default and rebuilds turns under a tool set the
 * child never had.
 * @param parent - the delegating parent agent.
 * @param childDepth - the resolved delegation depth to persist.
 * @param isSeeded - whether this child inherits a parent-log prefix, including an explicitly empty one.
 * @param cwd - fork（corum）：请求显式工作目录（worktree 隔离轴心）；缺省继承父会话 cwd。
 * @returns the `meta` for `ctx.agents.create()`.
 */
export function childSessionMeta(
  parent: Agent,
  childDepth: number,
  isSeeded: boolean,
  cwd?: string,
): NonNullable<CreateAgentOptions['meta']> {
  const parentHeader = parent.session.header
  const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
  // fork（corum）：cwd 优先取请求显式值（worktree 隔离），缺省继承父会话 cwd。
  const effectiveCwd = cwd ?? parentHeader.cwd
  return {
    ...effectiveCwd !== undefined ? { cwd: effectiveCwd } : {},
    ...agentPreset === undefined ? {} : { agentPreset },
    parentSession: parentHeader.id,
    isSeeded,
    // Navigation classification only; the descriptor remains the authority
    // for mode and continuation capability.
    origin: 'subagent',
    // Durable: the recursion budget must survive persistence and resume.
    delegationDepth: childDepth,
  }
}

/** The scoped composition a child agent's creation window applies. */
export interface ChildComposition {
  /** Per-child persona shadowing the deployment persona. */
  readonly persona?: string | undefined
  /** Per-child tool scoping. */
  readonly toolFilter?: ToolRestriction | undefined
}

/**
 * Model-facing delegation-scope statement for every in-process child. A
 * runtime-context contribution rather than a system-prompt section, so the
 * deployment's system prompt stays uniform across parents and children.
 */
export const SUBAGENT_DELEGATION_CONTEXT
  = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
    + 'widened from inside this session — operations that require approval are rejected automatically. '
    + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
    + 'limitation in your reply so the delegating agent can handle it.'

/**
 * Compose one child inside its creation window: join its parent's preset,
 * register the fixed delegation-scope statement, then apply the child's own
 * shadowing persona section and tool restriction, all owned by the child's
 * scope and therefore invisible to its parent and siblings. Creation and cold
 * resume both pass through here.
 *
 * The join comes first and the child's own registrations second, which is the
 * order the layering already implies — the nearest scope wins a name, and a
 * per-child restriction intersects with everything its chain admits — but
 * stating it here keeps the two steps from being read as independent.
 *
 * The join and the per-child registrations live in ONE call because a child
 * composed without the join is exactly the defect this function exists to
 * prevent: with every model-facing row on the agent plane, a child that joins
 * no preset sees an empty tool registry and none of its parent's prompt
 * sections. Taking the parent as a parameter is what makes that omission
 * unrepresentable at the call sites.
 * @param childCtx - the child agent's scoped creation context.
 * @param parent - the delegating parent whose composition the child joins.
 * @param composition - the per-child persona and tool filter to install.
 */
export function applyChildComposition(
  childCtx: Context,
  parent: Agent,
  composition: ChildComposition,
): void {
  childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
  childCtx.systemPrompt.context({
    name: 'subagent:delegation',
    order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: SUBAGENT_DELEGATION_CONTEXT,
  })
  /**
   * 指挥模式（`corumConductor` 服务，可选）下的子 Agent 契约（2026-09-11 用户定调）：
   *
   * ① **不继承父的角色人格**：父是指挥者时，preset 里那段 persona（含指挥者 iron rule
   *    "you physically cannot write / edit / bash"）会被原样继承到子 Agent —— 而子 Agent
   *    有全套写工具、正在跑 bash，人格与工具面直接矛盾。这里用 `deployment:persona`
   *    影子段换掉：中性工作型角色行 + **保留父的「工作风格人格」**（设置里那个，如专业干练）。
   * ② **不再召唤孙 Agent**：指挥模式下子 Agent 只干活不分层，deny 掉全部委派工具。
   *
   * 两者都在**子 scope** 注册，对父与兄弟不可见（与既有 per-child persona/toolFilter 同法）。
   * `corumConductor` 缺席时（精简装配）整段跳过，维持原行为。
   */
  const conductor = childCtx.get('corumConductor') as ConductorFace | undefined
  const conductorParent = conductor !== undefined && conductor.isConductor(String(parent.session.id))
  const persona = composition.persona
    ?? (conductorParent ? conductor?.childPersonaFor(String(parent.session.id)) : undefined)
  if (persona !== undefined) {
    childCtx.systemPrompt.section({
      name: 'deployment:persona',
      order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA'),
      text: persona,
    })
  }
  const raw = conductorParent
    ? mergeDelegationDeny(composition.toolFilter, delegationToolNames(childCtx))
    : composition.toolFilter
  const toolFilter = raw === undefined ? undefined : narrowChildToolFilter(childCtx, raw)
  if (toolFilter !== undefined) childCtx.tools.restrict(toolFilter)
}

/**
 * `corumConductor` 服务的**本地能力接口**（红线 3：跨 bundle 用能力接口收窄，不耦合实现包）。
 * 服务由 `@corum/corum-agent` provide；本包按可选服务消费（缺席 = 无指挥模式语义）。
 */
interface ConductorFace {
  isConductor: (sessionId: string) => boolean
  childPersonaFor: (sessionId: string) => string | undefined
}

/**
 * 子 scope 里**实际可见**的委派工具名（`subagent*` 全族 + `orchestrate`）。
 *
 * 按可见面取而不是写死清单：`tools.restrict({deny})` 对未注册的名字 fail-loud，
 * 而委派工具在不同装配下可能缺席（精简 preset / 未来改名）。
 * @param childCtx - 已 join 父 preset 的子 scope。
 * @returns 需要 deny 的工具名（可能为空）。
 */
function delegationToolNames(childCtx: Context): readonly string[] {
  const visible = corumVisibleToolNames(childCtx)
  return [...visible].filter(name => name === 'orchestrate' || name.startsWith('subagent'))
}

/**
 * 把子 Agent 的 toolFilter 收敛到**该子 scope 真实可见**的工具名上。
 *
 * 为什么必须做（2026-09-12 实机事故）：`preset` 里给的 deny 名单是**编译期写死**的，
 * 它会随装配漂移，而 `tools.restrict()` 对未知名 **fail-loud**（docs/LESSONS.md §6.18）。
 * 实测两次踩坑：
 *  1. `str_replace_editor` 从 corum preset 退场后，研究实例的 deny 仍写着它 →
 *     **每一次 `subagent_research` 都抛 `names unknown global tools`**，指挥者只能退回
 *     用 `subagent` 重发同一件事（用户看到「两个重复的子 Agent」），还白占一个隔离 worktree；
 *  2. `mcpDenyNames` 取的是 **MCP 服务名**（`pencil-mcp`），而实际工具名是
 *     `mcp__pencil-mcp__*` —— 服务名同样不是全局工具名，一配上 MCP 就必炸。
 *
 * 处理口径：
 *  - 名字直接可见 → 原样保留；
 *  - 名字是**某个 MCP 服务名**（隐藏前缀形态）→ 展开成该服务**实际可见**的工具名
 *    （保住「pencil 有写能力，只读研究实例也必须 deny 它」的原始意图）；
 *  - 其余不可见的名字 → 丢弃（拒绝一个不存在的工具没有意义，只会炸掉整次派遣）。
 * @param childCtx - 已 join 父 preset 的子 scope。
 * @param filter - 调用方给的过滤器（编译期 deny / 集成者过滤 / 禁委派）。
 * @returns 只含可见工具名的过滤器；deny 与 allow 收敛后皆空时 undefined。
 */
export function narrowChildToolFilter(
  childCtx: Context,
  filter: ToolRestriction,
): ToolRestriction | undefined {
  const visible = corumVisibleToolNames(childCtx)
  const deny = new Set<string>()
  for (const name of filter.deny ?? []) {
    if (visible.has(name)) {
      deny.add(name)
      continue
    }
    // MCP 服务名 → 该服务下实际可见的工具名（否则「只读实例不得用 pencil」形同虚设）。
    for (const candidate of visible) {
      if (candidate.startsWith(`mcp__${name}__`)) deny.add(candidate)
    }
  }
  const allow = filter.allow?.filter(name => visible.has(name))
  if (deny.size === 0 && (allow === undefined || allow.length === 0)) return undefined
  return {
    ...(allow === undefined || allow.length === 0 ? {} : { allow }),
    ...(deny.size === 0 ? {} : { deny: [...deny] }),
  }
}

/**
 * 把「禁委派」并入调用方给的 toolFilter（调用方的 filter 优先语义不变，deny 取并集）。
 * @param filter - 调用方（provider/集成者）给的过滤器。
 * @param deny - 要额外禁止的工具名。
 * @returns 合并后的过滤器；两者皆空时 undefined。
 */
function mergeDelegationDeny(
  filter: ToolRestriction | undefined,
  deny: readonly string[],
): ToolRestriction | undefined {
  if (deny.length === 0) return filter
  // 注意：`ToolRestriction` 的字段是 readonly，而 `corumNarrowDenyFilter` 要可变数组
  // （exactOptionalPropertyTypes 下也不接受显式 undefined）——这里显式重建一个可变对象。
  const combined: string[] = [...(filter?.deny ?? []), ...deny]
  const base: { allow?: string[]; deny?: string[] } = { deny: combined }
  if (filter?.allow !== undefined) base.allow = [...filter.allow]
  const merged = corumNarrowDenyFilter(base, new Set(combined))
  return merged ?? filter ?? { deny: combined }
}

/** Policy seeded onto a child session's log at the delegation boundary. */
export interface DelegatedPolicyOverrides {
  /** The parent session's explicit sandbox-mode override, or `undefined` without one. */
  readonly sandboxMode: SandboxMode | undefined
  /**
   * `'never'` whenever the approval capability is composed, `undefined`
   * otherwise: a delegated child acts only within the sandbox scope fixed at
   * delegation, so its asks are rejected deterministically.
   */
  readonly approvalPolicy: 'never' | undefined
}

/**
 * Capture the policy to seed into one delegation. Call synchronously before
 * the child start's first await: a later parent switch belongs to the
 * parent's future, not to this child. Only the parent session's explicit
 * sandbox override is captured — never deployment defaults or one-shot
 * grants — and the approval policy is pinned to `'never'` regardless of the
 * parent's own policy.
 * @param parent - the delegating parent agent.
 * @returns the sandbox override (or `undefined` without one) and the approval pin.
 */
export function captureDelegatedPolicyOverrides(parent: Agent): DelegatedPolicyOverrides {
  return {
    sandboxMode: parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session),
    approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never',
  }
}

/**
 * Append the captured delegation policy onto the child's own log as
 * `source: 'delegation'` events inside the unpublished creation window, so the
 * child's effective policy is reconstructable from its log alone. Appends land
 * after any fork seed, so fresh policy wins stale seed state; later child
 * switches still win over these events.
 * @param childSession - the unpublished child's session.
 * @param overrides - the policy captured at delegation.
 */
export function appendDelegatedPolicyOverrides(
  childSession: Session,
  overrides: DelegatedPolicyOverrides,
): void {
  if (overrides.sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'delegation' })
  }
  if (overrides.approvalPolicy !== undefined) {
    childSession.append('approval/policy', { policy: overrides.approvalPolicy, source: 'delegation' })
  }
}

/** Identity and lineage inputs shared by every in-process child creation. */
export interface ChildCreateInputs {
  /** The child's reserved session id. */
  readonly sessionId: SessionId
  /** The delegating parent agent. */
  readonly parent: Agent
  /** The resolved delegation depth. */
  readonly childDepth: number
  /** How many leading seed events came from the parent's log. */
  readonly lineageSeedLength: number
}
