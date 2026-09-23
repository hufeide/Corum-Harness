/**
 * 记忆设置页 —— 自备轻量视觉组件（红线 3.5：插件不得静态 value-import 壳的组件）。
 *
 * 为什么不用 `corum-ide-ui` 的 `SettingGroup / SettingRow / SelectField / Switch`：
 * 那些是**壳 client bundle 内部**的组件，跨 bundle 静态 import 会炸（见
 * docs/dev-conventions.md 红线 §3.5）。`corum-ollama` 也是同样处理（内联 style）。
 *
 * ## 与设计稿的对应（`doc/UXDesign/design.pen` 的 v3 两页）
 *
 * | 组件 | 设计稿 reusable |
 * |---|---|
 * | {@link GroupCard} | `group-card`（$glass-1 / r16 / $glass-border / padding [6,16,10,16]） |
 * | {@link Row} | 行 frame（width fill / gap 12 / padding [9,2] / space_between / center） |
 * | {@link RowLabel} + {@link RowDesc} | meta（vertical gap 2；label 13/600 `$label-primary`，desc 11 `$label-tertiary`） |
 * | {@link Select} | `select-field`（glass-2 / r10 / gap 8 / padding [7,10]，值 12px） |
 * | {@link Toggle} | `switch-off`（36×20 / r10 / knob 16） |
 * | {@link Segmented} | `scope-switch`（glass-2 / r10 / gap 2 / padding 2，active 段 $brand-primary） |
 * | {@link Badge} | `modified-badge` / `restart-badge`（glass-2 / r6 / padding [2,7]） |
 * | {@link Divider} | row 间 1px `$glass-border` opacity 0.5 |
 *
 * token 全部走 `var(--corum-glass-*)` / `var(--dsw-alias-*)`（壳在 `theme-layer.ts`
 * 声明）——**不写死 hex**（DESIGN.md §1 硬性规范）。缺 token 时给 fallback 会在
 * `scripts/audit-dsw-tokens.py` 里被记为「多余 fallback」，故只对确实可能缺的
 * `--corum-glass-*`（壳自有 token）留 fallback。
 *
 * @module @corum/corum-memory/client/ui
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/* ── token（壳的液态玻璃 token；深色/浅色由壳切 theme，插件不感知）────────── */

const T = {
  glass1: 'var(--corum-glass-1, rgba(255,255,255,0.08))',
  glass2: 'var(--corum-glass-2, rgba(255,255,255,0.12))',
  glass3: 'var(--corum-glass-3, rgba(255,255,255,0.18))',
  border: 'var(--corum-glass-border, rgba(255,255,255,0.14))',
  borderActive: 'var(--corum-glass-border-active, var(--dsw-alias-brand-primary))',
  labelPrimary: 'var(--dsw-alias-label-primary)',
  labelSecondary: 'var(--dsw-alias-label-secondary)',
  labelTertiary: 'var(--dsw-alias-label-tertiary)',
  labelDimmed: 'var(--dsw-alias-label-dimmed)',
  labelOnBrand: 'var(--corum-label-on-brand, #fff)',
  brand: 'var(--dsw-alias-brand-primary)',
  brandText: 'var(--dsw-alias-brand-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  idle: 'var(--dsw-alias-label-dimmed)',
} as const

/** UI 字族（壳的字体变量；壳在 theme-layer 里按用户偏好写入）。 */
const FONT = 'var(--corum-ui-font-family, Inter, -apple-system, sans-serif)'

/* ── 卡片 / 行 / 文案 ──────────────────────────────────────────────── */

/** 分组卡片（设计稿 `group-card`）。 */
export function GroupCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', boxSizing: 'border-box', width: '100%',
      padding: '6px 16px 10px 16px', borderRadius: 16,
      background: T.glass1, border: `1px solid ${T.border}`, overflow: 'hidden',
    }}>
      <span style={{ fontFamily: FONT, fontSize: 12, fontWeight: 600, color: T.labelSecondary }}>{title}</span>
      {children}
    </div>
  )
}

/** 设置行（设计稿 row frame；`control` 右对齐，缺省则该行只有文案）。 */
export function Row({ children, control }: { children: ReactNode; control?: ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, width: '100%', boxSizing: 'border-box', padding: '9px 2px',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>{children}</div>
      {control}
    </div>
  )
}

/** 行标题（13/600 `$label-primary`；可含 badge，故是 flex 行）。 */
export function RowLabel({ children }: { children: ReactNode }) {
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontFamily: FONT, fontSize: 13, fontWeight: 600, color: T.labelPrimary, lineHeight: 1.4,
    }}>{children}</span>
  )
}

/** 行说明（11/400 `$label-tertiary`）。 */
export function RowDesc({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: FONT, fontSize: 11, fontWeight: 400, color: T.labelTertiary, lineHeight: 1.45 }}>{children}</span>
}

