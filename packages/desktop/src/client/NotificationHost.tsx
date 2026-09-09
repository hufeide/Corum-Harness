/**
 * NotificationHost — corum-desktop 通知的渲染层（design.pen「row-通知框」YbfO9，
 * 深色 g5jAt / 浅色 QEM1e）。
 *
 * 结构 = 设计稿 toast 单行四元素（横向 gap 9、padding 10/12、宽 340、圆角 14）：
 *   ① 状态图标 16（lucide circle-check / hourglass / circle-alert / info，
 *      颜色 $state-success / $state-warn / $state-error / brand）
 *   ② col（fill_container，纵向 gap 2）：title 12/600 $label-primary +
 *      msg 10.5 $label-secondary（无 msg 时只渲染标题）
 *   ③ 相对时间（JetBrains Mono 9.5 $label-tertiary）
 *   ④ 关闭 ×（16 框内 9 图标，$label-tertiary）
 * 底 $glass-1 + 外阴影 0 10 28 #0000003D；**设计稿无描边、无操作行**——2026-09-09
 * 对齐时删掉了旧的 icon-box 与 r2 操作行（无消费方，见 notifications.ts）。
 * 通知栈经 createPortal 挂到 document.body 右下角（摆脱网格 .leaf 的
 * will-change:transform + overflow:hidden 合成层裁剪，同 SettingsShell 模式）。
 * @module corum-desktop/client/NotificationHost
 */

import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, CircleCheck, Hourglass, Info, X } from 'lucide-react'
import type { CorumNotification, NotificationStore, NotificationTone } from './notifications.ts'
import css from './NotificationHost.module.css'

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

function Toast({ notification, onDismiss }: {
  notification: CorumNotification
  onDismiss: (id: string) => void
}) {
  const Icon = TONE_ICON[notification.tone]
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

/** 通知栈宿主：portal 到 body 右下角纵向堆叠（设计稿 alignItems=end）。 */
export function NotificationHost({ store }: { store: NotificationStore }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot)
  if (items.length === 0) return null
  return createPortal(
    <div className={css.stack} aria-live="polite">
      {items.map(n => (
        <Toast key={n.id} notification={n} onDismiss={(id) => store.dismiss(id)} />
      ))}
    </div>,
    document.body,
  )
}
