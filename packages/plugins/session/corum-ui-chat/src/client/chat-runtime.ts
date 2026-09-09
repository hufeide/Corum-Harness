/**
 * fork（corum）：子 Agent 卡的「当前会话 id + RPC connection + 跳子会话桥」
 * 运行时服务（统一事件中心二期 window 全局迁移）。
 *
 * 原实现把这套动态值挂 window 全局（`__corumChatRuntime` / `__corumOpenSession`，
 * 见 apply.ts 旧版）——跨 bundle 共享可变状态挂 window 违反红线 1。本服务把它
 * 收敛为 cordis 服务 + uSES 源：
 *   - apply（激活期）`ctx.provide('chatRuntime', runtime)`——cordis 服务实例的
 *     唯一性由 root context `reflect.store` 保证，跨 bundle 天然单例
 *     （实证 .dbg/cordis-singleton-probe.md）。
 *   - 服务面：`sessionIdSnapshot()`（uSES getSnapshot 契约，稳定引用）+
 *     `onSessionIdChange(listener)`（uSES subscribe 契约）+ `connection`（只读
 *     引用）+ `openSession(id)`（替代 `__corumOpenSession`）。
 *   - SubagentCard（同 bundle 纯组件，无 inject 面）经下方模块级 `chatRuntimeRef`
 *     拿到服务实例——同 bundle 模块单例是合法的（不跨 bundle；cordis provide
 *     同时让其他 bundle 可 inject 本服务）。
 *
 * 时序（C1 教训）：cordis 模块顶层 = 加载期（apply 未跑），apply = 激活期。
 * 本服务的后端实例在 apply 才 new 出并写入 `chatRuntimeRef`——组件首次渲染晚于
 * 注册它的 slot 激活（apply 已跑），故渲染时 `chatRuntimeRef.current` 必然非空；
 * 防御性地保留「ref 未挂时返回 undefined」的窄化（与旧 window 全局未挂同语义）。
 *
 * 本文件保持 cordis-free（纯库纪律）：无任何 cordis import，Context 合并由
 * apply.ts 侧声明。
 *
 * 统一事件中心三-3：SubagentCard 的进度数据源从 2s 定时轮询迁移到
 * `ctx.remote.$on('corum/subagent/progress')` 推送（host corumAgent 在
 * `session/event` 追加点对 origin='subagent' 会话做 O(1) 增量折叠并 emit）。
 * 本服务的 remote 面引用 + 订阅登记（`subagentProgressSubscribe` 见下）即
 * 该推送通道进入本 bundle 的入口；订阅句柄记录活性供组件做降级判定。
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientRemote } from '@corum/corum-api-remotes/client'
import type { CorumWorktreeLedgerFrameEvent, SubagentChildEvent, SubagentProgressEvent } from '@corum/corum-api-remotes/corum-events'

/** uSES 源契约（getSnapshot 稳定引用 + subscribe）。 */
export interface SessionIdSource {
  getSnapshot: () => string | undefined
  subscribe: (listener: () => void) => () => void
}

/** chatRuntime 服务面（cordis 服务 + SubagentCard 消费面）。 */
export interface ChatRuntimeService {
  /** 当前会话 id 的 uSES 源（getSnapshot 稳定引用；值不变时返回同一引用）。 */
  sessionIdSnapshot(): SessionIdSource
  /** 订阅会话 id 变化（uSES subscribe 契约；返回退订函数）。 */
  onSessionIdChange(listener: () => void): () => void
  /** RPC connection 只读引用（子会话进度基线/兜底拉取的数据源；可能尚未挂载）。 */
  readonly connection: ConnectionHandle | undefined
  /** Remote 事件面只读引用（'corum/subagent/progress' 推送订阅入口）。 */
  readonly remote: ClientRemote | undefined
  /** 跳子会话桥（替代 `__corumOpenSession`；官方 sessions.open 寻址，同步幂等）。 */
  openSession(id: string): void
}

