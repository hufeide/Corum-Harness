/**
 * fork（corum）：**隔离版 in-process provider**——为「不是由 corum 工具层发起的委托」
 * （当前唯一消费者：`orchestrate` 的脚本模式，经官方 workflow 引擎）提供同一套隔离机制。
 *
 * 背景（2026-09-10 用户定调）：官方 `workflow` 的设计语义（模型写 JS 编排脚本、
 * 循环/条件/管道/结构化结果）被吸收进 `orchestrate` 的 script 模式，但引擎里的
 * `agent()` 由引擎直接调用 subagent provider，**不经过 corum 工具层**——于是脚本里的
 * 并发子 Agent 会同时改主工作区（用户实测痛点：主 Agent 不得不反复提醒子 Agent）。
 * 本 provider 把「工具层那份隔离」搬到 provider 层，让引擎子 Agent 也进 corum 台账：
 *
 *   ① `CorumOrchestration.createWorktreeChild()` 建 worktree + 分支 + 登记 active 条目；
 *   ② `request.cwd` 指向 worktree（fork #9 的 cwd 透传 → 子会话沙箱/shell/{{cwd}} 全跟随）；
 *   ③ prompt 前缀注入 `[corum isolation]` 纪律（与工具层同一文本，单一事实源）；
 *   ④ start 返回后 `bindRunId`，`subagent/end` 到达时由编排服务精确 settle；
 *   ⑤ start 抛错 → `discardEntry` 回滚（否则台账留下永不结算的 active 条目）。
 *
 * 三种 mode：
 * - `always`（默认）：每个子会话建 worktree（workflow 脚本的并发子 Agent）；
 * - `track`：**不建 worktree**，但把子会话登记进「在跑写子 Agent」计数并注入直连纪律
 *   （ralph——顺序执行、每轮必须看到上一轮的改动，不能隔离；但其它委托必须看得见它在写）；
 * - `off`：直通（只读脚本要看到父树未提交改动）。
 *
 * 只支持 one-shot 前台子会话（引擎的 `agent()` 就是一次性前台调用）；continuable
 * 创建直接 fail loud——静默降级会丢掉隔离保证。
 *
 * @module @corum/corum-subagent/isolated
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '../index.ts'
import { corumDirectWriteNotice, corumIsGitRepo, corumIsolationNotice } from '@corum/corum-orchestration'
import { startInProcessRun } from '../driver/index.ts'

export const name = 'corum-subagent-isolated-in-process'
export const inject = ['subagents']

/**
 * `always`（默认）= 每个子会话都建 worktree（并发脚本）；
 * `track` = 不建 worktree，但登记「在跑写子 Agent」计数 + 注入直连纪律（顺序迭代如 ralph）。
 *
 * `off` 已于 2026-09-16 **清除**（用户裁定「隔离恒定生效，off 语义应该被清除」）。
 * `track` **保留**：它不是逃生口，而是**独立模式**——顺序迭代（ralph）必须看到上一轮改动，
 * 语义与 plan 同级（用户原话：「迭代模式是一个单独模式，和 plan 一样，除非用户显式指定
 * 不然 LLM 不触发」）。
 */
export interface Config {
  /** Provider name on `ctx.subagents` (default `corum-isolated`). */
  providerName: string
  /** 见接口文档：`always` 建 worktree / `track` 顺序迭代不建（独立模式）。 */
  mode: 'always' | 'track'
  /** 并发上限（与工具层同口径，达到即抛错让脚本作者等待/先集成）。 */
  maxParallelChildren: number
  /** worktree 根目录（相对父 cwd 或绝对路径，默认 `.corum-worktrees`）。 */
  worktreeRoot?: string
  /** 分支名前缀（默认 `wt/`）。 */
  branchPrefix?: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('corum-isolated'),
  mode: z.union([z.const('always' as const), z.const('track' as const)]).default('always' as const),
  maxParallelChildren: z.natural().min(1).default(4),
  worktreeRoot: z.string(),
  branchPrefix: z.string(),
})

