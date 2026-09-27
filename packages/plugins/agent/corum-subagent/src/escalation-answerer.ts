/**
 * fork（corum）2026-09-26：**子 Agent 提权的机制应答器**——把「子 Agent 撞到沙箱墙」变成
 * 一条可判定的请求（策略见 `escalation-policy.ts`，判定与文案分离、各自可单测）。
 *
 * ## 为什么需要它（实测基线）
 *
 * 子会话的 `approvalPolicy` 此前被钉成 `never`，官方语义是「在到达任何应答者**之前**就
 * 确定性 rejected」⇒ 子 Agent 撞墙时**既拿不到权限、也无人知晓**。实测（会话 `bca632cd-…`）：
 * 4 次沙箱拒绝、**0 次提权尝试**、**0 条审批事件**，子 Agent 自述「本会话已禁用审批提示，
 * 我无法从内部申请提权」。
 *
 * ## 本模块做三件事
 *
 * 1. **读回请求**：从**子会话自己的日志**里按 `callId` 找到本次 `tool/call`，解析
 *    `arguments.sandbox_permissions`（结构化取值，**不解析 prose**）。任何一步失败 ⇒ 当作
 *    「不是提权」或朝关闭倒，绝不 fail-open。
 * 2. **判定**：`decideEscalation`（`X ≤ P` 自动批准 / 越硬天花板直接拒 / 否则上呈用户）。
 * 3. **上呈**：`X > P` 时**以父 Agent 为 scope 载体**再发一次官方审批请求 —— 这样它才会
 *    出现在**主会话**的审批卡上（见下）。
 *
 * ## 为什么必须「以父 Agent 为载体」重发，而不是转发子会话的原始 ask
 *
 * 官方 `ApprovalService.decide()` 用 `scopeTarget(req.agent, req.agent)` 派发，即
 * **载体 = 提问的 Agent（这里是子 Agent）**；`corum-api-remotes` 的转发器按
 * `carrierKeyOf(this)` 取载体并转发到 renderer，而审批面板又是**按会话分片**的
 * （`scope: 'session'`，面板在 `conversation.composer` 里，按 `ctx.sessions.scopeOf(owner)`
 * 决定渲染在哪个会话）。子会话在 UI 里通常根本没打开 ⇒ 子会话的 ask **两道都会被静默丢掉**
 * （转发器取不到可用载体时直接 `next()`；即便转发了也落在没打开的会话上），**没有任何报错**。
 *
 * 所以 `X > P` 时本模块**以父 Agent 重发请求**：载体变成父 ⇒ 转发到主会话 ⇒ 落在用户
 * 正在看的那张审批卡上。这正是用户 9-14 说的「**子 Agent 请求 → 主 Agent 转交用户**」的
 * 机制实现（`corum/model-ask` 用同一手法解决同一类问题）。
 *
 * ## 注册顺序（`prepend`）
 *
 * 必须**抢在转发器之前**认领：否则子会话的 ask 会先被转发到 renderer，而渲染点不可达 ⇒
 * 请求悬在那里直到 signal 中止。`prepend: true` 保证本应答器先跑并直接给出结果。
 * 对**非提权**的 ask 也直接回 `rejected`：那正是子会话在 `never` 策略下的既有语义
 * （「delegated child 的 ask 一律被拒」），换成 `ask` 策略后必须由本模块**原样保住**，
 * 否则等于顺手给子会话开了别的口子。
 *
 * @module @corum/corum-subagent/escalation-answerer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
// fork（corum）2026-09-26：corum 自有 waterfall 询问要**以父 Agent 为载体**（scopeTarget），
// 与 `corum/model-ask` 同款 —— 子会话载体到不了用户面前。
import { scopeTarget } from '@deepseek-ai/dsh-scope'
// fork（corum）2026-09-27：主仓目标的提权一律 refuse —— 复用隔离门禁的**同一个**判定
// （单一事实源；`confinementGuard` 与本题权应答器因此不会各自漂移）。
import { confinementViolation, type ConfinementScope } from '@corum/corum-orchestration'
import {
  applySessionGrant,
  decideEscalation,
  isEscalationTarget,
  type EscalationVerdict,
} from './escalation-policy.ts'

/** 官方审批结果词汇表（封闭；未知值会被官方归一为 fail-closed）。 */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * 上呈用户时的**最长等待**（与 `corum-tool-subagent` 的 `CORUM_ASK_TIMEOUT_MS` 同为 5 分钟，
 * 口径一致：机制级询问一律有界，绝不无限期挂住一轮）。
 *
 * 为什么必须有界：`approval.request()` 会一直等应答者。若该部署**没有**可应答的 UI
 * （renderer 未连、面板未挂、用户离开），没有超时的话子 Agent 的这次工具调用会**永久挂住**
 * 父轮 —— 而父轮是用户看得见的工作流，挂住比「被拒」糟得多。超时后官方回 `'cancelled'`，
 * 本模块映射成 `rejected`（朝关闭倒），子 Agent 得到明确结论并按提示词如实上报。
 */
