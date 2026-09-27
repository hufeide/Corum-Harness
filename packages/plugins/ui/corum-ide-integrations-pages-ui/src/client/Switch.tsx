/**
 * Switch — 开关控件（1:1 复刻 design.pen CDs9f ref + on 态）。
 *
 * 设计稿 switch-off (CDs9f reusable)：
 * - width: 36, height: 20, fill: $glass-3, cornerRadius: 10
 * - stroke: $glass-border 1px, layout: none
 * - knob: ellipse 16×16, fill: $label-secondary, x:2 y:2
 *
 * on 态（设计稿通知页 ZdIJT）：
 * - fill: $brand-primary, knob x:18 (right), fill: $label-on-brand
 *
 * PR6 起由本包自持一份副本（自 @corum/corum-ide-ui 的 settings/Switch 迁入）：
 * 两个包是各自独立的 client bundle，不能跨包 import 组件与 CSS module。
 * @module corum-ide-integrations-pages-ui/client/Switch
 */
import css from './Switch.module.css'

interface SwitchProps {
  /** 开关状态。 */
  checked: boolean
  /** 状态变更回调。 */
  onChange: (checked: boolean) => void
  /** 是否禁用。 */
  disabled?: boolean
}

/**
 * Render a glass-style toggle switch.
 * @param props - checked, onChange, disabled.
 * @returns the switch element.
 */
export function Switch({ checked, onChange, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={checked ? css.switchOn : css.switchOff}
      onClick={() => { if (!disabled) onChange(!checked) }}
    >
      <span className={checked ? css.knobOn : css.knobOff} />
    </button>
  )
}
