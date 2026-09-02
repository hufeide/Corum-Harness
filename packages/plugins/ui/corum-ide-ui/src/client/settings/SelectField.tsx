/**
 * SelectField — 下拉选择控件（1:1 复刻 design.pen Bf3cS ref）。
 *
 * 设计稿 select-field (Bf3cS reusable)：
 * - width: 180, fill: $glass-2, cornerRadius: 10, stroke: $glass-border 1px
 * - gap: 8, padding: [7,10], alignItems: center
 * - children: value text(Inter 16px normal) + chevron-down icon(18×18, label-tertiary)
 *
 * @module corum-ide-ui/client/settings/SelectField
 */
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import css from './SelectField.module.css'

interface SelectOption {
  id: string
  label: string
}

interface SelectFieldProps {
  /** 当前选中值。 */
  value: string
  /** 可选项列表。 */
  options: readonly SelectOption[]
  /** 选中变更回调。 */
  onChange: (id: string) => void
  /** 是否禁用。 */
  disabled?: boolean
}

/**
 * Render a glass-style select dropdown.
 * @param props - value, options, onChange, disabled.
 * @returns the select field element.
 */
export function SelectField({ value, options, onChange, disabled }: SelectFieldProps) {
  const [open, setOpen] = useState(false)
  const selected = options.find(o => o.id === value)
  const displayLabel = selected?.label ?? value

  return (
    <div className={css.wrapper}>
      <button
        type="button"
        className={css.select}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setOpen(v => !v) }}
      >
        <span className={css.value}>{displayLabel}</span>
        <ChevronDown className={css.chevron} size={18} />
      </button>
      {open && !disabled && (
        <div className={css.dropdown} role="listbox">
          {options.map(opt => (
            <button
              key={opt.id}
              type="button"
              role="option"
              aria-selected={opt.id === value}
              className={opt.id === value ? css.optionActive : css.option}
              onClick={() => {
                onChange(opt.id)
                setOpen(false)
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