/**
 * `CorumOrchestration` 的最小能力面（红线 3：跨包类型用局部能力接口收窄，不耦合实现包）。
 * 由 `@corum/corum-orchestration` 在根上下文 provide。
 */
interface CorumOrchestrationFace {
  createWorktreeChild: (
    sessionId: string,
    parentCwd: string,
    options: { worktreeRoot?: string; branchPrefix?: string; maxParallelChildren?: number },
  ) => { slug: string; branch: string; path: string }
  bindRunId: (sessionId: string, slug: string, runId: string) => void
  discardEntry: (sessionId: string, slug: string) => void
  /** track 模式：登记/注销「在跑写子 Agent」（并发感知信号④）。 */
  beginWriteChild: (sessionId: string) => void
  endWriteChild: (sessionId: string) => void
}

/**
 * 解析本次委托**实际生效**的隔离模式（非 git 工作区自动降级）。
 *
 * 用户可以在「新建工作区」时关掉「始终初始化 git」——那时工作区没有仓库，`git worktree add`
 * 会直接报 `fatal: not a git repository`。isolated provider 的 `always` 因此必须按
 * {@link corumIsGitRepo} 降级为 `track`：子 Agent 照常在父工作区里干活（不建 worktree），
 * 但仍然登记「在跑写子 Agent」计数 + 注入直连纪律——git 依赖能力自动关闭，而不是让整次
 * 编排失败。
 * @param mode - provider 配置的模式。
 * @param parentCwd - 父会话工作目录。
 * @returns 实际生效的模式（`always` 在非 git 工作区降级为 `track`）。
 */
export function resolveEffectiveMode(
  mode: Config['mode'],
  parentCwd: string,
): Config['mode'] {
  if (mode === 'always' && !corumIsGitRepo(parentCwd)) return 'track'
  return mode
}

/** 一个已准备的隔离子会话：可直接交给 driver 的请求 + 绑定/回滚回调。 */
export interface PreparedIsolatedChild {
  /** 已带 `cwd` 与隔离通知的请求（交给 driver）。 */
  readonly request: ResolvedSubagentStartRequest
  /** start 成功后绑定 run id（settle 精确匹配的前置）。 */
  bind: (runId: string) => void
  /** start 失败后回滚台账条目 + worktree/分支。 */
  rollback: () => void
}

/**
 * 准备一个隔离子会话（provider 的可测内核）：建 worktree + 登记台账 + 注入隔离通知。
 * @param ctx - provider 所在上下文（取根上的 `corumOrchestration` 服务）。
 * @param request - 引擎给出的 start 请求（含父 Agent / prompt）。
 * @param config - provider 配置（并发上限/worktree 根/分支前缀）。
 * @returns 已准备好的请求与绑定/回滚回调。
 */
export function prepareIsolatedChild(
  ctx: Context,
  request: ResolvedSubagentStartRequest,
  config: Config,
): PreparedIsolatedChild {
  const orchestration = ctx.root.get('corumOrchestration', false) as CorumOrchestrationFace | undefined
  if (orchestration === undefined) {
    throw new Error('corum-isolated provider requires the corumOrchestration service; load @corum/corum-orchestration before this provider')
  }
  const sessionId = String(request.parent.session.id)
  const parentCwd = request.parent.session.header.cwd ?? process.cwd()
  const child = orchestration.createWorktreeChild(sessionId, parentCwd, {
    ...config.worktreeRoot !== undefined ? { worktreeRoot: config.worktreeRoot } : {},
    ...config.branchPrefix !== undefined ? { branchPrefix: config.branchPrefix } : {},
    maxParallelChildren: config.maxParallelChildren,
  })
  // ResolvedSubagentStartRequest 的字段是 readonly：按需生成可变副本再交给 driver。
  return {
    request: {
      ...request,
      cwd: child.path,
      prompt: [{ type: 'text', text: corumIsolationNotice(child) + promptText(request.prompt) }],
    },
    bind: (runId: string) => { orchestration.bindRunId(sessionId, child.slug, runId) },
    rollback: () => { orchestration.discardEntry(sessionId, child.slug) },
  }
}

