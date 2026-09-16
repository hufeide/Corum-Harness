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
  /**
   * 徽标类型：
   * - `modified` 已修改（用户覆盖过该键）
   * - `restart` 重启后生效（宿主插件改动）
   * - `soon` 即将上线（真源待建，占位展示）
   * - `offline` 未上线（机制不存在；**必须与 `disabled` 控件成对出现**，PRD §6.1）
   */
  variant?: 'modified' | 'restart' | 'soon' | 'offline'
}

/**
 * Render a small glass badge.
 * @param props - label and variant.
 * @returns the badge element.
 */
export function Badge({ label, variant = 'modified' }: BadgeProps) {
  const cls =
    variant === 'restart' ? css.restart
      : variant === 'soon' ? css.soon
        : variant === 'offline' ? css.offline
          : css.modified
  return <span className={cls}>{label}</span>
}
