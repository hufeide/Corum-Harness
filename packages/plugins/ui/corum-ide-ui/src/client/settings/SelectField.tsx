/**
 * SelectField — 下拉选择控件（1:1 复刻 design.pen Bf3cS ref）。
 *
 * 下拉列表经 createPortal 挂到 document.body，避免被 body overflow:auto 裁切。
 * 定位用 getBoundingClientRect 动态计算，跟随滚动。
 *
 * @module corum-ide-ui/client/settings/SelectField
 */
import { useLayoutEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import css from './SelectField.module.css'

interface SelectOption {
  id: string
  label: string
}

/** 下拉与触发按钮/视口边缘的间距（px）。 */
const GAP = 4
/** 下拉与视口上下边缘的最小留白（px）。 */
const EDGE = 8
/** 下拉高度上限（px）；超出滚动。 */
const MAX_DROPDOWN_H = 320
/** 下拉高度下限（px）；空间再小也保证能滚动（不塌成 0）。 */
const MIN_DROPDOWN_H = 120

interface SelectFieldProps {
  /** 当前选中值。 */
  value: string
  /** 可选项列表。 */
  options: readonly SelectOption[]
  /** 选中变更回调。 */
  onChange: (id: string) => void
  /** 是否禁用。 */
  disabled?: boolean
  /** 尺寸变体：'fill'=占满父容器宽（编辑表单列）; 'compact'=设计稿弹窗版本选择器（小尺寸、自适应内容）。 */
  variant?: 'default' | 'fill' | 'compact'
}

/**
 * Render a glass-style select dropdown with portal-based floating list.
 * @param props - value, options, onChange, disabled.
 * @returns the select field element.
 */
export function SelectField({ value, options, onChange, disabled, variant = 'default' }: SelectFieldProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const dropdownStyle = useRef<CSSStyleDeclaration | null>(null)
  const [, forceUpdate] = useState(0)

  const selected = options.find(o => o.id === value)
  const displayLabel = selected?.label ?? value

  const updatePosition = useCallback(() => {
    const btn = buttonRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const el = document.getElementById('__select-dropdown')
    if (el) {
      // 视口空间自适应：优先向下展开；下方空间不足且上方更宽裕时向上翻转。
      // 高度按可用空间收敛（≤ 320px），超出交给 overflow-y 滚动 ——
      // 否则长列表（模型/供应商）会被视口底边裁掉，后段选项既看不到也滚不到。
      const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE
      const spaceAbove = rect.top - GAP - EDGE
      const openUp = spaceBelow < MIN_DROPDOWN_H && spaceAbove > spaceBelow
      const avail = Math.max(MIN_DROPDOWN_H, Math.min(MAX_DROPDOWN_H, openUp ? spaceAbove : spaceBelow))
      if (openUp) {
        el.style.top = 'auto'
        el.style.bottom = `${window.innerHeight - rect.top + GAP}px`
      } else {
        el.style.bottom = 'auto'
        el.style.top = `${rect.bottom + GAP}px`
      }
      el.style.maxHeight = `${avail}px`
      el.style.right = `${window.innerWidth - rect.right}px`
      el.style.minWidth = `${rect.width}px`
    }
    dropdownStyle.current = null
    forceUpdate(n => n + 1)
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    const onScroll = () => updatePosition()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, updatePosition])

  // 点击外部关闭
  useLayoutEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      const btn = buttonRef.current
      const dd = document.getElementById('__select-dropdown')
      if (btn?.contains(target)) return
      if (dd?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [open])

  return (
    <div className={`${css.wrapper}${variant === 'fill' ? ' ' + css.wrapperFill : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className={`${css.select}${variant === 'fill' ? ' ' + css.selectFill : variant === 'compact' ? ' ' + css.selectCompact : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setOpen(v => !v) }}
      >
        <span className={css.value}>{displayLabel || '　'}</span>
        <ChevronDown className={css.chevron} size={variant === 'compact' ? 11 : variant === 'fill' ? 16 : 18} />
      </button>
      {open && !disabled && createPortal(
        <div id="__select-dropdown" className={css.dropdown} role="listbox" style={{ position: 'fixed' }}>
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
        </div>,
        document.body,
      )}
    </div>
  )
}