const ESCALATION_ASK_TIMEOUT_MS = 5 * 60 * 1000

/** `approval` 服务的最小能力面（按需取，避免与官方包类型耦合；红线 3）。 */
interface ApprovalFace {
  request: (request: {
    readonly agent: Agent
    readonly toolName: string
    readonly reason?: string
    readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
    readonly signal?: AbortSignal
  }) => Promise<ApprovalOutcome>
}

/** `sandboxPolicy` 服务的最小能力面。 */
interface SandboxPolicyFace {
  resolve: (request: { readonly session: unknown }) => { readonly mode: SandboxMode }
}

/** 一条从日志里读回的提权请求。 */
export interface ReadEscalationRequest {
  /** 请求的目标档位（已校验在封闭词汇表内）。 */
  readonly mode: SandboxMode
  /** 模型给的理由（可缺省；仅用于呈现）。 */
  readonly justification?: string
}

/**
 * 从**子会话自己的事件流**里读回一次提权请求（纯函数，可单测）。
 *
 * 取值口径与 `corum-tool-subagent` 读 `todo_write` 参数同款（`JSON.parse(arguments)`），
 * 但**判定更严**：必须命中同 `callId` 的事件，且 `sandbox_permissions` 必须落在官方封闭的
 * 提权目标词汇表内（`isEscalationTarget`）。任何一步不成立都返回 `undefined`。
 *
 * 为什么不能「事件存在即视为提权」：`appendSkippedToolCall` 也会写 `tool/call`（被中止、
 * 未真正派发的调用同样是 `tool/call`），所以事件存在 ≠ 这次真的在请求提权 —— 必须以
 * **参数内容**为准。
 *
 * @param events - 子会话的事件流（`session.snapshotEvents()`）。
 * @param callId - 本次审批请求关联的工具调用 id（`ApprovalRequest.callId`）。
 * @returns 读回的提权请求；不是提权（或读不出来）时 `undefined`。
 */
export function readEscalationRequest(
  events: readonly { readonly type: string; readonly data?: unknown }[],
  callId: string | undefined,
): ReadEscalationRequest | undefined {
  const call = readToolCall(events, callId)
  if (call === undefined) return undefined
  const target = call.arguments['sandbox_permissions']
  if (!isEscalationTarget(target)) return undefined
  const justification = call.arguments['justification']
  return {
    mode: target,
    ...(typeof justification === 'string' && justification !== ''
      ? { justification }
      : {}),
  }
}

/**
 * fork（corum）2026-09-27：按 `callId` 读回**原始工具调用面**（工具名 + 参数对象）。
 *
 * 提权判定需要两样东西，都从这一处取（单一解析点）：`sandbox_permissions`（= 提权目标，
 * 见 {@link readEscalationRequest}）与**完整调用面**（= 判断这次提权是否打在主仓上，见
 * `adjudicateEscalation` 里对 `confinementViolation` 的复用）。
 *
 * `name` 缺省时按 `'bash'` 处理：只有 `bash`/`pwsh` 才可能带 `sandbox_permissions`，而
 * 既有代码在文案层也是这么兜的（`request.toolName ?? 'bash'`），保持一致。
 *
 * @param events - 子会话的事件流（`session.snapshotEvents()`）。
 * @param callId - 本次审批请求关联的工具调用 id。
 * @returns 解析后的调用面；读不出（无此 id / 非法 JSON / 非对象）时 `undefined`。
 */
