/**
 * SettingsAdvancedSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { Switch } from '../Switch.tsx'
import { GlassButton } from '../shared.tsx'
import { useDeveloperMode, setDeveloperMode } from '../developer-mode.ts'
import css from '../SettingsSections.module.css'

/* ── 高级 ──────────────────────────────────────────────────────────── */

export function AdvancedSection() {
  const developerMode = useDeveloperMode()
  return (
    <>
      <SettingGroup title="配置文件">
        <SettingRow label="打开 settings.yaml" desc="直接编辑全局配置文件">
          <GlassButton>打开</GlassButton>
        </SettingRow>
        <SettingRow label="打开配置目录" desc="在文件管理器中显示配置目录" divider={false}>
          <GlassButton>打开</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="诊断">
        <SettingRow label="复制诊断信息" desc="复制版本、平台与运行环境信息到剪贴板">
          <GlassButton>复制</GlassButton>
        </SettingRow>
        <SettingRow label="打开日志目录" desc="在文件管理器中显示日志目录">
          <GlassButton>打开</GlassButton>
        </SettingRow>
        <SettingRow label="开发者模式" desc="开启后 Agent 预设显示「继承自」，可编排非标准模式" divider={false}>
          <Switch checked={developerMode} onChange={v => setDeveloperMode(v)} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
