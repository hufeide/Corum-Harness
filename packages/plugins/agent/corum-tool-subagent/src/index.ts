/**
 * fork（corum）：模型面召唤工具的 corum 版——execute 隔离层（写任务自动建
 * git worktree+分支、deny str_replace_editor、会话级台账、maxParallelChildren
 * 上限）、integrate 编排（集成者 persona + 固定 checks + settle 后清理，骨架
 * 阶段仅前台路径）、模型锁（config.model 作为终值注入、schema 剔除 LLM 自主
 * 选模型参数）、readonlyResearch 只读研究实例语义。其余与官方逐行一致。
 * 原始模块：@deepseek-ai/dsh-tool-subagent。
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider lifecycle controls tool registration and context-sensitive schema
 * wording. Foreground calls always dispose the run after collection.
 * Background policy is selected by this plugin's configuration: one-shot
 * calls own a plain Task, while continuable calls use
 * `ctx.subagents.startContinuable()`.
 * @module @deepseek-ai/dsh-tool-subagent
 */

// fork（corum）：worktree 隔离层用 Node fs/path/crypto/child_process。
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  assertSubagentMaxDepth,
  parentAgentOptionsForDelegation,
  settleRun,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import {
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from './model-selection.ts'
import type { DelegationModelRequest, ModelSelectionPolicy } from './model-selection.ts'
import { registerListSubagentModels } from './list-models.ts'
import type {} from './model-selection-settings.ts'
import {
  recordSubagentModelSelection,
  subagentModelSelectionProjectionDefinition,
  subagentModelSelectionPolicy,
} from './model-selection-state.ts'

export const name = 'corum-tool-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections']

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Sample the Host `subagent-model-selection` user setting for each new
   * top-level session and inherit that decision in its child sessions.
   */
  modelSelectionSettings?: boolean
  /**
   * Expose `run_in_background` (default true). Disabled instances omit the
   * parameter and reject forced background calls.
   */
  enableRunInBackground?: boolean
  /**
   * Background execution policy (default `one-shot`). `one-shot` defaults calls
   * to foreground; `continuable` defaults them to background, requires a provider
   * with the `prepareContinuable` capability, and returns the durable child id.
   * Follow-up adapters remain independently optional.
   */
  backgroundMode?: 'one-shot' | 'continuable'
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Per-child persona that shadows `deployment:persona`. Requires the
   * provider's `persona` capability; omission preserves the deployment persona.
   */
  persona?: string
  /**
   * Tool filter applied to every child. Filtered tools disappear from its
   * prompt and reject execution. Requires the provider's `toolFilter`
   * capability; unknown names fail startup.
   */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from the child. */
    deny?: string[]
  }
  /**
   * Maximum child depth: a non-negative safe integer (default `3`; `0` forbids
   * delegation entirely), or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment.
   */
  maxDepth?: number | 'provider-managed'
  /** fork（corum）：子 Agent 隔离策略。 */
  isolation?: {
    /** always=凡召唤必隔离；write-tasks=按工具面判定（默认）；off=不隔离。 */
    mode?: 'always' | 'write-tasks' | 'off'
    /** worktree 根目录（相对父会话 cwd 或绝对路径，默认 '.corum-worktrees'）。 */
    worktreeRoot?: string
    /** 分支名前缀（默认 'wt/'）。 */
    branchPrefix?: string
    /** 合并后自动清理（默认 true）。 */
    autoCleanup?: boolean
    /** 子 Agent deny str_replace_editor（默认 true）。 */
    denyDirectFs?: boolean
  }
  /** fork（corum）：research 实例语义——本实例为只读研究实例（预 deny 写工具、不隔离）。 */
  readonlyResearch?: boolean
  /** fork（corum）：会话级并行子 Agent 上限（默认 4；超限拒绝新召唤）。 */
  maxParallelChildren?: number
  /** fork（corum）：integrate 召唤的固定核查命令（默认 ['pnpm -r typecheck']）。 */
  integrateChecks?: string[]
  /** fork（corum）：合并者归属（默认 'parent'）。 */
  merger?: 'parent' | 'merger'
  /** fork（corum）：子 Agent 固定模型路由（机制锁；缺省=跟随父）。 */
  model?: { provider: string; model: string; reasoningEffort?: string }
}

// ── fork（corum）：corum-subagent 全局设置面（三级配置第一级）──────────────────

/** host settings namespace（settings.yaml 的 corum-subagent 段）。 */
export const CORUM_SUBAGENT_SETTINGS_NAMESPACE = 'corum-subagent'

/** 全局默认配置形（与 preset config 逐键同名；全部可选——未设置的键由实例默认兜底）。 */
export interface CorumSubagentGlobalSettings {
  readonly isolationMode?: 'always' | 'write-tasks' | 'off'
  readonly worktreeRoot?: string
  readonly branchPrefix?: string
  readonly autoCleanup?: boolean
  readonly denyDirectFs?: boolean
  readonly maxParallelChildren?: number
  readonly integrateChecks?: string[]
  readonly merger?: 'parent' | 'merger'
  readonly defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  readonly defaultResearchModel?: { provider: string; model: string; reasoningEffort?: string }
}