export function readToolCall(
  events: readonly { readonly type: string; readonly data?: unknown }[],
  callId: string | undefined,
): { readonly name: string; readonly arguments: Record<string, unknown> } | undefined {
  if (callId === undefined || callId === '') return undefined
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown } | undefined
    if (data === undefined) continue
    // callId 两侧都转字符串比较：事件里是 ToolCallId（字符串品牌类型），审批请求里亦然，
    // 但品牌类型不可直接跨包比较，转成字符串是最稳的口径。
    if (String(data.callId ?? '') !== String(callId)) continue
    if (typeof data.arguments !== 'string') return undefined
    try {
      const parsed = JSON.parse(data.arguments) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      return {
        name: typeof data.name === 'string' && data.name !== '' ? data.name : 'bash',
        arguments: parsed as Record<string, unknown>,
      }
    } catch {
      // 参数不是合法 JSON ⇒ 读不出请求 ⇒ 朝关闭倒（调用方按「不是提权」处理）。
      return undefined
    }
  }
  return undefined
}

/** 上呈用户时的呈现文案（host 是文案的唯一事实源）。 */export function escalationAskCopy(mode: SandboxMode, justification: string | undefined): {
  reason: string
  displayReason: { en: string; zh: string }
} {
  const why = justification === undefined || justification === '' ? 'no reason given' : justification
  return {
    reason: `subagent requests sandbox escalation to ${mode}: ${why}`,
    displayReason: {
      en: `A delegated subagent asks to run ONE command with wider permissions (${mode}): ${why}`,
      zh: `委派的子 Agent 请求用更宽的权限（${mode}）执行一条命令：${why}`,
    },
  }
}

/** 应答器的依赖面（由 `applyChildComposition` 传入，便于单测直接驱动判定）。 */
export interface EscalationAnswererDeps {
  /** 父（委派方）Agent：既是 `P` 的来源，也是上呈时的 scope 载体。 */
  readonly parent: Agent
  /** 本子 Agent 的**硬天花板**（隔离 / 只读研究，见 `hardCeilingFor`）。 */
  readonly hardCeiling: SandboxMode
  /**
   * fork（corum）2026-09-27：**隔离作用域**（只有 `confined` 子 Agent 才传）。
   *
   * 给了它 ⇒ 打在当前仓库（主仓）上的提权请求一律 `refuse`（连卡都不出，会话级授权也
   * 豁免不了）。未给（集成者 / 主树子 Agent / 只读研究）⇒ 不做这道判定、行为与改动前
   * 完全一致——用户 2026-09-27 裁定：这条硬线**只约束隔离子 Agent**，主 Agent 与派到
   * main 上工作的 Agent（集成者）保留完整的 bash 与合并能力。
   */
  readonly confinement?: ConfinementScope | undefined
  /** 告警出口。 */
  readonly logger: { warn: (message: string) => void }
}

/**
 * 对一次 ask 作出机制决定（纯判定，无副作用；抽出来便于单测直接覆盖三分支）。
 *
 * @param deps - 依赖面（父 Agent / 硬天花板 / 日志）。
 * @param childEvents - 子会话事件流。
 * @param callId - 审批请求关联的工具调用 id。
 * @returns 判定结果；`undefined` = 这次 ask **不是提权**（调用方应回落到既有语义）。
 */
