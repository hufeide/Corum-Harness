/**
 * fork（corum）：`@corum/corum-ui-trajectory/view` —— 供消费方内联的组件面。
 *
 * 为什么单独一个入口：插件包的 `exports["./client"]` 指向 loader 闭包产物
 * （`window.__ModuleLoader__.load(...)`，无模块导出），另一个 bundle 无法从中
 * import 值；corum 共享 UI 库的惯例是 `exports["./x"] → TS 源码`，由消费方
 * tsdown 的 noExternal 内联（同 `@corum/corum-ui-base/client`）。corum-ui-chat 的
 * DetailsPanel 经本入口拿 `TrajectoryView` 与其数据面。
 *
 * @module @corum/corum-ui-trajectory/view
 */
export { createTrajectoryDurationStore } from './duration-store.ts'
export { NS as TRAJECTORY_NS } from './locales.ts'
export { EMPTY_TRAJECTORY_SNAPSHOT } from './trajectory-snapshot-builder.ts'
export type { TrajectorySnapshot } from './trajectory-contract.ts'
export { TrajectoryView, type TrajectoryViewInjected } from './TrajectoryView.tsx'
