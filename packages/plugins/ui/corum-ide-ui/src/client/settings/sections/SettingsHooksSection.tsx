/**
 * SettingsHooksSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import css from '../SettingsSections.module.css'

/* ── Hooks 与自动化 ────────────────────────────────────────────────── */

export function HooksSection() {
  return (
    <>
      <SettingGroup title="事件钩子">
        <SettingRow label="PreToolUse" desc="工具执行前触发，可用于审批或拦截">
          <SelectField value="none" options={[{id:'none',label:'无'},{id:'approve',label:'审批'},{id:'block',label:'拦截'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="PostToolUse" desc="工具执行后触发，可用于自动检查">
          <SelectField value="lint" options={[{id:'none',label:'无'},{id:'lint',label:'运行 lint'},{id:'test',label:'运行测试'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="Notification" desc="Agent 发出通知时触发" divider={false}>
          <SelectField value="none" options={[{id:'none',label:'无'},{id:'log',label:'记录日志'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="说明">
        <p className={css.hintText}>钩子脚本位于 ~/.corum/hooks/ 目录，使用 Node.js 编写。每个钩子接收事件数据并可通过返回值控制后续行为。</p>
      </SettingGroup>
    </>
  )
}
