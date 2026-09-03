/**
 * KbdKey — 快捷键标签（1:1 复刻 design.pen kbd frame）。
 *
 * 设计稿 kbd frame（快捷键页）：
 * - height: 22, fill: $glass-2, cornerRadius: 6, stroke: $glass-border-active 1px
 * - justifyContent: center, alignItems: center
 * - text: Inter 11px normal, $label-secondary
 *
 * @module corum-ide-ui/client/settings/KbdKey
 */
import css from './KbdKey.module.css'

interface KbdKeyProps {
  /** 快捷键文本（如 "Cmd+," "Cmd+K" "Esc"）。 */
  label: string
}

/**
 * Render a keyboard shortcut badge.
 * @param props - label.
 * @returns the kbd element.
 */
export function KbdKey({ label }: KbdKeyProps) {
  return (
    <span className={css.kbd}>
      {label}
    </span>
  )
}
