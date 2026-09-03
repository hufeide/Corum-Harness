/**
 * Shared settings UI components — 1:1 复刻 design.pen 设置中心可复用控件。
 *
 * 导出：
 * - SettingGroup: 组卡片容器（glass-1, radius 16, padding [6,16,10,16]）
 * - SettingRow: 行容器（gap 12, padding [10,2], meta + control）
 * - SelectField: 下拉选择（glass-2, radius 10, 180px, chevron-down）
 * - Switch: 开关（36×20, radius 10, knob 16×16）
 * - Badge: 徽标（modified/restart）
 * - KbdKey: 快捷键标签（glass-2, radius 6, glass-border-active stroke）
 * - ColorChips: 色彩选择器（18×18 ellipse, gap 8）
 */
export { SettingGroup } from './SettingGroup.tsx'
export { SettingRow } from './SettingRow.tsx'
export { SelectField } from './SelectField.tsx'
export { Switch } from './Switch.tsx'
export { Badge } from './Badge.tsx'
export { KbdKey } from './KbdKey.tsx'
export { ColorChips } from './ColorChips.tsx'
