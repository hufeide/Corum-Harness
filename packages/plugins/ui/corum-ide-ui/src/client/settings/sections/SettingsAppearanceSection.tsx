/**
 * SettingsAppearanceSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Badge } from '../Badge.tsx'
import { ColorChips } from '../ColorChips.tsx'
import css from '../SettingsSections.module.css'

/* ── 外观 ──────────────────────────────────────────────────────────── */

export function AppearanceSection() {
  return (
    <>
      <SettingGroup title="主题">
        <SettingRow label="外观主题" desc="浅色 / 深色 / 跟随系统" badge={<Badge label="已修改" />}>
          <SelectField value="system" options={[{id:'light',label:'浅色'},{id:'dark',label:'深色'},{id:'system',label:'跟随系统'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="强调色" desc="高亮、链接与品牌元素使用的颜色">
          <ColorChips chips={[{id:'violet',color:'#5B21F5'},{id:'pink',color:'#F5276C'},{id:'green',color:'#0BA57C'},{id:'orange',color:'#E07A00'}]} selectedId="violet" onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="字体与排版">
        <SettingRow label="UI 字体" desc="界面与菜单使用的字体">
          <SelectField value="inter" options={[{id:'inter',label:'Inter'},{id:'system',label:'系统默认'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="代码字体" desc="编辑器与终端使用的等宽字体">
          <SelectField value="jbm" options={[{id:'jbm',label:'JetBrains Mono'},{id:'mono',label:'Menlo'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="界面字号" desc="界面文字基准字号（px）">
          <SelectField value="13" options={[{id:'12',label:'12'},{id:'13',label:'13'},{id:'14',label:'14'},{id:'16',label:'16'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="界面密度" desc="列表与控件的纵向留白" divider={false}>
          <SelectField value="comfortable" options={[{id:'compact',label:'紧凑'},{id:'comfortable',label:'舒适'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