/** 已登记的「直连写子会话」（track 模式）：请求 + 注销回调。 */
export interface PreparedTrackedChild {
  /** 已注入直连纪律的请求（不建 worktree）。 */
  readonly request: ResolvedSubagentStartRequest
  /** settle/失败后注销计数（幂等）。 */
  release: () => void
}

/**
 * 准备一个「不隔离但被计数」的子会话（ralph 这类顺序迭代的引擎子 Agent）。
 *
 * 为什么不隔离：ralph 每轮必须看到上一轮的改动（工作区是唯一长期记忆），worktree 会让
 * 下一轮读到旧基线。为什么必须计数：它正在主工作区里写，其它委托（前台 `subagent` 写）
 * 必须看得见「已有写者」而选择隔离——否则又回到并行改同一棵树。
 * @param ctx - provider 所在上下文（取根上的 `corumOrchestration` 服务）。
 * @param request - 引擎给出的 start 请求。
 * @returns 已注入直连纪律的请求 + 幂等注销回调。
 */
export function prepareTrackedChild(
  ctx: Context,
  request: ResolvedSubagentStartRequest,
): PreparedTrackedChild {
  const orchestration = ctx.root.get('corumOrchestration', false) as CorumOrchestrationFace | undefined
  if (orchestration === undefined) {
    throw new Error('corum-isolated provider requires the corumOrchestration service; load @corum/corum-orchestration before this provider')
  }
  const sessionId = String(request.parent.session.id)
  orchestration.beginWriteChild(sessionId)
  let released = false
  return {
    request: {
      ...request,
      prompt: [{ type: 'text', text: corumDirectWriteNotice() + promptText(request.prompt) }],
    },
    release: () => {
      if (released) return
      released = true
      orchestration.endWriteChild(sessionId)
    },
  }
}

/** 隔离版 provider：把每次 `agent()` 变成「worktree + 台账 + 通知」的 corum 子会话。 */
class IsolatedInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  // 引擎子会话不带父对话上下文（与 corum-spawn 一致；workflow 的 agent() 也是自包含简报）。
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly config: Config,
    private readonly ctx: Context,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd ?? process.cwd()
    // 非 git 工作区：always 降级为 track（见 resolveEffectiveMode）。
    const mode = resolveEffectiveMode(this.config.mode, parentCwd)
    if (mode !== this.config.mode) {
      this.ctx.logger.warn(`corum-isolated: workspace "${parentCwd}" is not a git repository; degrading isolation mode "${this.config.mode}" → "track"`)
    }
    // `off` 分支已于 2026-09-16 移除（隔离恒定生效）：只剩 always（建 worktree）与
    // track（顺序迭代的独立模式，不建 worktree 但登记计数）。
    if (mode === 'track') {
      const tracked = prepareTrackedChild(this.ctx, request)
      try {
        const run = await startInProcessRun(tracked.request, {})
        void run.result.then(tracked.release, tracked.release)
        return run
      } catch (error: unknown) {
        tracked.release()
        throw error
      }
    }
    const prepared = prepareIsolatedChild(this.ctx, request, this.config)
    try {
      const run = await startInProcessRun(prepared.request, {})
      prepared.bind(String(run.id))
      return run
    } catch (error: unknown) {
      prepared.rollback()
      throw error
    }
  }

  prepareContinuable(_request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    // 静默降级会丢掉隔离保证：continuable 路径在创建期无法建 worktree（cwd 由创建
    // 窗口决定、run id 未知），因此明确拒绝，让调用方改用 corum-spawn 或前台委托。
    return Promise.reject(new Error('corum-isolated provider supports one-shot foreground children only; use corum-spawn for continuable delegations'))
  }
}

/** 把既有 prompt 块拍平成文本（隔离通知只加在最前面，原文本保持原样）。 */
function promptText(prompt: ResolvedSubagentStartRequest['prompt']): string {
  return prompt.map(block => block.type === 'text' ? block.text : '').join('')
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new IsolatedInProcessProvider(config.providerName, config, ctx))
}
