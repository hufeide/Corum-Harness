/**
 * 子 Agent 进度投影里的**纯判定**（corum fork 增量，2026-09-13 抽出）。
 *
 * 抽出的理由：这条判定此前长在 `agent-service.ts` 的 RPC 方法体里（读持久化事件的循环
 * + registry 查询 + 本进程启动时刻），没有任何单测能碰它——而 2026-09-12 那个把 8 张卡片
 * 全卡在 Running 的事故正出在这条路径上（`agents.list` 被当成可迭代属性用 → RPC 整体抛
 * `function is not iterable` → 渲染层的冷启动基线全废）。纯函数化之后，「什么时候算半途
 * 失去运行」有单测钉住，改坏了会红。
 */

/** 「半途失去运行」的判定输入。 */
export interface ChildRunInterruptInput {
  /** 事件窗口折出来的 turn 是否已闭合（`turn/end`）。 */
  readonly done: boolean
  /** `turn/end.reason.kind` 推出的权威终局原因（undefined = 没有）。 */
  readonly stopReason: string | undefined
  /**
   * registry 判定（**惰性**：只有真需要时才查，与旧实现一致——done/stopReason 已给定局时
   * 不必扫一遍 agents）。
   * true = 在跑 / false = 没在跑 / undefined = 问不到（没有 agents 服务）。
   */
  readonly agentRunning: () => boolean | undefined
  /** 最后一条事件的时间（ms epoch）。 */
  readonly lastActive: number
  /** 本进程启动时刻（ms epoch）。 */
  readonly bootAt: number
}

/**
 * 判定「半途失去运行」，返回判据（undefined = 不算中断）。
 *
 * 两个判据**取或**（缺一不可覆盖全部情况）：
 *   ① registry 说它没在跑——已 dispose 的一次性子会话，或 status=idle 的常驻子会话；
 *   ② 最后一条事件发生在本进程**启动之前**——那个未闭合的 turn 不可能还在本进程里跑。
 *      app 重启会把**常驻**子会话的半途 turn 留在 log 里（只有 turn/start、没有 turn/end），
 *      而常驻子会话不会被 dispose，故 ① 对它判不出来（2026-09-12 实测）。
 *
 * 不伪造 `stopReason`：既不是正常完成，也不是用户手动终止，UI 另有「已中断」文案。
 */
export function childRunInterruptOf(input: ChildRunInterruptInput): 'not-running' | 'pre-boot' | undefined {
  if (input.done) return undefined
  if (input.stopReason !== undefined) return undefined
  if (input.agentRunning() === false) return 'not-running'
  if (input.lastActive < input.bootAt) return 'pre-boot'
  return undefined
}
