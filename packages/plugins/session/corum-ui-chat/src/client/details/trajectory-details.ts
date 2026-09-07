/**
 * trajectory-details — 「轨迹按钮 → details 独立抽屉区」的 cordis 服务（跨 bundle 单例）。
 *
 * 模式照 chat-runtime.ts（红线 1：跨 bundle 共享状态走 cordis 服务）：
 *   - corum-ide-ui 壳（AppFrame 轨迹按钮）经 inject 拿本服务 `openTrajectory()`：
 *     打开 details 抽屉（layout.openDetails）+ 把 DetailsPanel 切到轨迹视图。
 *   - corum-ui-chat 的 DetailsPanel（同 bundle）经 trajectoryDetailsRef 订阅
 *     `view`（tool ⟷ trajectory）切换渲染工具详情 / 官方轨迹时间线。
 * 本文件保持 cordis-free（纯库纪律）：无 cordis import。
 */

/** DetailsPanel 当前视图。 */
export type DetailsViewMode = 'tool' | 'trajectory'

/** trajectoryDetails 服务面。 */
export interface TrajectoryDetailsService {
  /** 当前 details 视图（uSES getSnapshot）。 */
  readonly view: DetailsViewMode
  /** 打开 details 抽屉并切到轨迹视图（AppFrame 轨迹按钮）。 */
  openTrajectory: () => void
  /** 切到工具详情视图。 */
  showTool: () => void
  /** 切到轨迹视图（不开 details，DetailsPanel 内部 tab）。 */
  showTrajectory: () => void
  /** 打开 details 抽屉的回调（由 apply 注入 layout.openDetails）。 */
  setOpenDetails: (fn: () => void) => void
  /** uSES subscribe。 */
  subscribe: (listener: () => void) => () => void
}

class TrajectoryDetailsImpl implements TrajectoryDetailsService {
  #view: DetailsViewMode = 'tool'
  #openDetailsFn: (() => void) | null = null
  readonly #listeners = new Set<() => void>()

  get view(): DetailsViewMode { return this.#view }

  readonly openTrajectory = (): void => {
    this.#openDetailsFn?.()
    this.showTrajectory()
  }

  readonly showTool = (): void => { this.#set('tool') }

  readonly showTrajectory = (): void => { this.#set('trajectory') }

  readonly setOpenDetails = (fn: () => void): void => { this.#openDetailsFn = fn }

  #set(view: DetailsViewMode): void {
    if (view === this.#view) return
    this.#view = view
    for (const fn of this.#listeners) fn()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
}

/** 服务实例的同 bundle 模块级引用（DetailsPanel 消费入口）。 */
export const trajectoryDetailsRef: { current: TrajectoryDetailsImpl | null } = { current: null }

/** 创建服务实例（apply 调用；同时写入模块级 ref 供同 bundle 组件消费）。 */
export function createTrajectoryDetails(): TrajectoryDetailsImpl {
  const impl = new TrajectoryDetailsImpl()
  trajectoryDetailsRef.current = impl
  return impl
}
