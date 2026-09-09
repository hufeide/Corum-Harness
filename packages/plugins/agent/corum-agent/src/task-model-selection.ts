/**
 * fork（corum）：task 会话的模型绑定安装——官方 `installModelSelection` 的
 * 「用户显式选择优先」变体。
 *
 * 背景（2026-09-09 用户实测，PROGRESS 第 57 轮）：corum 在 `createAgentForTask`
 * 的 setup 里就把自己的选择装进 Agent 作用域；官方 session-controller 的 ref
 * 直到首次 `session/prompt` 才装、且注册在**更内层**。cordis waterfall 里
 * 先注册的监听是外层（拿到 next() 的最终返回值后再覆盖），于是用户在 composer
 * 里换模型（`session/selectModel` 成功、事件也落了盘）会被外层 corum 选择静默
 * 盖回创建时的模型：用户选了 deepseek-official，实际请求仍打 localhost/kimi-k3-1。
 *
 * 本变体在覆盖前读会话的 `modelSelection` 投影：
 * - 投影里出现**与安装时不同**的 pending（用户显式选过模型）→ 从此一律让官方
 *   结果生效（用户的选择粘住，后续 request/header 落成 lastUsed 也继续生效）；
 * - 从未出现 → 维持原行为（corum profile 的固定模型 / 新建任务表单选的模型）。
 *
 * 与官方实现唯一的差别就是上面这段「让位」判定；装配（assemble 快照 + request
 * 应用）逐行一致。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/** 会话级模型选择投影里本文件用到的最小形状（官方 api-session-controller 注册）。 */
interface ModelSelectionProjectionLike {
  /** 尚未被请求消费的显式选择（用户刚选的模型）。 */
  pending?: ModelSelection | null
  /** 最近一次实际请求用的模型。 */
  lastUsed?: ModelSelection | null
}

/** `sessionProjections` 服务的最小能力面（避免耦合官方包的类型增强）。 */
interface ProjectionReader {
  stateOf: (session: Session, key: 'modelSelection') => unknown
}

/** 两个选择是否等价（provider/model/effort 三元组）。 */
function sameSelection(left: ModelSelection | null, right: ModelSelection): boolean {
  return left !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/**
 * 安装一个「用户显式选择优先」的模型绑定。
 * @param agentCtx - 目标 Agent 的作用域上下文。
 * @param selection - 调用方持有的可变选择（current/assembled）。
 * @returns 两个作用域监听的 disposer。
 */
export function installTaskModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void {
  // 投影服务是可选依赖：没有它（精简组合）就退化成官方行为。
  const projections = (): ProjectionReader | undefined => {
    const service = (agentCtx as unknown as { sessionProjections?: ProjectionReader }).sessionProjections
    return service === undefined || typeof service.stateOf !== 'function' ? undefined : service
  }
  const pendingSelection = (): ModelSelection | null => {
    const agent = agentCtx.agent
    const state = agent === undefined ? undefined : projections()?.stateOf(agent.session, 'modelSelection')
    if (state === undefined || state === null || typeof state !== 'object') return null
    const pending = (state as ModelSelectionProjectionLike).pending
    return pending === undefined || pending === null ? null : pending
  }
  /** 用户是否已经显式选过模型——一旦成立就永久让位（含后续 lastUsed 阶段）。 */
  let userTookOver = false
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on(
    'agent/request',
    async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const selected = selection.assembled
      if (selected === undefined) return resolved
      const pending = pendingSelection()
      if (pending !== null && !sameSelection(pending, selected)) userTookOver = true
      if (userTookOver) return resolved
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort },
      }
    },
  )
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}