/** 内部可变状态 + 监听器集（服务实现的私有后端）。 */
class ChatRuntimeImpl implements ChatRuntimeService {
  #sessionId: string | undefined
  #connection: ConnectionHandle | undefined
  #remote: ClientRemote | undefined
  #openSessionFn: (id: string) => void = () => {}
  readonly #listeners = new Set<() => void>()
  /** uSES 源对象（稳定引用——getSnapshot/subscribe 闭包绑定本实例，值经 #sessionId 读）。 */
  readonly #source: SessionIdSource = {
    getSnapshot: () => this.#sessionId,
    subscribe: (fn) => this.onSessionIdChange(fn),
  }

  sessionIdSnapshot(): SessionIdSource {
    return this.#source
  }

  onSessionIdChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  get connection(): ConnectionHandle | undefined {
    return this.#connection
  }

  get remote(): ClientRemote | undefined {
    return this.#remote
  }

  openSession(id: string): void {
    this.#openSessionFn(id)
  }

  /** apply 挂载时注入 remote 事件面（'corum/subagent/progress' 订阅入口，幂等）。 */
  setRemote(remote: ClientRemote): void {
    this.#remote = remote
  }

  /** apply 挂载时更新当前会话 id + connection（view 挂载即调；id 变化才广播）。 */
  setSession(sessionId: string | undefined, connection: ConnectionHandle | undefined): void {
    this.#connection = connection
    if (sessionId === this.#sessionId) return
    this.#sessionId = sessionId
    for (const fn of this.#listeners) fn()
  }

  /** apply 挂载时注入跳子会话桥（幂等）。 */
  setOpenSession(fn: (id: string) => void): void {
    this.#openSessionFn = fn
  }
}

/**
 * 服务实例的同 bundle 模块级引用（SubagentCard 消费入口）。apply new 出实例后
 * 写入；同 bundle 模块单例是合法的（不跨 bundle）。cordis provide 让其他
 * bundle 可经 inject 拿同一实例。
 */
export const chatRuntimeRef: { current: ChatRuntimeImpl | null } = { current: null }

/** 创建服务实例（apply 调用；同时写入模块级 ref 供同 bundle 组件消费）。 */
export function createChatRuntime(): ChatRuntimeImpl {
  const impl = new ChatRuntimeImpl()
  chatRuntimeRef.current = impl
  return impl
}

// ── 子 Agent 进度推送（'corum/subagent/progress'）订阅登记 ──────────────────
//
// 单例 listener 集 + 懒挂底层 $on 订阅：SubagentCard 每张卡注册自己的帧监听，
// 首个订阅者挂载时才真正 `ctx.remote.$on`（remote 面由 apply 提前 setRemote
// 注入，组件挂载晚于 slot 激活，必然非空；防御性保留未挂判空），最后一个
// 退订时 dispose。帧计数经订阅句柄的 framesSeen() 暴露，供组件做「推送通道
// 活性」降级判定（宽限期内零帧 → 旧 host 不 emit → 回退 RPC 轮询）。

/** 订阅句柄：退订 + 活性读数（订阅存活期内全通道见过的推送帧数）。 */
export interface SubagentProgressSubscription {
  readonly unsubscribe: () => void
  readonly framesSeen: () => number
}

const subagentProgressListeners = new Set<(frame: SubagentProgressEvent) => void>()
let subagentProgressDispose: (() => void) | null = null
let subagentProgressFrames = 0

/**
 * 注册一个 'corum/subagent/progress' 帧监听（SubagentCard 每卡一个）。
 * @param listener - 帧回调（自行按 frame.sessionId 过滤本卡子会话）。
 * @returns 订阅句柄（退订 + 本订阅存活期内的推送帧计数）。
 */
export function subagentProgressSubscribe(
  listener: (frame: SubagentProgressEvent) => void,
): SubagentProgressSubscription {
  let framesAtStart = subagentProgressFrames
  subagentProgressListeners.add(listener)
  if (subagentProgressDispose === null) {
    const remote = chatRuntimeRef.current?.remote
    if (remote !== undefined) {
      subagentProgressDispose = remote.$on('corum/subagent/progress', (frame) => {
        subagentProgressFrames += 1
        for (const fn of subagentProgressListeners) fn(frame)
      })
    }
  }
  return {
    framesSeen: () => subagentProgressFrames - framesAtStart,
    unsubscribe: () => {
      subagentProgressListeners.delete(listener)
      framesAtStart = Number.POSITIVE_INFINITY // 退订后 framesSeen 不再误导降级判定。
      if (subagentProgressListeners.size === 0 && subagentProgressDispose !== null) {
        subagentProgressDispose()
        subagentProgressDispose = null
      }
    },
  }
}

// ── 'corum/worktree-ledger' 订阅（「并行工作区」chip 数据源；fork #10 发射）──
let worktreeLedgerDispose: (() => void) | null = null
const worktreeLedgerListeners = new Set<(frame: CorumWorktreeLedgerFrameEvent) => void>()

/** 注册一个 'corum/worktree-ledger' 帧监听（每 chip 一个；自行按 sessionId 过滤）。 */
export function worktreeLedgerSubscribe(
  listener: (frame: CorumWorktreeLedgerFrameEvent) => void,
): { unsubscribe: () => void } {
  worktreeLedgerListeners.add(listener)
  if (worktreeLedgerDispose === null) {
    const remote = chatRuntimeRef.current?.remote
    if (remote !== undefined) {
      worktreeLedgerDispose = remote.$on('corum/worktree-ledger', (frame) => {
        for (const fn of worktreeLedgerListeners) fn(frame)
      })
    }
  }
  return {
    unsubscribe: () => {
      worktreeLedgerListeners.delete(listener)
      if (worktreeLedgerListeners.size === 0 && worktreeLedgerDispose !== null) {
        worktreeLedgerDispose()
        worktreeLedgerDispose = null
      }
    },
  }
}

// ── 'corum/subagent/child' 订阅（卡片精确 childSessionId；fork #10 发射）──────
//
// 2026-09-09：卡片过去只能靠会话列表「时间就近」猜 childSessionId，运行期猜不
// 出来（父会话等工具结果 → 不产生事件 → 卡片不重算）→ goto 按钮恒 disabled、
// 进度帧也过滤不了。宿主在 spawn 那一刻按父侧 tool/call id 广播真实 id，卡片据
// 此在运行中即可跳转/订阅；历史回放仍走原有 summary 兜底匹配。
let subagentChildDispose: (() => void) | null = null
const subagentChildListeners = new Set<(frame: SubagentChildEvent) => void>()
/** callId → childSessionId 进程内缓存（本 bundle 单例；页面刷新后由 summary 兜底）。 */
const subagentChildByCall = new Map<string, string>()
/** 缓存上限（超限按插入序淘汰最旧——长会话里 delegation 可能很多，防无界增长）。 */
const SUBAGENT_CHILD_CACHE_MAX = 1000

/**
 * 已观测到的精确子会话 id（'corum/subagent/child' 广播过即命中）。
 *
 * 供卡片与 conversation fold 在同一进程内复用精确映射——fold 过去只能按时间
 * 就近猜，多子 Agent 并行时会串；精确值优先、猜值兜底。
 * @param callId - 父侧 tool/call id。
 * @returns 子会话 id，未广播过时 undefined。
 */
export function subagentChildOf(callId: string): string | undefined {
  return subagentChildByCall.get(callId)
}

/** 注册一个 'corum/subagent/child' 帧监听（每卡一个；自行按 callId 过滤）。 */
export function subagentChildSubscribe(
  listener: (frame: SubagentChildEvent) => void,
): { unsubscribe: () => void } {
  subagentChildListeners.add(listener)
  if (subagentChildDispose === null) {
    const remote = chatRuntimeRef.current?.remote
    if (remote !== undefined) {
      subagentChildDispose = remote.$on('corum/subagent/child', (frame) => {
        subagentChildByCall.set(frame.callId, frame.childSessionId)
        if (subagentChildByCall.size > SUBAGENT_CHILD_CACHE_MAX) {
          const oldest = subagentChildByCall.keys().next().value
          if (oldest !== undefined) subagentChildByCall.delete(oldest)
        }
        for (const fn of subagentChildListeners) fn(frame)
      })
    }
  }
  return {
    unsubscribe: () => {
      subagentChildListeners.delete(listener)
      if (subagentChildListeners.size === 0 && subagentChildDispose !== null) {
        subagentChildDispose()
        subagentChildDispose = null
      }
    },
  }
}

/**
 * apply 激活期提前建立订阅：即使卡片尚未挂载，spawn 广播也会进缓存——卡片挂载后
 * 经 {@link subagentChildOf} 立刻拿到精确 id（避免「广播早于订阅」的竞态）。
 * @returns 退订函数（挂到 ctx.effect 随插件生命周期释放）。
 */
export function primeSubagentChildCache(): () => void {
  return subagentChildSubscribe(() => {}).unsubscribe
}
