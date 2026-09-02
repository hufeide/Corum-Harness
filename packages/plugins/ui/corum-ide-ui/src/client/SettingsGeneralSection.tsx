/**
 * GeneralSection — 1:1 复刻 design.pen 通用页 (MEGzM)。
 *
 * 设计稿通用页结构：
 * - group-偏好: 界面语言(select) + 外观主题(select+badge) + 忙碌时回车行为(select)
 * - group-Agent 默认: 默认 Agent 预设(select+badge) + 默认权限预设(select) + 匿名使用统计(switch)
 *
 * 控件使用共享组件 SettingGroup/SettingRow/SelectField/Switch/Badge，
 * 数据为设计稿静态文案占位。
 */
import { SettingGroup } from './settings/SettingGroup.tsx'
import { SettingRow } from './settings/SettingRow.tsx'
import { SelectField } from './settings/SelectField.tsx'
import { Switch } from './settings/Switch.tsx'
import { Badge } from './settings/Badge.tsx'

const LANG_OPTIONS = [
  { id: 'zh', label: '简体中文' },
  { id: 'en', label: 'English' },
]
const THEME_OPTIONS = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' },
]
const ENTER_OPTIONS = [
  { id: 'queue', label: '排队' },
  { id: 'steer', label: '插入 steering' },
]
const PRESET_OPTIONS = [
  { id: 'standard', label: 'standard' },
  { id: 'reviewer', label: 'reviewer' },
  { id: 'researcher', label: 'researcher' },
]
const PERMISSION_OPTIONS = [
  { id: 'read-only', label: '只读' },
  { id: 'workspace-write', label: 'workspace-write' },
  { id: 'full', label: '完全访问' },
]

export function GeneralSection() {
  return (
    <>
      <SettingGroup title="偏好">
        <SettingRow
          label="界面语言"
          desc="界面显示语言，缺省跟随系统"
        >
          <SelectField value="zh" options={LANG_OPTIONS} onChange={() => {}} />
        </SettingRow>
        <SettingRow
          label="外观主题"
          desc="浅色 / 深色 / 跟随系统"
          badge={<Badge label="已修改" />}
        >
          <SelectField value="system" options={THEME_OPTIONS} onChange={() => {}} />
        </SettingRow>
        <SettingRow
          label="忙碌时回车行为"
          desc="Agent 运行中按回车：排队或插入 steering"
        >
          <SelectField value="queue" options={ENTER_OPTIONS} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="新会话默认">
        <SettingRow
          label="默认 Agent 预设"
          desc="新建会话默认挂载的预设"
          badge={<Badge label="重启后生效" variant="restart" />}
        >
          <SelectField value="standard" options={PRESET_OPTIONS} onChange={() => {}} />
        </SettingRow>
        <SettingRow
          label="默认权限预设"
          desc="新会话的沙箱与审批策略"
        >
          <SelectField value="workspace-write" options={PERMISSION_OPTIONS} onChange={() => {}} />
        </SettingRow>
        <SettingRow
          label="匿名使用统计"
          desc="帮助改进产品，不含任何代码内容"
        >
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
