/**
 * SettingsMemorySection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { Trash2 } from 'lucide-react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 记忆 ──────────────────────────────────────────────────────────── */

export function MemorySection() {
  return (
    <>
      <SettingGroup title="记忆">
        <SettingRow label="启用记忆" desc="允许 Agent 在对话中沉淀长期记忆">
          <Switch checked={true} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="跨会话共享" desc="记忆在所有会话之间共享，关闭后仅当前会话可见" badge={<Badge label="重启后生效" variant="restart" />}>
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="记忆容量上限" desc="超出上限后自动淘汰最旧的记忆条目" divider={false}>
          <SelectField value="500" options={[{id:'100',label:'100 条'},{id:'500',label:'500 条'},{id:'1000',label:'1000 条'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="已存记忆">
        <div className={css.memRow}><span className={css.memDot} /><span className={css.memTxt}>用户偏好使用中文交流，代码注释保持英文</span><Trash2 size={14} className={css.memDel} /></div>
        <div className={css.memDivider} />
        <div className={css.memRow}><span className={css.memDot} /><span className={css.memTxt}>项目使用 pnpm workspace，构建命令为 pnpm --filter 包名 build</span><Trash2 size={14} className={css.memDel} /></div>
        <div className={css.memDivider} />
        <div className={css.memRow}><span className={css.memDot} /><span className={css.memTxt}>桌面应用主目录为 ~/.corum-shell，可通过 CORUM_HOME 覆盖</span><Trash2 size={14} className={css.memDel} /></div>
        <div className={css.actionsRow}>
          <GlassButton variant="danger">清空全部</GlassButton>
        </div>
      </SettingGroup>
    </>
  )
}
