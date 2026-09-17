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
import { carrierKeyOf, scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  assertSubagentMaxDepth,
  parentAgentOptionsForDelegation,
  settleRun,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
// fork（corum）：orchestrate 任务级结构化输出（吸收 workflow 的 agent({schema}) 语义）。
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
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
// fork（corum）：隔离编排纯函数从 orchestration.ts 引入（含 re-export 到下游）。
import {
  CorumOrchestration,
  corumAutoIntegrate,
  corumCleanupWorktree,
  corumDetectIntegrateChecks,
  corumDirectWriteNotice,
  corumEffectiveToolFilter,
  corumGit,
  corumGitHead,
  corumGitStatusPorcelain,
  corumIntegrationFailure,
  corumIntegrationTruth,
  corumPortPendingBranches,
  corumIntegratorPersona,
  corumIsGitRepo,
  corumIsolationBoundaryNotice,
  corumIsolationNotice,
  corumIsWriteTask,
  corumMarkSettled,
  corumNarrowDenyFilter,
  corumPartialIntegrationNotice,
  corumMutationToolsForPlatform,
  corumBranchTip,
  corumReapRestoredEntries,
  corumReapOrphanWorktrees,
  corumListIsolatedWorktrees,
  corumBranchAddsCommits,
  corumReconcileIntegrated,
  corumMergedBranches,
  corumPendingIntegration,
  corumResearchToolFilter,
  corumShouldIsolate,
  corumVisibleToolNames,
  corumWriteToolsForPlatform,
} from './orchestration.ts'
import type { CorumWorktreeEntry, CorumWorktreeLedgerFrame } from './orchestration.ts'

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
    /**
     * always=凡召唤必隔离；write-tasks=写任务**且可能并发**才隔离（默认；
     * 单发前台写任务直接在主工作区执行，2026-09-09 并发感知）；off=不隔离。
     */
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

/**
 * fork（corum）：委派工具名 → 角色（UI 图标/小标）。**与
 * `@corum/corum-api-remotes` 的 `subagentDelegationRoleOf` 同表**——本包的编译
 * 程序里看不到 api-remotes（fork 包各自声明，见下），故在此镜像一份；
 * `@corum/corum-api-remotes` 的 `remote-events.host.spec.ts` 有单测逐项对账两处
 * 的工具名表（改一处不同步就红），改一处必须两处一起改。
 * 角色只从**工具名**派生，绝不按 label 文案猜（2026-09-12 用户定调）。
 */
const CORUM_DELEGATION_ROLE_BY_TOOL: Readonly<Record<string, 'worker' | 'research' | 'fork'>> = {
  subagent: 'worker',
  subagent_research: 'research',
  subagent_fork: 'fork',
}

/**
 * fork（corum）：`corum/subagent/child` 载荷——spawn 成功那一刻的精确父子映射。
 *
 * 与 `@corum/corum-api-remotes` 的 `SubagentChildEvent` 同构（自包含声明：本包
 * 的编译程序里看不到 api-remotes 的 Events 合并，按 fork 包之间的既有口径各自
 * 声明一次，结构必须逐字段一致，改一处要两处一起改——verify-fork-drift.sh
 * §事件段会兜住声明/转发两侧）。
 */
interface CorumSubagentChildEvent {
  readonly parentSessionId: string
  readonly callId: string
  readonly childSessionId: string
  readonly label: string
  readonly isolated: boolean
  /** 委派角色（工具名派生；见 `CORUM_DELEGATION_ROLE_BY_TOOL`）。 */
  readonly role?: 'worker' | 'research' | 'fork'
  /** 前台一次性（父等结果）还是后台 agent（父继续干活、可续接）。 */
  readonly mode: 'foreground' | 'background'
  readonly worktree?: { readonly slug: string; readonly branch: string; readonly path: string }
  /**
   * 本次 spawn 的真实生效模型路由（与 `SubagentChildEvent.model` 同构）。
   * 取 `request.agentOptions`（锁定路径=fork compile 的角色锁模型；非锁定/fork
   * 路径=从 `parentAgentOptionsForDelegation` 合并来的父真实路由），缺失退回
   * `corumEffectiveModel`，两者都无则不写。fork 实例不写 config.model →
   * `request.agentOptions` 来自 `parentAgentOptionsForDelegation(parent)` →
   * 读父 `session.requestHeader().config` 的 provider/model → 即父真实路由。
   */
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly time: number
}

// fork（corum）：与 corum-orchestration 的 `corum/worktree-ledger` 同款——本包
// 自己声明一次，emit 点不必 `as never`。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'corum/subagent/child': (data: CorumSubagentChildEvent) => void
  }
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
  /**
   * fork（corum）：本次委派的隔离落点——**只在没隔离时**由 `spawnOne` 附上
   * （`parent-tree` / `skipped-non-git`），由工具的 render 渲染成一行给父 Agent 的
   * 事实说明（见 `corumIsolationBoundaryNotice`）。2026-09-13 用户定调「先做可见性」。
   */
  readonly isolationBoundary?: 'parent-tree' | 'skipped-non-git'
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
        // fork（corum）：把权威 stopReason 挂到 Error 上，让 orchestrate 的
        // catch 分支能按 stopReason（而非错误串匹配）区分「手动终止」与「失败」。
        const thrown = new Error(withDiagnosticAndPartialText(error, result))
        ;(thrown as { stopReason?: SubagentResult['stopReason'] }).stopReason = result.stopReason
        throw thrown
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
 * fork（corum）：**部分集成**的通知——分支都落地了，但个别 worktree 还留着未提交
 * 改动（写了没提交）。这类条目保持 pending、保留现场，由主 Agent 决定补提交还是丢弃；
 * 其余条目已正常翻转。以 settlement notice 同款形态注入父会话，保证主 Agent 不会
 * 以为「全清干净了」。注入失败只告警（可见性是增强，不能反过来让委托失败）。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param notice - `corumPartialIntegrationNotice()` 产出的说明文本。
 * @param logger - 注入失败时的告警出口。
 */
