/**
 * Badge — 徽标控件（1:1 复刻 design.pen p2zJab/e8idQ ref）。
 *
 * 设计稿 modified-badge (p2zJab)：
 * - fill: $glass-2, cornerRadius: 6, stroke: $glass-border-active 1px
 * - padding: [2,7], text: Inter 14px 600, $brand-text, content: "已修改"
 *
 * 设计稿 restart-badge (e8idQ)：
 * - fill: $glass-2, cornerRadius: 6, stroke: $state-warn 1px
 * - padding: [2,7], text: Inter 14px 600, $state-warn, content: "重启后生效"
 *
 * @module corum-ide-ui/client/settings/Badge
 */
import css from './Badge.module.css'

interface BadgeProps {
  /** 徽标文案。 */
  label: string
  /** 徽标类型。 */
  variant?: 'modified' | 'restart'
}

/**
 * Render a small glass badge.
 * @param props - label and variant.
 * @returns the badge element.
 */
export function Badge({ label, variant = 'modified' }: BadgeProps) {
  return (
    <span className={variant === 'restart' ? css.restart : css.modified}>
      {label}
    </span>
  )
}