/** 行间 1px 分隔线（设计稿 `div`：$glass-border + opacity 0.5）。 */
export function Divider() {
  return <div style={{ width: '100%', height: 1, background: T.border, opacity: 0.5 }} />
}

/** 徽标（设计稿 `modified-badge` / `restart-badge`）。`tone` 决定描边与文字色。 */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'brand' | 'warn' | 'error' }) {
  const color = tone === 'brand' ? T.brandText : tone === 'warn' ? T.warn : tone === 'error' ? T.error : T.labelTertiary
  const stroke = tone === 'neutral' ? T.border : color
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', flex: 'none',
      padding: '1px 6px', borderRadius: 6, border: `1px solid ${stroke}`,
      background: T.glass3, color, fontFamily: FONT, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{children}</span>
  )
}

/* ── 控件 ──────────────────────────────────────────────────────────── */

/** 下拉项。 */
export interface Option<T extends string> {
  /** 落库值。 */
  value: T
  /** 展示文案（可含单位，如「5 次」）。 */
  label: string
  /** 该项是否可选（未上线项禁用，但仍要在列表里可见）。 */
  disabled?: boolean
}

/**
 * 选择器（设计稿 `select-field`：glass-2 / r10 / gap 8 / padding [7,10]）。
 *
 * 用原生 `<select>` 而不是自绘浮层：设置面板是**有滚动容器**的玻璃面板，自绘下拉
 * 需要 portal + 视口翻转（壳的 `SelectField` 花了 100 行 CSS 处理这些）。这里原生
 * 控件零额外风险，且 macOS 上原生 select 的展开列表本就不受面板裁切影响。
 */
export function Select<T extends string>({ value, options, onChange, disabled, width = 180 }: {
  value: T
  options: readonly Option<T>[]
  onChange: (next: T) => void
  disabled?: boolean
  width?: number
}) {
  const cur = options.find(o => o.value === value)
  return (
    <span style={{ position: 'relative', flex: 'none', display: 'inline-flex', alignItems: 'center', width }}>
      <select
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value as T)}
        style={{
          appearance: 'none', WebkitAppearance: 'none', boxSizing: 'border-box',
          width: '100%', padding: '7px 28px 7px 10px', borderRadius: 10,
          border: `1px solid ${T.border}`, background: T.glass2, color: T.labelPrimary,
          fontFamily: FONT, fontSize: 12, cursor: disabled === true ? 'not-allowed' : 'pointer',
          opacity: disabled === true ? 0.5 : 1, outline: 'none',
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value} disabled={o.disabled === true}>{o.label}</option>
        ))}
      </select>
      {/* chevron：原生 select 的箭头在各平台样式不一，统一自绘（设计稿 `chev` 18 `$label-tertiary`） */}
      <span aria-hidden style={{
        position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
        color: T.labelTertiary, fontSize: 9, lineHeight: 1, pointerEvents: 'none',
      }}>{cur === undefined ? '' : '▾'}</span>
    </span>
  )
}

/** 开关（设计稿 `switch-off`：36×20 / r10 / knob 16 / $label-secondary；on 态 knob 取 $label-on-brand）。 */
export function Toggle({ checked, onChange, disabled }: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        flex: 'none', position: 'relative', width: 36, height: 20, boxSizing: 'border-box',
        borderRadius: 10, border: `1px solid ${checked ? T.borderActive : T.border}`,
        background: checked ? T.brand : T.glass3,
        cursor: disabled === true ? 'not-allowed' : 'pointer',
        opacity: disabled === true ? 0.5 : 1, padding: 0, transition: 'background 140ms ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 1, left: checked ? 17 : 1, width: 16, height: 16,
        borderRadius: '50%', background: checked ? T.labelOnBrand : T.labelSecondary,
        transition: 'left 140ms ease',
      }} />
    </button>
  )
}

/** 分段切换（设计稿 `scope-switch`：glass-2 / r10 / gap 2 / padding 2，active 段 $brand-primary + r9）。 */
export function Segmented<T extends string>({ value, options, onChange, disabled }: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (next: T) => void
  disabled?: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2, padding: 2, width: '100%',
      boxSizing: 'border-box', borderRadius: 12, border: `1px solid ${T.border}`, background: T.glass2,
    }}>
      {options.map(o => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            style={{
              flex: 1, minWidth: 0, padding: '6px 0', borderRadius: 9, border: 'none',
              background: active ? T.brand : 'transparent',
              color: active ? T.labelOnBrand : T.labelSecondary,
              fontFamily: FONT, fontSize: 12, fontWeight: active ? 600 : 400,
              cursor: disabled === true ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >{o.label}</button>
        )
      })}
    </div>
  )
}

