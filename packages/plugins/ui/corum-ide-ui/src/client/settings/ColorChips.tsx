/**
 * ColorChips — 色彩选择器（1:1 复刻 design.pen chips row）。
 *
 * 设计稿 chips（外观页 V74O9）：
 * - gap: 8, alignItems: center
 * - 每个 chip: ellipse 18×18, fill: 对应色, selected 时 stroke glass-border-active 2px
 *
 * @module corum-ide-ui/client/settings/ColorChips
 */
import css from './ColorChips.module.css'

interface ColorChip {
  id: string
  /** 色值（hex 或 CSS 变量）。 */
  color: string
}

interface ColorChipsProps {
  /** 色彩列表。 */
  chips: readonly ColorChip[]
  /** 当前选中 id。 */
  selectedId: string
  /** 选中变更回调。 */
  onChange: (id: string) => void
}

/**
 * Render a row of color picker chips.
 * @param props - chips, selectedId, onChange.
 * @returns the color chips element.
 */
export function ColorChips({ chips, selectedId, onChange }: ColorChipsProps) {
  return (
    <div className={css.chips}>
      {chips.map(chip => (
        <button
          key={chip.id}
          type="button"
          aria-label={chip.id}
          aria-pressed={chip.id === selectedId}
          className={chip.id === selectedId ? css.chipActive : css.chip}
          style={{ background: chip.color }}
          onClick={() => { onChange(chip.id) }}
        />
      ))}
    </div>
  )
}
