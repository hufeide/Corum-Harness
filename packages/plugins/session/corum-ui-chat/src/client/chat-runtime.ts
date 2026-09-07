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
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

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
  /** RPC connection 只读引用（子会话进度轮询的数据源；可能尚未挂载）。 */
  readonly connection: ConnectionHandle | undefined
  /** 跳子会话桥（替代 `__corumOpenSession`；官方 sessions.open 寻址，同步幂等）。 */
  openSession(id: string): void
}

/** 内部可变状态 + 监听器集（服务实现的私有后端）。 */
class ChatRuntimeImpl implements ChatRuntimeService {
  #sessionId: string | undefined
  #connection: ConnectionHandle | undefined
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

  openSession(id: string): void {
    this.#openSessionFn(id)
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