/** schemastery schema（全键可选；保持 omission 语义——设置面只写用户显式改的键）。 */
// schemastery 的 z<T> 与 default 宽化在嵌套可选键上推断冲突——schema 段单独标注
// 宽接口，运行时行为由 default(undefined) 保证 omission。
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export const CORUM_SUBAGENT_SETTINGS_SCHEMA: z<CorumSubagentGlobalSettings & {
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  defaultResearchModel?: { provider: string; model: string; reasoningEffort?: string }
}> = z.object({
  isolationMode: z.union([z.const('always' as const), z.const('write-tasks' as const), z.const('off' as const)]).default(undefined as unknown as 'always' | 'write-tasks' | 'off'),
  worktreeRoot: z.string().default(undefined as unknown as string),
  branchPrefix: z.string().default(undefined as unknown as string),
  autoCleanup: z.boolean().default(undefined as unknown as boolean),
  denyDirectFs: z.boolean().default(undefined as unknown as boolean),
  maxParallelChildren: z.number().step(1).min(1).default(undefined as unknown as number),
  integrateChecks: z.array(z.string()).default(undefined as unknown as string[]),
  merger: z.union([z.const('parent' as const), z.const('merger' as const)]).default(undefined as unknown as 'parent' | 'merger'),
  defaultModel: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1).default(undefined as unknown as string),
  }).default(undefined as unknown as { provider: string; model: string; reasoningEffort: string }),
  defaultResearchModel: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1).default(undefined as unknown as string),
  }).default(undefined as unknown as { provider: string; model: string; reasoningEffort: string }),
})

/** SettingsScope 的消费面（读+写；跨 bundle 模块级单例）。 */
interface CorumSubagentGlobalSettingsScope {
  get(): CorumSubagentGlobalSettings
  update(patch: object): Promise<void>
}

/** 双实例共享的全局设置 scope（先注册者持有；模块级单例防同 namespace 重复注册）。 */
let corumGlobalSettingsScope: CorumSubagentGlobalSettingsScope | undefined

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  modelSelectionSettings: z.boolean().default(false),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as {
    provider: string
    model: string
    reasoningEffort: ReturnType<typeof ReasoningEffortId>
    maxTokens: number
  }),
  persona: z.string(),
  // Preserve omission; Schemastery's `{ allow: [] }` default would deny every tool.
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
  // fork（corum）：隔离/研究/并行/集成/模型锁字段全部保留 omission（不写默认物化）。
  isolation: z.object({
    mode: z.union(['always', 'write-tasks', 'off'] as const).default(undefined as unknown as 'always' | 'write-tasks' | 'off'),
    worktreeRoot: z.string().min(1).default(undefined as unknown as string),
    branchPrefix: z.string().default(undefined as unknown as string),
    autoCleanup: z.boolean().default(undefined as unknown as boolean),
    denyDirectFs: z.boolean().default(undefined as unknown as boolean),
  }).default(undefined as unknown as {
    mode: 'always' | 'write-tasks' | 'off'
    worktreeRoot: string
    branchPrefix: string
    autoCleanup: boolean
    denyDirectFs: boolean
  }),
  readonlyResearch: z.boolean().default(undefined as unknown as boolean),
  maxParallelChildren: z.natural().max(Number.MAX_SAFE_INTEGER).default(undefined as unknown as number),
  integrateChecks: z.array(z.string()).default(undefined as unknown as string[]),
  merger: z.union(['parent', 'merger'] as const).default(undefined as unknown as 'parent' | 'merger'),
  model: z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string().min(1).default(undefined as unknown as string),
  }).default(undefined as unknown as { provider: string; model: string; reasoningEffort: string }),
})

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    // Product providers aggregate startup and rollback failures. Cancellation
    // must not turn a failed cleanup into a cleanly killed Job.
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Append provider-authored failure detail and the child's preserved partial
 * answer to a stop-reason error, keeping diagnostic text separate from the
 * child's assistant output.
 * @param error - the stop-reason headline.
 * @param result - the child's terminal result.
 * @returns the headline, diagnostic, and partial text that are present.
 */
function withDiagnosticAndPartialText(error: string, result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined
    ? ''
    : `\nDiagnostic: ${result.diagnostic}`
  const text = result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const partial = text.length === 0
    ? ''
    : `\nPartial output before the run ended:\n${text}`
  return `${error}${diagnostic}${partial}`
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
}

/**
 * Collect and release one foreground run without letting disposal replace an
 * independent result failure.
 */
async function settleForegroundRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        // The registry converts this throw to isError; partial output is not
        // success, but the preserved partial answer still reaches the parent.
        throw new Error(withDiagnosticAndPartialText(error, result))
      }
      return {
        kind: 'foreground',
        runId: run.id,
        // Content blocks already cross durable JSON boundaries elsewhere;
        // the registry performs the authoritative lossless snapshot here.
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

interface DelegationRunRequest {
  readonly run_in_background?: boolean
  // fork（corum）：integrate 参数（parameters 已声明；官方类型未含）。
  readonly integrate?: boolean
}

interface DelegationRunSpec {
  readonly runInBackground: boolean
}

/** Resolve the model's optional scheduling request into one execution route. */
function resolveDelegationRun(
  request: DelegationRunRequest,
  options: { readonly backgroundEnabled: boolean; readonly continuable: boolean },
): DelegationRunSpec {
  if (!options.backgroundEnabled) {
    // The validator permits undeclared keys, so schema omission also needs
    // execution-time enforcement.
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
    }
    return { runInBackground: false }
  }
  return {
    // Continuable work is independently scheduled unless the caller explicitly
    // needs the result before its next action. One-shot policy keeps its existing
    // foreground default because its background result requires Task collection.
    runInBackground: request.run_in_background ?? options.continuable,
  }
}

// fork（corum）：写工具清单——按工具面判定写任务（§2 逐字核实）。
// eslint 保持只读：本文件其余位置不修改它。
const CORUM_WRITE_TOOLS = ['str_replace_editor', 'write', 'edit', 'bash', 'pwsh']