export function adjudicateEscalation(
  deps: EscalationAnswererDeps,
  childEvents: readonly { readonly type: string; readonly data?: unknown }[],
  callId: string | undefined,
): { request: ReadEscalationRequest; verdict: EscalationVerdict } | undefined {
  const request = readEscalationRequest(childEvents, callId)
  if (request === undefined) return undefined
  // fork（corum）2026-09-27：**主仓目标不可提权**（用户裁定：「子 Agent 不能操作除自己
  // worktree 之外的其它分支（可读）」，且这一类越界无法提权获得）。
  //
  // 必须放在**一切之前**，三个理由：
  //  · 早于 `P` 的读取——读不到父档位时既有逻辑会「上呈用户」，而这里根本不该问；
  //  · 早于会话级授权——「总是允许」只把 `ask-user` 升成放行，`refuse` 永不被豁免；
  //  · 复用门禁的同一个判定函数（`confinementViolation`，单一事实源）：`parent-tree`
  //    就是「打在当前仓库上」。于是「沙箱层可提权」这条不再对这堵墙生效。
  //
  // 依据（2026-09-27 会话 corum-task-56b7d485，01:11:30）：隔离子会话用
  // `git worktree remove --force …` + `git branch -D …`（**命令里没有绝对路径**）拿到
  // 一次「允许一次」后，真的删掉了主仓的 worktree 与分支。
  if (deps.confinement !== undefined) {
    const call = readToolCall(childEvents, callId)
    const violation = call === undefined ? undefined : confinementViolation(deps.confinement, call)
    if (violation?.kind === 'parent-tree') {
      return { request, verdict: { kind: 'refuse', reason: 'parent-tree' } }
    }
  }
  // `P` = 父 Agent **当前生效**档位。刻意不传 `mode`（传了会用「本次调用的显式档位」顶替
  // 会话策略，见官方 resolve() 的 `request.mode ?? overrideOf(session) ?? defaultMode`）。
  const parentMode = (deps.parent.ctx as unknown as { get: (name: string) => unknown })
    .get('sandboxPolicy') as SandboxPolicyFace | undefined
  if (parentMode === undefined || typeof parentMode.resolve !== 'function') {
    // 读不到 P ⇒ 无法判定上限 ⇒ **不猜**：交给上层（上呈用户），绝不放行。
    return { request, verdict: { kind: 'ask-user', reason: 'exceeds-parent-mode' } }
  }
  let resolved: SandboxMode
  try {
    resolved = parentMode.resolve({ session: deps.parent.session }).mode
  } catch (error: unknown) {
    deps.logger.warn(`subagent escalation: cannot resolve the parent sandbox mode (${String(error)}); escalating instead of granting`)
    return { request, verdict: { kind: 'ask-user', reason: 'exceeds-parent-mode' } }
  }
  return {
    request,
    verdict: decideEscalation({ requested: request.mode, parentMode: resolved, hardCeiling: deps.hardCeiling }),
  }
}

/** corum 自有询问通路 `corum/escalation/ask` 的回答（三档；第 3 档「自动」按用户裁定预留）。 */
type CorumEscalationAnswer = { readonly kind: 'allowed-once' | 'always-allow' | 'rejected' }

/**
 * 跨包调用 **corum 自有 waterfall** 所需的最小能力面（红线 3：不 import 声明方那个包，
 * 只用窄接口 —— corum-subagent 与 corum-api-remotes 的类型面本就不必互相耦合）。
 */
interface CorumAskFace {
  waterfall: (
    scope: unknown,
    event: string,
    data: unknown,
    next: () => Promise<CorumEscalationAnswer>,
  ) => Promise<CorumEscalationAnswer>
}

/**
 * 以**父 Agent 为载体**发起 corum 自有 waterfall 询问，并施加**有界等待**。
 *
 * ## 为什么是 corum 自有通路（而不是直接再发一次官方 `approval/request`）
 *
 * 官方审批 outcome 词汇表封闭（`allowed-once | rejected | cancelled | unavailable`），且归一化
 * 发生在 `ApprovalService.request()` **内部**（`user-approval/src/index.ts:288`）⇒ 三档里的
 * 「总是允许」**传不过去**（会被归一成 `unavailable`）。corum 自有 waterfall 的返回值**不**经过
 * 那层归一化，故只有它能携带自己的答案词汇表。先例：`corum/model-ask/request`。
 *
 * ## 有界等待
 *
 * `Promise.race` 一个超时（见 {@link ESCALATION_ASK_TIMEOUT_MS}）：客户端装了监听器但用户一直
 * 不答时，不得**永久挂住父轮**；超时按 `rejected` 收口（朝关闭倒）。
 *
 * ## 无人应答时**不**在这里兜底
 *
 * `next` 由调用方传入（它退回官方审批卡）。老渲染 / 未装 UI 插件时 waterfall 会立刻走 `next`
 * ⇒ 行为与改动前完全一致，**没有回归窗口**。
 *
 * @param deps - 应答器依赖面（`parent` 既是载体也是授权主体）。
 * @param escalation - 已读回的提权请求。
 * @param request - 原始审批请求（取 `signal` 与工具名）。
 * @param fallback - 无人应答时退回的官方通路（带 signal）。
 * @returns 三档答案。
 */
