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
import { carrierKeyOf, scopeChainOf, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
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
import {
  corumAskAboutModelFailure,
  corumAskAboutModelOnce,
  type CorumDelegationPolicyState,
  type CorumModelAskChannel,
  type CorumModelCatalog,
  type CorumProfileWriteFace,
  type CorumRoute,
} from './model-ask-run.ts'
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
  CorumIntegrateRejected,
  // fork（corum）2026-09-16：机制侧 verify 门禁——「集成成功」= git 实况 ∧ 声明式 verify
  // 退出码 0（根因：真值门禁只判 git，集成者用 `git merge` 时合并提交自己就进了 HEAD，
  // verify 失败被盖过，机制对外报「merged + committed」）。
  corumIntegrationVerdict,
  corumVerifyFailureNotice,
  corumResolveRejectedIntegration,
  CORUM_INTEGRATE_VERIFY_TIMEOUT_MS,
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
  // fork（corum）2026-09-20：集成判定改「按条目」+ 分支 tip 快照——修「集成成功却判
  // 未落地」（集成者 merge 后合规 `branch -D`，按分支名判定假阴）。
  corumSnapshotBranchTips,
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
  // 2026-09-21 裁定：`isolation` / `integrateChecks` / `merger` 三键已从本接口与 schema
  // 剔除——隔离与合并机制恒定生效（调用点固化常量），不允许 preset 覆盖。存量 preset
  // yaml 里的旧键忽略不迁移（宽松处理：schema 不再声明，读到时丢弃）。
  /** fork（corum）：research 实例语义——本实例为只读研究实例（预 deny 写工具、不隔离）。 */
  readonlyResearch?: boolean
  /** fork（corum）：会话级并行子 Agent 上限（默认 4；超限拒绝新召唤）。 */
  maxParallelChildren?: number
  /** fork（corum）：子 Agent 固定模型路由（机制锁；缺省=跟随父）。 */
  model?: { provider: string; model: string; reasoningEffort?: string }
}

// ── fork（corum）：`corum-subagent` 全局设置面（三级配置第一级）──────────────────
//
// 2026-09-18：声明（namespace + 形 + schema）与「取 scope」逻辑抽到
// `settings-namespace.ts`，供**两个装配时机**共用——`settings-registrar.ts`（boot 常驻行）
// 与下面的 `apply()`（按会话挂载的工具实例）。抽出的必要性见该文件头注释（避免把 100KB
// 工具实现内联进 registrar、避免模块级单例被复制成两份）。
import {
  acquireCorumSubagentSettingsScope,
  CORUM_SUBAGENT_SETTINGS_NAMESPACE,
  CORUM_SUBAGENT_SETTINGS_SCHEMA,
  type CorumSettingsProviderFace,
  type CorumSubagentGlobalSettings,
  type CorumSubagentGlobalSettingsScope,
} from './settings-namespace.ts'

// 保持对外导出面不变（此前这些名字直接定义在本文件，外部/测试可能引用）。
export {
  CORUM_SUBAGENT_SETTINGS_NAMESPACE,
  CORUM_SUBAGENT_SETTINGS_SCHEMA,
  type CorumSubagentGlobalSettings,
} from './settings-namespace.ts'

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
  // fork（corum）：研究/并行/模型锁字段保留 omission（不写默认物化）。
  // （2026-09-21：`isolation` / `integrateChecks` / `merger` 已随机制恒定生效剔除。）
  readonlyResearch: z.boolean().default(undefined as unknown as boolean),
  maxParallelChildren: z.natural().max(Number.MAX_SAFE_INTEGER).default(undefined as unknown as number),
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
 * fork（corum）2026-09-18：机制提问/续跑的**超时上限**。
 *
 * 为什么必须自己设时限：官方 `userQuestions.ask()` **没有内建超时**——用户既不回答也不点
 * 取消时它会一直等。本机制跑在子 Agent 失败之后的收尾路径上，无限挂住会让父会话永远等不到
 * 「接下来该干什么」。超时后按 `ASK_ABORTED` 走「不改变现状」的保守降级
 * （见 `model-ask-run.ts`），并如实通知用户机制没能问到——绝不替用户做主。
 */
export const CORUM_ASK_TIMEOUT_MS = 5 * 60 * 1000

// ── fork（corum）：一次性子 Agent 失败后的「智能续跑」─────────────────────────
//
// 一次性子 Agent 失败后 session 写句柄已 close，无法 coldResume。但事件已持久化，
// 可以**读出它做了什么**，把关键上下文注入到新子 Agent 的 prompt 里——新子 Agent
// 「接着做」而非「从头做」，避免重复调用工具、丢失关键决策。

/** 从失败子 Agent 提取的可续跑上下文。 */
interface CorumFailedChildContext {
  /** 原始任务目标（第一条 user message 的文本）。 */
  readonly originalTask: string
  /** 最后一轮 assistant 的非空输出（已完成的工作摘要）。 */
  readonly lastOutput: string | undefined
  /** 最新的 todo 计划（未完成的步骤）。 */
  readonly todos: readonly { content: string; status: string }[] | undefined
  /** 失败原因（turn/end 的 stopReason）。 */
  readonly stopReason: string | undefined
}

/** `ctx.sessionQuery` 的窄能力面（红线 3）。 */
interface CorumSessionQueryFace {
  observeSession(
    id: SessionId,
    options: { signal?: AbortSignal },
  ): Promise<{ events: readonly SessionEvent[]; inheritedEventCount: number }>
}

/**
 * 从失败子 Agent 的持久化 session 提取可续跑上下文。
 *
 * 读子 Agent 自己的事件后缀（跳过 seed 前缀），用 `foldConsumedWork` 找最后
 * 一轮的 turn/end（拿 stopReason），用 `finalAssistantOutput` 拿最后的 assistant
 * 输出，从 `tool/call` 里提取 todo 状态。
 *
 * @param ctx - host context（取 sessionQuery）。
 * @param childSessionId - 失败子 Agent 的 session id。
 * @param signal - 取消信号。
 * @returns 提取的上下文；session 不存在/读失败时返回 undefined（退化为盲重跑）。
 */
async function corumExtractFailedChildContext(
  ctx: Context,
  childSessionId: string,
  signal: AbortSignal,
): Promise<CorumFailedChildContext | undefined> {
  const query = ctx.get('sessionQuery') as unknown as CorumSessionQueryFace | undefined
  if (query === undefined) return undefined
  try {
    const observation = await query.observeSession(childSessionId as SessionId, { signal })
    const events = observation.events
    const own = events.slice(observation.inheritedEventCount)

    // 原始任务 = 第一条 user/message 的文本内容
    let originalTask = ''
    for (const event of own) {
      if (event.type === 'user/message') {
        const content = (event.data as { content?: readonly ContentBlock[] }).content
        if (content !== undefined) {
          originalTask = content
            .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
            .map(b => b.text)
            .join('')
        }
        break
      }
    }

    // 最后一轮 assistant 输出
    const lastOutput = finalAssistantOutput(own)
    const lastOutputText = lastOutput === undefined
      ? undefined
      : lastOutput
          .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
          .map(b => b.text)
          .join('')

    // 最新 todo 状态（从 tool/call name=todo_write 的 arguments 里取最后一次调用）
    let todos: CorumFailedChildContext['todos']
    for (const event of [...own].reverse()) {
      if (event.type === 'tool/call' && (event.data as { name?: string }).name === 'todo_write') {
        try {
          const args = JSON.parse((event.data as { arguments?: string }).arguments ?? '{}') as {
            todos?: readonly { content: string; status: string }[]
          }
          if (args.todos !== undefined) todos = args.todos
        } catch { /* 解析失败略过 */ }
        break
      }
    }

    // 失败原因
    const { end } = foldConsumedWork(own)
    const stopReason = end === undefined ? undefined : String((end.data as { reason?: { kind?: string } }).reason?.kind)

    return { originalTask, lastOutput: lastOutputText, todos, stopReason }
  } catch {
    // session 不存在/读失败 ⇒ 退化为盲重跑（不阻塞重跑路径）。
    return undefined
  }
}

/**
 * 构造「接着做」的增强 prompt。
 *
 * 把失败子 Agent 的上下文注入到新子 Agent 的原始 prompt 前面，让新子 Agent
 * 知道：目标是什么、已经做了什么、做到哪了、为什么失败了。
 *
 * @param originalPrompt - 原始委派的 prompt。
 * @param context - 从失败子 Agent 提取的上下文。
 * @returns 增强后的 prompt（前缀 + 原始 prompt）。
 */
/**
 * fork（corum）2026-09-20：主 Agent 经 `roleContext` 注入的叠加层人格**长度上限**。
 *
 * ⚠️ **本地常量，刻意不从 `@corum/corum-subagent` import**：本包 import 的是官方
 * `@deepseek-ai/dsh-subagent`（注册表实体），而 fork 是另一个模块实例——跨实例取值会踩
 * 「两份模块实例」红线（见本文件 1509 行附近对同源不同实例的说明）。该上限是**产品口径**
 * 而非实现细节，两处各持一份、由 `verify-fork-drift.sh` 的注释对账约束（改动需两处同步）。
 * 权威真源在 `corum-subagent/src/child-roles.ts` 的 `PERSONA_INJECTION_MAX_CHARS`。
 */
const PERSONA_INJECTION_MAX_CHARS = 2000

/**
 * fork（corum）2026-09-20：把主 Agent 注入的 `roleContext` 收成可用的叠加层人格。
 *
 * 用户定调「叠加，且不可覆盖机制层」+「2000 字符上限」：
 * - 空/纯空白 ⇒ `undefined`（不注入，子 Agent 只用机制角色契约）；
 * - 超限 ⇒ **截断并显式标注**，不静默丢弃——子 Agent 知道自己拿到的上下文不完整，
 *   主 Agent 也能从结果里看出自己的注入被截了（静默截断会让双方都误以为完整）。
 *
 * @param raw - 模型传入的 `roleContext`（可能缺失、非字符串或空白）。
 * @returns 归一化后的注入文本；无有效内容时 `undefined`。
 */