// fork（corum）：会话级隔离台账条目。
// settled=子 Agent 已完工（不占 maxParallelChildren 额度），worktree 等 integrate。
export interface CorumWorktreeEntry {
  readonly slug: string
  readonly branch: string
  readonly path: string
  status: 'active' | 'settled' | 'integrated' | 'discarded'
  // fork（corum）：settle 关联键——subagent/start|end 事件的 runId（session 级去重）。
  runId?: string
}

// fork（corum）：会话级隔离台账（key=父 session id）。模块级单例按 cordis
// 根上下文唯一性成立；仅托管本进程登记的条目。导出仅供单测直接操作。
export const corumWorktreeLedger = new Map<string, CorumWorktreeEntry[]>()

// fork（corum）：台账 session → 父会话 cwd（dispose 清理时定位 git 主干）。
const corumLedgerCwds = new Map<string, string>()

// fork（corum）：台账快照事件（renderer「并行工作区」chip 的订阅源）。
// cordis Events 合并声明自包含（与 corum-api-remotes 的转发 allowlist 配套）。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'corum/worktree-ledger': (frame: CorumWorktreeLedgerFrame) => void
  }
}

/** 台账快照的一帧：某父会话的 worktree 条目全量投影（renderer 直接渲染）。 */
export interface CorumWorktreeLedgerFrame {
  /** 父会话 id（台账键）。 */
  readonly sessionId: string
  /** 条目投影（状态/分支/路径；路径仅供调试展示，renderer 主显分支+状态）。 */
  readonly entries: readonly CorumWorktreeEntry[]
  /** 聚合计数（chip 文案用）：待集成 = active+settled。 */
  readonly pending: number
}

/** 发射某会话的台账快照（台账每次变更后调用；cordis 根上下文 emit）。 */
function emitLedgerFrame(ctx: Context, sessionId: string): void {
  const entries = corumWorktreeLedger.get(sessionId) ?? []
  const pending = entries.filter(e => e.status === 'active' || e.status === 'settled').length
  ctx.emit('corum/worktree-ledger', {
    sessionId,
    entries: entries.map(e => ({ ...e })),
    pending,
  } satisfies CorumWorktreeLedgerFrame)
}

// fork（corum）：有效 toolFilter——config.toolFilter 与 denyDirectFs 的 deny 并集
// （denyDirectFs=false 时不附加；config.toolFilter 缺省时并集只有附加项）。
export function corumEffectiveToolFilter(
  toolFilter: { allow?: string[]; deny?: string[] } | undefined,
  denyDirectFs: boolean,
): { allow?: string[]; deny: string[] } {
  return {
    ...toolFilter?.allow !== undefined ? { allow: toolFilter.allow } : {},
    deny: [...toolFilter?.deny ?? [], ...denyDirectFs ? ['str_replace_editor'] : []],
  }
}

// fork（corum）：写工具判定——readonlyResearch 恒只读；否则看有效 toolFilter
// 是否已把全部写工具 deny。
export function corumIsWriteTask(
  toolFilter: { allow?: string[]; deny?: string[] } | undefined,
  readonlyResearch: boolean,
  denyDirectFs = true,
): boolean {
  if (readonlyResearch) return false
  const deny = corumEffectiveToolFilter(toolFilter, denyDirectFs).deny
  // 平台实际装载的写工具口径（pwsh 仅 win32——未装载的工具不会被 deny，
  // 也不应参与「全 deny 即只读」的判定，否则非 win32 恒判写任务）。
  const presentWriteTools = process.platform === 'win32'
    ? CORUM_WRITE_TOOLS
    : CORUM_WRITE_TOOLS.filter(tool => tool !== 'pwsh')
  return !presentWriteTools.every(tool => deny.includes(tool))
}

// fork（corum）：隔离触发判定（readonlyResearch 实例恒不隔离）。
export function corumShouldIsolate(
  mode: 'always' | 'write-tasks' | 'off',
  isWriteTask: boolean,
  readonlyResearch: boolean,
): boolean {
  if (readonlyResearch) return false
  return mode === 'always' || (mode === 'write-tasks' && isWriteTask)
}

// fork（corum）：integrate 准入——active 或 settled 的待集成条目（空则拒绝；
// 修复第一阶段"无 active 即拒绝"挡住"全部完工后合并"的语义缺陷）。
export function corumPendingIntegration(entries: CorumWorktreeEntry[]): CorumWorktreeEntry[] {
  return entries.filter(entry => entry.status === 'active' || entry.status === 'settled')
}

// fork（corum）：subagent/end settle 联动——按 runId 精确翻转 active→settled；
// runId 未登记时回退匹配唯一 active 条目（continuable 登记的是 childId）。
export function corumMarkSettled(
  entries: CorumWorktreeEntry[],
  settle: { runId?: string; childId?: string },
): boolean {
  if (settle.runId !== undefined) {
    const byRunId = entries.find(entry => entry.status === 'active' && entry.runId === settle.runId)
    if (byRunId !== undefined) {
      byRunId.status = 'settled'
      return true
    }
  }
  if (settle.childId === undefined) return false
  const candidates = entries.filter(entry => entry.status === 'active' && entry.runId === undefined)
  if (candidates.length === 1) {
    candidates[0].status = 'settled'
    candidates[0].runId = settle.runId ?? settle.childId
    return true
  }
  return false
}

// fork（corum）：git 命令同步执行（父会话 header.cwd 下）。导出供单测驱动。
export function corumGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

// fork（corum）：最佳努力回滚/清理（清理失败不掩盖原始错误）。
function corumCleanupWorktree(cwd: string, entry: Pick<CorumWorktreeEntry, 'path' | 'branch'>): void {
  try {
    corumGit(cwd, ['worktree', 'remove', '--force', entry.path])
  } catch {
    // Best effort: 台账仍登记，dispose 清理会重试。
  }
  try {
    corumGit(cwd, ['branch', '-D', entry.branch])
  } catch {
    // Best effort: 分支可能未建或已删。
  }
}

