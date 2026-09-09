/**
 * SettingsPermissionsSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 权限 ──────────────────────────────────────────────────────────── */

export function PermissionsSection() {
  return (
    <>
      <SettingGroup title="沙箱与审批">
        <SettingRow label="沙箱模式" desc="Agent 执行命令时可写入的文件范围。">
          <SelectField value="workspace-write" options={[{id:'read-only',label:'只读'},{id:'workspace-write',label:'工作区读写'},{id:'full',label:'完全访问'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="审批策略" desc="何时要求人工确认 Agent 的工具调用。">
          <SelectField value="ask" options={[{id:'never',label:'从不'},{id:'ask',label:'每次询问'},{id:'dangerous',label:'仅危险操作'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="危险完全访问" desc="关闭所有沙箱与审批保护，请谨慎开启。" divider={false}>
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="工具规则">
        <SettingRow label="允许规则" desc="这些工具调用无需审批即可执行。">
          <GlassButton>编辑</GlassButton>
        </SettingRow>
        <SettingRow label="禁止规则" desc="这些工具调用将被直接拒绝。" divider={false}>
          <GlassButton>编辑</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
