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
import { useContext, useEffect, useState } from 'react'
import { SettingGroup } from './settings/SettingGroup.tsx'
import { SettingRow } from './settings/SettingRow.tsx'
import { SelectField } from './settings/SelectField.tsx'
import { Switch } from './settings/Switch.tsx'
import { Badge } from './settings/Badge.tsx'
import { CorumSettingsContext } from './settings/shared.tsx'

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

      <WorkspaceGitGroup />
    </>
  )
}

/** corum-workspace namespace（与 host corum-git.ts 注册同 namespace/schema）。 */
const CORUM_WORKSPACE_NS = 'corum-workspace'

/**
 * 「工作区」设置组（fork corum，2026-09-09 用户需求）：新工作区始终初始化 git 开关。
 * 真实接数据（useCorumSettings + mutate），照 SubagentSection.autoCleanup 同款模式；
 * 本组件所在的 GeneralSection 此前是纯静态占位，本组是第一个真实持久化项。
 */
function WorkspaceGitGroup() {
  const settings = useContext(CorumSettingsContext)
  const [, force] = useState(0)
  useEffect(() => {
    if (settings === null) return undefined
    void settings.describe.ensure()
    return settings.describe.subscribe(() => { force(v => v + 1) })
  }, [settings])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // settings 面未 provide（如非 IDE 上下文）时降级隐藏本组。
  if (settings === null) return null
  const snapshot = settings.describe.getSnapshot()
  const ns = snapshot.view?.namespaces.find(n => n.ns === CORUM_WORKSPACE_NS)
  const user = (ns?.user ?? {}) as { autoInitGit?: boolean }
  const resolved = (ns?.value ?? {}) as { autoInitGit?: boolean }
  const writable = snapshot.view?.writable === true
  const loading = snapshot.status === 'loading' || snapshot.status === 'idle'

  const applyAutoInitGit = async (value: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await settings.mutate(CORUM_WORKSPACE_NS, [{ op: 'set' as const, path: ['autoInitGit'], value }], ns?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingGroup title="工作区">
      {error !== null && <p style={{ color: 'var(--dsw-alias-state-danger-primary)', fontSize: 12 }}>{error}</p>}
      <SettingRow
        label="新工作区始终初始化 git"
        desc="添加工作区时若不是 git 仓库则自动初始化（git init + 初始 commit）；关闭后每次添加时询问。子 Agent 并行隔离、声明式验证、集成合并依赖 git。"
        divider={false}
      >
        <Switch
          checked={user.autoInitGit ?? resolved.autoInitGit ?? true}
          disabled={!writable || busy || loading}
          onChange={v => { void applyAutoInitGit(v) }}
        />
      </SettingRow>
    </SettingGroup>
  )
}