function corumNotifyPartialIntegration(
  parent: Agent,
  notice: string,
  logger: { warn: (message: string) => void },
): void {
  try {
    parent.inject(createUserMessage({
      content: [{ type: 'text', text: notice }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary('integrate partially persisted — leftovers kept pending'),
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`partial-integration notice was not delivered to its parent: ${String(error)}`)
  }
}

/**
 * fork（corum）：**待集成分支**的通知（2026-09-12 用户实测后补）。
 *
 * 数据：12 个用过 orchestrate 的会话里 `autoIntegrate` 声明 true 仅 5 次、false 10 次、
 * 未声明 6 次，而真正发生过集成的只有 3 个会话——旧默认「不声明/false 一律只报告」
 * 把合并交给模型记性，它大多不会回来做，于是隔离分支静默搁浅（唯一一份提交没人看得到）。
 * 现在：声明 `verify` 即默认自动集成；**显式 opt-out 时由本通知兜底**，把「还有 N 条分支
 * 没合并、怎么收尾」推到父会话的第一步，而不是埋在工具结果里。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param branches - 仍未合并的分支名。
 * @param logger - 注入失败时的告警出口。
 */
function corumNotifyPendingIntegration(
  parent: Agent,
  branches: readonly string[],
  logger: { warn: (message: string) => void },
): void {
  if (branches.length === 0) return
  try {
    parent.inject(createUserMessage({
      content: [{
        type: 'text',
        text: `[corum] ${branches.length} isolated branch(es) are NOT merged into the main tree: ${branches.join(', ')}. `
          + 'Their commits are the only copy of that work — nobody sees them otherwise. '
          + 'Finish it yourself with `subagent { integrate: true }` (merge + verify + commit), or discard them explicitly.',
      }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary('pending integration: branches not merged'),
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`pending-integration notice was not delivered to its parent: ${String(error)}`)
  }
}

/**
 * fork（corum）：前台子 Agent 的最终汇报以「settlement notice」形态注入父会话。
 *
 * 2026-09-09 用户实机反馈「子 Agent 结束后反馈没有注入主 Agent」：汇报本来就在
 * `subagent` 的工具结果里（父 Agent 的模型上下文拿得到），但它在会话流里只是一张
 * 工具卡的内容，用户很难注意到；而子会话卡片只显示进度与任务提示词。这里复用
 * fork #9 后台子 Agent 的同款通知形态（`source.kind: 'subagent-settled'` +
 * `form: 'notice'`，chat 渲染成一条可见的注入行），把汇报变成会话里的一等消息。
 *
 * 注入走 `agent.inject()`（模型面上下文，不唤醒驱动器）：父 Agent 正在等工具结果，
 * 下一个 step 边界领取；若这一轮就此结束，消息留在收件箱、下一轮可见，绝不会
 * 因为它凭空开启新回合。注入失败只告警——可见性是增强，不能反过来让委托失败。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param childId - 子会话 id（notice 的 senderSessionId）。
 * @param label - 委托标签（给 summary 一句人话上下文）。
 * @param outcome - 前台 settle 结果（output = 子 Agent 最终 assistant 文本块）。
 * @param logger - 注入失败时的告警出口。
 */
function corumNotifyForegroundResult(
  parent: Agent,
  childId: string,
  label: string,
  outcome: ForegroundToolResult,
  logger: { warn: (message: string) => void },
): void {
  try {
    const report = outputValueText(outcome.output).trim()
    const summary = `Subagent ${childId} finished (${label}) — final report:`
    parent.inject(createUserMessage({
      content: [
        { type: 'text', text: summary },
        { type: 'text', text: report === '' ? 'It left no closing message.' : report },
      ],
      // fork #9 的 source 声明在 @corum/corum-subagent 的模块增补里，本包的程序
      // 里看不到那个 MessageSourceMap 合并——按 dev-conventions §4a 的跨包类型
      // 口径收窄（与同一文件里 `subagent/end` 监听同款）。
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary(summary),
        senderSessionId: childId,
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`subagent foreground result notice was not delivered to its parent: ${String(error)}`)
  }
}

/**
 * fork（corum）：**收口强制提交失败**的模型面投递（2026-09-15 机制补漏）。
 *
 * 用户裁定：「commit 失败后**交由模型处理并完成提交**」。⇒ 这里不是「报告一个错误然后算了」，
 * 而是把失败变成**模型必须接手的待办**，因此消息里必须给全三样：
 *   ① **哪个 worktree**（slug + 路径）；② **为什么失败**（git stderr 摘要，逐条可读）；
 *   ③ **下一步该做什么**（把提交补上；工作与现场都还在，没有丢）。
 *
 * 投递方式与 {@link corumNotifyForegroundResult} 同款（`form: 'notice'`，会话里一条可见注入行）：
 * 走 `parent.inject()`（模型面上下文，**不唤醒驱动器**）——父 Agent 正在等工具结果，
 * 下一个 step 边界领取；注入失败只告警，不让收口本身失败。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param failures - 收口时提交失败的 worktree 清单（结构化）。
 * @param logger - 注入失败时的告警出口。
 */
function corumNotifySettleCommitFailures(
  parent: Agent,
  failures: readonly CorumSettleCommitFailure[],
  logger: { warn: (message: string) => void },
): void {
  try {
    const summary = `Settle auto-commit FAILED for ${failures.length} isolated worktree(s) — you must finish the commit`
    const detail = failures
      .map(failure => `· ${failure.slug}  ${failure.path}\n  reason: ${failure.reason}`)
      .join('\n')
    parent.inject(createUserMessage({
      content: [
        { type: 'text', text: summary },
        {
          type: 'text',
          text: [
            'The mechanism auto-commits an isolated worktree when it settles so that no isolated work can be',
            'lost. That commit FAILED, so the work is still uncommitted inside the worktree(s) below — it is',
            'NOT lost, but nobody can see it until it is committed.',
            '',
            detail,
            '',
            'Do this next: fix the cause (a missing `git config user.email`/`user.name` is the common one),',
            'then commit inside each worktree listed above, and report the resulting commit hash(es).',
            'Do not discard the worktree and do not force-remove it.',
          ].join('\n'),
        },
      ],
      // 与 corumNotifyForegroundResult 同款跨包类型收窄（fork #9 的 source 声明在
      // @corum/corum-subagent 的模块增补里，本包程序看不到那个 MessageSourceMap 合并）。
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary(summary),
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`settle commit-failure notice was not delivered to its parent: ${String(error)}`)
  }
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

/**
 * fork（corum）：bash / 委派效率纪律（机制段条目，**单一事实源**）。
 *
 * 抽成导出纯函数的原因（2026-09-14 委派正确性轮）：这段文本此前以字面量内联在
 * `systemPrompt.section` 回调里，只有「实机重启后读工具描述」才能验证它是否还
 * 与机制事实一致。抽出来后单测能直接断言内容与措辞纪律（`prompt-discipline.spec.ts`），
 * 提示词漂移变成可执行断言。
 *
 * 措辞纪律（用户 2026-09-14 定调）：只写**通用规则 + 机制理由**，英文、祈使、
 * 一句话说清「什么时候用、怎么用、什么时候不能用」；不写实测数字、不写具体
 * 端口/脚本名/会话、不假设某种使用模式；量化只允许机制常量（默认超时、上限、
 * 每次调用新 shell、stdin 忽略、后台句柄等）。
 * @returns 机制段的效率纪律行（含前置空行）。
 */
export function corumEfficiencyDisciplineLines(): string[] {
  return [
    '',
    'EFFICIENCY DISCIPLINE:',
    '- MERGE SMALL QUERIES. Batch every `grep`/`sed`/`nl`/`awk`/`head` extraction you need into ONE `bash` call instead of one call per fact: every extra call costs a full model round-trip.',
    '- KNOW YOUR SHELL. The bash tool runs one command per call, non-interactively with stdin ignored, so a bare `grep foo` returns immediately instead of waiting for input. Commands are time-boxed — 60s by default; pass `timeoutMs` (up to 600000) for longer runs. Create and edit files with the `write`/`edit` tools rather than shell redirection or in-place editors: they keep quoting under control and land in the change-review trail.',
    '- KEEP EACH COMMAND ON ONE LINE, statements joined with `;` or `&&`, so that a loosely delimited fragment cannot do something other than what you intended.',
    '- EVERY CALL GETS A FRESH SHELL. No cwd, variable or function persists between calls, so never rely on a `cd` from an earlier call: chain `cd <dir> && <cmd>` inside one call, or pass `workdir`.',
    '- PUT LONG-RUNNING OR NOT-YET-NEEDED COMMANDS IN THE BACKGROUND. A server, a watcher, a long build or a long test suite belongs behind `run_in_background: true`, so the call returns a handle at once and the conversation is not blocked; read that handle with `job_output` and stop it with `job_kill`. Never replace that handle with "wait a moment, then look again". Do not background a command whose result you need before the next step; do not background an operation that would stop or restart the runtime this session depends on; do not start a background process whose output cannot be retrieved.',
    '- BUDGET YOUR OWN VERIFICATION. Self-checking your work means exactly three things: (1) read your own diff, (2) run the repo guard ONCE in full, (3) at most 3 targeted checks on the riskiest points you touched. That is the entire budget.',
    '- DELEGATION IS NOT VERIFICATION. A child started from the same context reads the same code and cannot produce independent evidence, so re-running a check through another delegation buys no confidence. Spend the verification budget on your own diff and a few targeted checks.',
    '- REPORT SCOPE. State how many steps and how many tool calls the run took, so the cost and the progress of the work are legible to whoever reads the result.',
  ]
}

/**
 * fork（corum）：沙箱拒绝 → 一次升级 → 由用户裁决（机制段条目，单一事实源）。
 *
 * 这段文本同时注入主会话与子会话（preset scope 共享，子 Agent 经
 * `agentPresets.composeFrom` 继承父的 preset scope 段），所以弹窗承诺必须双分岔：
 * 主会话的审批策略是 `ask`（弹窗真实存在），子会话的审批策略钉死为 `never`
 * （`corum-subagent/src/child-agent.ts` 的 `captureDelegatedPolicyOverrides`，
 * `approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never'`），
 * 子会话拿不到可审批通路。措辞纪律同 {@link corumEfficiencyDisciplineLines}。
 * @returns 机制段的沙箱升级行（含前置空行）。
 */
export function corumSandboxEscalationLines(): string[] {
  return [
    '',
    'SANDBOX DENIALS AND ESCALATION:',
    '- A blocked file operation reports a `[sandbox: file access denied under <mode> mode]` marker. That is a policy decision, not a failure of the command: read the marker instead of assuming the denial.',
    '- When a wider mode would let the command succeed, retry the exact same command once, in the same turn, with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. In a session whose approval policy is `ask` that retry raises the approval prompt, and the user\'s answer to it is the consent — do not detour through chat to ask first.',
    '- In a DELEGATED CHILD session the approval policy is pinned to `never`, so no approval prompt is reachable and a retry is rejected deterministically. Treat a denial there as the final result: report it as a conclusion in your final report, so the caller sees it, instead of reworking around it or waiting for an approval that cannot come.',
    '- Escalate only from a real denial, never speculatively. If the session states that approval prompts are disabled, a denial is final: do not set `sandbox_permissions`.',
    '- A rejected escalation is final for that command: stop and explain it instead of working around it. It does not forbid attempting or escalating other commands later.',
  ]
}

/**
 * fork（corum）：工具描述里的调度句（单一事实源）。
 *
 * 模型可见文本内联在 `defineTool` 回调里时只有实机重启后读工具描述才能验证
 * 它是否与机制事实一致。抽成导出纯函数后单测能直接断言「research 实例读到
 * 恒前台」并钉住它与 `run_in_background` 拒绝路径（throw）一致。措辞纪律同
 * {@link corumEfficiencyDisciplineLines}。
 * @param options.backgroundEnabled - 是否启用后台调度。
 * @param options.continuable - 是否为 continuable 后台模式。
 * @param options.readonlyResearch - 是否为只读研究实例。
 * @returns 接在 `wording.description` 后面的调度描述句（开头保留一个空格）。
 */
export function corumSchedulingDescription(options: { readonly backgroundEnabled: boolean; readonly continuable: boolean; readonly readonlyResearch: boolean }): string {
  if (options.readonlyResearch) {
    return ' This read-only research tool ALWAYS runs in the FOREGROUND: its report returns in this tool result, so you read the findings inline. Do NOT pass `run_in_background: true` (it is rejected).'
  }
  if (!options.backgroundEnabled) {
    return ' This call waits for the subagent and returns its result.'
  }
  if (options.continuable) {
    return ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` steers the child\'s nearest step while it is running and starts a turn while it is idle. Set `run_in_background: false` only when your next action depends on receiving the result.'
  }
  return ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
}

/**
 * fork（corum）：机制段 `tool:${toolName}` 的调度文本（单一事实源）。
 *
 * 与 {@link corumSchedulingDescription} 同源：research 实例读「恒前台」，其余实例
 * 读官方后台默认措辞。抽成纯函数的原因同上——模型可见文本内联在
 * `systemPrompt.section` 回调里时只有实机重启才能验证，抽出后单测直接断言。
 * @param options - 同 {@link corumSchedulingDescription}。
 * @param toolName - 段内点名的是本实例的工具名——同一段文本服务
 * `subagent` / `subagent_research` / `subagent_fork` 三个实例，写死任一个就会指错工具。
 * @param ptcPrefix - PTC 模式前缀（非 PTC 为空串）。
 * @returns 机制段文本（`ptcPrefix` + 调度句）。
 */
export function corumSchedulingSectionText(options: { readonly backgroundEnabled: boolean; readonly continuable: boolean; readonly readonlyResearch: boolean }, toolName: string, ptcPrefix: string): string {
  if (options.readonlyResearch) {
    return ptcPrefix + 'This read-only research tool ALWAYS runs in the FOREGROUND: its report returns in this tool result, so you read the findings inline. Do NOT pass `run_in_background: true` (it is rejected) — a backgrounded investigation leaves you guessing or repeating work. It has a shell for read-only commands (`git log`, `ls`, reading PID/log files, a verify script\'s `status`) but its sandbox is pinned to `read-only` and write/edit are denied, so it can never modify the repo. Fan out several research calls in ONE message when you need answers from different angles.'
  }
  return ptcPrefix + `Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message. IMPORTANT: when you need to fan out SEVERAL parallel sub-tasks (especially parallel WRITE tasks), use the \`orchestrate\` tool instead of issuing multiple ${toolName} calls — one orchestrate call gives every task its own isolated worktree AND a final integrator that merges + verifies + commits them for you; multiple bare ${toolName} calls leave you to integrate each branch by hand.`
}

/**
 * fork（corum）：`run_in_background` 参数 schema 的描述（单一事实源）。
 *
 * 与 {@link corumSchedulingDescription} / {@link corumSchedulingSectionText} 同源：
 * research 实例的 `run_in_background` 被拒绝（throw），描述必须说实话而非写
 * 「Defaults to true」。抽成纯函数的原因同上——模型可见 schema 描述同样需要
 * 可执行断言钉住它与拒绝路径一致。措辞纪律同 {@link corumEfficiencyDisciplineLines}。
 * @param options.continuable - 是否为 continuable 后台模式。
 * @param options.readonlyResearch - 是否为只读研究实例。
 * @returns 参数描述句。
 */
export function corumRunInBackgroundDescription(options: { readonly continuable: boolean; readonly readonlyResearch: boolean }): string {
  if (options.readonlyResearch) {
    return 'Not supported for this read-only research tool: it always runs in the foreground and `true` is rejected — omit it.'
  }
  return options.continuable
    ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.'
    : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.'
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

// fork（corum）：隔离编排纯函数 + 台账类型已下沉到 orchestration.ts
// （docs/plan/PLAN-subagent-orchestration.md §5，红线 1：台账状态改 cordis service）。
// 上方 import 引入局部作用域（apply 内部使用），此处 re-export 保持对外 API
// 兼容（单测/下游 import 路径不变）。
export {
  corumBranchIntegrated,
  corumBranchMerged,
  corumCleanupLedgerEntries,
  corumCleanupWorktree,
  corumDetectIntegrateChecks,
  corumEffectiveToolFilter,
  corumEntryDead,
  corumGit,
  corumGitHead,
  corumGitStatusPorcelain,
  corumDirtyOwnershipLines,
  corumIntegrationFailure,
  corumPartialIntegrationNotice,
  corumPortBranchDiff,
  corumPortPendingBranches,
  corumMergeBase,
  corumIntegrationTruth,
  corumIntegratorPersona,
  corumIsGitRepo,
  corumIsolationBoundaryNotice,
  corumIsWriteTask,
  corumMarkSettled,
  corumNarrowDenyFilter,
  corumMutationToolsForPlatform,
  corumAutoIntegrate,
  corumBranchTip,
  corumReapRestoredEntries,
  corumReapOrphanWorktrees,
  corumListIsolatedWorktrees,
  corumBranchAddsCommits,
  corumReconcileIntegrated,
  corumMergedBranches,
  corumPendingIntegration,
  corumResearchToolFilter,
  corumShouldIsolate,
  corumWorktreeHasUncommitted,
  corumWriteToolsForPlatform,
} from './orchestration.ts'
// 2026-09-15 机制补漏：收口强制提交失败的**结构化形状**（投递给模型时逐条标注）。
import type { CorumSettleCommitFailure } from './orchestration.ts'
export type { CorumCleanupOptions, CorumIntegrationTruth, CorumSettleCommitFailure, CorumWorktreeEntry, CorumWorktreeLedgerFrame } from './orchestration.ts'
export { CorumOrchestration } from './orchestration.ts'

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
  // fork（corum）：orchestrate 是**全局唯一**工具名，只能由 worker 实例注册。2026-09-10
  // 恢复 subagent_fork 实例（toolName 'subagent_fork'）后，原判据 `!corumReadonlyResearch`
  // 会让 fork 实例也去注册 orchestrate → 挂载直接失败（"tool \"orchestrate\" is already
  // registered in this scope"，实机 preset mount 报错）。判据收敛为「worker 实例」=
  // toolName 是 'subagent'（compile 恒定产物；research/fork 实例各有自己的 toolName）。
  const isWorkerInstance = toolName === 'subagent'

  // fork（corum）：编排器 service 只读消费（红线 1：跨会话/跨 bundle 单例）。
  // 台账语义是会话级（key=父 session id），必须在根上下文共享。provide 职责已
  // 移交给独立包 @corum/corum-orchestration（其 cordis 行在 patch.yml 中位于
  // 本工具行之前 apply，保证先就绪）；本 apply 不再幂等自建兜底，缺则抛装配
  // 错误——顺序由 patch.yml 行序承担（docs/plan/PLAN-refactor-orchestration-
  // package-and-settings-center.md 重构 1）。
  const orchestration = ctx.root.get('corumOrchestration') as CorumOrchestration
  if (orchestration === undefined) {
    throw new Error(
      'tool-subagent: `corumOrchestration` service not provided — '
      + '@corum/corum-orchestration must be mounted before this tool (cordis.patch.yml row order)',
    )
  }

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
  // fork（corum）：`subagent/end` 的父 Agent 是 dispatch 的 `this`（scope carrier），
  // **不是第二参数**——fork #9 声明为 `'subagent/end'(this: Scoped<SubagentRuntime>,
  // info)`，发射端只 `callback(info)`（lifecycle.ts）。此前写成 `(info, parentAgent)`
  // 恒收 undefined，`settleFromEnd` 里 `parentAgent.session.id` 抛错被 emitter 的
  // per-listener 容错吞掉 → 台账 settle 从未生效（docs/TODO.md，2026-09-09 修复）。
  // 用普通函数取 `this`，经 carrierKeyOf 解出父 Agent（dsh-scope 与 corum-subagent
  // 同实例：tsdown 已 external）。
  ctx.on('subagent/end' as never, (function (this: unknown, info: SubagentRunEndInfo) {
    // fork（corum）：settle 联动已下沉编排器 service（台账实例字段 + 帧发射）。
    const parent = carrierKeyOf(this) as Agent | undefined
    orchestration.settleFromEnd(info, parent)
    // 2026-09-15 机制补漏：**收口强制提交失败 ⇒ 交给模型完成提交**（用户裁定：
    // 「commit 失败后交由模型处理并完成提交」）。
    // ⚠️ 必须在这里投递，不能在 `settleFromEnd` 里 throw —— emitter 的 per-listener
    // 容错会**吞掉**抛错（本文件上方注释已记过 `parentAgent.session.id` 抛错被吞的先例）。
    // 有 parent 时按会话精确取走；拿不到 parent 时兜底取走全部，避免失败在实例里累积。
    const failures = orchestration.drainSettleCommitFailures(
      parent === undefined ? undefined : String(parent.session.id),
    )
    if (failures.length === 0) return
    if (parent === undefined) {
      ctx.logger.warn(
        `settle auto-commit failed for ${failures.length} worktree(s) but no parent Agent was reachable,`
          + ` so the model was not told: ${failures.map(failure => `${failure.slug}: ${failure.reason}`).join('; ')}`,
      )
      return
    }
    corumNotifySettleCommitFailures(parent, failures, ctx.logger)

    // 不变式④（invariant.merge-strategy，用户 2026-09-16）：**单发异步后台子 Agent 的分支
    // 由主 Agent 合并**——settle 后若有待集成隔离分支，同样注入 pending-integration 通知
    // （告知主 Agent「分支未合并 + 用 subagent {integrate:true} 收尾」）。原先 corumNotifyPendingIntegration
    // 只在编排（orchestrate）结果处触发，单发后台路径不报 ⇒ 主 Agent 可能永不合并（工作不丢但
    // 永不进主树，UI 只报 finished）。这里对所有产生隔离分支的 settle 统一补发，让单发后台与
    // 编排同样「不可静默」。编排路径仍会发自己的通知（两处通知幂等合并——同键去重）。
    if (parent !== undefined) {
      const pendingAfter = corumPendingIntegration(orchestration.entriesOf(String(parent.session.id)))
      if (pendingAfter.length > 0) {
        corumNotifyPendingIntegration(parent, pendingAfter.map(entry => entry.branch), ctx.logger)
      }
    }
  }) as never, { global: true })

  // fork（corum）：全局设置的 RPC 面（「子 Agent」设置 section 读写；
  // 经 corum-agent 的 TypertRemoteService 通道不可达（本包无 remote 面），
  // 以 cordis 服务直挂——UI 走 ctx.remote 的 settings-controller 官方通道，
  // 本行仅保证 namespace 已注册使官方 settings 文档面可用。
  // （见 packages/api/settings-controller：document-updated / section 读写
  // 按 namespace 分发，无需本包自建 RPC。）

  // fork（corum）：父 scope dispose 时清理未集成的 worktree（编排器 service 持有台账）。
  ctx.effect(() => () => {
    orchestration.cleanupOnDispose(['active', 'settled'])
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
    let mounted: { subagentProvider: SubagentProvider; disposeTool: () => void; disposeOrchestrate: () => void } | undefined

    /**
     * fork（corum）：单任务隔离 spawn——subagent（单发）与 orchestrate（任务清单
     * fan-out）共用。闭包捕获 install 的配置终值（三级配置已解析）；入参只给
     * runtimeCtx/exec/task 级差异。返回前台 settle 结果或后台/continuable 句柄。
     */
    /**
     * fork（corum）：广播 spawn 精确父子映射（`corum/subagent/child`）。
     *
     * 2026-09-09 用户反馈「子 Agent 处理时无法进入子会话实时查看」：卡片过去靠
     * 会话列表时间就近猜 childSessionId，运行期猜不出来（父会话在等工具结果、
     * 不产生事件 → 卡片不重算），于是 goto 按钮恒 disabled、进度帧也过滤不了。
     * 这里在 start 返回的同一刻按父侧 tool/call id 广播真实 id——卡片第一帧就能
     * 跳转并订阅进度。广播失败只告警（可见性增强，绝不影响委托）。
     */
    const corumChildRole = CORUM_DELEGATION_ROLE_BY_TOOL[toolName]
    const corumEmitChildStarted = (
      parentSessionId: string,
      callId: string | undefined,
      childSessionId: string,
      label: string,
      isolated: boolean,
      mode: 'foreground' | 'background',
      worktree: { slug: string; branch: string; path: string } | undefined,
      // 真实生效路由：取 request.agentOptions（锁定路径=角色锁；非锁定=fork 继承父
      // 真实路由），缺失退回 corumEffectiveModel，两者都无则 undefined（不伪造）。
      model: { provider: string; model: string; reasoningEffort?: string } | undefined,
    ): void => {
      if (callId === undefined || callId === '') return
      try {
        runtimeCtx.emit('corum/subagent/child', {
          parentSessionId,
          callId,
          childSessionId,
          label,
          isolated,
          // 角色 = 本工具实例的名字（subagent_research → research / subagent_fork →
          // fork / subagent → worker）。UI 图标与小标只认它，绝不按 label 文案猜。
          ...corumChildRole === undefined ? {} : { role: corumChildRole },
          mode,
          ...worktree === undefined ? {} : { worktree: { ...worktree } },
          ...model === undefined ? {} : {
            model: {
              provider: model.provider,
              model: model.model,
              ...model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {},
            },
          },
          time: Date.now(),
        })
      } catch (error: unknown) {
        runtimeCtx.logger.warn(`corum/subagent/child emit failed: ${String(error)}`)
      }
    }

    const spawnOne = async (
      runtimeCtx: Context,
      exec: { agent: Agent; signal: AbortSignal; callId?: string },
      args: {
        label: string
        prompt: string
        run_in_background?: boolean
        integrate?: boolean
        verify?: string
        // fork（corum）：orchestrate 任务级隔离/只读覆盖（subagent 工具不传，用配置终值）。
        taskIsolation?: 'always' | 'write-tasks' | 'off'
        taskResearch?: boolean
        // fork（corum）：本次调用内的 fan-out 任务数（并发感知隔离信号①；
        // subagent 工具不传 = 1）。
        fanoutCount?: number
        // fork（corum）：前台 settle 后是否向父会话注入 settlement notice
        // （subagent 工具注入；orchestrate 任务与 integrate 不注入——结果已由
        // 工具结果汇总，避免 N 条重复通知）。
        notifyParent?: boolean
        // fork（corum）：orchestrate 任务级结构化输出（对象根 JSON Schema）——子 Agent
        // 必须提交 schema 合法的结果，工作流式结构化子结果（2026-09-10 吸收 workflow 语义）。
        taskSchema?: ObjectJsonSchema
        // fork（corum）：orchestrate 任务级模型锁（tasks[i].model，P0-4 真接线
        // 2026-09-14）——调用方最具体的声明，优先级高于 preset config.model 与全局
        // 默认；subagent 工具不传（它的模型面被 schema 剔除，锁死 preset 路由）。
        taskModel?: { provider: string; model: string; reasoningEffort?: string }
      },
      subagentProvider: SubagentProvider,
    ): Promise<ForegroundToolResult | { kind: 'continuable'; subagentId: string } | { kind: 'background'; jobId: string }> => {
      const parent = exec.agent
      // fork（corum）：官方模型自选请求面（provider/model/reasoning_effort 直挂
      // args 顶层）——corum 的 subagent/orchestrate schema 已剔除这三个字段
      // （模型锁），modelRequest 恒为空对象，仅保形供官方函数签名消费；
      // tasks[i].model 走 taskModel 专线（上方锁分支），不混入此面。
      const modelRequest = args as DelegationModelRequest
      const parentOptions = parentAgentOptionsForDelegation(parent)
      const providerRouteDefaults = subagentProvider.agentRouteDefaults
      // fork（corum）：模型锁优先级（P0-4 真接线 2026-09-14）——
      //   任务级 tasks[i].model > preset config.model（角色锁，见
      //   corum-agent/compile.ts：worker→profile.subagentModel，research→
      //   profile.researchModel ?? subagentModel）> 全局默认 defaultModel/
      //   defaultResearchModel > 跟随父。任务级是最具体的调用方声明；
      //   subagent 工具的模型面被 schema 剔除，taskModel 只能来自 orchestrate。
      const corumGlobalModel = corumReadonlyResearch ? corumGlobal().defaultResearchModel : corumGlobal().defaultModel
      const corumEffectiveModel = args.taskModel ?? config.model ?? corumGlobalModel
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
      // fork（corum）：研究标志提前解析（任务级覆盖优先）——request 构造要用它把子会话
      // 沙箱钉成 read-only（2026-09-12 用户定调：research 开放 shell 以后，只读性由
      // 沙箱层保证，而不是靠 deny 掉 bash）。
      const effReadonlyResearch = args.taskResearch ?? corumReadonlyResearch
      const request: {
        label: string
        prompt: ContentBlock[]
        parent: Agent
        agentOptions?: AgentOptions
        persona?: string
        toolFilter?: { allow?: string[]; deny?: string[] }
        maxDepth?: number
        cwd?: string
        outputSchema?: ObjectJsonSchema
        readonlySandbox?: boolean
      } = {
        label: args.label,
        prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
        parent,
        ...corumLockedOptions !== undefined ? { agentOptions: corumLockedOptions } : {},
        ...config.persona !== undefined ? { persona: config.persona } : {},
        ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
        ...maxDepth !== undefined ? { maxDepth } : {},
        // fork（corum）：结构化子结果（orchestrate 任务级 schema，吸收 workflow 语义）。
        ...args.taskSchema !== undefined ? { outputSchema: args.taskSchema } : {},
        // fork（corum）：只读研究子 Agent 的沙箱钉成 read-only（工具面禁变异工具 + 沙箱层
        // 禁文件写入，两层分工保证「调研能跑命令，但改不了仓库」）。
        ...effReadonlyResearch ? { readonlySandbox: true } : {},
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

      // fork（corum）：任务级模型锁的校验（P0-4 真接线 2026-09-14）——tasks[i].model
      // 声明的路由必须过两道门禁才允许生效：① settings 兜底（modelSelectionPolicy
      // 的 routes 白名单，与官方模型自选同一权威；corum preset 未开
      // modelSelectionSettings 时 policy=undefined，该层自动跳过）；② 真路由预检
      // （llm.resolveCallConfig）——非法 provider/model 在 spawn 前报错，任务以
      // 「[task N] failed」落汇合结果，而不是启一个半死的子会话。
      if (args.taskModel !== undefined) {
        assertAllowedModelSelection(
          modelSelectionPolicy,
          parentOptions,
          request.agentOptions,
          { provider: args.taskModel.provider, model: args.taskModel.model },
        )
        const llm = runtimeCtx.get('llm')
        if (llm === undefined) {
          throw new Error('cannot resolve the task-selected child LLM route because the `llm` service is unavailable')
        }
        await preflightChildLlmRoute(
          llm,
          parentOptions,
          request.agentOptions,
          exec.signal,
          providerRouteDefaults === undefined,
        )
        if (runtimeCtx.subagents.getProvider(config.provider) !== subagentProvider) {
          throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
        }
        exec.signal.throwIfAborted()
      }

      // fork（corum）：提取本次 spawn 的真实生效模型路由，用于广播帧。
      // 取 request.agentOptions 的 provider/model/reasoningEffort——它是 890 行
      // 之前两条路径的终值：锁定路径（corumLockedOptions）= compile.ts 按角色锁
      // 的 model；非锁定/fork 路径 = requestedAgentOptions，后者由
      // parentAgentOptionsForDelegation(parent) 合并而来，读父
      // session.requestHeader().config 的 provider/model——故 fork 实例（不写
      // config.model）的帧显示父的真实路由。request.agentOptions 缺失时退回
      // corumEffectiveModel（全局默认），两者都无则 undefined（不伪造空对象）。
      const corumSpawnModel = request.agentOptions !== undefined
        ? request.agentOptions.provider !== undefined && request.agentOptions.model !== undefined
          ? {
              provider: request.agentOptions.provider,
              model: request.agentOptions.model,
              ...request.agentOptions.reasoningEffort !== undefined
                ? { reasoningEffort: request.agentOptions.reasoningEffort as string }
                : {},
            }
          : corumEffectiveModel !== undefined
            ? {
                provider: corumEffectiveModel.provider,
                model: corumEffectiveModel.model,
                ...corumEffectiveModel.reasoningEffort !== undefined
                  ? { reasoningEffort: corumEffectiveModel.reasoningEffort }
                  : {},
              }
            : undefined
        : corumEffectiveModel !== undefined
          ? {
              provider: corumEffectiveModel.provider,
              model: corumEffectiveModel.model,
              ...corumEffectiveModel.reasoningEffort !== undefined
                ? { reasoningEffort: corumEffectiveModel.reasoningEffort }
                : {},
            }
          : undefined

      // fork（corum）：写工具判定与隔离触发（纯函数，单测覆盖）。
      // 任务级覆盖（orchestrate 的 tasks[i].isolation/research）优先于实例配置终值。
      // `effReadonlyResearch` 已在上方 request 构造处解析（供只读沙箱钉使用）。
      const effIsolationMode = args.taskIsolation ?? corumIsolationMode
      const corumIsWrite = corumIsWriteTask(config.toolFilter, effReadonlyResearch, corumDenyDirectFs)
      // fork（corum）：并发感知（2026-09-09 用户实机反馈「只派遣一个 TASK 时还是走了
      // 隔离工作区」）——隔离的存在理由是并发写冲突，没有并发就没有隔离的必要。
      // 四个并发信号（任一成立即视为「可能并发」）：
      //   ① 本次 orchestrate 的 tasks.length ≥ 2（同一调用内的 fan-out）；
      //   ② 本次委托走后台/continuable（父 Agent 继续干活，随时可能再发一个）；
      //   ③ 该会话台账仍有 active 条目（已隔离的写子 Agent 还在跑）；
      //   ④ 该会话有在跑的非隔离开写子 Agent（同一条消息里的并发前台调用）。
      // fork（corum）：**只读研究恒前台**（2026-09-12 用户定调）——「前台等报告」对任何
      // 调研场景都适用；调研留在后台时，前台主 Agent 拿不到结论，容易做出错误判断或
      // 重复调研（实测：4 次 research 里 2 次被父 Agent 提前 abort，报告为空）。
      const corumRunSpec = effReadonlyResearch
        ? { runInBackground: false }
        : resolveDelegationRun(args, { backgroundEnabled, continuable })
      if (effReadonlyResearch && args.run_in_background === true) {
        throw new Error('run_in_background is not supported for read-only research: the report IS the deliverable, so a research child always runs in the foreground and its report returns in this tool result.')
      }
      const corumSessionId = parent.session.id
      const corumConcurrent = (args.fanoutCount ?? 1) > 1
        || corumRunSpec.runInBackground
        || orchestration.entriesOf(corumSessionId).some(entry => entry.status === 'active')
        || orchestration.runningWriteChildrenOf(corumSessionId) > 0
      let corumIsolate = corumShouldIsolate(effIsolationMode, corumIsWrite, effReadonlyResearch, corumConcurrent)
      // fork（corum）：非 git 工作区自动降级（2026-09-09 用户需求）——隔离依赖 git
      // 仓库（worktree/branch/verify/integrate 全在 git 上），非 git 目录下强制不隔离，
      // 避免 `git worktree add` 报 `fatal: not a git repository`（实测 ai-lab）。即使用户
      // 在「新建工作区」时拒绝了 git 初始化，此降级保证 git 依赖能力自动关闭而非报错。
      //
      // 2026-09-10 核查：强制隔离（模式 always / 任务 isolation:'always'）在非 git 工作区
      // **同样降级**（不 fail loud——用户可能故意不初始化 git），但要让模型知道这次没隔离：
      // 子 Agent 的直连纪律通知会追加一句说明（见下方 corumIsolationSkipped）。
      let corumIsolationSkipped = false
      if (corumIsolate) {
        const parentCwdForRepo = parent.session.header.cwd ?? process.cwd()
        if (!corumIsGitRepo(parentCwdForRepo)) {
          corumIsolate = false
          corumIsolationSkipped = true
        }
      }
      /**
       * fork（corum）：**父 Agent 可见的隔离边界**（2026-09-13 用户定调「先做可见性」）。
       *
       * 只有**写委派**才有意义（只读调研不落盘，边界对父 Agent 无所谓）：它回答
       * 「这次改动落在哪」——隔离 worktree（要 integrate 才进主树）还是**已经在你的
       * 主工作区里了**。此前这件事只写在给子 Agent 的提示词里，父侧从结果读不出来，
       * 于是 2026-09-12 的探针把「没隔离」当成了「隔离了」。
       *
       * `worktree` 不发给父侧（那是常规路径、无需提醒；集成结果另有报告），只报两种
       * 「没隔离」的落点。
       */
      const corumIsolationBoundary: 'parent-tree' | 'skipped-non-git' | undefined =
        !corumIsWrite || effReadonlyResearch
          ? undefined
          : corumIsolate
            ? undefined
            : corumIsolationSkipped ? 'skipped-non-git' : 'parent-tree'

      // fork（corum）：机制追加的 deny 必须收敛到「本 preset 真正注册的工具名」——
      // `tools.restrict()` 对未知名 fail-loud，而 corum 的写工具名单是平台硬编码
      // （str_replace_editor 只有挂 str-replace-editor 行的 preset 才有；官方
      // standard/ptc/cordis 挂的是 write/edit）。不收敛则子 Agent 创建直接抛错
      // （2026-09-10 实机：官方三模式全部派不出子 Agent）。口径与边界见
      // corumNarrowDenyFilter 的注释。
      const corumSetMechanismFilter = (
        filter: { allow?: string[]; deny?: string[] } | undefined,
      ): void => {
        const narrowed = filter === undefined
          ? undefined
          : corumNarrowDenyFilter(filter, corumVisibleToolNames(parent.ctx))
        if (narrowed === undefined) delete request.toolFilter
        else request.toolFilter = narrowed
      }

      // fork（corum）：任务级 research 的只读硬约束——orchestrate 的 tasks[i].research
      // 名实相符：research=true 的任务 deny **变异**工具（write/edit/str_replace_editor）
      // 且沙箱钉 read-only；shell 保留（调研要跑命令），只读性由沙箱层保证
      // （2026-09-12 用户定调：research 开放 shell，但改不了仓库）。
      const researchFilter = corumResearchToolFilter(config.toolFilter, effReadonlyResearch)
      if (researchFilter !== undefined) corumSetMechanismFilter(researchFilter)

      // fork（corum）：integrate 召唤（fan-in/Manager）——恒前台路径（机制强制）。
      // fan-in 汇合的本质是同步等待点：主 Agent 必须等到集成者 merge+verify 的结果
      // 才能做最终验收，后台路径（continuable/one-shot background）拿不到结果无意义。
      // 此前用「runSpec.runInBackground 时抛错」要求模型显式 run_in_background:false
      // 压过 continuable 默认后台——把机制成本转嫁给模型（编排者等 continuable 实例
      // 的 Agent 很难记住该约束，实机反复撞「integrate must run in foreground」）。
      // 修正：integrate 恒由机制强制前台（integrate 是 corum 自研，非官方语义；
      // 删 throw，不再读 run_in_background/continuable 默认值），既保 fan-in 语义
      // 又消掉一类报错。下游 settleForegroundRun 本就是前台 settle，无需其它改动。
      if (args.integrate === true) {
        const sessionId = parent.session.id
        const entries = orchestration.entriesOf(sessionId)
        const pending = corumPendingIntegration(entries)
        if (pending.length === 0) {
          throw new Error('no isolated worktrees to integrate')
        }
        const parentCwd = parent.session.header.cwd ?? process.cwd()
        const effectiveChecks = corumIntegrateChecks ?? corumDetectIntegrateChecks(parentCwd)
        const declaredVerify = typeof args.verify === 'string' && args.verify.trim() !== '' ? args.verify : undefined
        const corumIntegrateRequest = {
          ...request,
          cwd: parentCwd,
          persona: corumIntegratorPersona(pending, effectiveChecks, corumMerger, declaredVerify),
          prompt: [{
            type: 'text',
            text: corumIntegratorPersona(pending, effectiveChecks, corumMerger, declaredVerify) + '\n\n' + String(args.prompt),
          }] as ContentBlock[],
        }
        // fork（corum）：机制真值门禁的前置快照（主树 HEAD + 未提交基线）。
        const corumHeadBefore = corumGitHead(parentCwd)
        const corumDirtyBefore = corumGitStatusPorcelain(parentCwd)
        const run: SubagentRun = await runtimeCtx.subagents.start(config.provider, {
          ...corumIntegrateRequest,
          signal: exec.signal,
        })
        // fork（corum）：**集成者也是子会话**——它这条路此前漏了 spawn 广播（前台/后台
        // 两条路径都有），于是编排卡在「集成中」那一整段拿不到子会话 id：用户实测
        // 「Agent 在集成但状态没有变，也没有按钮进入会话查看详情」。这里补上广播
        // （label 由调用方给 = 'integrate'），卡的「进入集成者会话」按钮即可点。
        // 集成者不建 worktree（`corumEntryInfo` 在这条路上不存在），故 worktree 传 undefined。
        corumEmitChildStarted(parent.session.id, exec.callId, String(run.id), args.label, corumIsolate, 'foreground', undefined, corumSpawnModel)
        const outcome = await settleForegroundRun(run)
        // fork（corum）：集成成功**不再由集成者自述决定**——`settleForegroundRun` 只
        // 保证子 Agent 正常结束，不代表它真的把分支合进了主树。2026-09-09 事故：
        // 集成者自称「已 merge + verify 通过」→ 机制无条件写 integrated 并
        // `worktree remove --force` + `branch -D` → 子任务 commit 变 unreachable、
        // 文件从主树消失（docs/TODO.md 高优先项）。此处按 git 实况判定：
        //   ① 每个待集成分支必须已并入 HEAD（祖先或 patch 等价）；
        //   ② 其 worktree 不得残留未提交改动（写了没提交 = 未持久化）。
        // 未达标 → 抛错（附「集成者自述 vs git 实况」对照）+ **保留 worktree 与分支**
        // + 台账保持 settled（PLAN 不变量「失败不 commit、保留现场」的机制化）。
        const corumTruth = corumIntegrationTruth(parentCwd, pending, corumDirtyBefore)
        // 排障日志（2026-09-16）：integrate 真值判定结果写主日志——verify 失败是否被拦住、
        // 分支并入与否，此前只能从 throw 反推（「merged+committed 但 verify 失败」无从定位）。
        runtimeCtx.logger.info(
          `integrate truth check: integrated=${corumTruth.integrated} unmerged=[${corumTruth.unmerged.join(',')}] uncommitted=[${corumTruth.uncommitted.join(',')}] head=${corumTruth.head}`,
        )
        if (!corumTruth.integrated) {
          // fork（corum）2026-09-14 用户同意 B：**脏主树/未提交场景的集成 diff 口**。
          // 集成者按纪律不许动主树里与本轮无关的在制品（persona 明禁
          // reset/checkout/clean/stash），于是脏树上的 merge 可能被拒得不明不白。
          // 这里对「没进 HEAD 的分支」逐条走 `git diff <base>..<branch>` +
          // `git apply --3way`：只落该分支自己的改动，主树既有改动参与三方合并、
          // 不被覆盖。**门禁不放宽**——补完仍按 git 实况复判，没落地照旧走失败分支。
          const unmergedEntries = pending.filter(entry => corumTruth.unmerged.includes(entry.branch))
          if (unmergedEntries.length > 0) {
            const ports = corumPortPendingBranches(parentCwd, unmergedEntries)
            const landed = ports.filter(port => port.applied)
            if (landed.length > 0) {
              runtimeCtx.logger.info(
                `integrate: applied ${landed.length}/${ports.length} unmerged branch diff(s) onto the dirty main tree (${landed.map(p => p.branch).join(', ')})`,
              )
            }
            const failed = ports.filter(port => !port.applied)
            if (failed.length > 0) {
              runtimeCtx.logger.warn(
                `integrate: branch diff port failed for ${failed.map(p => `${p.branch} (${p.error ?? 'no reason reported'})`).join('; ')}`,
              )
            }
          }
          const corumTruthAfterPort = corumIntegrationTruth(parentCwd, pending, corumDirtyBefore)
          if (!corumTruthAfterPort.integrated) {
            orchestration.emitFrame(sessionId)
            throw new Error(corumIntegrationFailure(
              corumTruthAfterPort,
              corumHeadBefore,
              pending,
              outputValueText(outcome.output),
            ))
          }
        }
        // fork（corum）2026-09-12：**部分集成**不再判死整次 fan-in。旧口径把
        // `uncommitted`（任何兄弟 worktree 的未提交残留）也算进 `integrated`，实测
        // 让一次已落地的集成被报成失败（corum-task-d51272e3：wt-5700d6 一个 scratch
        // 文件 → 主 Agent 的「验证/提交」三阶段整条没起来）。现在只把**已并入 HEAD**
        // 的条目翻转 + 清理；残留未提交的条目**保持 pending、保留现场**，并显式通知
        // 主 Agent（补提交后再次 integrate，或明确丢弃）。
        const leftover = new Set(corumTruth.uncommitted.map(text => text.split(' ')[0]))
        const landed = pending.filter(entry => !leftover.has(entry.slug))
        if (landed.length > 0) orchestration.markIntegrated(sessionId, landed, corumAutoCleanup)
        if (corumTruth.uncommitted.length > 0) {
          orchestration.emitFrame(sessionId)
          runtimeCtx.logger.warn(`integrate partially persisted: ${corumTruth.uncommitted.join(', ')} kept pending`)
          corumNotifyPartialIntegration(parent, corumPartialIntegrationNotice(corumTruth, corumHeadBefore), runtimeCtx.logger)
        }
        return outcome
      }

      // fork（corum）：worktree 创建（隔离触发时，父会话 header.cwd 下）。
      // 条目先登记（run id 尚不可知），start 返回后立刻经 corumBindRun 绑定 id——
      // 这是 settle 精确匹配（并行安全）的前置（docs/TODO.md 2026-09-09 修复）。
      let corumEntry: { sessionId: string; slug: string } | undefined
      // fork（corum）：广播用 worktree 三件套（无隔离时 undefined）。
      let corumEntryInfo: { slug: string; branch: string; path: string } | undefined
      if (corumIsolate) {
        // fork（corum）：worktree 创建下沉到编排服务（工具层与 isolated provider 共用同一
        // 实现，见 CorumOrchestration.createWorktreeChild）。通知文本同样是单一事实源。
        const parentCwd = parent.session.header.cwd ?? process.cwd()
        const sessionId = parent.session.id
        const child = orchestration.createWorktreeChild(sessionId, parentCwd, {
          ...corumIsolation?.worktreeRoot !== undefined ? { worktreeRoot: corumIsolation.worktreeRoot } : {},
          ...corumIsolation?.branchPrefix !== undefined ? { branchPrefix: corumIsolation.branchPrefix } : {},
          maxParallelChildren: corumMaxParallelChildren,
        })
        corumEntry = { sessionId, slug: child.slug }
        corumEntryInfo = { slug: child.slug, branch: child.branch, path: child.path }
        request.cwd = child.path
        corumSetMechanismFilter(corumEffectiveToolFilter(config.toolFilter, corumDenyDirectFs))
        request.prompt = [{ type: 'text', text: corumIsolationNotice(child) + args.prompt }] as ContentBlock[]
      } else if (corumIsWrite && !effReadonlyResearch) {
        // fork（corum）：不隔离的写任务（单发前台，无并发）直接在主工作区改——必须明确
        // 告诉它「不要碰版本控制」（文本见 corumDirectWriteNotice 的单一事实源）。
        // 非 git 工作区导致隔离被跳过时追加一句，避免模型误以为自己在隔离环境里。
        const skipped = corumIsolationSkipped
          ? 'NOTE: this workspace is not a git repository, so isolation was skipped for this delegation.\n\n'
          : ''
        request.prompt = [{ type: 'text', text: skipped + corumDirectWriteNotice() + args.prompt }] as ContentBlock[]
      }
      /** fork（corum）：把 run/child id 绑定到本次 spawn 的台账条目（无隔离时 no-op）。 */
      const corumBindRun = (runId: string): void => {
        if (corumEntry !== undefined) orchestration.bindRunId(corumEntry.sessionId, corumEntry.slug, runId)
      }
      /**
       * fork（corum）：spawn 失败回滚（无隔离时 no-op）。
       *
       * 台账条目在 start **之前**登记，start 抛错会让它永远 active 且无 runId：占满
       * maxParallelChildren 额度，并让该会话后续派遣恒命中并发信号③而强制隔离。
       * 此时子 Agent 从未执行过任何工具，worktree/分支都是本次 spawn 的产物，强清理安全。
       * （2026-09-10 实机：官方 preset 的子 Agent 因 deny 未知名创建失败，三个会话各泄漏数条。）
       */
      const corumDiscardEntry = (): void => {
        if (corumEntry === undefined) return
        orchestration.discardEntry(corumEntry.sessionId, corumEntry.slug)
        corumEntry = undefined
      }
      /** fork（corum）：spawn 包装——start 抛错时先回滚台账条目（无隔离时 no-op）。 */
      const corumStart = async <T>(start: () => Promise<T>): Promise<T> => {
        try {
          return await start()
        } catch (error: unknown) {
          corumDiscardEntry()
          throw error
        }
      }
      // fork（corum）：非隔离的前台写子 Agent 登记进并发计数（同消息并发调用时，
      // 后一个 spawn 才能看到「已经有一个在写主工作区」而选择隔离）。后台/continuable
      // 的子 Agent 由 runSpec 信号②恒判并发，无需计数，避免跨调用泄漏。
      const corumTrackWrite = corumIsWrite && !effReadonlyResearch && !corumRunSpec.runInBackground

      if (corumRunSpec.runInBackground) {
        if (continuable) {
          const started = await corumStart(() => runtimeCtx.subagents.startContinuable({
            provider: config.provider,
            label: args.label,
            request,
            signal: exec.signal,
          }))
          // continuable 登记的是 childId（settle 事件按 childId 精确匹配）。
          corumBindRun(String(started.childId))
          corumEmitChildStarted(parent.session.id, exec.callId, String(started.childId), args.label, corumIsolate, 'background', corumEntryInfo, corumSpawnModel)
          return { kind: 'continuable' as const, subagentId: started.childId }
        }
        const jobs = runtimeCtx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        const id = jobs.start({
          kind: 'subagent',
          label: args.label,
          owner: parent,
          run: () => {
            const controller = new AbortController()
            const start = corumStart(() => runtimeCtx.subagents.start(config.provider, { ...request, signal: controller.signal }))
            // 后台路径的 run 在 job 启动后才创建——start 解析即绑定。
            void start.then((startedRun) => {
              corumBindRun(String(startedRun.id))
              corumEmitChildStarted(parent.session.id, exec.callId, String(startedRun.id), args.label, corumIsolate, 'background', corumEntryInfo, corumSpawnModel)
            }).catch(() => {})
            return {
              cancel: (reason?: string) => {
                controller.abort(reason ?? 'background subagent task killed')
              },
              done: settleStart(start, controller.signal),
            }
          },
        })
        return { kind: 'background' as const, jobId: id }
      }

      if (corumTrackWrite) orchestration.beginWriteChild(corumSessionId)
      try {
        const run: SubagentRun = await corumStart(() => runtimeCtx.subagents.start(config.provider, {
          ...request,
          signal: exec.signal,
        }))
        corumBindRun(String(run.id))
        corumEmitChildStarted(parent.session.id, exec.callId, String(run.id), args.label, corumIsolate, 'foreground', corumEntryInfo, corumSpawnModel)
        const outcome = await settleForegroundRun(run)
        // fork（corum）：前台子 Agent 的最终汇报注入父会话（2026-09-09 用户反馈
        // 「子 Agent 结束后反馈没有注入主 Agent」）。工具结果里本来就有汇报，但它埋在
        // 工具卡里、容易被忽略，且子会话卡片只显示进度与任务提示词——这里按后台子
        // Agent 的同款「settlement notice」形态再注入一条正式消息（form:'notice'，
        // 会话流里渲染成一条可见的注入行），汇报以一等消息出现。
        if (args.notifyParent !== false) {
          corumNotifyForegroundResult(parent, String(run.id), args.label, outcome, runtimeCtx.logger)
        }
        // fork（corum）：把「这次改动落在哪」附在**工具结果**上（用户 2026-09-13 定调）。
        // 只在没隔离时附（worktree 是常规路径，报告由 integrate 负责）。
        return corumIsolationBoundary === undefined
          ? outcome
          : { ...outcome, isolationBoundary: corumIsolationBoundary }
      } finally {
        if (corumTrackWrite) orchestration.endWriteChild(corumSessionId)
      }
    }

    const mount = (subagentProvider: SubagentProvider): void => {
      assertSubagentProviderConfiguration(subagentProvider)
      const wording = providerWording(subagentProvider.inheritsParentContext)
      const providerRouteDefaults = subagentProvider.agentRouteDefaults
      const disposeTool = runtimeCtx.tools.register(defineTool({
        name: toolName,
        // fork（corum）：描述头追加隔离语义（英文，接在官方 wording 前）。
        description: 'Delegates run in isolated git worktrees when this instance has isolation configured and the delegation can run concurrently with another write child; a lone write delegation edits the parent working tree directly (no worktree, no branch). The result states which of the two happened, so you never have to guess whether a branch carries the work. ' 
          + wording.description + corumSchedulingDescription({ backgroundEnabled, continuable, readonlyResearch: corumReadonlyResearch })
          // fork（corum）：决策点分工（2026-09-14 委派正确性轮）——工具描述是模型
          // 选工具时唯一**贴着选择点**读到的文本，因此分工必须写在这里，而不是只
          // 写在机制段里。只读调研走 `subagent_research`（无修改 → 不召唤写能力
          // 子 Agent，隔离/分支/集成对只读工作没有意义）。只读实例自身不注入这段
          // （它没有别的委派工具可选）。
          + (corumReadonlyResearch
            ? ''
            // fork（corum）2026-09-14 修正（用户点名「主 Agent 派 research 去验收」）：
            //
            // 原文把 `verification by inspection`（验收）整类划给只读研究工具，模型照做 ⇒
            // **执行型验收被派给没有 write 工具的子会话**，派单里于是出现「不许改任何文件」
            // 与「必须造 fixture」并存的矛盾要求（实证：会话 `6364e3ea` 派单同时含这两句）。
            //
            // 改为按**是否需要执行**分流，并把两者的**工具面边界**写清 —— 决策点上模型唯一
            // 贴着选择点读到的文本就是这里：
            //   · `subagent_research`：有 shell 可跑只读命令，但 **write/edit 被拒、沙箱锁 read-only**；
            //   · 本工具（写能力）：bash + read + **write/edit**，可在仓库内落盘。
            // 需要跑断言、造 fixture、落盘证据的验收 ⇒ 必须用本工具。
            : ' Choose by whether the subtask must EXECUTE or only JUDGE. `subagent_research` is read-only: it has a shell for read-only commands, but **write/edit are denied and its sandbox is pinned to `read-only`**, so it can never create a file, a fixture, or an evidence artifact inside the repo. Use it for knowledge work and judgement-by-reading — research, search, fact-finding, summarization, comparing an implementation against a spec by reading code. Call THIS write-capable tool whenever the subtask must create or modify anything, including **executable verification**: running assertions, building a fixture or temp home, or writing evidence files. Running a verification is not the same as inspecting one. Never ask a read-only child to write: a "do not modify files" instruction and a "create this fixture" instruction cannot both hold — if you must both constrain writes and require a fixture, use this tool and scope the writes explicitly. A subtask that changes nothing must not be given a write-capable child: isolation, branches and merging all exist for changes.'),
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
              description: corumRunInBackgroundDescription({ continuable, readonlyResearch: corumReadonlyResearch }),
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
                  /**
                   * fork（corum）：本次委派的隔离落点（只在**没隔离**时出现，见
                   * `corumIsolationBoundaryNotice`）。父 Agent 据此知道改动已经在自己的
                   * 主工作区里、没有分支代管。
                   */
                  isolationBoundary: { type: 'string', enum: ['parent-tree', 'skipped-non-git'] },
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
                : `${outputValueText(value.output)}${value.isolationBoundary === undefined
                  ? ''
                  : `\n\n${corumIsolationBoundaryNotice(value.isolationBoundary)}`}`,
          }],
        },
        // Children never mutate the parent session; the one parent-owned write
        // (tasks.start) is a synchronous commutative insertion.
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) {
            throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
          }
          // fork（corum）：单任务隔离 spawn 已抽取为 spawnOne（install 作用域闭包），
          // subagent 工具 execute 是它的薄壳。
          return spawnOne(runtimeCtx, { agent: parent, signal: exec.signal, callId: String(exec.callId) }, {
            label: args.description,
            prompt: args.prompt,
            ...args.run_in_background !== undefined ? { run_in_background: args.run_in_background } : {},
            ...args.integrate !== undefined ? { integrate: args.integrate } : {},
            ...args.verify !== undefined ? { verify: args.verify } : {},
          }, subagentProvider)
        },
      }))
      // fork（corum）：orchestrate 工具（方案甲任务清单 fan-out）——仅在 worker 实例
      // 注册（research 只读实例不提供编排入口，toolName 为 subagent_research 时跳过）。
      const disposeOrchestrate = !isWorkerInstance
        ? (() => {}) as () => void
        : runtimeCtx.tools.register(defineTool({
            name: 'orchestrate',
            description: [
              'Orchestrate several subagents in ONE call. Two modes, same isolation and merge machinery:',
              '• DECLARATIVE (`tasks`): a list of independent tasks you declare up front — each may carry `label`, `isolation`, `research`, `model`, `schema` (structured output) and `background`.',
              '• SCRIPTED (`script` + `meta` + `args`): you write a JavaScript orchestration script (top-level await; hooks `agent`, `parallel`, `pipeline`, `phase`, `log`; end with `return <json-value>`). Use this when the fan-out needs program logic — loops, conditionals, retries, aggregation in code, or per-item pipelines.',
              'ISOLATION: scripted children are ISOLATED in their own git worktree + branch by default (`isolate: "always"`), so concurrent writers never touch the same tree; pass `isolate: "off"` for a read-only script that must see the parent tree exactly as it is (isolated children see the branch base, not uncommitted parent edits). Declarative tasks keep the concurrency-aware rule: 2+ concurrent write tasks isolate, a lone foreground write task works directly in the parent tree.',
              'FINISH: declare `merge.verify` (how to build/run/verify this repo) — declaring `merge` is what makes the mechanism merge + verify + commit the isolated branches once every task is done. Omit `merge` only when you intend to finish it yourself with `subagent { integrate: true }`; the call reports pending branches and raises a pending-integration notice either way, because branches you never merge are work nobody can see.',
            ].join('\n'),
            parameters: {
              script: { type: 'string', description: 'SCRIPTED mode: the plain-JS workflow script body (top-level await allowed; NO `export const meta` statement; end with `return <json-value>`). Requires `meta`; mutually exclusive with `tasks`.' },
              meta: {
                type: 'object',
                additionalProperties: true,
                description: 'SCRIPTED mode: the workflow identity block (plain JSON, never code).',
                properties: {
                  name: { type: 'string', required: true, description: 'Short kebab-case workflow name.' },
                  description: { type: 'string', required: true, description: 'One-line description of what the script does.' },
                  whenToUse: { type: 'string', description: 'Optional guidance on when this script applies.' },
                },
              },
              args: { type: 'object', additionalProperties: true, description: 'SCRIPTED mode: optional JSON input exposed verbatim to the script as the `args` global.' },
              isolate: { type: 'string', enum: ['always', 'off'], description: 'SCRIPTED mode isolation: `always` (default) gives every scripted child its own worktree + branch so concurrent writes never collide; `off` runs them directly in the parent tree (use for read-only scripts that must see the parent tree as-is).' },
              tasks: {
                type: 'array',
                description: 'DECLARATIVE mode: the list of tasks to run (1 or more). Each task is an independent subagent delegation.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    prompt: { type: 'string', required: true, description: 'The complete, self-contained task for this subagent. It does not share this conversation, so include everything it needs.' },
                    label: { type: 'string', description: 'A short (3-5 word) label for display.' },
                    isolation: { type: 'string', enum: ['always', 'write-tasks', 'off'], description: 'Override isolation for this task (always=force a worktree; write-tasks=isolate only when the task can run concurrently with another write task; off=never isolate). Defaults to the instance policy.' },
                    research: { type: 'boolean', description: 'Set true for a read-only research task (write tools denied, no worktree).' },
                    model: {
                      type: 'object',
                      additionalProperties: false,
                      description: 'Fixed model for this task (mechanism lock). Omit to follow the instance/global default.',
                      properties: {
                        provider: { type: 'string', required: true },
                        model: { type: 'string', required: true },
                        reasoningEffort: { type: 'string' },
                      },
                    },
                    background: { type: 'boolean', description: 'Run in the background (continuable, steered via send_message). Defaults to foreground one-shot.' },
                    schema: {
                      type: 'object',
                      additionalProperties: true,
                      description: 'Optional object-rooted JSON Schema: when present the child must commit a schema-valid structured result, returned in `output` instead of free text (workflow-style structured children).',
                    },
                  },
                },
              },
              merge: {
                type: 'object',
                additionalProperties: false,
                description: 'Declaring this object makes the mechanism finish the pipeline: after every task settles it merges the isolated branches into the main tree, runs `verify`, and commits. There is no opt-out flag — omitting `merge` is how you keep the branches for yourself, and then finishing them is the explicit action `subagent { integrate: true }` (an unmerged branch is invisible work, so a pending-integration notice is raised).',
                properties: {
                  verify: { type: 'string', description: 'How to build, run, and verify this repository after merging (e.g. "cd studio && npm test"). Declare it: you know this repo — the mechanism injects your declaration verbatim and enforces it. Omit to fall back to detected checks (minimal format bar).' },

                },
              },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mode: { type: 'string', required: true, enum: ['tasks', 'script'] },
                  results: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        index: { type: 'integer', required: true },
                        label: { type: 'string' },
                        ok: { type: 'boolean', required: true },
                        aborted: { type: 'boolean' },
                        output: { type: 'string' },
                        error: { type: 'string' },
                      },
                    },
                  },
                  script: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string', required: true },
                      agentsStarted: { type: 'integer', required: true },
                      value: { type: 'json' },
                    },
                  },
                  integration: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      pendingBranches: { type: 'array', items: { type: 'string' } },
                      integrated: { type: 'boolean' },
                      // 集成者子会话 id（编排卡「进入会话」按钮用；合并成功时才有）。
                      childSessionId: { type: 'string' },
                      // 集成失败的错误信息（Bug B：真值门禁失败时 runIntegrate 不再 throw 顶替
                      // 整个结果，而是把错误并入 integration.error——per-task results 不丢）。
                      error: { type: 'string' },
                    },
                  },
                  /**
                   * fork（corum）：跑在**父主工作区**（没隔离）的任务序号 + 判据
                   * （2026-09-13 用户定调「先做可见性」，见 `corumIsolationBoundaryNotice`）。
                   * 只有存在这种任务时才出现。
                   */
                  parentTreeTasks: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      indexes: { type: 'array', items: { type: 'integer' } },
                      boundary: { type: 'string', enum: ['parent-tree', 'skipped-non-git'] },
                    },
                  },
                },
              },
              render: (_args, value) => {
                const out = value as {
                  mode: string
                  results?: Array<{ index: number; label?: string; ok: boolean; aborted?: boolean; output?: string; error?: string }>
                  script?: { name: string; agentsStarted: number; value?: unknown }
                  /** `childSessionId` = 集成者子会话（合并成功时才有；卡片「进入会话」按钮用）。 */
                  integration?: { pendingBranches: string[]; integrated: boolean; childSessionId?: string; error?: string }
                  /** 跑在父主工作区（没隔离）的任务序号与判据（见上）。 */
                  parentTreeTasks?: { indexes: number[]; boundary: 'parent-tree' | 'skipped-non-git' }
                }
                // 全结构化（用户 2026-09-16 选定 B）：orchestrate 结果**不再展平成文本投影**，
                // 直接返回 JSON 对象——`results[].ok`/`error`/`output`、`integration.integrated`/
                // `error` 都是**可寻址字段**（文本投影下模型只能读 `[task N] done` 反推成败，
                // 看不到 `results[].ok`/`integration.error`，实测 dev 两次「没收到结构化结果」）。
                // 注：ContentBlock 只有 text/image 两型，故结构化对象经 JSON.stringify 进 text——
                // 模型读到规整 JSON（字段可寻址），而非纯文本投影。
                const structured: Record<string, unknown> = { mode: out.mode }
                if (out.mode === 'script' && out.script !== undefined) {
                  structured.script = {
                    name: out.script.name,
                    agentsStarted: out.script.agentsStarted,
                    ...(out.script.value !== undefined ? { value: out.script.value } : {}),
                  }
                } else {
                  structured.results = (out.results ?? []).map(r => ({
                    index: r.index,
                    ...(r.label !== undefined ? { label: r.label } : {}),
                    ok: r.ok,
                    ...(r.aborted === true ? { aborted: true } : {}),
                    ...(r.output !== undefined ? { output: r.output } : {}),
                    ...(r.error !== undefined ? { error: r.error } : {}),
                  }))
                }
                if (out.integration !== undefined) {
                  structured.integration = {
                    pendingBranches: out.integration.pendingBranches,
                    integrated: out.integration.integrated,
                    ...(out.integration.childSessionId !== undefined ? { childSessionId: out.integration.childSessionId } : {}),
                    ...(out.integration.error !== undefined ? { error: out.integration.error } : {}),
                  }
                }
                if (out.parentTreeTasks !== undefined && out.parentTreeTasks.indexes.length > 0) {
                  structured.parentTreeTasks = out.parentTreeTasks
                }
                return [{ type: 'text', text: JSON.stringify(structured, null, 2) }]
              },
            },
            // fork（corum）：Phase 3 编排结果面板——presentCall 显示任务清单概要
            // （标题=任务数），presentResult 显示结果卡（成功/失败计数）。
            presentCall: (args) => {
              const call = args as { tasks?: Array<{ label?: string }>; script?: string; meta?: { name?: string } }
              if (call.script !== undefined) {
                return {
                  card: 'generic' as const,
                  title: `orchestrate · script ${call.meta?.name ?? '(unnamed)'}`,
                  rawInput: [call.script.slice(0, 400)],
                }
              }
              const tasks = call.tasks ?? []
              return {
                card: 'generic' as const,
                title: `orchestrate · ${tasks.length} task(s)`,
                rawInput: tasks.map((t, i) => `[${i}] ${t.label ?? '(unnamed)'}`),
              }
            },
            presentResult: (_args, value) => {
              const out = value as unknown as {
                mode: string
                results?: Array<{ index: number; ok: boolean; aborted?: boolean; error?: string }>
                script?: { name: string; agentsStarted: number }
              }
              if (out.mode === 'script') {
                return {
                  card: 'generic' as const,
                  title: `orchestrate · script ${out.script?.name ?? ''} · ${out.script?.agentsStarted ?? 0} agent(s)`,
                  content: [{ type: 'text', text: 'scripted orchestration settled' }],
                }
              }
              const results = out.results ?? []
              const done = results.filter(r => r.ok).length
              const aborted = results.filter(r => r.aborted === true).length
              const failed = results.length - done - aborted
              const summary = aborted > 0
                ? `${done} ok / ${failed} failed / ${aborted} aborted`
                : `${done} ok / ${failed} failed`
              return {
                card: 'generic' as const,
                title: `orchestrate · ${summary}`,
                content: [{ type: 'text', text: results.map(r => `[task ${r.index}] ${r.ok ? '✓ done' : r.aborted === true ? '⊘ aborted' : `✗ ${r.error ?? 'failed'}`}`).join('\n') }],
              }
            },
            isConcurrencySafe: () => true,
            async execute(args, exec) {
              const parent = exec.agent
              if (!parent) {
                throw new Error('orchestrate tool requires a calling agent (exec.agent was undefined)')
              }
              /** 合并台账里待集成的隔离分支（声明 merge 时由机制调用）。 */
              const runIntegrate = async (merge: { verify?: string } | undefined): Promise<{ pendingBranches: string[]; integrated: boolean; childSessionId?: string }> => {
                const pending = corumPendingIntegration(orchestration.entriesOf(parent.session.id))
                if (pending.length === 0) return { pendingBranches: [], integrated: false }
                const branches = pending.map(entry => entry.branch)
                // fork（corum）2026-09-12 修正（用户实测「最后一个节点始终不会运行」+ 全库数据）：
                // **声明即执行**：传了 merge（哪怕空对象）= 机制跑完流水线；不传 = 分支留给
                // 调用方，收尾走显式动作 subagent {integrate:true}。旧口径把合并交给模型记性
                // （全库 12 个会话里 9 个分支从未合并），autoIntegrate 这个开关更是个 footgun
                // ——模型 10 次提及里 10 次设 false 却不回来做。见 BUG-29。
                //
                // 不变式④（invariant.merge-strategy，用户 2026-09-16 澄清）：**默认 merge（声明
                // verify 即自动集成），除非 LLM 自主 opt-out（omit merge）**——omit 是合法的
                // 「我自己收尾」路径，由 pending-integration 通知兜底（不可静默，见下方 settle 钩子
                // 对单发异步后台同样补发通知）。⚠️ 不要把 omit 也强制集成：那会堵死 LLM 自主
                // opt-out 的合法路径（我一度误改成那样，已回滚）。
                if (merge === undefined || !corumAutoIntegrate(merge)) {
                  return { pendingBranches: branches, integrated: false }
                }
                // 排障日志（2026-09-16）：runIntegrate 的 verify 传入与分支清单写主日志——
                // verify 是否被传给集成者、传的是什么命令，verify 失效排查的关键一手。
                runtimeCtx.logger.info(
                  `runIntegrate: verify=${merge.verify === undefined ? '(omitted, fallback to detected checks)' : JSON.stringify(merge.verify)} branches=[${branches.join(',')}]`,
                )
                // fork（corum）：integrate 结果**必须**被检查（2026-09-09 事故 RC4）
                // ——此前 `await spawnOne(...)` 丢弃返回值，集成没落地时任务结果照样
                // 逐条报 `[task N] done`，主 Agent 据此以为全部完成。integrate 恒前台
                // （机制强制），非 foreground 即装配异常；集成未落地由 spawnOne 抛错
                // （机制真值门禁），此处让错误向上冒泡，orchestrate 整体报失败。
                const integrateOutcome = await spawnOne(runtimeCtx, { agent: parent, signal: exec.signal, callId: String(exec.callId) }, {
                  label: 'integrate',
                  prompt: 'Integrate the isolated worktrees and commit after all checks pass.',
                  integrate: true,
                  ...merge.verify !== undefined ? { verify: merge.verify } : {},
                }, subagentProvider)
                if (integrateOutcome.kind !== 'foreground') {
                  throw new Error(`integrate ran in ${integrateOutcome.kind} mode; integrate must settle in the foreground`)
                }
                // fork（corum）：把集成者子会话 id 带进结果——编排卡的「进入会话」按钮要它。
                // 运行期由 `corum/subagent/child` 帧（label 'integrate'）给出，但**推送帧不重放**
                // （刷新/重启后丢失）；写进工具结果 = durable，刷新后按钮仍在。
                return { pendingBranches: branches, integrated: true, childSessionId: String(integrateOutcome.runId) }
              }

              // fork（corum）：SCRIPTED 模式（2026-09-10 用户定调「把 workflow 的设计语义
              // 吸收进 orchestrate」）——脚本交给官方 workflow 引擎执行，子 Agent 经
              // corum-isolated provider 建 worktree + 进台账；跑完按 merge 声明合并。
              const script = typeof args.script === 'string' && args.script.trim() !== '' ? args.script : undefined
              if (script !== undefined) {
                const meta = args.meta as { name: string; description: string; whenToUse?: string } | undefined
                if (meta === undefined || typeof meta.name !== 'string' || typeof meta.description !== 'string') {
                  throw new Error('orchestrate script mode requires `meta` with at least { name, description }')
                }
                if (args.tasks !== undefined) throw new Error('orchestrate accepts either `tasks` or `script`, not both')
                const engine = runtimeCtx.get('workflowEngine', false) as {
                  start: (request: {
                    script: string
                    meta: unknown
                    args?: unknown
                    subagentProvider?: string
                    parent: typeof parent
                    signal?: AbortSignal
                  }) => Promise<{
                    result: Promise<{ value: unknown; stopReason: string; error?: string; agentsStarted: number }>
                    dispose: () => Promise<void>
                  }>
                } | undefined
                if (engine === undefined) {
                  throw new Error('orchestrate script mode requires the workflow engine; this preset does not mount @deepseek-ai/dsh-workflow-worker-thread')
                }
                const isolate = args.isolate === 'off' ? 'off' : 'always'
                const scriptProvider = isolate === 'off' ? 'corum-spawn' : 'corum-isolated'
                if (runtimeCtx.subagents.getProvider(scriptProvider) === undefined) {
                  throw new Error(`orchestrate script mode needs the "${scriptProvider}" subagent provider; it is not registered in this composition`)
                }
                const run = await engine.start({
                  script,
                  meta,
                  ...args.args !== undefined ? { args: args.args } : {},
                  subagentProvider: scriptProvider,
                  parent,
                  signal: exec.signal,
                })
                let settled: { value: unknown; stopReason: string; error?: string; agentsStarted: number }
                try {
                  settled = await run.result
                } finally {
                  await run.dispose()
                }
                if (settled.stopReason !== 'completed') {
                  throw new Error(`scripted orchestration "${meta.name}" ${settled.stopReason}${settled.error !== undefined ? `: ${settled.error}` : ''}`)
                }
                const integration = await runIntegrate(args.merge as { verify?: string } | undefined)
                if (!integration.integrated) corumNotifyPendingIntegration(parent, integration.pendingBranches, runtimeCtx.logger)
                return {
                  mode: 'script' as const,
                  // 引擎的 result.value 已是 JSON-safe（跨 worker realm 物化过）；类型面收窄到 JsonValue。
                  script: { name: meta.name, agentsStarted: settled.agentsStarted, value: settled.value as JsonValue },
                  ...integration.pendingBranches.length > 0 || integration.integrated ? { integration } : {},
                }
              }

              // fork（corum）：方案甲 fan-out——tasks[] 并发 spawn（spawnOne 复用
              // 隔离/模型锁/integrate 逻辑），前台等待全部 settle，汇合结果。
              const tasks = args.tasks as unknown as Array<{
                prompt: string
                label?: string
                isolation?: 'always' | 'write-tasks' | 'off'
                research?: boolean
                model?: { provider: string; model: string; reasoningEffort?: string }
                background?: boolean
                schema?: ObjectJsonSchema
              }>
              if (tasks === undefined || tasks.length === 0) throw new Error('orchestrate requires either `tasks` (1 or more) or `script`')
              /**
               * fork（corum）：**哪些任务跑在父主工作区里**（没隔离）——2026-09-13 用户
               * 定调「先做可见性」。收集成一张表，汇总时另起一行报给父 Agent；**不动**
               * 每任务行（`[task N · label] done|aborted|failed`）的格式——那个格式被
               * `corum-ui-chat` 的编排卡正则消费，改它会让卡片静默退化（见审查报告 F-02）。
               */
              const parentTreeTasks: Array<{ index: number; boundary: 'parent-tree' | 'skipped-non-git' }> = []
              const run = (index: number): Promise<{ index: number; ok: boolean; aborted?: boolean; output?: string; error?: string; label?: string }> => {
                const task = tasks[index]
                const base = { index, ...task.label !== undefined ? { label: task.label } : {} }
                return spawnOne(runtimeCtx, { agent: parent, signal: exec.signal, callId: String(exec.callId) }, {
                  label: task.label ?? `task ${index}`,
                  prompt: task.prompt,
                  // fork（corum）：orchestrate 任务默认前台 one-shot（fan-in 汇合要求）；
                  // 只有显式 background:true 才走后台。不能沿用 subagent 的
                  // 「continuable 默认后台」——否则任务落入 continuable 路径，
                  // orchestrate 无法前台汇合（CDP 端到端验证暴露的 bug）。
                  run_in_background: task.background === true,
                  ...task.isolation !== undefined ? { taskIsolation: task.isolation } : {},
                  ...task.research !== undefined ? { taskResearch: task.research } : {},
                  ...task.schema !== undefined ? { taskSchema: task.schema } : {},
                  // fork（corum）：任务级模型锁真接线（P0-4 2026-09-14）——tasks[i].model
                  // 落到该任务的模型选择；缺失时沿用 preset config.model > 全局默认 > 跟随父。
                  ...task.model !== undefined ? { taskModel: task.model } : {},
                  // fork（corum）：并发感知隔离的两个入参——① 本次 fan-out 任务数
                  // （≥2 才需要 worktree）；② 不向父会话逐条注入 notice（结果由
                  // orchestrate 的汇总结果承载，避免 N 条重复通知）。
                  fanoutCount: tasks.length,
                  notifyParent: false,
                }, subagentProvider).then((outcome) => {
                  if (outcome.kind === 'foreground') {
                    if (outcome.isolationBoundary !== undefined) {
                      parentTreeTasks.push({ index, boundary: outcome.isolationBoundary })
                    }
                    return { ...base, ok: true, output: outputValueText(outcome.output) }
                  }
                  // 后台/continuable：本阶段 orchestrate 汇合要求前台（fan-in 语义）。
                  return { ...base, ok: false, error: `task ${index} ran in ${outcome.kind} mode; orchestrate currently requires foreground tasks` }
                }).catch((error: unknown) => {
                  // fork（corum）：按权威 stopReason 区分「手动终止」与「失败」。
                  // settleForegroundRun 把 SubagentResult.stopReason 挂到 Error 上；
                  // 此处读它，不靠错误串匹配。
                  // 排障日志（2026-09-16）：orchestrate 任务失败写主日志——此前 catch 只把错误
                  // 写进结果行，主日志零痕迹，「任务 2 从未 spawn」这类失败只能靠现场反推。
                  runtimeCtx.logger.warn(`orchestrate task ${index} failed: ${String(error)}`)
                  if ((error as { stopReason?: SubagentResult['stopReason'] }).stopReason === 'aborted') {
                    return { ...base, ok: false, aborted: true, error: String(error) }
                  }
                  return { ...base, ok: false, error: String(error) }
                })
              }
              const results = await Promise.all(tasks.map((_, index) => run(index)))
              // fork（corum）：merge 联动——声明了 merge 就在所有任务 settle 后
              // 触发 integrate（fan-in：合并台账分支 + 声明的 verify 门禁）。verify
              // 由 merge.verify 声明（原样注入集成者 persona）；未声明回落探测式默认。
              // 若任务均未隔离（isolation:off / research），台账无待集成条目——
              // 静默跳过 integrate（结果已由任务直接产出，无需 fan-in）。
              //
              // Bug B 修复（2026-09-16）：runIntegrate 的真值门禁失败会 **throw**（`:1434`
              // `integrate did not persist into the main tree`）——若不捕获，这个 throw 向上
              // 顶替整个 orchestrate 结果 ⇒ **`results`（每个任务的 ok/error/output）被整块
              // 吞掉**，模型只看到 integrate 错误、看不到「某个任务为什么失败」的真相。
              // 这里捕获 integrate 错误：results（已算好）与 `integration: { integrated:false,
              // error }` 一起返回——**集成失败仍 fail-loud**（结果里带错误标记 + pending 通知），
              // 但 per-task results 不丢。
              let integration: { pendingBranches: string[]; integrated: boolean; childSessionId?: string; error?: string }
              try {
                integration = await runIntegrate(args.merge as { verify?: string } | undefined)
              } catch (integrateError: unknown) {
                const pendingOnError = corumPendingIntegration(orchestration.entriesOf(parent.session.id))
                integration = {
                  pendingBranches: pendingOnError.map(entry => entry.branch),
                  integrated: false,
                  error: integrateError instanceof Error ? integrateError.message : String(integrateError),
                }
              }
              if (!integration.integrated) corumNotifyPendingIntegration(parent, integration.pendingBranches, runtimeCtx.logger)
              return {
                mode: 'tasks' as const,
                results,
                ...integration.pendingBranches.length > 0 || integration.integrated || integration.error !== undefined ? { integration } : {},
                ...parentTreeTasks.length === 0 ? {} : {
                  parentTreeTasks: {
                    indexes: parentTreeTasks.map(t => t.index),
                    boundary: parentTreeTasks.every(t => t.boundary === 'skipped-non-git') ? 'skipped-non-git' as const : 'parent-tree' as const,
                  },
                },
              }
            },
          }))
      mounted = { subagentProvider, disposeTool, disposeOrchestrate }
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
      mounted.disposeOrchestrate()
      mounted = undefined
    })
    const present = runtimeCtx.subagents.getProvider(config.provider)
    if (present !== undefined) {
      mount(present)
    } else {
      // A backend fiber may activate later; a misspelled provider remains visible in this log.
      runtimeCtx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
    }
    // fork（corum）：research 与 worker 各注册自己的 `tool:${toolName}` 段——段名
    // 不同（`tool:subagent_research` / `tool:subagent`）不冲突；text 按读者可见性
    // 自我抑制（工具不可见时返回空串，等价于不注册）。
    /**
     * fork（corum）：PTC 模式前缀——该模式下工具不直接暴露，全部经 `run_code` 的
     * 生成式 SDK 调用（官方 ptc preset 的 `tool-presentation mode: ptc`）。2026-09-09
     * 把 corum 编排工具换进官方 preset 后，提示词必须说明调用形态，否则模型会直接
     * 点名 `subagent` 而找不到工具。
     * @param scope - 当前渲染 scope。
     * @returns PTC 说明句（非 PTC 为空串）。
     */
    const corumPtcPrefix = (scope: Parameters<typeof runtimeCtx.tools.get>[1]): string =>
      runtimeCtx.tools.get('run_code', scope) === undefined
        ? ''
        : 'This agent runs in PTC mode: every tool below is called from inside `run_code` (e.g. `await tools.subagent({...})`), not as a direct tool call. '

    if (corumReadonlyResearch || (backgroundEnabled && continuable)) {
      // The section follows provider availability without its own manual
      // lifecycle: empty text is omitted from rendered prompts while the tool is
      // absent, and the registration itself stays owned by this plugin fiber.
      runtimeCtx.systemPrompt.section({
        name: `tool:${toolName}`,
        order: runtimeCtx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
        text: context => mounted === undefined || runtimeCtx.tools.get(toolName, context.scope) === undefined
          ? ''
          : corumSchedulingSectionText({ backgroundEnabled, continuable, readonlyResearch: corumReadonlyResearch }, toolName, corumPtcPrefix(context.scope)),
      })
    }

    // fork（corum）：子 Agent 机制运用指引——让 Agent 主动判断何时用哪种委托形式
    // （含只读搜索子 Agent），而非等用户显式点名。仅 worker 实例注入（research
    // 只读实例无这些工具，注入会误导）；worker 实例的 toolName 是 'subagent'。
    //
    // 2026-09-10 用户要求「每个 Agent 都配备了 search Agent，所有模式都应该提到
    // 这一点，让 LLM 灵活指派」：只读搜索子 Agent 的指引**不再依赖 orchestrate
    // 可见性**——只要 worker 实例可见就注入；orchestrate 段落按可见性条件拼接
    // （PTC 模式经 run_code SDK 呈现，同样可见）。
    if (isWorkerInstance) {
      runtimeCtx.systemPrompt.section({
        name: 'corum:subagent-orchestration',
        order: runtimeCtx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 1,
        text: context => {
          if (mounted === undefined || runtimeCtx.tools.get(toolName, context.scope) === undefined) return ''
          const hasOrchestrate = runtimeCtx.tools.get('orchestrate', context.scope) !== undefined
          const hasResearch = runtimeCtx.tools.get('subagent_research', context.scope) !== undefined
          // 2026-09-10：官方 workflow / ralph / subagent_fork 按 corum 机制恢复挂载，
          // 机制段按可见性补一段「怎么选」——官方能力与 corum 机制并存，模型要知道
          // 哪些路径有隔离/台账/notice，哪些没有。
          const hasFork = runtimeCtx.tools.get('subagent_fork', context.scope) !== undefined
          const hasWorkflow = runtimeCtx.tools.get('workflow', context.scope) !== undefined
          const hasRalph = runtimeCtx.tools.get('ralph', context.scope) !== undefined
          if (!hasOrchestrate && !hasResearch && !hasFork && !hasWorkflow && !hasRalph) return ''
          const lines = [
            `${corumPtcPrefix(context.scope)}You have subagents. Use them PROACTIVELY — do not wait for the user to name a tool.`,
            '',
            'Choose the right delegation form by the shape of the work:',
            '- READ-ONLY work (research, search, fact-finding, summarization, JUDGING BY READING — e.g. checking an implementation against a spec, or comparing output against expected values) → call `subagent_research`.',
            '- Work that CHANGES files → call `subagent`.',
            '- ONE focused, self-contained subtask that must create or modify files (an implementation, a scoped fix) → call `subagent`.',
            // fork（corum）2026-09-14：**执行型验收**必须走写能力工具（用户点名「主 Agent 派
            // research 去验收」）。验收分两种，旧文案把两者都塞进只读清单，于是需要跑断言/造
            // fixture/落盘证据的验收被派给没有 write 的子会话 ⇒ 派单自相矛盾（实证会话
            // `6364e3ea`：「不许改任何文件」与「必须造 fixture」并存）。
            '- EXECUTABLE verification (running assertions or tests, building a fixture or temp home, writing evidence files, driving a UI to observe real behaviour) → call `subagent`, NOT `subagent_research`: running a verification is not the same as inspecting one, and a read-only child has no write/edit to build what the run needs.',
          ]
          if (hasResearch) {
            lines.push('- ANY read-only work — searching the codebase, reading files, tracing a call path, summarizing a module, gathering facts, answering "how does X work", or running read-only commands (`git log`, `ls`, a verify script\'s `status`) → call `subagent_research`. It ALWAYS runs in the FOREGROUND: its report returns in this tool result, so you get the findings inline instead of waiting for a notice — never try to background it (`run_in_background: true` is rejected). It has a shell but its sandbox is pinned to `read-only` and the mutating tools (write/edit/str_replace_editor) are denied, so it can investigate freely and can never modify the repo. Fan out several such searches in ONE message when you need answers from different angles.')
          }
          if (hasFork) {
            lines.push('- CONTINUING THIS CONVERSATION instead of briefing a stranger (the child is seeded with your completed turns, so it already knows the context) → call `subagent_fork`. It gets the same isolation, ledger and settlement-notice treatment as `subagent`; prefer `subagent` when a self-contained brief is cleaner.')
          }
          if (hasOrchestrate) {
            lines.push(
              '- SEVERAL INDEPENDENT pieces of work that can run in parallel (e.g. "split this into modules A/B/C", "do these 4 migrations", "research these 3 alternatives at once") → call `orchestrate` with a task list. This fans out concurrently and collects every result in one call — far better than several sequential `subagent` calls.',
              '',
              'How the mechanism works (rely on it, do not re-implement):',
              '- Write-capable children get ISOLATED git worktrees (own branch; the parent working tree is write-denied to that child) only when they can run CONCURRENTLY with another write child (orchestrate with 2+ tasks, a background delegation, or another write child already running). A lone foreground write delegation works directly in the parent working tree and leaves git to you. Isolation needs a git repository: in a non-repo workspace it is skipped automatically (children work in the parent tree and leave version control to you) — even a forced `isolation: "always"` is skipped rather than failing, and the child is told so. Nothing to do either way.',
              '- Isolation is a property of CHANGE, not of delegation: it exists so a child\'s edits land on their own branch and reach your tree through integrate. A delegation that only reads produces nothing to isolate, so route it to `subagent_research` — never call the write-capable `subagent` for a task that changes nothing.',
              '- Model routing precedence: a per-task `model` on an `orchestrate` task wins for that task; otherwise the preset role lock (worker/research profile) wins over the global default, and with neither the child follows your route. Task-level routes are validated before spawn (settings allowlist when configured, plus a live route preflight) — an invalid provider/model fails that task. Never ask the user to pick a model; `subagent` has no model parameter at all.',
              '- For `orchestrate`, declare `merge.verify`: how to build/run/verify THIS repo after merging (you know this repo best). Declaring `merge` at all means the mechanism finishes the job — it merges + commits the isolated branches once every task is done. Omitting `merge` keeps the branches for you; then finish them yourself with the explicit action `subagent { integrate: true }`, because an unmerged branch is invisible work.',
              '- INTEGRATION IS THE MECHANISM\'S when you declare `merge` (it merges + verifies + commits once every task is done — never a child\'s job). Without `merge`, YOU finish it with the explicit `subagent { integrate: true }`; a pending-integration notice is raised either way so branches cannot silently strand. NEVER delegate a main-tree write to an ISOLATED child and expect it to land: that child works in its own worktree, so its writes cannot reach the parent tree.',
              '- `orchestrate` tasks run in the foreground by default and the call returns when all settle; a per-task `background: true` is allowed but then that task cannot join the fan-in.',
            )
          } else {
            lines.push(
              '',
              'How the mechanism works (rely on it, do not re-implement):',
              '- Model routing is LOCKED by the mechanism. Never ask the user (or try) to pick a model for a child — there is no such parameter.',
            )
          }
          if (hasWorkflow || hasRalph) {
            lines.push('')
            if (hasWorkflow) {
              lines.push('- A model-authored orchestration SCRIPT — loops, conditionals, retries, aggregation in code — → call `workflow` (only when the user asks for a workflow or the fan-out genuinely needs program logic).')
            }
            if (hasRalph) {
              lines.push('- Fresh-agent iteration toward ONE immutable objective → call `ralph` (sequential, bounded rounds).')
            }
            const engineTools = [hasWorkflow ? '`workflow`' : '', hasRalph ? '`ralph`' : ''].filter(Boolean).join(' and ')
            lines.push(`IMPORTANT: ${engineTools} children are created by their own engine${hasWorkflow && hasRalph ? 's' : ''} — they do NOT get isolated worktrees, ledger entries or settlement notices, and nothing merges their work. Use them for read-only audits or work that does not need merging; for parallel WRITES that need isolation + merge, use \`orchestrate\` instead.`)
          }
          lines.push(...corumEfficiencyDisciplineLines())
          lines.push(...corumSandboxEscalationLines())
          lines.push(
            '',
            'After delegating, keep doing useful work while children run; when each settles you are notified with its outcome.',
            'A BACKGROUND subagent is NOT a job: there is no job id to poll and no `job_output` to read. Track it with `list_agents` (list running/known children), steer or follow up with `send_message`, and wait for its settlement notice — or simply keep working and act when the notice arrives.',
          )
          return lines.join('\n')
        },
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
