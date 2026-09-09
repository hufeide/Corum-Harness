/**
 * SettingsNotificationsSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { Switch } from '../Switch.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 通知 ──────────────────────────────────────────────────────────── */

export function NotificationsSection() {
  return (
    <>
      <SettingGroup title="任务通知">
        <SettingRow label="任务完成时通知" desc="Agent 任务执行完毕时弹出提醒">
          <Switch checked={true} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="通知声音" desc="通知到达时播放提示音">
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="系统通知权限" desc="需在系统设置中允许 Corum 发送通知" divider={false}>
          <GlassButton>去开启</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="勿扰">
        <SettingRow label="勿扰模式" desc="开启后不弹出任何通知" divider={false}>
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
