/**
 * SettingsDataSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 数据管理 ──────────────────────────────────────────────────────── */

export function DataSection() {
  return (
    <>
      <SettingGroup title="存储占用">
        <SettingRow label="技能仓库" desc="">
          <span className={css.sizeLabel}>45 MB</span>
          <GlassButton>清理</GlassButton>
        </SettingRow>
        <SettingRow label="缓存" desc="" divider={false}>
          <span className={css.sizeLabel}>312 MB</span>
          <GlassButton>清理</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="危险操作">
        <SettingRow label="清除全部缓存" desc="清空本地缓存文件，下次启动重新生成">
          <GlassButton variant="danger">清除</GlassButton>
        </SettingRow>
        <SettingRow label="重置全部设置" desc="恢复所有设置为默认值，不可撤销" divider={false}>
          <GlassButton variant="danger">重置</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