function corumPersonaHint(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (trimmed.length <= PERSONA_INJECTION_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, PERSONA_INJECTION_MAX_CHARS)}\n\n[truncated: this role context exceeded ${PERSONA_INJECTION_MAX_CHARS} characters]`
}

function corumBuildResumePrompt(
  originalPrompt: ContentBlock[],
  context: CorumFailedChildContext,
): ContentBlock[] {
  const sections: string[] = [
    'CONTEXT FROM A PREVIOUS ATTEMPT THAT FAILED DUE TO MODEL UNAVAILABILITY:',
    '',
    `Original task: ${context.originalTask || '(not available)'}`,
  ]
  if (context.lastOutput !== undefined && context.lastOutput.length > 0) {
    sections.push('', `Work completed before failure:\n${context.lastOutput}`)
  }
  if (context.todos !== undefined && context.todos.length > 0) {
    const remaining = context.todos.filter(t => t.status !== 'completed')
    if (remaining.length > 0) {
      sections.push('', 'Remaining steps from the plan:', ...remaining.map(t => `- [${t.status}] ${t.content}`))
    }
  }
  if (context.stopReason !== undefined) {
    sections.push('', `The previous attempt ended with: ${context.stopReason}`)
  }
  sections.push(
    '',
    'INSTRUCTION: Continue from where the previous attempt left off. Do NOT repeat work that was already completed. Use the context above to avoid redundant tool calls and build on the progress already made.',
    '',
    '---',
    '',
  )
  return [{ type: 'text', text: sections.join('\n') }, ...originalPrompt]
}

/**
 * fork（corum）2026-09-18：**可带路线覆盖的续跑**所需的最小能力面。
 *
 * 为什么需要（红线 3）：本包编译期解析的是**官方** `@deepseek-ai/dsh-subagent` 的
 * `SubagentSendMessageOptions`（该包被 tsdown external，类型面是官方基线），而运行期
 * `subagents` 服务实例来自 **fork #9** `@corum/corum-subagent`（`cordis.patch.yml` 的
 * `corum-subagent` 行取代了官方行，服务名同为 `subagents`）。fork 给该 options 增了
 * `agentOptions`（按次路线覆盖），官方类型里没有 ⇒ 直接用会 TS2353。
 * 按红线 3 的做法：**本地声明窄的能力接口**，不 import fork 实现包（那会把 fork 源码
 * 内联进本 bundle）。
 */
interface CorumRouteAwareDelivery {
  readonly signal: AbortSignal
  /** 本次投递的 LLM 路线覆盖（按次、不落盘；仅冷恢复路径 honoring）。 */
  readonly agentOptions?: { provider: string; model: string; reasoningEffort?: ReasoningEffortId }
}

/** fork #9 的 `subagents.sendMessage`（带路线覆盖版）；运行期实例即 fork，安全。 */
type CorumRouteAwareSendMessage = (
  sender: Agent,
  targetId: never,
  content: ContentBlock[],
  options: CorumRouteAwareDelivery,
) => Promise<unknown>

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
    /**
     * 机制级模型询问（host → client 的独立通路；**不是** userQuestions）。
     *
     * 与 `@corum/corum-api-remotes` 的白名单声明各自一次（fork 包之间看不到彼此的
     * Events 合并，见上方 `corum/subagent/child` 的同一说明）：结构必须逐字段一致，
     * 改一处要两处一起改。
     * @param request - 失败事实 + 档位清单 + 可用模型清单。
     * @param next - 无应答者时继续传递（落到调用方传的默认值）。
     * @mode waterfall
     */
    'corum/model-ask/request'(
      request: CorumModelAskRequest,
      next: () => Promise<CorumModelAskAnswer>,
    ): Promise<CorumModelAskAnswer>
  }
}

/** `corum/model-ask/request` 的载荷（与 api-remotes 的 CorumModelAskRequestEvent 同构）。 */
interface CorumModelAskRequest {
  readonly agent: Agent
  readonly label: string
  readonly configured: { provider: string; model: string }
  readonly fallback: { provider: string; model: string }
  readonly cause: string
  readonly role: 'worker' | 'research'
  readonly options: readonly { kind: string; label: string; description: string }[]
  readonly catalog: readonly {
    provider: string
    label: string
    models: readonly { model: string; label: string }[]
  }[]
}

/** `corum/model-ask/request` 的回传（与 api-remotes 的 CorumModelAskOutcomeEvent 同构）。 */
interface CorumModelAskAnswer {
  readonly kind: 'temporary' | 'permanent-follow' | 'permanent-route' | 'decline' | 'dismissed'
  readonly route?: { provider: string; model: string; reasoningEffort?: string }
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
  /**
   * fork（corum）：本次委派的**隔离落点**——由 `spawnOne` 附上，工具 render 渲染成一行
   * 事实说明给父 Agent（文本单一事实源 = `corumIsolationBoundaryNotice`）。
   *
   * ⚠️ 2026-09-18 反向修正：此前**只在「没隔离」时**才附（注释原话「worktree 是常规路径、
   * 无需提醒」）。那个假设是错的——隔离成功恰恰是**唯一需要模型采取行动**的情形：改动在
   * 分支上，**只有 `integrate: true` 能把它并进主树**；不提醒就等于把「分支已提交、模型
   * 以为完事」当默认结局，工作静默搁浅（作者本人 2026-09-18 就这么中招：两次隔离委派都
   * 没被提醒，手工 cherry-pick 收尾，机制台账从未翻成 integrated）。故现在**两档都报**。
   */
  readonly isolationBoundary?: 'worktree' | 'skipped-non-git'
}

/**
 * fork（corum）2026-09-20：把一次前台委派产出的 content blocks 折成纯文本。
 *
 * 用途：`integrate` 收尾时把集成者的报告正文带回 `orchestrate` 的工具结果（见 `runIntegrate`
 * 的注释）。此前集成者的 `output` 拿到了却被丢弃，主 Agent 只看到 `integrated: true`。
 *
 * 只取 text block 并拼接（与 `withDiagnosticAndPartialText` 同一口径）；非 text block
 * （图片等）不进报告——集成报告是给人读的结论，不是原始回执。
 * @param output - 子 Agent 产出（`ForegroundToolResult['output']`）。
 * @returns 拼接后的正文；无文本 block 时为空串。
 */
function corumOutputText(output: readonly ContentBlock[] | readonly JsonValue[]): string {
  return (output as readonly ContentBlock[])
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
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
 * fork（corum）：**被拒集成后的现场解卡**（2026-09-16 实机补，两道门禁的失败路径共用）。
 *
 * 由来：门禁要求集成者「先 `git merge --no-commit` 合、验完再提交」（为了消掉「合并即提交」
 * 让 verify 失败被盖过那条路）。副作用是**被拒时主树停在未结清的合并现场**：`MERGE_HEAD`
 * 存在会让后续**每一次** merge/commit 都失败（`fatal: You have not concluded your merge`），
 * 包括下一轮 orchestrate 的集成者与 turn-end 收口——实测 `corum-task-78da6133` 那一轮的
 * `integration.error` 里因此同时出现「分支未进 HEAD」与「A u1.md」两条证据。
 *
 * 安全性见 `corumResolveRejectedIntegration`：被拒分支从未删除（提交仍在分支上），
 * `git merge --abort` 只回退本次合并引入的暂存/工作区改动，**不丢工作、不碰在制品**。
 * 解卡失败只记日志——不能让它掩盖原始失败原因。
 */
function corumUnblockRejectedMerge(cwd: string, logger: { warn: (message: string) => void }): void {
  const failure = corumResolveRejectedIntegration(cwd)
  if (failure !== undefined) {
    logger.warn(`integrate rejected: could not unblock the in-progress merge in the main tree (${failure})`)
  }
}

/**
 * fork（corum）：**声明式 verify 拒绝集成**的通知（2026-09-16 根因修复配套）。
 *
 * 为什么不能复用 `corumNotifyPendingIntegration`：那条通知的第一句是「are NOT merged into
 * the main tree」——在 verify 拒绝的形态下**那是假的**。实测事故（`corum-task-b7122dc0`）里
 * 集成者的 `git merge` 合并提交**已经进了主树**，分支是合了的，失败的只是验收；照抄那条
 * 通知会把主 Agent 引去重做合并（它读到「分支未合并」会再派一次集成者）。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param report - 机制产出的 verify 失败报告（含命令、退出码、输出尾部、现状与出路）。
 * @param logger - 注入失败时的告警出口。
 */
function corumNotifyVerifyRejected(
  parent: Agent,
  report: string,
  logger: { warn: (message: string) => void },
): void {
  try {
    parent.inject(createUserMessage({
      content: [{
        type: 'text',
        text: `[corum] the declared verification REJECTED this integration — the branches ARE merged into the main tree, but the verification did not pass, so the mechanism did not accept the round.\n\n${report}`,
      }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary('integrate rejected by declared verification'),
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`verify-rejection notice was not delivered to its parent: ${String(error)}`)
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
 * fork（corum）2026-09-18：**子 Agent 模型路由回退**的可见通知（用户策略第 2 条）。
 *
 * 用户策略：「如果发生子 Agent 模型调用出错，则默认退回主 Agent 路由，确保任务完成，
 * 并**通知用户该情况的处理方式**」。⇒ 这条通知的职责不是「报告一个错误」，而是把
 * 机制**已经替你做了什么**说清楚，否则用户只看到子 Agent 跑在了别的模型上而无从得知为什么。
 *
 * 通知必须给全四样（缺一样用户就无法判断该不该干预）：
 *   ① 哪个子 Agent（label + childId）；② 原定的模型路由（用户配置的那个）；
 *   ③ 实际改用的路由（主 Agent 的）；④ 这是**自动回退**、以及用户可以怎么改
 *   （去 Agent 预设改子 Agent 模型，或换一个可用的 provider/model）。
 *
 * 投递形态与 {@link corumNotifyForegroundResult} 同款（`form: 'notice'`，会话里一条
 * 可见注入行）。注入失败只告警——可见性是增强，不能反过来让委派失败。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param label - 委托标签（给用户一句人话上下文）。
 * @param configured - 原定（用户配置的）模型路由。
 * @param fallback - 实际改用的主 Agent 路由。
 * @param cause - 触发回退的原因原文（子 Agent 的失败信息）。
 * @param logger - 注入失败时的告警出口。
 */
/**
 * fork（corum）2026-09-18：**模型不可用问用户的结果**投递给父会话（取代旧版「已自动回退」通知）。
 *
 * 为什么必须投递：用户策略的两条规则都以「**主 Agent 提醒用户**」为前提（原话
 * 「主 Agent 提醒用户子 Agent 配置的 LLM 当前无法使用」）。提问卡是**交互式**的一次性 UI，
 * 用户答完即消失；这条 notice 是**留在会话里**的记录，也是主 Agent 知道「现在该怎么继续」
 * （自己干 / 重新指派 / 换个模型）的唯一来源。
 *
 * 投递形态与其它通知同款（`form: 'notice'`，会话里一条可见注入行）；注入失败只告警。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param label - 委托标签（人话上下文）。
 * @param summary - 机制决定的结论（`model-ask-run.ts` 生成，已含「已发生什么 + 下一步」）。
 * @param logger - 注入失败时的告警出口。
 */
function corumNotifyModelDecision(
  parent: Agent,
  label: string,
  summary: string,
  logger: { warn: (message: string) => void },
): void {
  try {
    parent.inject(createUserMessage({
      content: [{ type: 'text', text: `Subagent model unavailable (${label}) — ${summary}` }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: boundContextSummary(`Subagent model decision (${label})`),
      } as unknown as MessageSource,
    }))
  } catch (error: unknown) {
    logger.warn(`subagent model-decision notice was not delivered to its parent: ${String(error)}`)
  }
}

/**
 * fork（corum）：可用模型路由清单（供「永久改为别的模型」二级选择）。
 *
 * 红线 3 的窄化用法：只依赖 `llm` 服务的两个方法，不 import 官方 llm 实现包的类型。
 * 目录列举失败返回空数组——调用方会据此如实报告「列不出来」，绝不替用户瞎选一个模型。
 */
function corumModelCatalog(runtimeCtx: Context): CorumModelCatalog {
  return {
    listRoutes: async () => {
      const llm = runtimeCtx.get('llm') as unknown as {
        listProviders?: () => readonly { id: string; name?: string }[]
        listModels?: (provider: string) => Promise<readonly { id: string; name?: string }[]>
      } | undefined
      if (llm?.listProviders === undefined || llm.listModels === undefined) return []
      const out: { provider: string; label: string; models: { model: string; label: string }[] }[] = []
      for (const provider of llm.listProviders()) {
        try {
          const models = await llm.listModels(provider.id)
          out.push({
            provider: provider.id,
            label: provider.name ?? provider.id,
            models: models.map(model => ({ model: model.id, label: model.name ?? model.id })),
          })
        } catch {
          // 单个 provider 列举失败不影响其它（已授权但离线的 provider 会拒绝列举）。
        }
      }
      return out
    },
  }
}

/**
 * fork（corum）2026-09-18：**机制级模型询问**的独立通路调用面。
 *
 * 走 host 侧自定义 waterfall `corum/model-ask/request`（`corum-api-remotes` 已把该事件
 * 加进转发白名单，`mode: 'waterfall'`），由 client 插件 `@corum/corum-ui-model-ask` 应答。
 * **刻意不复用 `userQuestions`**：那条通路的消费者是 LLM 的 `ask_user_question` 工具，
 * 与机制级提问共用会让两者在同一 waterfall 里互相截获、delegate 语义纠缠。
 *
 * ## 必须带 scope 载体（2026-09-19 实机：不带 ⇒ 静默降级成 dismissed）
 *
 * `corum-api-remotes` 的转发循环对 waterfall 事件先取 `carrierKeyOf(this)`，**取不到就
 * 直接 `next()`**（见其 `remoteEventSource`）——即不带载体的派发根本不会转发到 renderer，
 * 用户的界面永远不出现，机制拿到的是我们自己传的 dismissed。表现极具迷惑性：日志里
 * 「无 choice made」，看起来像用户没作答。
 *
 * 载体的正确取法与官方两条同类通路（`user-approval` / `user-questions`）逐字一致：
 * `ctx.waterfall(scopeTarget(agent, agent), event, request, fallback)` —— 第一个参数是
 * **作用域分派载体**，不是普通入参。
 *
 * 为什么在这里 `ctx.get` 而不是注入一个服务：该通路是**事件**（cordis 事件总线），
 * 事件不需要「服务存在」即可安全发起——没有应答者时 waterfall 会落到我们传的
 * `next`（返回 dismissed），这正是「该部署没有 UI 插件」时想要的保守降级。
 *
 * @param runtimeCtx - host context（发事件用）。
 * @returns 通路调用面（恒非 undefined——事件总线永远可用）。
 */
function corumModelAskChannel(runtimeCtx: Context): CorumModelAskChannel {
  return {
    call: (request, next) => Promise.resolve().then(() => runtimeCtx.waterfall(
      scopeTarget(request.agent, request.agent),
      'corum/model-ask/request',
      request,
      next,
    )),
  }
}

/**
 * fork（corum）2026-09-18：**子 Agent 模型不可用 ⇒ 退回主 Agent 路由**的可见通知。
 *
 * ⚠️ 已被 {@link corumNotifyModelDecision} 取代（用户 2026-09-18 改为「先问用户」，
 * 不再有「机制自动重试」这条路径）。保留本函数只因其文案在台账/规格里被引用过，
 * 若确认无引用可删除。
 *
 * @param parent - 委派方 Agent（注入目标）。
 * @param label - 委托标签（给用户一句人话上下文）。
 * @param configured - 原定（用户配置的）模型路由。
 * @param fallback - 实际改用的主 Agent 路由。
 * @param cause - 触发回退的原因原文（子 Agent 的失败信息）。
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
    // fork（corum）2026-09-20 修正（用户报障，见 docs/PENDING-conductor-...md §D1/D2）：
    //
    // 本段**同时注入主会话与子会话**（preset scope 共享），但原文两处假设了「读者能跑构建」：
    //   D1 「run the repo guard ONCE in full」—— 指挥模式的主 Agent **被裁掉了写工具、
    //       shell 也只读**，它物理上跑不了仓库守卫；实测该指令与人格段「you cannot edit
    //       files」直接矛盾（指令与能力不符，与 worker 那次「你没有写工具 vs 工具表里有
    //       write」是同一类病）。
    //   D2 「a child ... cannot produce independent evidence」—— 对**重复同一个校验**成立，
    //       但对 `subagent_research` 不成立：它有独立上下文、自己读代码，**能**产生独立
    //       证据。原措辞会抵消「把广域调研委派出去」的引导（用户 2026-09-20 定的三阶段）。
    //
    // 修法：D1 改为**按能力表述**（能跑命令的读者才跑守卫；跑不了的读者读报告 + 点读 diff，
    // 验证归委派方），D2 收窄到「重复同一校验」并明确 research 的独立调查**是**有效证据。
    '- BUDGET YOUR OWN VERIFICATION. Self-checking means at most three things: (1) read your own diff, (2) run the repository guard ONCE in full **if you can run commands**, (3) at most 3 targeted checks on the riskiest points you touched. That is the entire budget. If your tools do not let you run the guard — a read-only shell, or no shell at all — you do not get to skip verification: check what you can read, and state plainly which checks you could not run and who owns them.',
    '- REPEATING A CHECK IS NOT VERIFICATION. Re-running the same check through another delegation, from the same context, reads the same code and produces no new evidence — that buys no confidence, so spend the budget on your own diff and a few targeted checks. This is about **re-running a check you already ran**, not about investigation: an independent `subagent_research` child reads the code itself in its own context and **is** valid evidence, which is exactly why broad investigation belongs with it.',
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
  corumShaInHead,
  corumEntryIntegrated,
  corumSnapshotBranchTips,
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
  corumIntegrationVerdict,
  corumRunIntegrateVerify,
  corumVerifyFailureNotice,
  corumResolveRejectedIntegration,
  CORUM_INTEGRATE_VERIFY_TIMEOUT_MS,
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
import type { CorumChildSpawnFacts, CorumSettleCommitFailure } from './orchestration.ts'
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
  //
  // 2026-09-18 修复「冷启动该 ns 不存在」：正常路径下**本包不再负责注册**——boot 常驻行
  // `settings-registrar.ts` 已在更早的行序注册它（该 ns 是全局配置，与有无 corum 会话无关；
  // 只在按会话 apply 时注册会导致冷启动进设置页读到空值、模板预填失效）。
  // 这里保留**兜底**：registrar 缺席时（其它组合/其它部署）仍能注册。两侧共用
  // `acquireCorumSubagentSettingsScope`，它容忍「已被注册」（官方 register 对重复注册抛错）。
  // worker/research 双实例共享模块级单例，避免第二次 apply 重复注册。
  if (corumGlobalSettingsScope === undefined) {
    ctx.inject(['settings'], (settingsCtx) => {
      if (corumGlobalSettingsScope !== undefined) return
      corumGlobalSettingsScope = acquireCorumSubagentSettingsScope(
        settingsCtx.settings as unknown as CorumSettingsProviderFace,
      )
    })
  }

  // fork（corum）：实例级配置终值。
  // 2026-09-21 裁定：隔离 / 合并相关键（isolation / integrateChecks / merger）已从 preset
  // 配置面（Config 接口 + schema）与全局 ns 移除，**机制恒定生效**，故这里不再有相关解析，
  // 调用点直接固化常量（隔离模式恒 write-tasks、denyDirectFs / autoCleanup 恒 true、
  // 合并者恒 parent、核查命令恒按父 cwd 探测）。
  // getSnapshot 每次执行时读（文档更新即时生效）。
  const corumGlobal = (): CorumSubagentGlobalSettings => corumGlobalSettingsScope?.get() ?? {}
  const corumReadonlyResearch = config.readonlyResearch === true
  const corumMaxParallelChildren = config.maxParallelChildren ?? corumGlobal().maxParallelChildren ?? 4

  /** 机制状态面（`corumOrchestration` 已在本 apply 顶部强制就绪）。 */
  const corumPolicyState: CorumDelegationPolicyState = {
    setModelOverride: (sessionId, route) => orchestration.setModelOverride(sessionId, route),
    modelOverrideOf: sessionId => orchestration.modelOverrideOf(sessionId),
    clearModelOverride: sessionId => orchestration.clearModelOverride(sessionId),
  }

  /**
   * fork（corum）2026-09-18：**子 Agent 模型不可用 ⇒ 问用户**，并按下文两规则处置。
   *
   * 本函数是三条失败路径（前台 one-shot / continuable / 后台）**共用**的收尾：
   * 机制全权完成（问用户 → 解析 → 改会话级临时路由或写预设 → 必要时停用委派 → 通知），
   * **不给 LLM 任何改模型的工具或参数**（用户明确要求）。
   *
   * @returns 机制决定（调用方据此决定是否就地重跑）；问不到/失败时返回 dismissed。
   */
  const corumAskAboutModel = async (
    parent: Agent,
    label: string,
    role: 'worker' | 'research',
    configuredModel: { provider: string; model: string },
    cause: string,
    signal: AbortSignal,
    notify: boolean,
  ): Promise<{ route: CorumRoute | undefined; summary: string }> => {
    /**
     * ★ 2026-09-21：**陈旧失败不问**。
     *
     * 实机现场（会话 `corum-task-1b927cf3`）：主 Agent 同时发两个 subagent，两个都拿
     * `deepseek-v4.1-flash` 起跑。用户在第 1 个弹窗选了「永久改为 glm-5.3-flash」⇒
     * 会话级覆盖已写、预设已改。但**第 2 个兄弟的失败在那之前就已产生**，它带着
     * 「配置模型 = deepseek-v4.1-flash」这一**已经过时**的事实来问，于是用户被同一个根因
     * 又问了一遍（seq 191「No choice was made」）。
     *
     * 判据：本次失败声称的「配置模型」若**已不等于**该会话当前生效的路由，说明用户/机制
     * 已经换过了 —— 这条失败是旧路由的遗留，再问一次毫无信息量。直接返回「无决议」，
     * 让调用方按原样把失败交回主 Agent（**不重跑**：这次失败本身没有用户许可）。
     *
     * ⚠️ 只在「当前生效路由与失败路由**不同**」时才跳过：相同 ⇒ 换了也还是坏的，
     * 那时必须问（那是真·新的信息）。
     */
    const effectiveNow = corumPolicyState.modelOverrideOf(String(parent.session.id))
    if (effectiveNow !== undefined
      && (effectiveNow.provider !== configuredModel.provider || effectiveNow.model !== configuredModel.model)) {
      ctx.logger.info(
        `subagent (${label}): stale model failure ignored — configured ${configuredModel.provider}/${configuredModel.model} `
        + `is no longer this session's child route (now ${effectiveNow.provider}/${effectiveNow.model})`,
      )
      return { route: undefined, summary: '' }
    }
    // 回退路由 = 父 Agent 的真实路由（用户要的「和主 Agent 一样」）。拿不到就只报告。
    const parentOptions = parentAgentOptionsForDelegation(parent)
    if (parentOptions.provider === undefined || parentOptions.model === undefined) {
      ctx.logger.warn(
        `subagent (${label}): configured model ${configuredModel.provider}/${configuredModel.model} failed `
        + `(${cause}) and the parent route is unresolvable, so the user cannot be offered a fallback`,
      )
      return { route: undefined, summary: '' }
    }
    // 提问走 host 侧的**独立通路** `corum/model-ask/request`（waterfall）——不借
    // `ctx.userQuestions`：那是 LLM 主动提问的通路，与机制级询问的生命周期、取消语义、
    // 文案归属都不同，共用会让两者互相截获（见 model-ask.ts 头注释）。
    // 2026-09-18 实机修正：用 `ctx.get` 而**不是** `ctx.root.get`——corumAgent 由
    // `@corum/corum-agent` 在**根 composition** 的 apply 里 `new CorumAgentService(ctx)`
    // 注册（`Service` 构造即 provide 到传入的 ctx），而 cordis 的 reflect store 按
    // isolate key 跨 scope 查找、子 scope 沿祖先链继承 ⇒ 本 scope 直接 get 就够；
    // 写 `ctx.root.get` 在实测里取不到（首次实机「永久档」报 no writable profile 即此因）。
    // 按红线 3 用窄接口收窄，不 import @corum/corum-agent。
    const profile = ctx.get('corumAgent') as unknown as CorumProfileWriteFace | undefined
    // ★ 2026-09-21：走「至多问一次」入口 —— 同一父会话同一角色的并行失败**共享一个决定**。
    // 实机现场：主 Agent 在同一消息里发两个并行 subagent（会话 corum-task-1b927cf3 的
    // step 27 的 :187/:188），两个子 Agent 都用坏模型起跑 ⇒ 各自失败 ⇒ 用户被同一个根因
    // 连问两次（seq 190 已答、seq 191 又问）。共享后只问一次。
    const outcome = await corumAskAboutModelOnce(
      {
        state: corumPolicyState,
        channel: corumModelAskChannel(ctx),
        profile,
        catalog: corumModelCatalog(ctx),
      },
      parent,
      {
        label,
        role,
        configured: configuredModel,
        fallback: { provider: parentOptions.provider, model: parentOptions.model },
        cause,
      },
      signal,
      ctx.logger,
    )
    ctx.logger.info(
      `subagent (${label}): model decision=${outcome.decision.kind} persisted=${outcome.persisted} `
      + `persisted=${outcome.persisted}`,
    )
    if (notify && outcome.summary !== '') {
      corumNotifyModelDecision(parent, label, outcome.summary, ctx.logger)
    }
    return {
      route: outcome.override,
      summary: outcome.summary,
    }
  }

  /**
   * fork（corum）2026-09-18：**规则 1** 的异步处理器——前台/后台「能 continue」的委派，
   * 模型不可用时问用户，并按答案**带着新模型续跑同一个子会话**。
   *
   * 用户规则 1 原文：「前台或后台任务且能 continue 的，主 Agent 直接询问用户是否回退继续，
   * 选是则**临时更换为主 Agent 配置的大模型**完成任务。选否则直接报告子 Agent 配置模型
   * 不可用，后续主 Agent 不再派遣子 Agent，所有工作由主 Agent 继续」。
   *
   * 与「一次性任务」的关键差别：这类子会话**上下文还在**，所以「继续」= 往同一个子会话
   * 投递一条「用主 Agent 模型接着做完」的消息，而**不是**新开一个子会话（那样会丢掉它
   * 已经掌握的上下文，等于让用户为一次模型故障多付一遍钱）。
   *
   * fire-and-forget：调用方（`subagent/end` 监听器）必须同步返回，见那里的说明。
   */
  const corumHandleAsyncModelFailure = async (
    parent: Agent,
    facts: CorumChildSpawnFacts,
    info: SubagentRunEndInfo,
    appCtx: Context,
  ): Promise<void> => {
    try {
      const cause = info.stopReason === 'error'
        ? 'the child run ended with an error stop reason (model/transport failure)'
        : String(info.stopReason)
      const asked = await corumAskAboutModel(
        parent,
        facts.label,
        facts.role,
        facts.configured,
        cause,
        AbortSignal.timeout(CORUM_ASK_TIMEOUT_MS),
        true,
      )
      if (asked.route === undefined) return
      const childId = String(info.id)
      if (!facts.continuable) {
        // **一次性**后台任务：子会话已终结、无法"继续"（官方契约：one-shot 不驻留）。
        // 用户规则 2 的对应动作是「**重新指派**子 Agent，并使用与主 Agent 一致的模型」——
        // 这一步由主 Agent 在新的委派里完成（此时会话级临时覆盖已生效，新子 Agent 自然
        // 跑在主 Agent 的模型上）。机制这里只负责"把路铺好 + 通知"，不替主 Agent 编造派单。
        appCtx.logger.info(
          `subagent (${facts.label}): one-shot background run failed on the configured model; `
          + `the user approved the main-model fallback, so the parent may re-issue the delegation`,
        )
        return
      }
      // **能 continue**：子会话上下文还在 ⇒ 带着「用主 Agent 模型接着做完」的指令
      // **续跑同一个子会话**（而不是新开一个——那会丢掉它已掌握的上下文，等于让用户
      // 为一次模型故障多付一遍钱）。
      //
      // ★ 路线覆盖是**必需**的（2026-09-18）：失败的 continuable 子 Agent 以
      // `stopReason:'error'` 终结时已被 DISPOSED（dispose 在 `subagent/end` 之前），
      // 故这次投递会走 `coldResume`；而 coldResume 默认按**持久化 descriptor** 重建路由
      // —— 那正是刚刚失败的那个坏模型。不传 `agentOptions` 就等于「用同一个坏模型再跑
      // 一遍」，用户的「是」会被静默浪费掉。故这里显式带上主 Agent 路由
      // （per-delivery、不落盘；descriptor 保持权威，见 corum-subagent 的 seam 注释）。
      await (appCtx.subagents.sendMessage as unknown as CorumRouteAwareSendMessage)(
        parent,
        childId as never,
        [{
          type: 'text',
          text: "[corum] The model configured for this subagent was unavailable, and the user approved continuing on the main Agent's model. Resume and FINISH the task you were given, using the main Agent's model from now on. Do not restart from scratch — keep whatever work and context you already have.",
        }],
        {
          signal: AbortSignal.timeout(CORUM_ASK_TIMEOUT_MS),
          agentOptions: {
            provider: asked.route.provider,
            model: asked.route.model,
            ...asked.route.reasoningEffort !== undefined
              ? { reasoningEffort: asked.route.reasoningEffort as ReasoningEffortId }
              : {},
          },
        },
      )
      appCtx.logger.info(`subagent (${facts.label}): re-drove continuable child ${childId} after the user approved the fallback`)
    } catch (error: unknown) {
      // 提问/续跑的任何失败都只告警：此刻的立场是「尽量把任务救回来」，不是再抛一个错。
      appCtx.logger.warn(`subagent (${facts.label}): async model-failure handling failed: ${String(error)}`)
    }
  }

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

    // fork（corum）2026-09-18：**规则 1** —— 前台/后台且**能 continue** 的委派，
    // 模型不可用时由机制问用户「是否回退继续」。
    //
    // 为什么在这里而不是工具调用里：后台一次性与 continuable 的失败**不在工具栈上**
    // （工具早已返回子会话 id / job id）。spawn 时记下的 `ChildSpawnFacts` 正是为了
    // 让这一刻还拿得到「用户配的是哪个模型 / label / 角色」。
    //
    // ⚠️ 本监听器**必须同步返回**、不可 await：emitter 的 per-listener 容错会吞掉抛错，
    // 且阻塞它会拖住 settle 链。故提问走 fire-and-forget 的异步任务，失败只告警。
    if (parent !== undefined && info.stopReason === 'error') {
      // ⚠️ 查找键用 `info.id`（= 子会话 id）**而不是** `info.runId`：实测（2026-09-18）
      // continuable 路径的 `runId` 是 `createActivationObserver` 每次激活**新生成的
      // randomUUID**（lifecycle.ts:182），与 spawn 时 `startContinuable` 返回的
      // childId 毫无关系 —— 用 runId 查恒 miss，于是规则 1 在默认路径上**静默不触发**
      // （第一次实机验证正是这样：子会话建了、失败了、提问卡没出现）。
      // 子会话 id 才是稳定键：spawn 时记的是它，end 时 `info.id` 还是它。
      const facts = orchestration.takeChildSpawn(String(info.id))
      if (facts !== undefined) {
        void corumHandleAsyncModelFailure(parent, facts, info, ctx)
      }
    }

    // 2026-09-15 机制补漏：**收口强制提交失败 ⇒ 交给模型完成提交**（用户裁定：
    // 「commit 失败后交由模型处理并完成提交」）。
    // ⚠️ 必须在这里投递，不能在 `settleFromEnd` 里 throw —— emitter 的 per-listener
    // 容错会**吞掉**抛错（本文件上方注释已记过 `parentAgent.session.id` 抛错被吞的先例）。
    // 有 parent 时按会话精确取走；拿不到 parent 时兜底取走全部，避免失败在实例里累积。
    // ⚠️ 这两件事**必须各自独立判定**：`failures`（收口提交失败）与 `pendingAfter`
    // （有分支待集成）互不蕴含。此处早先是 `if (failures.length === 0) return`，
    // 于是**只有收口提交也失败时**才会发出下面的「待集成」通知——正常情况下
    // （提交没失败）那条通知**永远发不出去**（2026-09-18 定位：作者同一场会话里
    // 两次前台隔离委派都没收到提示，只好手工 cherry-pick 集成；机制台账因此从未翻成
    // integrated、autoCleanup 也没跑，worktrees 堆到 2.4GB/13 个）。
    // 修法：把「收口失败」的处理收窄进它自己的分支，**别拦后面的通知**。
    const failures = orchestration.drainSettleCommitFailures(
      parent === undefined ? undefined : String(parent.session.id),
    )
    if (failures.length > 0) {
      if (parent === undefined) {
        ctx.logger.warn(
          `settle auto-commit failed for ${failures.length} worktree(s) but no parent Agent was reachable,`
            + ` so the model was not told: ${failures.map(failure => `${failure.slug}: ${failure.reason}`).join('; ')}`,
        )
      } else {
        corumNotifySettleCommitFailures(parent, failures, ctx.logger)
      }
    }

    // 不变式④（invariant.merge-strategy，用户 2026-09-16）：**单发异步后台子 Agent 的分支
    // 由主 Agent 合并**——settle 后若有待集成隔离分支，同样注入 pending-integration 通知
    // （告知主 Agent「分支未合并 + 用 subagent {integrate:true} 收尾」）。原先 corumNotifyPendingIntegration
    // 只在编排（orchestrate）结果处触发，单发后台路径不报 ⇒ 主 Agent 可能永不合并（工作不丢但
    // 永不进主树，UI 只报 finished）。这里对所有产生隔离分支的 settle 统一补发，让单发后台与
    // 编排同样「不可静默」。编排路径仍会发自己的通知（两处通知幂等合并——同键去重）。
    if (parent !== undefined) {
      const sessionId = String(parent.session.id)
      const pendingAfter = corumPendingIntegration(orchestration.entriesOf(sessionId))
      // ⚠️ 认领式去重（2026-09-18）：本插件在 corum preset 里是**双实例**（worker + research，
      // 见 corum-agent/compile.ts），两个实例各注册一个 {global:true} 的 end 监听 ⇒ 同一个
      // settle 会被处理两次。上面两个「取走即删」的用量天然只生效一次，而本条是**纯读**，
      // 不去重就会发两条逐字相同的通知（实机确认：同一会话 seq 24/25 内容一致）。
      const fresh = pendingAfter.filter(entry => orchestration.claimPendingIntegrationNotice(sessionId, entry.branch))
      if (fresh.length > 0) {
        corumNotifyPendingIntegration(parent, fresh.map(entry => entry.branch), ctx.logger)
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
        taskIsolation?: 'always' | 'write-tasks'
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
        /** fork（corum）：主 Agent 注入的叠加层人格（`roleContext`）——上层已截断。 */
        roleContext?: string
        // fork（corum）2026-09-18：`taskModel` **已按用户策略移除**——per-task 模型
        // 面不再存在（orchestrate 的 tasks[i].model 已从 schema 剔除且不再转达）。
      },
      subagentProvider: SubagentProvider,
    ): Promise<ForegroundToolResult | { kind: 'continuable'; subagentId: string } | { kind: 'background'; jobId: string }> => {
      const parent = exec.agent
      // fork（corum）：官方模型自选请求面（provider/model/reasoning_effort 直挂
      // args 顶层）——corum 的 subagent/orchestrate schema 已剔除这三个字段
      // （模型锁），modelRequest 恒为空对象，仅保形供官方函数签名消费。
      const modelRequest = args as DelegationModelRequest
      const parentOptions = parentAgentOptionsForDelegation(parent)
      const providerRouteDefaults = subagentProvider.agentRouteDefaults
      // fork（corum）：模型路由**始终两档**（2026-09-18 用户澄清口径）——
      //   ① **预设里配的模型**（`config.model`，角色锁，见 corum-agent/compile.ts：
      //      worker→profile.subagentModel，research→profile.researchModel ?? subagentModel）；
      //   ② **跟随主 Agent**：预设没配（= 菜单里选了「（同主 Agent）」）就落到父的真实路由。
      //
      // ❗**运行期没有全局兜底那一档**。用户 2026-09-18 明确：「跟随主 Agent 就是主 Agent
      // 当前预设哪个，子 Agent 也预设哪个。**全局页面的配置只是说你创建一个新预设的时候
      // 默认使用这套配置**，如果新的预设自己覆盖了就按预设的配置，**始终是两档**」。
      // 故 `corum-subagent` 全局 ns 的 defaultModel/defaultResearchModel **不参与运行期
      // 解析**——它们是**新建预设时的模板值**（由设置页在创建草稿时预填，见
      // SettingsAgentPresetsSection 的 emptyDraft + 全局模板）。
      // 此前这里写成 `config.model ?? corumGlobalModel`，等于把「模板」当成了运行期的
      // 第三档：用户在全局页改一项，会静默影响**所有没配该键的预设**的子 Agent 路由
      // ——既违反两档语义，也让「预设没配 = 跟随主 Agent」这句话不成立。
      //
      // 2026-09-18（同日稍后）：**会话级临时覆盖**插在这里，且**优先级高于预设**。
      // 它是机制在「用户被告知配置的模型不可用、并选择了临时改用主 Agent 模型」之后
      // 写进 `corumOrchestration` 的内存值（`setModelOverride`）——**只对本会话生效、
      // 不落盘**（用户明确要求「临时生效，不覆盖用户的设置」）。它不构成"第三档配置"：
      // 用户从未配置它，是机制的一次会话内决定，新会话自然回到预设/跟随主 Agent。
      const corumSessionOverride: CorumRoute | undefined =
        orchestration.modelOverrideOf(String(parent.session.id))
      const corumEffectiveModel = corumSessionOverride ?? config.model
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
      /**
       * fork（corum）：子 Agent 的**种类**（2026-09-20 用户定调）——决定它在子 scope 里拿哪套
       * 角色契约（`@corum/corum-subagent` 的 `ChildComposition.kind`）：
       *   · `researcher`（本实例为只读研究实例）→ **全面调查员**，允许继续派子 Agent 深入调查；
       *   · `worker`（其余写型实例）→ **忠实执行者**，不许重规划/重调研/越界，且**禁止构建**。
       * 与 `readonlySandbox` 同源判定（同一个 `effReadonlyResearch`），但语义不同：前者管沙箱、
       * 后者管人格，故单独传递而不是让下游从沙箱反推。
       */
      const childKind: 'worker' | 'researcher' = effReadonlyResearch ? 'researcher' : 'worker'
      const request: {
        label: string
        prompt: ContentBlock[]
        parent: Agent
        agentOptions?: AgentOptions
        kind?: 'worker' | 'researcher'
        persona?: string
        personaHint?: string
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
        kind: childKind,
        // fork（corum）2026-09-20：主 Agent 注入的叠加层人格——**截断到上限**（用户定调
        // 2000 字符）。超限不静默丢弃：截断后显式标注，让子 Agent 与主 Agent 都知道被截了。
        ...corumPersonaHint(args.roleContext) === undefined ? {} : { personaHint: corumPersonaHint(args.roleContext)! },
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

      // fork（corum）2026-09-18：任务级模型锁的校验块**已删除**（连同 `taskModel`
      // 入参）。per-task 模型面按用户策略剔除后，这里不再有「LLM 声明的路由」需要
      // 白名单校验——子 Agent 的路由只来自用户配置（`corumLockedOptions`）或跟随父
      // （`request.agentOptions` 由父路由合并而来），两者都已在各自分支做过
      // `preflightChildLlmRoute` 真路由预检。

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
      // 任务级覆盖（orchestrate 的 tasks[i].isolation/research）优先于实例固定终值
      // （2026-09-21 裁定：隔离机制恒定生效，实例侧不再是可配置项，故字面固化常量）。
      // `effReadonlyResearch` 已在上方 request 构造处解析（供只读沙箱钉使用）。
      const effIsolationMode = args.taskIsolation ?? 'write-tasks'
      const corumIsWrite = corumIsWriteTask(config.toolFilter, effReadonlyResearch, true)
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
       * ⚠️ 2026-09-18 修正：**两档都要报**。此前只报「没隔离」那一档，理由是「worktree 是
       * 常规路径、无需提醒」——但隔离成功时模型**必须**做一件事（`integrate: true`）才能把
       * 改动并进主树，不报就等于让它以为交完活了（作者 2026-09-18 实测中招：两次隔离委派都
       * 没收到任何提示，工作卡在分支上）。「无需提醒」把最需要提醒的一档给省掉了。
       *
       * **2026-09-16 不变式⑤**：写委派恒隔离 ⇒ git 工作区下不再有「直落父树」这一档；
       * 唯一残留的「没隔离」是**非 git 工作区**的自动降级（worktree 建不出来）。
       */
      const corumIsolationBoundary: 'worktree' | 'skipped-non-git' | undefined =
        !corumIsWrite || effReadonlyResearch
          ? undefined
          : corumIsolate ? 'worktree' : (corumIsolationSkipped ? 'skipped-non-git' : undefined)

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
        // 拒绝时随错误带出的分支快照（抛出后 `entriesOf` 会按 git 实况对账翻转这些条目）。
        const corumPendingBranchNames = pending.map(entry => entry.branch)
        // 2026-09-21 裁定：核查命令恒按父 cwd 探测；合并者恒 'parent'。
        const effectiveChecks = corumDetectIntegrateChecks(parentCwd)
        const declaredVerify = typeof args.verify === 'string' && args.verify.trim() !== '' ? args.verify : undefined
        const corumIntegrateRequest = {
          ...request,
          cwd: parentCwd,
          persona: corumIntegratorPersona(pending, effectiveChecks, 'parent', declaredVerify),
          prompt: [{
            type: 'text',
            text: corumIntegratorPersona(pending, effectiveChecks, 'parent', declaredVerify) + '\n\n' + String(args.prompt),
          }] as ContentBlock[],
        }
        // fork（corum）：机制真值门禁的前置快照（主树 HEAD + 未提交基线）。
        const corumHeadBefore = corumGitHead(parentCwd)
        const corumDirtyBefore = corumGitStatusPorcelain(parentCwd)
        // fork（corum）2026-09-20（机制 bug 修复）：**在集成者启动之前**快照每条分支的 tip。
        //
        // 这是唯一可靠的快照时机：集成者是子 Agent，它 merge 完完全可能顺手
        // `branch -D`（机制自己的 persona/清理都在鼓励这个合规收尾）。分支一没，
        // 之后按**分支名**跑 `merge-base --is-ancestor` 与 `git cherry` 都非零退出 ⇒
        // 判定 false ⇒ 一次**真的落了地**的集成被报成
        // `Error: integrate did not persist into the main tree`。
        // sha 快照不会消失：它之后用来证明「这条工作已经在 HEAD 的祖先链上」。
        const corumSnapshotted = corumSnapshotBranchTips(parentCwd, pending)
        runtimeCtx.logger.info(
          `integrate: snapshotted tip for ${corumSnapshotted}/${pending.length} pending branch(es) before integrator start`,
        )
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
        //   ① 每个待集成分支必须已并入 HEAD（祖先或 patch 等价）；未达标 → 抛错
        //      （附「集成者自述 vs git 实况」对照）+ **保留 worktree 与分支**
        //      + 台账保持 settled（PLAN 不变量「失败不 commit、保留现场」的机制化）；
        //   ②（2026-09-16）声明式 verify 的退出码见下方 `corumIntegrationVerdict`。
        // fork（corum）2026-09-20：判定前**再刷新一次** tip 快照。分支若仍在（集成者只是
        // merge、没删分支）这里刷新到最新；分支若已被合规删除，快照保留着启动前那份
        // 有效证据，判定即按 tip 的祖先关系证明并入。
        const corumSnapshottedAfter = corumSnapshotBranchTips(parentCwd, pending)
        if (corumSnapshottedAfter > 0) {
          runtimeCtx.logger.info(`integrate: refreshed branch tip(s) for ${corumSnapshottedAfter} pending entr(ies) before truth check`)
        }
        let corumTruth = corumIntegrationTruth(parentCwd, pending, corumDirtyBefore)
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
            } else if (ports.length > 0) {
              // 排障日志（2026-09-16）：一条都没落盘时把逐条原因写主日志——此前只有
              // 「port failed」的汇总行，warn 分支在 `failed.length > 0` 之前还会漏掉
              // 「全部 applied=false 但都无 error」的形态。
              runtimeCtx.logger.warn(
                `integrate: branch diff port applied 0/${ports.length} (${ports.map(p => `${p.branch}: ${p.error ?? 'no reason reported'}`).join('; ')})`,
              )
            }
            const failed = ports.filter(port => !port.applied)
            if (failed.length > 0 && landed.length > 0) {
              runtimeCtx.logger.warn(
                `integrate: branch diff port failed for ${failed.map(p => `${p.branch} (${p.error ?? 'no reason reported'})`).join('; ')}`,
              )
            }
          }
          corumTruth = corumIntegrationTruth(parentCwd, pending, corumDirtyBefore)
          if (!corumTruth.integrated) {
            orchestration.emitFrame(sessionId)
            corumUnblockRejectedMerge(parentCwd, runtimeCtx.logger)
            throw new CorumIntegrateRejected(
              'unmerged',
              corumIntegrationFailure(
                corumTruth,
                corumHeadBefore,
                pending,
                outputValueText(outcome.output),
              ),
              corumPendingBranchNames,
            )
          }
        }
        // fork（corum）：集成总判定——**两道闸门合取**（2026-09-16 根因修复）。
        //
        // 事故（用户实测，会话 corum-task-b7122dc0）：声明 `merge.verify = test -f u1.md &&
        // … && test -f zzz.md`（zzz.md 不存在），集成者如实跑了、拿到 exit 1、也按 persona
        // 没再提交——但 `git merge` 的**合并提交自己就是提交**，分支工作已进 HEAD，于是上面
        // 只判 git 实况的真值门禁报 integrated=true，机制对外宣告「merged + committed」，
        // **verify 的失败被完全忽略**。同一形态在 corum-task-d0a24b08 却被拦住，唯一差别是
        // 那次集成者用了 `git merge --no-commit`（分支 tip 没进 HEAD，真值兜住了）——
        // 成败取决于子 Agent 偶然选了哪条 git 命令。verify 是否执行、退出码是否被检查，
        // 此前**只写在 persona 提示词里**，违反「机制优先于提示词」红线。
        //
        // 现在：机制自己跑一遍声明并取退出码，非 0 ⇒ 抛错（保留现场、不翻转台账、不清理），
        // 与真值失败并列成第二种**可辨识**的失败形态（报告区分「分支没进 HEAD」与
        // 「进了 HEAD 但验收没过」，后者不替调用方回滚主树历史）。
        const corumVerdict = corumIntegrationVerdict(parentCwd, pending, corumDirtyBefore, declaredVerify)
        corumTruth = corumVerdict.truth
        if (corumVerdict.verify !== undefined) {
          const corumVerify = corumVerdict.verify
          // 排障日志（2026-09-16）：verify 门禁的退出码写主日志——此前的日志只有「verify 传了
          // 什么」，没有「跑出来是什么」，正是本次根因被漏掉的那一格。
          runtimeCtx.logger.info(
            `integrate verify gate: command=${JSON.stringify(corumVerify.command)} exit=${corumVerify.code} ok=${corumVerify.ok} timedOut=${corumVerify.timedOut} took=${corumVerify.durationMs}ms`,
          )
          if (!corumVerdict.integrated) {
            orchestration.emitFrame(sessionId)
            corumUnblockRejectedMerge(parentCwd, runtimeCtx.logger)
            throw new CorumIntegrateRejected(
              'verify',
              corumVerifyFailureNotice(corumVerify, corumTruth, corumHeadBefore, pending),
              corumPendingBranchNames,
            )
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
        if (landed.length > 0) orchestration.markIntegrated(sessionId, landed, true)
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
          maxParallelChildren: corumMaxParallelChildren,
        })
        corumEntry = { sessionId, slug: child.slug }
        corumEntryInfo = { slug: child.slug, branch: child.branch, path: child.path }
        request.cwd = child.path
        corumSetMechanismFilter(corumEffectiveToolFilter(config.toolFilter, true))
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

      // fork（corum）2026-09-18：**异步失败的提问前置**——把「用户为该角色配的模型 /
      // label / 角色」与即将产生的 run/child id 绑定，供 `subagent/end` 到达时问用户。
      //
      // 为什么必须在这里记：后台一次性与 continuable 的失败**不在本工具调用的栈上**
      // （工具早已带着 jobId/子会话 id 返回），到 `subagent/end` 时只剩 runId/childId
      // 与 stopReason——那时再想拿「配置的模型是哪个」已经无从取。只对**锁定路由**的
      // 委派登记：没配模型的委派本来就用主路由，失败与"配置模型不可用"无关。
      const corumSpawnFacts: CorumChildSpawnFacts | undefined = corumEffectiveModel !== undefined
        ? {
            parentSessionId: String(parent.session.id),
            label: args.label,
            role: (effReadonlyResearch ? 'research' : 'worker') as 'worker' | 'research',
            configured: { provider: corumEffectiveModel.provider, model: corumEffectiveModel.model },
            // 用户两规则的分界：能 continue 的续跑同一子会话，一次性的只能重新指派。
            continuable,
          }
        : undefined

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
          if (corumSpawnFacts !== undefined) orchestration.rememberChildSpawn(String(started.childId), corumSpawnFacts)
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
              if (corumSpawnFacts !== undefined) orchestration.rememberChildSpawn(String(startedRun.id), corumSpawnFacts)
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
        /**
         * fork（corum）2026-09-18：前台失败 ⇒ **问用户**（用户两规则里的第 2 条「一次性任务」）。
         *
         * ⚠️ 语义已从「机制自动退回主路由重试一次」改为「**先问用户，得到许可才动**」——
         * 用户 2026-09-18 定调：机制可以全权执行，但**不许替用户做主**。故这里不再有任何
         * 自动重跑：失败后先问，选「是」才用主 Agent 模型**重新指派**完成任务。
         *
         * 判定用官方契约（`SubagentRun.result` 文档明写）：**模型/传输失败以
         * `stopReason: 'error'` 返回**（不 reject），`settleForegroundRun` 把它转成带
         * stopReason 的 throw。其余终态（aborted / max-tokens / refusal）**不是模型不可用**，
         * 不触发本机制（重跑只会把同样结局再演一遍并重复收费）。
         *
         * 「预检」也算失败判据：锁定路径不走下面的 `preflightChildLlmRoute`，于是配错的模型
         * 有两种失败形态——spawn 期解析失败（provider/model 不存在，若不预检就直接抛出去，
         * 用户看到「任务失败」而非「模型不可用」）、运行期失败（stopReason==='error'）。
         */
        const configuredRoute = corumEffectiveModel !== undefined
          && parentOptions.provider !== undefined && parentOptions.model !== undefined
          ? {
              configured: { provider: corumEffectiveModel.provider, model: corumEffectiveModel.model },
            }
          : undefined
        /** 子 Agent 是否因**模型调用**失败（官方契约：stopReason === 'error'）。 */
        const modelFailureOf = (error: unknown): string | undefined => {
          const stopReason = (error as { stopReason?: string } | undefined)?.stopReason
          return stopReason === 'error' ? (error instanceof Error ? error.message : String(error)) : undefined
        }

        const startRun = (): Promise<SubagentRun> => corumStart(() => runtimeCtx.subagents.start(config.provider, {
          ...request,
          signal: exec.signal,
        }))
        const emitStarted = (started: SubagentRun): void => {
          corumBindRun(String(started.id))
          corumEmitChildStarted(parent.session.id, exec.callId, String(started.id), args.label, corumIsolate, 'foreground', corumEntryInfo, corumSpawnModel)
        }

        /**
         * 至多两轮：① 用户配置的路由；② **用户同意后**用主 Agent 路由重新指派。
         *
         * 第②轮只在用户明确选了「是」时才跑（`corumAskAboutModel` 返回 route）；
         * 选「否」或问不到 ⇒ 不重跑，如实把失败抛给主 Agent，由它自己接手（规则 2 的
         * 「主 Agent 全权承担开发直到任务完成」）。
         */
        let outcome: ForegroundToolResult | undefined
        let configuredFailure: string | undefined
        /** 最终 settle 的那次 run 的 id（通知标题用它；重跑轮会覆盖成新 run）。 */
        let settledRunId = ''
        /** fork（corum）：失败子 Agent 的上下文（attempt 0 失败后提取，attempt 1 注入）。 */
        let failedChildContext: CorumFailedChildContext | undefined
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt === 0) {
            const llm = runtimeCtx.get('llm')
            if (llm !== undefined) {
              try {
                await preflightChildLlmRoute(
                  llm,
                  parentOptions,
                  request.agentOptions,
                  exec.signal,
                  providerRouteDefaults === undefined,
                )
              } catch (error: unknown) {
                // 配置的路由解析不了 ⇒ 判「模型不可用」并直接进「问用户」分支（不启死会话）。
                configuredFailure = error instanceof Error ? error.message : String(error)
                break
              }
            }
          }
          const run = await startRun()
          emitStarted(run)
          settledRunId = String(run.id)
          try {
            outcome = await settleForegroundRun(run)
            break
          } catch (error: unknown) {
            const reason = modelFailureOf(error)
            // 非模型失败（aborted / max-tokens / refusal）⇒ 原样抛出，本机制不管。
            if (reason === undefined) throw error
            if (attempt === 0) {
              // 第一轮就模型失败：**先问用户**，得到许可才重跑。
              if (configuredRoute === undefined) throw error
              const asked = await corumAskAboutModel(
                parent,
                args.label,
                effReadonlyResearch ? 'research' : 'worker',
                configuredRoute.configured,
                reason,
                exec.signal,
                args.notifyParent !== false,
              )
              if (asked.route === undefined) throw error
              // fork（corum）：提取失败子 Agent 的上下文，注入到重跑的 prompt 里——
              // 新子 Agent「接着做」而非「从头做」，避免重复调用工具。
              failedChildContext = await corumExtractFailedChildContext(ctx, settledRunId, exec.signal)
              if (failedChildContext !== undefined) {
                request.prompt = corumBuildResumePrompt(request.prompt, failedChildContext)
              }
              // 用主 Agent 路由重跑：清掉角色锁的 agentOptions（缺失时官方 seam 用父路由）。
              delete request.agentOptions
              continue
            }
            // 第二轮（用户已许可的重跑）仍模型失败 ⇒ 不再追问，原样抛出。
            throw error
          }
        }
        if (outcome === undefined) {
          if (configuredFailure !== undefined && configuredRoute !== undefined) {
            // spawn 期就解析不了：同样走「问用户」——用户许可才重跑（此时不启动死会话）。
            const asked = await corumAskAboutModel(
              parent,
              args.label,
              effReadonlyResearch ? 'research' : 'worker',
              configuredRoute.configured,
              configuredFailure,
              exec.signal,
              args.notifyParent !== false,
            )
            if (asked.route !== undefined) {
              delete request.agentOptions
              const run = await startRun()
              emitStarted(run)
              settledRunId = String(run.id)
              outcome = await settleForegroundRun(run)
            } else {
              // 用户没同意 ⇒ 如实报告「模型不可用」让主 Agent 接手（规则 2 的下半句）。
              throw new Error(
                `subagent (${args.label}): the configured child model `
                + `${configuredRoute.configured.provider}/${configuredRoute.configured.model} is unavailable `
                + `(${configuredFailure}) and no fallback was authorized`,
              )
            }
          }
        }
        if (outcome === undefined) {
          // 循环只有「成功 break」与「抛出」两种出口，故此处不可达；保留是为了让
          // `outcome` 在类型上收敛为非空（去掉它会退化成 `possibly undefined`）。
          throw new Error('subagent run produced no outcome')
        }
        // fork（corum）2026-09-18：这里**不再有**「已自动回退」的收尾——回退只在用户
        // 明确同意后发生，而「同意」这件事本身已在 `corumAskAboutModel` 里问过并通知过
        // （见该函数的 `corumNotifyModelDecision` 投递）。此处的成功路径只管汇报结果。
        // fork（corum）：前台子 Agent 的最终汇报注入父会话（2026-09-09 用户反馈
        // 「子 Agent 结束后反馈没有注入主 Agent」）。工具结果里本来就有汇报，但它埋在
        // 工具卡里、容易被忽略，且子会话卡片只显示进度与任务提示词——这里按后台子
        // Agent 的同款「settlement notice」形态再注入一条正式消息（form:'notice'，
        // 会话流里渲染成一条可见的注入行），汇报以一等消息出现。
        if (args.notifyParent !== false) {
          corumNotifyForegroundResult(parent, settledRunId, args.label, outcome, runtimeCtx.logger)
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
        // 2026-09-16 不变式⑤：凡**写**委派恒隔离（前台/后台/可继续一视同仁，无逃生口）；
        // 只读研究委派不隔离（它不落盘）。
        description: 'Every write-capable delegation runs in its own isolated git worktree + branch — there is no opt-out, so its edits reach your tree only through integration (`subagent { integrate: true }` or an `orchestrate` `merge` declaration). A read-only research delegation is not isolated (it writes nothing). The result tells you which of the two happened, so you never have to guess whether a branch carries the work. '
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
          // fork（corum）2026-09-20：主 Agent 动态注入的**叠加层**人格（用户定调「叠加，且
          // 不可覆盖机制层」）。子 Agent 的角色契约由机制按种类写死（执行者/调查员），本参数
          // 只补充**本次任务**的领域上下文与约定，拼在机制人格之后，无法删除或覆盖它。
          roleContext: {
            type: 'string' as const,
            description: 'OPTIONAL extra context for the child\'s role — domain expertise and conventions for THIS subtask (e.g. "this repo is a pnpm monorepo; the change must stay Node 18 compatible"), not a replacement for its role. The child already has a fixed role contract (executor or investigator) that you cannot override; whatever you write here is appended after it. Keep it short (a few sentences); it is truncated past 2000 characters.',
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
                   * fork（corum）：本次委派的隔离落点（**两档都出现**，见
                   * `corumIsolationBoundaryNotice`）：`worktree` = 改动在隔离分支上、
                   * 必须 `integrate: true` 才进主树；`skipped-non-git` = 没隔离，改动已在
                   * 父树里。⚠️ 本 schema 声明了 `additionalProperties: false`，故新增字段
                   * **必须**同步在这里，否则整个结果会被 INVALID_TOOL_OUTPUT 吞掉
                   * （本仓已付过这个学费，见 HANDOFF-2026-09-16 §教训）。
                   */
                  isolationBoundary: { type: 'string', enum: ['worktree', 'skipped-non-git'] },
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
              '• DECLARATIVE (`tasks`): a list of independent tasks you declare up front — each may carry `label`, `isolation`, `research`, `schema` (structured output) and `background`.',
              '• SCRIPTED (`script` + `meta` + `args`): you write a JavaScript orchestration script (top-level await; hooks `agent`, `parallel`, `pipeline`, `phase`, `log`; end with `return <json-value>`). Use this when the fan-out needs program logic — loops, conditionals, retries, aggregation in code, or per-item pipelines.',
              'ISOLATION: every write task is ISOLATED in its own git worktree + branch — declarative tasks and scripted children alike, foreground or background, with no opt-out. Isolated children branch off HEAD, and the mechanism commits the parent tree right before creating the worktree, so an isolated child always sees the parent\'s latest committed work. Read-only research tasks are not isolated (they write nothing).',
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
              tasks: {
                type: 'array',
                description: 'DECLARATIVE mode: the list of tasks to run (1 or more). Each task is an independent subagent delegation.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    prompt: { type: 'string', required: true, description: 'The complete, self-contained task for this subagent. It does not share this conversation, so include everything it needs.' },
                    label: { type: 'string', description: 'A short (3-5 word) label for display.' },
                    isolation: { type: 'string', enum: ['always', 'write-tasks'], description: 'Override isolation for this task. Every write task is isolated regardless (there is no opt-out); this only matters for a task whose tool face has no write ability, where `always` still forces a worktree. Defaults to the instance policy.' },
                    research: { type: 'boolean', description: 'Set true for a read-only research task (write tools denied, no worktree).' },
                    // fork（corum）2026-09-18：per-task `model` **已从 schema 剔除**。
                    //
                    // 用户策略（第 1/4 条）：「子 Agent 使用模型必须唯一，不给 LLM 候选列表；
                    // 用户设置了子 Agent 要路由到哪个模型就路由到那个模型」，且
                    // 「orchestrate 也不能豁免」。此前 `tasks[i].model` 是 LLM 可见参数
                    // （描述还写着 "mechanism lock"），实测主 Agent 可以据此把子 Agent
                    // 换到任意模型——这正是策略要禁的「让 LLM 决定子 Agent 模型」。
                    //
                    // 现在与 `subagent` 工具同款：模型面**物理不可表达**，路由只由
                    // 用户配置决定（预设锁 → 跟随主 Agent）。`subagent` 工具早在
                    // 1765 行就做了同样的事（"LLM 物理上无法表达模型偏好"），
                    // orchestrate 是当时漏掉的那一处。
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
                      // fork（corum）2026-09-16：**拒绝形态**——`'unmerged'`（分支没进 HEAD）与
                      // `'verify'`（进了 HEAD 但声明的验证没过）的现状与出路相反，调用方要能分辨。
                      // ⚠️ 本字段必须同时声明在 schema 里：输出校验是 `additionalProperties: false`，
                      // 少声明一个字段会让 harness 用 `INVALID_TOOL_OUTPUT` **顶替整个 payload**
                      // ——那会把 results + integration 一起吞掉，正是 Bug B 的反向形态
                      // （2026-09-16 实机复现抓到：只加了返回值、漏了 schema）。
                      rejected: { type: 'string', enum: ['unmerged', 'verify'] },
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
                  integration?: { pendingBranches: string[]; integrated: boolean; childSessionId?: string; error?: string; rejected?: 'unmerged' | 'verify'; report?: string }
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
                    ...(out.integration.rejected !== undefined ? { rejected: out.integration.rejected } : {}),
                    // fork（corum）2026-09-20：集成者报告正文（含「需要委派方注意的几点」）。
                    ...(out.integration.report !== undefined ? { report: out.integration.report } : {}),
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
              const runIntegrate = async (merge: { verify?: string } | undefined): Promise<{ pendingBranches: string[]; integrated: boolean; childSessionId?: string; report?: string }> => {
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
                //
                // fork（corum）2026-09-20：**同时带回集成者的报告正文**（用户实测报障）。
                //
                // 报障原话：「orchestrate 的结果只给了 integrated: true，没有 verify 输出……
                // 我希望机制上能够让最后合并者将合并结果、前面所有子 Agent 执行中提及需要注意的
                // 点都汇总后报告给主 Agent」。
                //
                // 实测（会话 corum-task-36e24826）：集成者**确实写了**一份 1864 字符的报告，
                // 含「分支落地确认」表 + 「需要委派方注意的几点」（构建产物在 `lib/` 不是 `dist/`、
                // 某分支内含 auto-commit 等）；而 `settleForegroundRun` 已把正文放在
                // `integrateOutcome.output` 交到手上，此处**只取了 runId 就把它丢了** ⇒ 主 Agent
                // 只看到 `integrated: true`，全部风险提示搁浅在子会话里，用户只能自己进去翻
                // （他正是这么说的：「我必须亲眼核对，不能凭子报告定论」）。
                //
                // 修法：原样透传（用户定调「直接透传集成者报告」——不另跑汇总者、不改集成者人格）。
                // 注意这里补的是**人能读懂的集成结论**；`verify` 的成败不走这条文本通路，
                // 它由机制真值门禁执行、失败直接抛错（见 corumIntegrationVerdict）。
                const integrateReport = corumOutputText(integrateOutcome.output)
                return {
                  pendingBranches: branches,
                  integrated: true,
                  childSessionId: String(integrateOutcome.runId),
                  ...integrateReport === '' ? {} : { report: integrateReport },
                }
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
                // 不变式⑤（2026-09-16）：script 模式**不再有 isolate:'off' 绕过口**。
                // 它此前能直接选 `corum-spawn`（不建 worktree）而不经过 `corumShouldIsolate`
                // ——是「凡写委派恒隔离」之外的一条独立逃逸路径。用户裁定「隔离恒定生效」⇒
                // 一律走 `corum-isolated`（脚本子 Agent 也是子 Agent，同样隔离 + 进台账）。
                // 注：脚本本身是只读的（纯逻辑编排），真正落盘的是它派出的子 Agent；这些
                // 现在全部隔离，收尾统一由 `merge` 声明或 `subagent { integrate: true }` 完成。
                const scriptProvider = 'corum-isolated'
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
                isolation?: 'always' | 'write-tasks'
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
                  // fork（corum）2026-09-18：**不再转达 task.model**——per-task 模型面
                  // 已按用户策略剔除（见 schema 处说明），子 Agent 路由只由用户配置决定。
                  // fork（corum）：并发感知隔离的两个入参——① 本次 fan-out 任务数
                  // （≥2 才需要 worktree）；② 不向父会话逐条注入 notice（结果由
                  // orchestrate 的汇总结果承载，避免 N 条重复通知）。
                  fanoutCount: tasks.length,
                  notifyParent: false,
                }, subagentProvider).then((outcome) => {
                  if (outcome.kind === 'foreground') {
                    // ⚠️ orchestrate 的 `parentTreeTasks` 语义是「**没**隔离、改动直接落在父树
                    // 的那几个任务」（它是异常档，用于提示父 Agent「这些改动已在你的树里」）。
                    // 2026-09-18 起 `isolationBoundary` 变成两档都填（`'worktree'` 也要报，
                    // 因为隔离的才需要 integrate）——故这里必须**显式排除 `'worktree'`**，
                    // 否则每个正常任务都会被误记成「父树任务」，该档位失去意义。
                    if (outcome.isolationBoundary !== undefined && outcome.isolationBoundary !== 'worktree') {
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
              let integration: { pendingBranches: string[]; integrated: boolean; childSessionId?: string; error?: string; rejected?: 'unmerged' | 'verify'; report?: string }
              try {
                integration = await runIntegrate(args.merge as { verify?: string } | undefined)
              } catch (integrateError: unknown) {
                // fork（corum）2026-09-16：拒绝形态由类型携带（`CorumIntegrateRejected`）——
                // 分支快照也随错误带出，因为抛出后 `entriesOf` 会按 git 实况对账：「合并提交已在
                // 主树」的条目下一次读台账就被翻成 integrated，调用方**再也还原不出**本次被拒的
                // 是哪几条（verify 失败正是这种形态，实测两者只差集成者选的 git 命令）。
                const rejected = integrateError instanceof CorumIntegrateRejected ? integrateError : undefined
                const pendingOnError = rejected !== undefined
                  ? [...rejected.pendingBranches]
                  : corumPendingIntegration(orchestration.entriesOf(parent.session.id)).map(entry => entry.branch)
                integration = {
                  pendingBranches: pendingOnError,
                  integrated: false,
                  error: integrateError instanceof Error ? integrateError.message : String(integrateError),
                  ...rejected !== undefined ? { rejected: rejected.kind } : {},
                }
              }
              // 通知形态必须与事实一致：`verify` 拒绝时那批分支**已经在主树里**，发
              // 「are NOT merged into the main tree」是谎报（会把主 Agent 引去重做合并）。
              // 两种形态都不可静默，只是各说各的真相。
              if (!integration.integrated) {
                if (integration.rejected === 'verify') {
                  corumNotifyVerifyRejected(parent, integration.error ?? 'the declared verification failed', runtimeCtx.logger)
                } else {
                  corumNotifyPendingIntegration(parent, integration.pendingBranches, runtimeCtx.logger)
                }
              }
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
      /**
       * fork（corum）2026-09-19：**「停止委派」不再注册 guard**（用户实测纠正）。
       *
       * 前一版把「停止委派」实现成会话级硬禁用：注册 `tools.guard`，此后该会话**任何**
       * subagent/orchestrate 调用都被拒绝，且没有解除入口。用户实测发现这不对——
       * 主 Agent 因此连「换个模型重新派」「用 subagent_research 去调研」都做不到，
       * 而且它在通知里读到「delegation is DISABLED for this session」，就把整个会话
       * 的委派当成永久关停，剩余工作全部自己写（连本该委派的活也自己干了）。
       *
       * 正确语义：这一档只是**本次失败不自动重试**（机制本来会在用户同意后重跑一轮，
       * 选它就跳过那一步，并把失败如实交回主 Agent）。**会话的委派能力不受影响**——
       * 主 Agent 之后主动要派就派。
       *
       * 于是这里不再有 guard，`delegationDisabledFor` 也不再被任何执行路径查询。
       */
      const disposeToolWithGuard = (): void => {
        disposeTool()
      }
      mounted = { subagentProvider, disposeTool: disposeToolWithGuard, disposeOrchestrate }
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
              '- EVERY write-capable delegation gets its OWN isolated git worktree + branch (the parent working tree is write-denied to that child), whether it runs in the foreground or the background, and whether or not another write child is running — there is no opt-out. Its edits reach your tree ONLY through integration: `orchestrate` with a `merge` declaration does it for you, or you do it explicitly with `subagent { integrate: true }`. Never assume a delegated write has landed — read the result, which states where the work is. Read-only research delegations are not isolated (they write nothing). Isolation needs a git repository: in a non-repo workspace it is skipped automatically (children work in the parent tree and leave version control to you) and the child is told so.',
              '- Isolation is a property of CHANGE, not of delegation: it exists so a child\'s edits land on their own branch and reach your tree through integrate. A delegation that only reads produces nothing to isolate, so route it to `subagent_research` — never call the write-capable `subagent` for a task that changes nothing.',
              '- Child model routing is NOT yours to choose: neither `subagent` nor `orchestrate` exposes any model parameter (a per-task `model` used to exist on `orchestrate` tasks and was deliberately removed). The child runs on the model the user configured for this Agent — or, when the user left it unset, on your own route. Never ask the user to pick a model; never try to route a child elsewhere. If a child fails because its configured model is unavailable, the MECHANISM — not you — asks the user what to do (temporarily switch this session to your model, permanently change the child model, or stop delegating) and then acts on that answer; you must not try to change any model or route yourself. Read the resulting notice: it tells you whether to re-issue the delegation or do the work yourself.',
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
