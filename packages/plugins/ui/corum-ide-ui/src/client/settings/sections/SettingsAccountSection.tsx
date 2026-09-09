/**
 * SettingsAccountSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 账户与用量 ────────────────────────────────────────────────────── */

export function AccountSection() {
  return (
    <>
      <SettingGroup title="账户">
        <SettingRow label="当前账户" desc="corum@local">
          <GlassButton>登出</GlassButton>
        </SettingRow>
        <SettingRow label="订阅" desc="免费版" divider={false}>
          <GlassButton>升级</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="用量统计">
        <SettingRow label="本月 API 调用" desc="">
          <span className={css.sizeLabel}>1,234 次</span>
        </SettingRow>
        <SettingRow label="Token 用量" desc="" divider={false}>
          <span className={css.sizeLabel}>5.6M tokens</span>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
