/**
 * corum-desktop 通知服务（框架级）：任何 combo 可用的应用内 toast 通知。
 *
 * 设计来源：design.pen「row-通知框」（YbfO9，深色 g5jAt / 浅色 QEM1e）——
 * 右下角纵向堆叠的**单行** toast：状态图标（16，state-*）+ 标题（12/600
 * label-primary）/副文案（10.5 label-secondary）+ 相对时间（JetBrains Mono
 * 9.5 label-tertiary）+ 关闭 ×（16 框内 9 图标）。宽 340、圆角 14、
 * padding 10/12、gap 9、玻璃底 $glass-1 + 外阴影 0 10 28 #0000003D。
 * 本模块是无 React 依赖的 store（subscribe/getSnapshot），UI 由
 * NotificationHost 挂载；生产方（HMR 失败、会话事件、任意插件）只调 notify()。
 *
 * 框架定位：这是 corum-desktop 提供的基础能力，不限 dev——HMR 失败只是
 * 第一个消费方。通知服务本身常驻，任何 combo 的生产方都可经 ctx 或
 * 直接 import notify() 发通知。
 * @module corum-desktop/client/notifications
 */

/** 通知语义色（对应设计稿状态图标配色 $state-*）。 */
export type NotificationTone = 'success' | 'warn' | 'info' | 'error'

/** 一条通知（结构 = 设计稿 toast 单行四元素）。 */
export interface CorumNotification {
  id: string
  /** 语义色，决定状态图标与配色（默认 info）。 */
  tone: NotificationTone
  /** 标题（12/600 $label-primary）。 */
  title: string
  /** 副文案（10.5 $label-secondary，缺省只显示标题）。 */
  message?: string
  /** 创建时间戳（ms），相对时间显示用。 */
  createdAt: number
  /**
   * 已自动收起（design.pen `drawer-tab`：右下角 bell 常驻图标 + 未读数）。
   * 由 NotificationHost 在 5s 未处理后置位；点击 bell 全部展开（清零）。
   */
  collapsed: boolean
}

/** 通知 store 的可订阅快照。 */
export interface NotificationStore {
  getSnapshot(): readonly CorumNotification[]
  subscribe(listener: () => void): () => void
  /** 发一条通知，返回其 id（供调用方后续 dismiss）。 */
  notify(input: Omit<CorumNotification, 'id' | 'createdAt' | 'collapsed'> & { createdAt?: number }): string
  /** 关闭指定通知。 */
  dismiss(id: string): void
  /** 收起一条通知（5s 未处理 → 右下角 bell）。 */
  collapse(id: string): void
  /** 展开全部已收起通知（点 bell）。 */
  expandAll(): void
  /** 清空全部通知。 */
  clear(): void
}

/** 创建通知 store（单实例由桌面壳持有并暴露）。 */
export function createNotificationStore(): NotificationStore {
  let items: readonly CorumNotification[] = []
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[corum-desktop] notification listener threw:', error)
      }
    }
  }
  return {
    getSnapshot: () => items,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify: (input) => {
      const id = `ntf-${crypto.randomUUID()}`
      const next: CorumNotification = {
        id,
        tone: input.tone ?? 'info',
        title: input.title,
        createdAt: input.createdAt ?? Date.now(),
        collapsed: false,
        ...(input.message !== undefined ? { message: input.message } : {}),
      }
      items = [...items, next]
      emit()
      return id
    },
    dismiss: (id) => {
      if (!items.some(n => n.id === id)) return
      items = items.filter(n => n.id !== id)
      emit()
    },
    collapse: (id) => {
      if (!items.some(n => n.id === id && !n.collapsed)) return
      items = items.map(n => (n.id === id ? { ...n, collapsed: true } : n))
      emit()
    },
    expandAll: () => {
      if (!items.some(n => n.collapsed)) return
      items = items.map(n => (n.collapsed ? { ...n, collapsed: false } : n))
      emit()
    },
    clear: () => {
      if (items.length === 0) return
      items = []
      emit()
    },
  }
}
