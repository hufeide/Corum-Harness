/**
 * SettingsRulesSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 规则与指令 ────────────────────────────────────────────────────── */

export function RulesSection() {
  return (
    <>
      <SettingGroup title="全局自定义指令">
        <div className={css.cmdArea}>
          <div className={css.cmdLine}># AGENTS.md — 全局自定义指令</div>
          <div className={css.cmdLine}>- 使用中文回答，代码注释保持英文</div>
          <div className={css.cmdLine}>- 修改前先列出计划，未经确认不要大范围重构</div>
          <div className={css.cmdLine}>- 提交信息遵循 Conventional Commits</div>
        </div>
        <div className={css.actionsRow}>
          <GlassButton>编辑</GlassButton>
        </div>
      </SettingGroup>
      <SettingGroup title="人格 Personality">
        <SettingRow label="人格预设" desc="决定 Agent 的沟通风格与行为倾向">
          <SelectField value="pragmatic" options={[{id:'pragmatic',label:'务实'},{id:'friendly',label:'友好'},{id:'concise',label:'简洁'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="启用自定义指令" desc="将上方全局指令注入到每个会话的系统提示词" divider={false}>
          <Switch checked={true} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
