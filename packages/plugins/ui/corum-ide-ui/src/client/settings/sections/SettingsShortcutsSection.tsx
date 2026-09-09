/**
 * SettingsShortcutsSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { KbdKey } from '../KbdKey.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 快捷键 ────────────────────────────────────────────────────────── */

export function ShortcutsSection() {
  return (
    <>
      <div className={css.searchBox}>
        <span className={css.searchPlaceholder}>搜索快捷键…</span>
      </div>
      <SettingGroup title="命令">
        <SettingRow label="打开设置"><KbdKey label="Cmd+," /></SettingRow>
        <SettingRow label="快速打开文件"><KbdKey label="Cmd+K" /></SettingRow>
        <SettingRow label="命令面板"><KbdKey label="Cmd+Shift+P" /></SettingRow>
        <SettingRow label="新建会话"><KbdKey label="Cmd+N" /></SettingRow>
        <SettingRow label="关闭弹层" divider={false}><KbdKey label="Esc" /></SettingRow>
      </SettingGroup>
      <div className={css.resetWrap}>
        <GlassButton variant="primary">重置全部快捷键</GlassButton>
      </div>
    </>
  )
}
