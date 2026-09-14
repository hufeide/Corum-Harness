// fork（corum）：Review 卡的数据形状。
//
// 2026-09-11 重构后本文件**只保留类型**：真正的数据源是 host 的影子 git 仓库
// （`corumReview` RPC，见 packages/desktop/src/host/corum-review.ts）。
//
// 被删掉的历史实现（以及为什么）：
//   - `parseWriteToolArgs` / `writeLineDelta` / `aggregateReviewChanges`：从会话事件流
//     的 tool/call 入参反推改动。三个绕不过去的缺陷：整文件覆盖（`write`）的旧内容
//     不可知；反推要求唯一匹配、会随外部改动漂移；增删行数只能靠「逐次 edit 的片段
//     行数差之和」近似 —— 实测 `package.json` 累加出 `+1 −1`，但那一行是「加了又被
//     删掉」，净变化为 0，用户点进去看不到任何改动（BUG-9）。
//   - 三级水位（全局 / 单文件 / 轮次自动保留）：git 的轮次提交边界天然表达「未审核
//     默认保留」，不再需要 localStorage 水位。

/** 一次文件写操作的类型（保留给需要逐条 op 的消费方；git 数据源下为空数组）。 */
export interface ReviewWriteOp {
  readonly callId: string
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly added: number
  readonly removed: number
}

/** Review 卡里一个文件的聚合视图。 */
export interface ReviewFileChange {
  readonly path: string
  readonly added: number
  readonly removed: number
  /** 逐条写操作；git 数据源不提供（恒为空数组）。 */
  readonly ops: readonly ReviewWriteOp[]
  /**
   * 当前内容的 blob 哈希（git 数据源提供）。客户端用它做内容级「已看过」判定：
   * 文件再被改动 → 哈希变 → 标记失效、条目重新出现。
   */
  readonly hash: string
  /**
   * 子 Agent 归属标注（问题 2 父卡聚合）：值 = 委托标签。
   * 该文件来自某个子会话轮次（pre-image/撤销按它路由）；缺省 = 父会话自身改动。
   */
  readonly fromSubagent?: string
}

/** Review 卡完整聚合：总 diff + 每文件 diff。 */
export interface ReviewChanges {
  readonly totalAdded: number
  readonly totalRemoved: number
  readonly files: readonly ReviewFileChange[]
  /** 撤销顺序（旧实现用）；git 数据源不提供。 */
  readonly revertOrder: readonly ReviewWriteOp[]
}

const EMPTY_REVIEW: ReviewChanges = {
  totalAdded: 0, totalRemoved: 0, files: [], revertOrder: [],
}

/** 空聚合（卡片未渲染任何改动时的初值）。 */
export function emptyReviewChanges(): ReviewChanges {
  return EMPTY_REVIEW
}
