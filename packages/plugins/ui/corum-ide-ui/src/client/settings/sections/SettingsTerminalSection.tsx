/**
 * SettingsTerminalSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import css from '../SettingsSections.module.css'

/* ── 终端 ──────────────────────────────────────────────────────────── */

export function TerminalSection() {
  return (
    <>
      <SettingGroup title="执行器">
        <SettingRow label="默认 shell" desc="新建终端会话使用的 shell 解释器">
          <SelectField value="bash" options={[{id:'bash',label:'bash'},{id:'zsh',label:'zsh'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="工作目录 cwd" desc="终端启动时的初始工作目录">
          <input className={css.textInput} placeholder="~/workspace" defaultValue="~/workspace" />
        </SettingRow>
        <SettingRow label="超时 timeoutMs" desc="单次命令执行的最长等待时间">
          <SelectField value="120" options={[{id:'60',label:'60s'},{id:'120',label:'120s'},{id:'300',label:'300s'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="最大超时 maxTimeoutMs" desc="超时上限，超过将被强制终止">
          <SelectField value="600" options={[{id:'300',label:'300s'},{id:'600',label:'600s'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="最大输出 maxOutputBytes" desc="命令输出的最大保留字节数" divider={false}>
          <SelectField value="64" options={[{id:'32',label:'32 KB'},{id:'64',label:'64 KB'},{id:'128',label:'128 KB'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="外观">
        <SettingRow label="终端字体" desc="终端使用的等宽字体">
          <SelectField value="jbm" options={[{id:'jbm',label:'JetBrains Mono'},{id:'mono',label:'Menlo'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="字号" desc="终端文字大小（px）" divider={false}>
          <SelectField value="13" options={[{id:'12',label:'12'},{id:'13',label:'13'},{id:'14',label:'14'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