// fork（corum）：删除本实例登记的台账条目（status 过滤）。
function corumCleanupLedgerEntries(cwd: string, entries: CorumWorktreeEntry[], statuses: readonly CorumWorktreeEntry['status'][]): void {
  for (const entry of entries) {
    if (!statuses.includes(entry.status)) continue
    corumCleanupWorktree(cwd, entry)
    entry.status = 'discarded'
  }
}

/**
 * fork（corum）：探测式默认 integrateChecks（P0-1 b 方向）——按父会话 cwd 的
 * 仓库形态生成可用的核查命令，替代一刀切 'pnpm -r typecheck'（对非 pnpm
 * workspace 必然失败的基线缺陷，CDP §11.6 暴露）：
 *   1. 存在 pnpm-workspace.yaml → 'pnpm -r typecheck'（原默认，TS monorepo 语义）；
 *   2. 根 package.json scripts.typecheck → 'npm run typecheck'；
 *   3. 根 package.json scripts.test → 'npm test'；
 *   4. 均无 → 'git diff --check'（仅验合并补丁格式完整性：冲突标记残留/空白
 *      错误——保守兜底，永不误拦，门禁语义降级为格式校验）。
 * 用户显式配置的 integrateChecks（preset config）恒优先，本函数不参与。
 */
export function corumDetectIntegrateChecks(cwd: string): string[] {
  if (existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) return ['pnpm -r typecheck']
  try {
    const pkgPath = path.join(cwd, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
      if (typeof pkg.scripts?.typecheck === 'string') return ['npm run typecheck']
      if (typeof pkg.scripts?.test === 'string') return ['npm test']
    }
  } catch {
    // package.json 不可读/坏 JSON → 落保守兜底。
  }
  return ['git diff --check']
}

// fork（corum）：integrate 召唤的集成者 persona（机制拼装，非 LLM 自由写）。
// merger 语义差异（v0.1 仅 persona 层）：真正的 merger 独立子 Agent 编排需要
// 嵌套 delegation，受当前 maxDepth 限制不做——留待后续阶段。
export function corumIntegratorPersona(
  entries: CorumWorktreeEntry[],
  checks: string[],
  merger: 'parent' | 'merger' = 'parent',
  declared?: string,
): string {
  const branches = entries.map(entry => `- ${entry.branch} (worktree: ${entry.path})`).join('\n')
  // fork（corum）：核查语义（2026-09-08 用户定调）——静态穷举（pnpm/typecheck/test
  // 四档猜）对千奇百怪的项目不可能准确；正确做法是主 Agent 在 integrate prompt 里
  // 声明本仓库的编译/运行/验证方式（declared，机制原样注入），探测式默认仅作
  // 主 Agent 未声明时的兜底。功能性验收（改动对不对、功能成不成立）由主 Agent
  // 基于原始目标最终裁决——机制只把「声明的失败」挡在提交前，不臆测验收标准。
  const checkLines = checks.length > 0
    ? checks.map(check => `- ${check}`).join('\n')
    : '- git diff --check'
  const declaredBlock = declared !== undefined && declared.trim() !== ''
    ? `\nHow to build, run, and verify this repository (declared by the delegating agent — follow it exactly):\n${declared.trim()}\n`
    : '\nThe delegating agent did not declare how to build or verify this repository: run the checks below and treat them as the minimum bar only.\n'
  return 'You are the integration manager. Merge the branches listed below into the main working tree IN ORDER. Branches:\n'
    + branches
    + declaredBlock
    + '\nChecks (run every one; commit only when all pass):\n'
    + checkLines
    + '\nIf any check or declared verification step fails, report and leave the tree dirty — do NOT commit.\n'
    + (merger === 'merger'
      ? 'You are a dedicated integration specialist: after completing the merge and verification, report a per-branch summary (merged/conflicts/verification results) as your final answer.'
      : 'Report the integration outcome (merge result, verification output, and anything that looks off) so the delegating agent can make the final acceptance call against the original goal.')
}