async function askCorumEscalation(
  deps: EscalationAnswererDeps,
  escalation: ReadEscalationRequest,
  request: { readonly toolName?: string, readonly signal?: AbortSignal },
  fallback: (signal: AbortSignal) => Promise<CorumEscalationAnswer>,
): Promise<CorumEscalationAnswer> {
  const timeout = AbortSignal.timeout(ESCALATION_ASK_TIMEOUT_MS)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  // ⚠️ 必须在**根（未 scoped）**上下文上派发：scoped 派发会把**发起者自己的 scope 过滤器**
  // 一并合成进载体（见 `corum-subagent/src/index.ts` 里 `createLifecycleEmitter` 的注释
  // 「whose own context filter composes into the carrier」）。若用 `parent.ctx` 派发，过滤器
  // 会窄于转发器所监听的 scope ⇒ 事件**不会**被转发到 renderer ⇒ 客户端永远收不到、
  // 静默走 `next` 退回官方两档卡（2026-09-26 实机就是这样：卡出现了，但只有「允许一次/拒绝」）。
  // 载体仍用 `scopeTarget(parent, parent)` 指定，与 `corum/model-ask` 同款（它用的也是 runtime 根 ctx）。
  const root = (deps.parent.ctx as unknown as { root?: unknown }).root ?? deps.parent.ctx
  const face = (root as { waterfall?: CorumAskFace['waterfall'] }).waterfall
  if (typeof face !== 'function') {
    // 事件总线永远可用，理论上到这里不可达；真到了就退回官方通路（保守，而不是静默拒绝）。
    deps.logger.warn('subagent escalation: no waterfall on the root context; falling back to the approval card')
    return await fallback(signal)
  }
  const ask = face.call(
    root,
    scopeTarget(deps.parent, deps.parent),
    'corum/escalation/ask',
    {
      agent: deps.parent,
      sessionId: String(deps.parent.session.id),
      mode: escalation.mode,
      ...(escalation.justification === undefined ? {} : { justification: escalation.justification }),
    },
    async () => await fallback(signal),
  )
  const expired = new Promise<CorumEscalationAnswer>(resolve => {
    signal.addEventListener('abort', () => resolve({ kind: 'rejected' }), { once: true })
  })
  return await Promise.race([ask, expired])
}

/**
 * 记一条**会话级**提权授权（三档第 2 档）。经窄接口取用 `subagents` 服务（红线 3/1）。
 *
 * 失败只告警：授权没记上**只影响「下次还问不问」**，本次已经放行，不该因此回滚。
 *
 * @param deps - 应答器依赖面。
 */
function grantEscalationForSession(deps: EscalationAnswererDeps): void {
  const face = (deps.parent.ctx as unknown as { get: (name: string) => unknown })
    .get('subagents') as { grantEscalation?: (sessionId: string) => void } | undefined
  try {
    face?.grantEscalation?.(String(deps.parent.session.id))
  } catch (error: unknown) {
    deps.logger.warn(`subagent escalation: could not record the session grant (${String(error)})`)
  }
}

/**
 * 该 ask 所属的**父会话**是否已被用户授权「后续同类提权免问」（三档第 2 档「总是允许」）。 *
 * 取用方式是**窄接口**（红线 3）：只声明 `isEscalationGranted` 这一小块，不耦合
 * `SubagentRuntime` 的其余能力，也不 import 它所在的包（跨 bundle 类型面本就不一致）。
 *
 * **fail-closed**：服务缺失（精简装配 / 未来改动）或方法不存在一律返回 `false`
 * ⇒ 退回「照常问用户」，绝不会因为读不到授权而**擅自放行**。
 *
 * @param deps - 应答器依赖面（需要 `parent` 以定位父会话与其 ctx）。
 * @returns 已授权为 `true`；任何不确定情形均为 `false`。
 */
function isSessionGranted(deps: EscalationAnswererDeps): boolean {
  const face = (deps.parent.ctx as unknown as { get: (name: string) => unknown })
    .get('subagents') as { isEscalationGranted?: (sessionId: string) => boolean } | undefined
  if (face === undefined || typeof face.isEscalationGranted !== 'function') return false
  try {
    return face.isEscalationGranted(String(deps.parent.session.id)) === true
  } catch (error: unknown) {
    deps.logger.warn(`subagent escalation: cannot read the session grant (${String(error)}); asking the user instead`)
    return false
  }
}

/**
 * 在子 scope 上安装提权应答器。
 *
 * 安装前提：官方 `approval` 服务可用（否则子会话的 `ask` 策略没有应答者，会落到
 * fail-closed 的 `unavailable`，与旧的 `never` 等效但报错文案不同 —— 那种部署下不安装、
 * 也不改子会话策略，保持现状）。
 *
 * @param childCtx - 子 Agent 自己的 scope（应答器只作用于这个子会话）。
 * @param deps - 依赖面（见 {@link EscalationAnswererDeps}）。
 * @returns 是否真的安装了（未安装时调用方**不得**把子会话策略改成 `ask`）。
 */
