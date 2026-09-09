/**
 * NotificationHost — corum-desktop 通知的渲染层（design.pen「row-通知框」YbfO9，
 * 深色 g5jAt / 浅色 QEM1e；收起态见「Session 顶栏 · Agent 胶囊融合」③ 与
 * `drawer-tab` cZ9D4）。
 *
 * 结构 = 设计稿 toast 单行四元素（横向 gap 9、padding 10/12、宽 340、圆角 14）：
 *   ① 状态图标 16（lucide circle-check / hourglass / circle-alert / info，
 *      颜色 $state-*-primary / brand）
 *   ② col（fill_container，纵向 gap 2）：title 12/600 $label-primary +
 *      msg 10.5 $label-secondary（无 msg 时只渲染标题）
 *   ③ 相对时间（JetBrains Mono 9.5 $label-tertiary）
 *   ④ 关闭 ×（16 框内 9 图标，$label-tertiary）
 * 底 $glass-1 + 外阴影 0 10 28 #0000003D；**设计稿无描边、无操作行**——2026-09-09
 * 对齐时删掉了旧的 icon-box 与 r2 操作行（无消费方，见 notifications.ts）。
 *
 * 2026-09-10 用户定调「有通知弹出后，5s 未处理自动收起到右下角」：未处理的 toast
 * 计时 5s 后收起为右下角常驻 bell（`drawer-tab`：28×52、左侧圆角 14、bell 18 +
 * $state-error 未读数），点 bell 全部展开；鼠标悬停 toast 期间暂停计时。
 *
 * 通知栈经 createPortal 挂到 document.body 右下角（摆脱网格 .leaf 的
 * will-change:transform + overflow:hidden 合成层裁剪，同 SettingsShell 模式）。
 * @module corum-desktop/client/NotificationHost
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Bell, CircleAlert, CircleCheck, Hourglass, Info, X } from 'lucide-react'
import type { CorumNotification, NotificationStore, NotificationTone } from './notifications.ts'
import css from './NotificationHost.module.css'

/** 未处理自动收起的等待时长（用户定调 5s）。 */
export const AUTO_COLLAPSE_MS = 5000

/** tone → lucide 图标（设计稿：success=circle-check / warn=hourglass / error=circle-alert）。 */
const TONE_ICON: Record<NotificationTone, typeof Info> = {
  success: CircleCheck,
  warn: Hourglass,
  error: CircleAlert,
  info: Info,
}

/** tone → 状态色类（显式映射，避免动态键在 CSS Modules 下失配）。 */
const TONE_CLASS: Record<NotificationTone, string> = {
  success: css.toneSuccess,
  warn: css.toneWarn,
  error: css.toneError,
  info: css.toneInfo,
}

/** r3 行时间戳的相对时间标签（对齐侧栏 timeLabel 语义，设计稿示例「2 分钟前」）。 */
function relTime(createdAt: number): string {
  const diff = Date.now() - createdAt
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function Toast({ notification, paused, onCollapse, onDismiss }: {
  notification: CorumNotification
  paused: boolean
  onCollapse: (id: string) => void
  onDismiss: (id: string) => void
}) {
  const Icon = TONE_ICON[notification.tone]
  // 5s 未处理 → 收起；悬停暂停（清除计时），移开后重新计时。
  useEffect(() => {
    if (paused) return undefined
    const timer = setTimeout(() => { onCollapse(notification.id) }, AUTO_COLLAPSE_MS)
    return () => { clearTimeout(timer) }
  }, [paused, notification.id, onCollapse])
  return (
    <div className={css.toast} data-tone={notification.tone} role="status">
      <Icon size={16} strokeWidth={2} className={`${css.toneIcon} ${TONE_CLASS[notification.tone]}`} />
      <div className={css.col}>
        <span className={css.title}>{notification.title}</span>
        {notification.message !== undefined && notification.message !== '' && (
          <span className={css.msg}>{notification.message}</span>
        )}
      </div>
      <span className={css.time}>{relTime(notification.createdAt)}</span>
      <button
        type="button"
        className={css.btnX}
        aria-label="关闭通知"
        onClick={() => onDismiss(notification.id)}
      >
        <X size={9} strokeWidth={2} />
      </button>
    </div>
  )
}

/** 通知栈宿主：portal 到 body 右下角纵向堆叠（设计稿 alignItems=end）+ 收起 bell。 */
export function NotificationHost({ store }: { store: NotificationStore }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [paused, setPaused] = useState(false)
  // 回调引用稳定：Toast 的计时 effect 依赖它们，内联箭头函数会让每次渲染都重置 5s 计时。
  const onCollapse = useRef((id: string) => { store.collapse(id) }).current
  const onDismiss = useRef((id: string) => { store.dismiss(id) }).current
  const onExpandAll = useRef(() => { store.expandAll() }).current
  if (items.length === 0) return null
  const collapsed = items.filter(n => n.collapsed)
  const visible = items.filter(n => !n.collapsed)
  return createPortal(
    <>
      {visible.length > 0 && (
        <div
          className={css.stack}
          aria-live="polite"
          onMouseEnter={() => { setPaused(true) }}
          onMouseLeave={() => { setPaused(false) }}
        >
          {visible.map(n => (
            <Toast key={n.id} notification={n} paused={paused} onCollapse={onCollapse} onDismiss={onDismiss} />
          ))}
        </div>
      )}
      {collapsed.length > 0 && (
        <button
          type="button"
          className={css.tab}
          aria-label={`展开 ${collapsed.length} 条通知`}
          title={`${collapsed.length} 条未处理通知`}
          onClick={onExpandAll}
        >
          <Bell size={18} strokeWidth={2} className={css.tabIcon} />
          <span className={css.tabBadge}>{collapsed.length > 99 ? '99+' : collapsed.length}</span>
        </button>
      )}
    </>,
    document.body,
  )
}