/** 按钮（设计稿按钮规范：primary `$brand-primary` 底 + on-brand 字；secondary glass-2 + 描边；ghost 透明）。 */
export function Button({ children, onClick, disabled, variant = 'secondary', title }: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  title?: string
}) {
  const style: CSSProperties = {
    flex: 'none', padding: '4px 11px', borderRadius: 9, fontFamily: FONT,
    fontSize: 11, fontWeight: variant === 'ghost' ? 400 : 600, whiteSpace: 'nowrap',
    cursor: disabled === true ? 'not-allowed' : 'pointer',
    opacity: disabled === true ? 0.45 : 1,
  }
  if (variant === 'primary') Object.assign(style, { border: 'none', background: T.brand, color: T.labelOnBrand })
  else if (variant === 'danger') Object.assign(style, { border: `1px solid ${T.error}`, background: T.glass2, color: T.error })
  else if (variant === 'ghost') Object.assign(style, { border: `1px solid ${T.border}`, background: 'transparent', color: T.labelSecondary })
  else Object.assign(style, { border: `1px solid ${T.border}`, background: T.glass2, color: T.labelPrimary })
  return <button type="button" title={title} disabled={disabled} onClick={onClick} style={style}>{children}</button>
}

/** 文本输入（设计稿 input：glass-2 / r9 / padding [6,10]，11px placeholder `$label-tertiary`）。 */
export function TextInput({ value, onChange, placeholder, disabled, onEnter }: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  disabled?: boolean
  onEnter?: () => void
}) {
  return (
    <input
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && onEnter !== undefined) onEnter() }}
      style={{
        flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '6px 10px', borderRadius: 9,
        border: `1px solid ${T.border}`, background: T.glass2, color: T.labelPrimary,
        fontFamily: FONT, fontSize: 11, outline: 'none',
      }}
    />
  )
}

/** 过滤/搜索条（只读展示用的玻璃小胶囊；点击行为由外部用 Select 提供）。 */
export function Chip({ children, active, onClick, title }: {
  children: ReactNode
  active?: boolean
  onClick?: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        flex: 'none', padding: '3px 9px', borderRadius: 8,
        border: `1px solid ${active === true ? T.borderActive : T.border}`,
        background: active === true ? T.glass3 : 'transparent',
        color: active === true ? T.brandText : T.labelSecondary,
        fontFamily: FONT, fontSize: 11, fontWeight: active === true ? 600 : 400,
        cursor: onClick === undefined ? 'default' : 'pointer', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  )
}

/* ── 反馈（错误 / 提示 / 空态）────────────────────────────────────── */

/** 错误条（`$state-error`）。 */
export function ErrorNote({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: FONT, fontSize: 11, color: T.error, wordBreak: 'break-word' }}>{children}</span>
}

/** 中性提示条（`$label-tertiary`）。 */
export function Hint({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: FONT, fontSize: 11, color: T.labelTertiary }}>{children}</span>
}

/* ── 时间格式（记忆列表用）────────────────────────────────────────── */

/**
 * 相对时间（记忆列表的「最后使用 / 创建」）。
 *
 * 用相对时间而不是绝对时间戳：记忆列表里「2 小时前」比「2026-09-21 14:03:11」
 * 更能直接回答「这条还新鲜吗」。
 *
 * @param ms - epoch ms，null = 从未。
 * @returns 中文相对时间；null → 「从未」。
 */
export function fmtRelative(ms: number | null): string {
  if (ms === null) return '从未'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

/** 绝对时间（hover 提示用，`title` 属性）。 */
export function fmtAbsolute(ms: number | null): string {
  return ms === null ? '从未' : new Date(ms).toLocaleString()
}

/* ── 二选一确认弹窗（破坏性操作用）────────────────────────────────── */

/**
 * 二次确认弹窗（设计稿里的 `ConfirmDialog` 同款形态，这里自备一份）。
 *
 * Escape 关闭 + 打开时焦点落到确认按钮：破坏性操作要么明确确认，要么明确取消，
 * 不允许「点空白顺手关掉」。
 */
export function ConfirmDialog({ title, desc, confirmLabel, onConfirm, onCancel, danger }: {
  title: string
  desc: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
}) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 40, display: 'flex',
      alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)',
    }}>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 10, width: 340, padding: 16,
        borderRadius: 16, background: T.glass1, border: `1px solid ${T.border}`,
        backdropFilter: 'blur(16px) saturate(140%)',
      }}>
        <span style={{ fontFamily: FONT, fontSize: 13, fontWeight: 600, color: T.labelPrimary }}>{title}</span>
        <span style={{ fontFamily: FONT, fontSize: 11, color: T.labelTertiary, lineHeight: 1.5 }}>{desc}</span>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button onClick={onCancel}>取消</Button>
          <button
            ref={ref}
            type="button"
            onClick={onConfirm}
            style={{
              padding: '4px 11px', borderRadius: 9, border: 'none',
              background: danger === true ? T.error : T.brand,
              color: T.labelOnBrand, fontFamily: FONT, fontSize: 11, fontWeight: 600, cursor: 'pointer',
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

/** 受控的「重载计数器」（列表刷新用；配合 useEffect 依赖触发重拉）。 */
export function useReload(): [number, () => void] {
  const [n, setN] = useState(0)
  return [n, () => setN(v => v + 1)]
}
