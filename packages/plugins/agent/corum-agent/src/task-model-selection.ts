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
import { VISION_CAPABILITY, VISION_SECTION } from './vision.ts'

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

/** `ctx.llm` 的最小能力面（按需取，避免加载顺序耦合）。 */
interface ModelInfoProbe {
  resolveModelInfo: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] }>
}

/**
 * 目标模型是否显式支持图片输入。
 *
 * **语义严格对齐官方**（`api-session-controller/commands.ts` 的准入校验）：
 * `inputModalities` 为 `undefined` 表示「未知」，**不当作不支持**——否则本地模型
 * 未声明模态时会被误判为纯文本，视觉提示词永远挂不上。只有显式声明且不含
 * `image` 才算不支持。查询失败同样返回 false（不注入，宁缺勿错）。
 * @param provider - 供应商路由 id。
 * @param model - 模型 id。
 * @returns 是否为已确认的视觉模型。
 */
async function supportsImageModel(ctx: Context, provider: string, model: string): Promise<boolean> {
  try {
    const llm = (ctx as unknown as { llm?: ModelInfoProbe }).llm
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return false
    const info = await llm.resolveModelInfo(provider, model)
    return info.inputModalities !== undefined && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

/**
 * 已安装监听的 disposer（**按 agentCtx 记账**，只作为 WeakMap 的键，不读它的成员）。
 *
 * ## 为什么必须有这张表（2026-09-21 实机缺陷）
 *
 * 一个 agentCtx 上重复安装会**各 append 一次** `system-prompt/assemble` 的结果：
 * cordis 是 waterfall，`await next()` 拿到的是**外层已完成**的装配，第二层再 append
 * 一次视觉能力段 ⇒ prompt 里同一段出现两遍。
 *
 * 实机现场（用户主实例会话 `corum-task-1b927cf3`）：建会话时按 `corum-dev` 装了一层，
 * 用户切 preset 到 `conductor-lead` 时走了 `selectTaskAgentProfileRemote` 的 fallback
 * 分支（进程重启后内存登记丢失）**又装一层** ⇒ 组装出的 system prompt 里
 * 「You can see images in this conversation…」逐字节重复两遍。
 *
 * 根因不是那一处 append，而是**本函数返回 disposer 却没有任何调用方接住它**
 * （4 个调用点全部丢弃）⇒ 重装 = 多留一层永不撤销的旧监听；旧 selection ref 的
 * `agent/request` 强制绑定也还活着。
 *
 * ⇒ 所有权收在这里：{@link installTaskModelSelection} 自己负责「重装即替换」。
 * 用 WeakMap 而不是在 Context 上挂字段：ctx 生命周期结束时表项自然回收，不留痕。
 */
const installedDisposers = new WeakMap<object, () => void>()

/**
 * 安装一个「用户显式选择优先」的模型绑定。
 *
 * **幂等**：同一个 `agentCtx` 再次安装会**先撤销上一次**（见 {@link installedDisposers}）。
 * 调用方不需要（也无法）自己接住 disposer。
 *
 * @param agentCtx - 目标 Agent 的作用域上下文。
 * @param selection - 调用方持有的可变选择（current/assembled）。
 * @returns 撤销本次安装的 disposer（已登记进 WeakMap，调用方丢弃也无妨）。
 */
export function installTaskModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void {
  // 重装前先撤销上一次：否则两个监听器都在，装配结果会被 append 两遍。
  installedDisposers.get(agentCtx)?.()
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
    // 视觉能力段：目标模型显式声明支持 image 输入时，把「你现在能收图」这一
    // 事实注入本次组装（模型本身不知道会话此刻绑的是哪个模型，部署默认是纯文本时
    // 尤其明显）。能力查询是异步且可能失败——失败即不注入，绝不影响组装。
    const vision = await supportsImageModel(agentCtx, selected.provider, selected.model)
    return {
      ...assembled,
      sections: vision
        ? [...assembled.sections, { name: VISION_SECTION, text: VISION_CAPABILITY }]
        : assembled.sections,
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
  const dispose = (): void => {
    disposeAssembly()
    disposeRequest()
  }
  installedDisposers.set(agentCtx, dispose)
  return dispose
}