export function installEscalationAnswerer(childCtx: Context, deps: EscalationAnswererDeps): boolean {
  const approval = (deps.parent.ctx as unknown as { get: (name: string) => unknown })
    .get('approval') as ApprovalFace | undefined
  if (approval === undefined || typeof approval.request !== 'function') return false
  const child = childCtx.agent as Agent | undefined
  childCtx.on('approval/request' as never, (async (
    request: { readonly agent?: Agent, readonly toolName?: string, readonly callId?: string, readonly signal?: AbortSignal },
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    // 只认领本子会话的 ask（scope 过滤已保证，这里再核一次身份，防串台）。
    if (child !== undefined && request.agent !== undefined && request.agent !== child) return next()
    const events = (child?.session as unknown as { snapshotEvents?: () => readonly { type: string, data?: unknown }[] })
      ?.snapshotEvents?.() ?? []
    const adjudicated = adjudicateEscalation(deps, events, request.callId)
    // 不是提权 ⇒ 保住旧语义（子会话的 ask 一律被拒），**不放行**。
    if (adjudicated === undefined) return 'rejected'
    const { request: escalation, verdict } = adjudicated
    // 三档第 2 档「总是允许」：只把 `ask-user` 升级为放行，**绝不**改变 `refuse`
    // （硬天花板不被授权豁免）—— 这条不变式被钉在纯函数 `applySessionGrant` 上并有单测。
    const effective = applySessionGrant(verdict, isSessionGranted(deps))
    if (effective.kind === 'auto-approve') {
      deps.logger.warn(
        verdict.kind === 'ask-user'
          ? `subagent escalation: auto-approved ${escalation.mode} (session-wide grant)`
          : `subagent escalation: auto-approved ${escalation.mode} (within the parent's own mode)`,
      )
      return 'allowed-once'
    }
    if (effective.kind === 'refuse') {
      // 硬天花板（只读研究）：连问都不问。理由由提示词层解释。
      deps.logger.warn(`subagent escalation: refused ${escalation.mode} (exceeds the hard ceiling ${deps.hardCeiling})`)
      return 'rejected'
    }
    // `X > P` 且未被授权：**以父 Agent 为载体**上呈用户（见模块头注：子会话载体到不了用户面前）。
    //
    // 两级通路（2026-09-26 定案）：
    //   ① 先走 **corum 自有 waterfall** `corum/escalation/ask` —— 只有它能携带三档词汇表
    //      （官方 `approval/request` 的 outcome 在 `ApprovalService.request()` **内部**就被
    //      归一化成 4 个词，见 `user-approval/src/index.ts:288`）；
    //   ② 该 waterfall 的 `next`（**无人应答**时）退回**现有官方审批卡** —— 于是老渲染 /
    //      没装 UI 插件的部署行为与本次改动前**完全一致**，不存在「换了通路反而批不了」的窗口。
    try {
      const asked = await askCorumEscalation(deps, escalation, request, async signal => {
        const copy = escalationAskCopy(escalation.mode, escalation.justification)
        const outcome = await approval.request({
          agent: deps.parent,
          toolName: request.toolName ?? 'bash',
          reason: copy.reason,
          displayReason: copy.displayReason,
          signal,
        })
        return outcome === 'allowed-once' ? { kind: 'allowed-once' as const } : { kind: 'rejected' as const }
      })
      if (asked.kind === 'always-allow') {
        // 三档第 2 档：本次**照放行**，并记一条**会话级**授权 ⇒ 该父会话后续同类提权免问。
        // 授权只豁免「上呈用户」这一步；硬天花板早在上面 `refuse` 分支就拦掉了，永不豁免。
        grantEscalationForSession(deps)
        deps.logger.warn(`subagent escalation: allowed-once + session-wide grant recorded for ${escalation.mode}`)
        return 'allowed-once'
      }
      return asked.kind === 'allowed-once' ? 'allowed-once' : 'rejected'
    } catch (error: unknown) {
      // 父会话没有 open turn（例如后台子 Agent 跑完父轮已结束）⇒ 任何失败都朝关闭倒。
      deps.logger.warn(`subagent escalation: cannot ask the user (${String(error)}); treating as rejected`)
      return 'rejected'
    }
  }) as never, { prepend: true } as never)
  return true
}
