/**
 * SettingsPrivacySection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { Switch } from '../Switch.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 隐私 ──────────────────────────────────────────────────────────── */

export function PrivacySection() {
  return (
    <>
      <SettingGroup title="数据与遥测">
        <SettingRow label="匿名使用统计" desc="帮助改进产品，不含任何代码内容">
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="崩溃报告" desc="应用崩溃时自动发送报告" divider={false}>
          <Switch checked={true} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="敏感文件排除">
        <SettingRow label="排除模式" desc="匹配的文件不会被 Agent 读取或写入" divider={false}>
          <GlassButton>编辑</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
