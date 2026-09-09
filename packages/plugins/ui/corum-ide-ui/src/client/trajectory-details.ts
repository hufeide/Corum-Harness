/**
 * fork（corum）：details 抽屉的「工具详情 ⟷ 轨迹」视图状态服务（fork #12）。
 *
 * 归属与依赖方向（2026-09-09 实机修正）：抽屉本体由**壳**打开
 * （LayoutController.openDetails），视图状态因此归壳所有——壳 provide 本服务，
 * corum-ui-chat 的 DetailsPanel 经 inject 消费（提供者=壳、消费方=chat，方向单一）。
 * 早前把服务放在 chat 侧、让壳 inject，导致 **chat inject layout ↔ 壳 inject
 * trajectoryDetails 的循环等待**（实机 boot 7 个插件 pending，见 docs/fork-delta.md §14）。
 *
 * 本文件保持 cordis-free（纯状态容器）：Context 合并与 provide 在 index.tsx。
 *
 * @module corum-ide-ui/trajectory-details
 */

/** details 抽屉当前视图。 */
export type DetailsViewMode = 'tool' | 'trajectory'

/** trajectoryDetails 服务面（壳 provide；chat 经能力接口收窄消费）。 */
export interface TrajectoryDetailsFace {
  /** 当前视图（uSES getSnapshot 契约：值不变时调用方拿到同一枚举值）。 */
  readonly view: DetailsViewMode
  /** 打开 details 抽屉并切到轨迹视图（右上角轨迹按钮）。 */
  openTrajectory: () => void
  /** 切到工具详情视图（抽屉内 tab）。 */
  showTool: () => void
  /** 切到轨迹视图（不开抽屉；抽屉内 tab）。 */
  showTrajectory: () => void
  /** uSES subscribe 契约。 */
  subscribe: (listener: () => void) => () => void
}

/** 抽屉视图状态容器（壳 apply 时构造；openDetails 由 LayoutController 注入）。 */
export class TrajectoryDetails implements TrajectoryDetailsFace {
  #view: DetailsViewMode = 'tool'
  readonly #listeners = new Set<() => void>()
  readonly #openDetails: () => void

  /** @param openDetails - 打开抽屉的壳动作（LayoutController.openDetails）。 */
  constructor(openDetails: () => void) {
    this.#openDetails = openDetails
  }

  get view(): DetailsViewMode { return this.#view }

  readonly openTrajectory = (): void => {
    this.#openDetails()
    this.#set('trajectory')
  }

  readonly showTool = (): void => { this.#set('tool') }

  readonly showTrajectory = (): void => { this.#set('trajectory') }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #set(view: DetailsViewMode): void {
    if (view === this.#view) return
    this.#view = view
    for (const fn of this.#listeners) fn()
  }
}