export function apply(ctx: Context, config: Config): void {
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  // Reject an empty explicit filter at load instead of failing every delegation.
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  }
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent'

  // fork（corum）：host settings namespace `corum-subagent`（三级配置第一级：
  // 全局默认；「子 Agent」设置 section 读写此面，preset config 逐键覆盖）。
  // settings.register 返回的 SettingsScope 承载 settings.yaml 的 corum-subagent
  // 段（不存在时回落 schema 默认）；每个实例 apply 都会注册一次——cordis 对同
  // namespace 重复注册抛错，所以 worker/research 双实例只有一个能持有注册：
  // 用 registration 单例守卫（先注册者持有，后注册者共享同一 scope 读取）。
  if (corumGlobalSettingsScope === undefined) {
    ctx.inject(['settings'], (settingsCtx) => {
      corumGlobalSettingsScope = settingsCtx.settings.register(
        CORUM_SUBAGENT_SETTINGS_NAMESPACE,
        CORUM_SUBAGENT_SETTINGS_SCHEMA,
      ) as unknown as CorumSubagentGlobalSettingsScope
    })
  }

  // fork（corum）：实例级隔离配置终值（默认在此固化，omission 语义保留在 schema 层）。
  const corumIsolation = config.isolation
  // fork（corum）：三级配置解析——preset config（实例）> 全局设置（corum-subagent
  // namespace 文档值）> 实例内置默认。getSnapshot 每次执行时读（文档更新即时生效）。
  const corumGlobal = (): CorumSubagentGlobalSettings => corumGlobalSettingsScope?.get() ?? {}
  const corumIsolationMode = corumIsolation?.mode ?? corumGlobal().isolationMode ?? 'write-tasks'
  const corumDenyDirectFs = corumIsolation?.denyDirectFs ?? corumGlobal().denyDirectFs ?? true
  const corumAutoCleanup = corumIsolation?.autoCleanup ?? corumGlobal().autoCleanup ?? true
  const corumReadonlyResearch = config.readonlyResearch === true
  const corumMaxParallelChildren = config.maxParallelChildren ?? corumGlobal().maxParallelChildren ?? 4
  // fork（corum）：integrateChecks 三级解析——显式 config 恒优先；缺省时 integrate
  // 执行点按父 cwd 探测（corumDetectIntegrateChecks），不再静态默认。
  const corumIntegrateChecks = config.integrateChecks ?? corumGlobal().integrateChecks
  const corumMerger = config.merger ?? corumGlobal().merger ?? 'parent'

  // fork（corum）：subagent/end settle 联动——end 事件的第二回调参数是委派方
  // 父 Agent（见 corum-subagent lifecycle.ts 的 Events 声明），直接从
  // parent.session.id 取台账键；runId 精确匹配（登记自 spawn 的 SubagentRun.id），
  // 回退 childId 唯一匹配（continuable 登记的是 startContinuable 返回的
  // childId）。settled 不占 maxParallelChildren 额度（子 Agent 已完工，
  // worktree 等 integrate）。as never 窄化原因：cordis Events 合并声明来自
  // @corum/corum-subagent 包，与本包 import 的官方 @deepseek-ai/dsh-subagent
  // 类型面同源但模块实例不同，类型系统认不出。
  ctx.on('subagent/end' as never, ((info: SubagentRunEndInfo, parentAgent: Agent) => {
    const entries = corumWorktreeLedger.get(String(parentAgent.session.id))
    if (entries === undefined) return
    const flipped = corumMarkSettled(entries, { runId: String(info.runId), childId: String(info.id) })
    if (flipped) emitLedgerFrame(ctx, String(parentAgent.session.id))
  }) as never, { global: true })

  // fork（corum）：全局设置的 RPC 面（「子 Agent」设置 section 读写；
  // 经 corum-agent 的 TypertRemoteService 通道不可达（本包无 remote 面），
  // 以 cordis 服务直挂——UI 走 ctx.remote 的 settings-controller 官方通道，
  // 本行仅保证 namespace 已注册使官方 settings 文档面可用。
  // （见 packages/api/settings-controller：document-updated / section 读写
  // 按 namespace 分发，无需本包自建 RPC。）

  // fork（corum）：父 scope dispose 时清理本实例台账中未集成的 worktree。
  ctx.effect(() => () => {
    for (const [sessionId, entries] of corumWorktreeLedger) {
      const cwd = corumLedgerCwds.get(sessionId)
      if (cwd === undefined) continue
      corumCleanupLedgerEntries(cwd, entries, ['active', 'settled'])
    }
  })

  const modelSelectionCapable = config.modelSelectionSettings === true
  ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)

  const assertSubagentProviderConfiguration = (subagentProvider: SubagentProvider): void => {
    if (typeof config.maxDepth === 'number' && !subagentProvider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    if (config.agentOptions !== undefined && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`,
      )
    }
    if (modelSelectionCapable && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child model selection`,
      )
    }
    if (continuable && subagentProvider.prepareContinuable === undefined) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support \`backgroundMode: continuable\``,
      )
    }
  }

  // Validate provider-owned config outside the optional LLM binding so an
  // invalid provider always rejects its registration or this plugin's load.
  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider)
  })
  const initialProvider = ctx.subagents.getProvider(config.provider)
  if (initialProvider !== undefined) assertSubagentProviderConfiguration(initialProvider)

  const install = (runtimeCtx: Context, modelSelectionPolicy: ModelSelectionPolicy | undefined): void => {
    const modelSelectionEnabled = modelSelectionPolicy !== undefined
    if (modelSelectionPolicy !== undefined) registerListSubagentModels(runtimeCtx, modelSelectionPolicy)
    // Load order and HMR replacement can change provider availability while
    // this fiber remains active.
    let mounted: { subagentProvider: SubagentProvider; disposeTool: () => void } | undefined
    const mount = (subagentProvider: SubagentProvider): void => {
      assertSubagentProviderConfiguration(subagentProvider)
      const wording = providerWording(subagentProvider.inheritsParentContext)
      const providerRouteDefaults = subagentProvider.agentRouteDefaults
      const disposeTool = runtimeCtx.tools.register(defineTool({
        name: toolName,
        // fork（corum）：描述头追加隔离语义（英文，接在官方 wording 前）。
        description: 'Delegates run in isolated git worktrees when this instance has isolation configured; each write-capable child gets its own worktree and branch automatically. '
          + wording.description + (backgroundEnabled
          // The completion notice is the continuation service's own behavior, not
          // a separately installed capability, so this promise holds whenever the
          // continuable background path is reachable at all.
          ? continuable
            ? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` steers the child\'s nearest step while it is running and starts a turn while it is idle. Set `run_in_background: false` only when your next action depends on receiving the result.'
            : ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
          : ' This call waits for the subagent and returns its result.'),
        parameters: {
          description: {
            type: 'string',
            required: true,
            description: 'A short (3-5 word) description of the delegated task, for display.',
          },
          prompt: {
            type: 'string',
            required: true,
            description: wording.promptDescription,
          },
          // fork（corum）：模型锁——schema 剔除 provider/model/reasoning_effort
          // 三个参数（官方 modelSelectionEnabled 条件展开块恒不展开）；LLM 物理上
          // 无法表达模型偏好，固定路由由 config.model 注入。
          integrate: {
            type: 'boolean' as const,
            description: 'Set true to merge all isolated worktree branches of this session back into the main working tree, run the verification, and commit. Use after parallel development children have settled.',
          },
          // fork（corum）：主 Agent 声明的仓库验证方式（2026-09-08 用户定调：静态
          // 穷举不可能覆盖千奇百怪的项目——主 Agent 最懂这个仓库怎么编译/跑/验收）。
          verify: {
            type: 'string' as const,
            description: 'How to build, run, and verify this repository after merging (e.g. "cd studio && npm test", "cargo build --workspace && cargo test -p core", "make -j8 && make check"). Only used with integrate: true. Declare it: you know this repo — the mechanism injects your declaration verbatim and enforces it. Omit to fall back to detected checks (minimal format bar).',
          },
          ...backgroundEnabled ? {
            run_in_background: {
              type: 'boolean' as const,
              description: continuable
                ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.'
                : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
            },
          } : {},
        },
        output: {
          schema: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'background' },
                  jobId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'continuable' },
                  subagentId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'foreground' },
                  runId: { type: 'string', required: true },
                  output: { type: 'array', required: true, items: { type: 'json' } },
                },
              },
            ],
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.kind === 'background'
              ? `started background subagent job ${value.jobId}`
              : value.kind === 'continuable'
                ? `started subagent ${value.subagentId}`
                : outputValueText(value.output),
          }],
        },
        // Children never mutate the parent session; the one parent-owned write
        // (tasks.start) is a synchronous commutative insertion.
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) {
            // Non-agent callers provide no parent for delegation ownership.
            throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
          }

          const modelRequest = args as DelegationModelRequest
          const parentOptions = parentAgentOptionsForDelegation(parent)
          // fork（corum）：模型锁——preset config.model > 全局默认模型（research 实例
          // 用 defaultResearchModel，worker 用 defaultModel）> 跟随父（官方原逻辑）。
          const corumGlobalModel = corumReadonlyResearch ? corumGlobal().defaultResearchModel : corumGlobal().defaultModel
          const corumEffectiveModel = config.model ?? corumGlobalModel
          const corumLockedOptions: AgentOptions | undefined = corumEffectiveModel === undefined
            ? undefined
            : {
                provider: corumEffectiveModel.provider,
                model: corumEffectiveModel.model,
                ...corumEffectiveModel.reasoningEffort !== undefined
                  ? { reasoningEffort: corumEffectiveModel.reasoningEffort as ReasoningEffortId }
                  : {},
              }
          const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined
          const request: {
            label: string
            prompt: ContentBlock[]
            parent: Agent
            agentOptions?: AgentOptions
            persona?: string
            toolFilter?: { allow?: string[]; deny?: string[] }
            maxDepth?: number
            // fork（corum）：SubagentStartRequest.cwd（@corum/corum-subagent seam 层校验绝对路径）。
            cwd?: string
          } = {
            label: args.description,
            prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
            parent,
            ...corumLockedOptions !== undefined ? { agentOptions: corumLockedOptions } : {},
            ...config.persona !== undefined ? { persona: config.persona } : {},
            ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
            ...maxDepth !== undefined ? { maxDepth } : {},
          }
          if (corumLockedOptions === undefined) {
            const requiresRoutePreflight = hasDelegationModelRequest(modelRequest)
              || hasConfiguredLlmSelection(config.agentOptions)
            const configuredChildAgentOptions = requiresRoutePreflight && providerRouteDefaults !== undefined
              ? { ...providerRouteDefaults, ...config.agentOptions }
              : config.agentOptions
            const requestedChildAgentOptions = requestedAgentOptions(
              parentOptions,
              configuredChildAgentOptions,
              modelRequest,
              modelSelectionEnabled,
            )
            assertAllowedModelSelection(
              modelSelectionPolicy,
              parentOptions,
              requestedChildAgentOptions,
              modelRequest,
            )
            if (requiresRoutePreflight) {
              const llm = runtimeCtx.get('llm')
              if (llm === undefined) {
                throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
              }
              await preflightChildLlmRoute(
                llm,
                parentOptions,
                requestedChildAgentOptions,
                exec.signal,
                providerRouteDefaults === undefined,
              )
              if (runtimeCtx.subagents.getProvider(config.provider) !== subagentProvider) {
                throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
              }
            }
            exec.signal.throwIfAborted()
            if (requestedChildAgentOptions !== undefined) request.agentOptions = requestedChildAgentOptions
          } // fork（corum）：end 模型锁缺省分支（官方原逻辑）

          // fork（corum）：写工具判定与隔离触发（纯函数，单测覆盖）。
          const corumIsWrite = corumIsWriteTask(config.toolFilter, corumReadonlyResearch, corumDenyDirectFs)
          const corumIsolate = corumShouldIsolate(corumIsolationMode, corumIsWrite, corumReadonlyResearch)

          // fork（corum）：integrate 召唤（fan-in/Manager）——骨架阶段仅前台路径。
          if (args.integrate === true) {
            const sessionId = parent.session.id
            const entries = corumWorktreeLedger.get(sessionId) ?? []
            // fork（corum）：准入=active 或 settled 全量（修复第一阶段只认 active
            // 挡住"全部完工后合并"的缺陷）。
            const pending = corumPendingIntegration(entries)
            if (pending.length === 0) {
              throw new Error('no isolated worktrees to integrate')
            }
            const runSpec = resolveDelegationRun(args, { backgroundEnabled, continuable })
            if (runSpec.runInBackground) {
              // 本阶段 continuation/背景路径 settle 时机在工具外，无法执行台账
              // 结算与清理——integrate 只允许前台。
              throw new Error('integrate must run in foreground (runInBackground: false)')
            }
            const parentCwd = parent.session.header.cwd ?? process.cwd()
            // fork（corum）：未显式配置时按主干仓库形态探测默认 checks。
            const effectiveChecks = corumIntegrateChecks ?? corumDetectIntegrateChecks(parentCwd)
            // fork（corum）：主 Agent 声明的验证方式（schema 的 verify 参数；
            // 未声明时 persona 标注「最低限度格式校验」语义）。
            const declaredVerify = typeof args.verify === 'string' && args.verify.trim() !== '' ? args.verify : undefined
            const corumIntegrateRequest = {
              ...request,
              // fork（corum）：集成者回主干、不附加 deny、persona 注入集成者身份、
              // prompt 机制拼装（台账分支清单+固定 checks 在前，LLM prompt 在后）。
              cwd: parentCwd,
              persona: corumIntegratorPersona(pending, effectiveChecks, corumMerger, declaredVerify),
              prompt: [{
                type: 'text',
                text: corumIntegratorPersona(pending, effectiveChecks, corumMerger, declaredVerify) + '\n\n' + String(args.prompt),
              }] as ContentBlock[],
            }
            const run: SubagentRun = await runtimeCtx.subagents.start(config.provider, {
              ...corumIntegrateRequest,
              signal: exec.signal,
            })
            const outcome = await settleForegroundRun(run)
            // fork（corum）：settle 后台账结算 + autoCleanup（仅台账登记的条目）。
            for (const entry of pending) entry.status = 'integrated'
            if (corumAutoCleanup) corumCleanupLedgerEntries(parentCwd, pending, ['integrated'])
            emitLedgerFrame(ctx, sessionId)
            return outcome
          }

          // fork（corum）：worktree 创建（隔离触发时，父会话 header.cwd 下）。
          if (corumIsolate) {
            const parentCwd = parent.session.header.cwd ?? process.cwd()
            const sessionId = parent.session.id
            const entries = corumWorktreeLedger.get(sessionId) ?? []
            // fork（corum）：maxParallelChildren 强制——超限拒绝新召唤（只计 active）。
            if (entries.filter(entry => entry.status === 'active').length >= corumMaxParallelChildren) {
              throw new Error('parallel child limit reached; wait for one to settle or integrate first')
            }
            const slug = `wt-${randomBytes(3).toString('hex')}`
            const root = path.resolve(parentCwd, corumIsolation?.worktreeRoot ?? '.corum-worktrees')
            const branch = `${corumIsolation?.branchPrefix ?? 'wt/'}${slug}`
            const worktreePath = path.join(root, slug)
            mkdirSync(root, { recursive: true })
            try {
              corumGit(parentCwd, ['worktree', 'add', worktreePath, '-b', branch])
            } catch (error: unknown) {
              // fork（corum）：失败回滚后抛出（清理失败不掩盖原始错误）。
              corumCleanupWorktree(parentCwd, { path: worktreePath, branch })
              throw error
            }
            entries.push({ slug, branch, path: worktreePath, status: 'active' })
            corumWorktreeLedger.set(sessionId, entries)
            corumLedgerCwds.set(sessionId, parentCwd)
            emitLedgerFrame(ctx, sessionId)
            request.cwd = worktreePath
            // fork（corum）：request.toolFilter 合并 deny str_replace_editor。
            request.toolFilter = corumEffectiveToolFilter(config.toolFilter, corumDenyDirectFs)
            // fork（corum）：隔离告知——子 Agent 只看相对路径行动（防止它按父
            // prompt 里的主干绝对路径写文件而被沙箱拒；机制语义对齐
            // SUBAGENT_DELEGATION_CONTEXT 的 runtime-context 形式）。
            const isolationNotice = `[corum isolation] You are working inside an isolated git worktree (branch ${branch}). Your working directory IS the worktree root; address every file by RELATIVE path only. The parent working tree outside this worktree is read-denied by the sandbox. Commit your changes on branch ${branch} inside this worktree; do not attempt to touch paths outside it.\n\n`
            request.prompt = [{ type: 'text', text: isolationNotice + args.prompt }] as ContentBlock[]
          }

          const runSpec = resolveDelegationRun(args, { backgroundEnabled, continuable })
          if (runSpec.runInBackground) {
            if (continuable) {
              // Resolves at inbox acceptance: the child owns its own turns from
              // there, so this call neither waits for nor collects a result.
              const started = await runtimeCtx.subagents.startContinuable({
                provider: config.provider,
                label: args.description,
                request,
                signal: exec.signal,
              })
              return { kind: 'continuable' as const, subagentId: started.childId }
            }
            const jobs = runtimeCtx.get('jobs')
            if (jobs === undefined) {
              throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
            }
            // One-shot background child: job preflight finishes before the
            // starter can spawn, and the task-owned signal covers startup.
            const id = jobs.start({
              kind: 'subagent',
              label: args.description,
              owner: parent,
              run: () => {
                const controller = new AbortController()
                const start = runtimeCtx.subagents.start(config.provider, { ...request, signal: controller.signal })
                return {
                  cancel: (reason?: string) => {
                    controller.abort(reason ?? 'background subagent task killed')
                  },
                  done: settleStart(start, controller.signal),
                  // No readOutput: the child session owns intermediate detail.
                }
              },
            })
            return { kind: 'background' as const, jobId: id }
          }

          const run: SubagentRun = await runtimeCtx.subagents.start(config.provider, {
            ...request,
            signal: exec.signal,
          })
          return settleForegroundRun(run)
        },
      }))
      mounted = { subagentProvider, disposeTool }
    }

    // Register listeners before checking presence so no synchronous change is missed.
    // TODO(subagent-dup-toolname): two waiting one-shot fibers configured with the
    // same toolName collide when their provider appears, and the duplicate-name
    // throw rolls back the provider registration. Continuable instances reserve
    // their prompt-section name during apply() and fail earlier. Add an intent
    // registry if the late one-shot collision occurs in a shipped composition.
    runtimeCtx.on('subagent/provider-added', (subagentProvider) => {
      if (subagentProvider.name === config.provider && mounted === undefined) mount(subagentProvider)
    })
    runtimeCtx.on('subagent/provider-removed', (name) => {
      if (name !== config.provider || mounted === undefined) return
      mounted.disposeTool()
      mounted = undefined
    })
    const present = runtimeCtx.subagents.getProvider(config.provider)
    if (present !== undefined) {
      mount(present)
    } else {
      // A backend fiber may activate later; a misspelled provider remains visible in this log.
      runtimeCtx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
    }
    if (backgroundEnabled && continuable) {
      // The section follows provider availability without its own manual
      // lifecycle: empty text is omitted from rendered prompts while the tool is
      // absent, and the registration itself stays owned by this plugin fiber.
      runtimeCtx.systemPrompt.section({
        name: `tool:${toolName}`,
        order: runtimeCtx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
        text: context => mounted === undefined || runtimeCtx.tools.get(toolName, context.scope) === undefined
          ? ''
          : `Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.`,
      })
    }
  }

  if (config.modelSelectionSettings !== true) {
    install(ctx, undefined)
    return
  }

  const settings = ctx.get('subagentModelSelection')
  if (settings === undefined) {
    throw new Error(
      'tool-subagent: `modelSelectionSettings` requires '
      + '@deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope',
    )
  }
  const compositionScope = scopeOf(ctx)
  if (compositionScope === undefined) {
    throw new Error('tool-subagent: `modelSelectionSettings` requires an Agent or preset scope')
  }

  const selectForAgent = (agent: NonNullable<Context['agent']>): ModelSelectionPolicy | undefined => {
    const freshSession = agent.session.firstLiveSeq === 0
      && agent.session.eventAt(SessionSeq(0))?.type !== 'session/end-seed'
    let allowedModels = subagentModelSelectionPolicy(ctx.sessionProjections, agent.session)
    if (allowedModels === undefined) {
      const parentId = agent.session.header.origin === 'subagent'
        ? agent.session.header.parentSession
        : undefined
      if (parentId !== undefined) {
        const parent = ctx.get('agents')?.get(parentId)
        allowedModels = parent === undefined
          ? undefined
          : subagentModelSelectionPolicy(ctx.sessionProjections, parent.session)
      } else if (freshSession) {
        const current = settings.current()
        allowedModels = current.enabled ? current.allowedModels : undefined
      }
    }
    if (allowedModels !== undefined) {
      recordSubagentModelSelection(ctx.sessionProjections, agent.session, allowedModels)
    }
    return allowedModels === undefined ? undefined : { routes: allowedModels }
  }

  const agent = ctx.agent
  if (agent !== undefined) {
    install(ctx, selectForAgent(agent))
    return
  }
  const agents = ctx.get('agents')
  /* v8 ignore next -- Agent and preset scopes are minted only by the Agent registry. */
  if (agents === undefined) throw new Error('tool-subagent: scoped model-selection settings require the Agent registry')
  const scopedInstalls = new WeakMap<Agent, ReturnType<Context['inject']>>()
  const installing = new WeakSet<Agent>()
  const belongsToComposition = (candidate: Agent): boolean =>
    scopeChainOf(scopeOf(candidate.ctx)).includes(compositionScope)
  const installScoped = (candidate: Agent): void => {
    if (scopedInstalls.has(candidate) || installing.has(candidate)) return
    // Reserve before the injected fiber runs: tool registration emits
    // `tools/change` synchronously, which re-enters the reconciliation below.
    installing.add(candidate)
    let fiber: ReturnType<Context['inject']>
    try {
      const policy = selectForAgent(candidate)
      fiber = candidate.ctx.inject(['tools', 'subagents', 'systemPrompt'], (runtimeCtx) => {
        install(runtimeCtx, policy)
      })
    } finally {
      installing.delete(candidate)
    }
    scopedInstalls.set(candidate, fiber)
  }
  const removeScoped = (candidate: Agent): void => {
    const fiber = scopedInstalls.get(candidate)
    if (fiber === undefined) return
    scopedInstalls.delete(candidate)
    /* v8 ignore next 3 -- Cordis Fiber disposal contains registration cleanup failures; this is the final diagnostic sink. */
    void fiber.dispose().catch((error: unknown) => {
      ctx.logger.warn(`tool-subagent: failed to remove recomposed Agent "${candidate.id}" definitions: ${String(error)}`)
    })
  }
  const reconcileComposedAgents = (): void => {
    // Every Agent and preset scope is minted by the Agent registry; the scope
    // check above makes this same-process typed relationship authoritative.
    for (const candidate of agents.list()) {
      if (belongsToComposition(candidate)) installScoped(candidate)
      else removeScoped(candidate)
    }
  }
  // A shipped preset is mounted once in a standing scope. Its listener admits
  // only descendant Agents and installs the sampled tool definition in each
  // Agent's own scope, so a later settings change cannot mutate a live session.
  ctx.on('agent/created', ({ agent: created }) => {
    installScoped(created)
  })
  ctx.on('agent/disposed', ({ agent: disposed }) => { removeScoped(disposed) })
  // Reparenting an Agent between standing presets changes its inherited tool
  // set and emits `tools/change`; reconcile the Agent-owned override with the
  // new ancestry. Other registry changes are idempotent no-ops here.
  ctx.on('tools/change', reconcileComposedAgents)
}
