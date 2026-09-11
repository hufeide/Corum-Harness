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

      <ReviewRetentionGroup />
      <AgentStallGroup />
    </>
  )
}

/** corum-review settings namespace（与 host corum-review.ts 注册同 namespace/schema）。 */
const CORUM_REVIEW_NS = 'corum-review'

/** 保留天数候选（默认 1 天）。0 = 不保留轮次历史（只留已接受的现状）。 */
const RETENTION_OPTIONS = [
  { id: '1', label: '1 天' },
  { id: '3', label: '3 天' },
  { id: '7', label: '7 天' },
  { id: '14', label: '14 天' },
  { id: '30', label: '30 天' },
  { id: '90', label: '90 天' },
  { id: '0', label: '不保留（只留当前轮）' },
]

/**
 * 「改动审查」设置组（2026-09-11 用户要求：默认保留 1 天，并在设置里可改天数）。
 *
 * 这一项控制 host 影子 git 仓库里**轮次历史**的保留时长：超过天数的轮次会被
 * prune 掉（连带 gc 回收对象），磁盘因此有硬上限。当前轮与已接受状态不受影响。
 *
 * 只负责写设置；真正的 host 推送由 corum-ui-chat 订阅该 namespace 后调
 * `corumReview/setRetention`（host 侧没有 settings 读取面）。
 */
function ReviewRetentionGroup() {
  const settings = useContext(CorumSettingsContext)
  const [, force] = useState(0)
  useEffect(() => {
    if (settings === null) return undefined
    void settings.describe.ensure()
    return settings.describe.subscribe(() => { force(v => v + 1) })
  }, [settings])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (settings === null) return null

  const snapshot = settings.describe.getSnapshot()
  const ns = snapshot.view?.namespaces.find(n => n.ns === CORUM_REVIEW_NS)
  const user = (ns?.user ?? {}) as { retentionDays?: number }
  const resolved = (ns?.value ?? {}) as { retentionDays?: number }
  const writable = snapshot.view?.writable === true
  const loading = snapshot.status === 'loading' || snapshot.status === 'idle'
  const current = user.retentionDays ?? resolved.retentionDays ?? 1

  const apply = async (value: number): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await settings.mutate(CORUM_REVIEW_NS, [{ op: 'set' as const, path: ['retentionDays'], value }], ns?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingGroup title="改动审查">
      {error !== null && <p style={{ color: 'var(--dsw-alias-state-danger-primary)', fontSize: 12 }}>{error}</p>}
      <SettingRow
        label="轮次历史保留天数"
        desc="Agent 每轮改动都会记进一个独立的影子 git 仓库（只存被改动的文件）。超过这个天数的轮次历史会被清理，磁盘占用因此有上限；当前轮与已接受的内容不受影响。"
        divider={false}
      >
        <SelectField
          value={String(current)}
          options={RETENTION_OPTIONS}
          disabled={!writable || busy || loading}
          onChange={id => { void apply(Number(id)) }}
        />
      </SettingRow>
    </SettingGroup>
  )
}

/** corum-agent settings namespace（与 host corum-agent/index.ts 注册同 namespace/schema）。 */
const CORUM_AGENT_NS = 'corum-agent'

/** 自动恢复阈值候选（分钟）。默认 10。 */
const STALL_OPTIONS = [
  { id: '2', label: '2 分钟' },
  { id: '5', label: '5 分钟' },
  { id: '10', label: '10 分钟（默认）' },
  { id: '20', label: '20 分钟' },
  { id: '30', label: '30 分钟' },
  { id: '60', label: '60 分钟' },
]

/**
 * 「Agent 执行」设置组（C4，2026-09-11 用户要求把卡住恢复阈值配置化）。
 *
 * 阈值语义：执行中的任务**多久没有活动**就判定为卡住，主动 cancel 该 turn 并让任务
 * 重排队。项目制扫描与 task 泳道共用这一个值。
 * 太小会打断正常的长工具执行（bash 工具自身超时 300s），默认 10 分钟是经验值。
 */
function AgentStallGroup() {
  const settings = useContext(CorumSettingsContext)
  const [, force] = useState(0)
  useEffect(() => {
    if (settings === null) return undefined
    void settings.describe.ensure()
    return settings.describe.subscribe(() => { force(v => v + 1) })
  }, [settings])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (settings === null) return null

  const snapshot = settings.describe.getSnapshot()
  const ns = snapshot.view?.namespaces.find(n => n.ns === CORUM_AGENT_NS)
  const user = (ns?.user ?? {}) as { stallRecoverMinutes?: number }
  const resolved = (ns?.value ?? {}) as { stallRecoverMinutes?: number }
  const writable = snapshot.view?.writable === true
  const loading = snapshot.status === 'loading' || snapshot.status === 'idle'
  const current = user.stallRecoverMinutes ?? resolved.stallRecoverMinutes ?? 10

  const apply = async (value: number): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await settings.mutate(CORUM_AGENT_NS, [{ op: 'set' as const, path: ['stallRecoverMinutes'], value }], ns?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingGroup title="Agent 执行">
      {error !== null && <p style={{ color: 'var(--dsw-alias-state-danger-primary)', fontSize: 12 }}>{error}</p>}
      <SettingRow
        label="卡住自动恢复阈值"
        desc="执行中的任务多久没有任何活动就判定为卡住：主动中断该轮并让任务重排队，避免永久挂起。设太小会打断正常的长时间工具执行（bash 工具自身超时 5 分钟）。"
        divider={false}
      >
        <SelectField
          value={String(current)}
          options={STALL_OPTIONS}
          disabled={!writable || busy || loading}
          onChange={id => { void apply(Number(id)) }}
        />
      </SettingRow>
    </SettingGroup>
  )
}
