/**
 * GeneralSection — the shell-owned General settings section.
 *
 * P0-5（2026-09-14）：该条目收编为 `settings.general.item` 的渲染点（子槽
 * children 声明由 index.tsx 的本 section 条目携带，照官方 ui-settings-general
 * 的 General entry 形态）。官方契约：section 列只负责堆叠各 feature 注册的
 * 偏好行，不传 owner props（SettingsGeneralItemOwnerProps 是空标记）；行内的
 * 标题/描述/控件/写路径全部由注册方自带。官方 ui-theme（外观/字号）、
 * dsh-client-locale（界面语言）、ui-permission-presets（权限档）、
 * ui-conversation fork（忙碌时回车）、ui-chat fork（轨迹视图）、
 * session-archive（导入会话日志）都注册进这个槽。
 *
 * 此前这里的六行自绘假行（界面语言/外观主题/忙碌时回车/默认预设/权限档/
 * 匿名统计）是全空 onChange + 固定 value 的静态占位，其中「忙碌时回车」还是
 * composer-enter 真行的死副本——真行挂不进来（无渲染点），假行占位还静默
 * 无效，违反 §13.1「禁止外观可用而静默无效」。P0-5 全部删除：官方真行
 * 会注册进同一槽（ui-theme 挂载、已核实其 client 源码 slots.register
 * 'settings.general.item' id appearance/font-size），由官方插件自己拥有。
 *
 * ReviewRetentionGroup / AgentStallGroup 是真实现（接 settings.mutate），保留。
 */
import { useContext, useEffect, useState } from 'react'
import { SettingGroup } from './settings/SettingGroup.tsx'
import { SettingRow } from './settings/SettingRow.tsx'
import { SelectField } from './settings/SelectField.tsx'
import { CorumSettingsContext } from './settings/shared.tsx'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

/** Full section props: section owner share plus the item render share. */
export type GeneralSectionComponentProps =
  & PropsRenderSlots<'settings.general.item'>

export function GeneralSection({ renderSlot }: GeneralSectionComponentProps) {
  return (
    <>
      {/*
        M4「双入口归一」（PRD §4.13 + 用户第三批裁定「只留外观页」）：
        该槽共 7 个注册方，本页**只保留 2 个**，其余 5 个一律迁出（唯一入口在各自页面）：

        | id | 注册方 | 处置 |
        |---|---|---|
        | `language` | 官方 locale | ✅ **保留** |
        | `composer-enter` | 官方 ui-conversation / corum fork | ✅ **保留** |
        | `appearance` | 官方 ui-theme | ➖ 迁出 → **外观页**（唯一入口） |
        | `font-size` | 官方 ui-theme | ➖ 迁出 → **外观页**（= 会话正文字号） |
        | `permission` | 官方 ui-permission-presets | ➖ 迁出 → **权限页** |
        | `transcript-view` | 官方 ui-chat / corum fork | ➖ 迁出 → **高级页** |
        | `session-archive-import` | corum fork session-archive | ➖ 迁出 → **数据管理页** |

        ⚠️ **为什么用 `only` 过滤而不是删注册**：这些注册方多数是官方 plugin，本仓不能改；
        而子槽「声明即独占」（官方 ui-slots 注释：Declaring is claiming），
        别的分区也拿不到 renderSlot ⇒ **只能在本渲染点过滤**。若直接不过滤，
        同一个键就还有两个可写入口，正是 M4 要消除的问题。
      */}
      {renderSlot('settings.general.item', {}, { only: 'language' })}
      {renderSlot('settings.general.item', {}, { only: 'composer-enter' })}
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
      {error !== null && <p style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{error}</p>}
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
      {error !== null && <p style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{error}</p>}
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
