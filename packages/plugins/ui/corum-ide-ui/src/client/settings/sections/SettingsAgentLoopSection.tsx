/**
 * SettingsAgentLoopSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 高级 Agent Loop ──────────────────────────────────────────────── */

export function AgentLoopSection() {
  return (
    <>
      <SettingGroup title="并发与重试">
        <SettingRow label="最大并发数" desc="同时运行的工具调用上限">
          <SelectField value="3" options={[{id:'1',label:'1'},{id:'3',label:'3'},{id:'5',label:'5'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="重试次数" desc="工具调用失败后的重试上限">
          <SelectField value="2" options={[{id:'0',label:'0'},{id:'2',label:'2'},{id:'5',label:'5'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="重试间隔" desc="每次重试之间的等待时间" divider={false}>
          <SelectField value="1" options={[{id:'0',label:'0s'},{id:'1',label:'1s'},{id:'5',label:'5s'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="提示">
        <SettingRow label="系统提示词前缀" desc="注入到每个会话开头的额外指令" divider={false}>
          <GlassButton>编辑</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
