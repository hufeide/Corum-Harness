/**
 * SettingsPermissionsSection — 权限分区（PRD v2 §4.6）。
 *
 * ## M4「双入口归一」+ 控件归一
 *
 * 1. **双入口消除**：通用页（`settings.general.item` 槽）里官方
 *    `ui-permission-presets` 注册的 `permission` 行已移除，
 *    **唯一入口 = 本页**（PRD §4.13 GE-d，用户第二批裁定）。
 * 2. **三控件归一**：本页原先有「沙箱模式」「审批策略」「危险完全访问」**三个控件**，
 *    但真源里它们**不是三个独立字段** —— `permission` ns **只有 `defaultPreset` 一个字段**，
 *    而预设表把 `sandbox` 与 `approval` **绑在一起**变（`bundle/base/cordis.patch.yml:235-247`）：
 *
 *    | 预设 id | sandbox | approval |
 *    |---|---|---|
 *    | `read-only` | `read-only` | `ask` |
 *    | `workspace-write` | `workspace-write` | `ask` |
 *    | `danger-full-access` | `danger-full-access` | `never` |
 *
 *    ⇒ 三个独立控件**在结构上不可能生效**（改「审批策略」却不换预设是写不进去的）。
 *    现归一为**一个三档选择器**（PRD §4.6 PE1/PE2/PE3）。
 *
 * ⚠️ 原设计稿**缺「只读」档**（只有 workspace-write 与 danger-full-access 的对应控件），
 * 现按真源补全三档。
 *
 * ## 未就绪项（PRD §6.1：禁用 + 标「未上线」）
 *
 * - **PE4 自动授权**：用户 2026-09-16「增加一个自动授权，后续开发这个功能，
 *   当前**占位不可选**提示规划中」⇒ 渲染为**不可选**的「规划中」。
 * - **PE5/PE6 允许/禁止规则**：`permission` ns **无 allow/deny 列表字段**，需新建。
 *   设计注明「**deny 优先于 allow**」（PRD §4.6）。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsPermissionsSection
 */

import { useContext, useEffect, useState } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'
import { CorumSettingsContext } from '../shared.tsx'

/* ── 权限（PRD §4.6）──────────────────────────────────────────────── */

/** 官方权限预设插件拥有的设置 namespace（`PERMISSION_SETTINGS_NAMESPACE`）。 */
const PERMISSION_NS = 'permission'

/** 预设字段（该 ns 的**唯一**用户可写字段）。 */
const PRESET_FIELD = 'defaultPreset'

/**
 * 三档预设（id 取自 `bundle/base/cordis.patch.yml` 的 presets 表；顺序＝保护由强到弱）。
 * ⚠️ 这是**真源里实际存在的 3 个 id**，不是自造枚举。
 */
const PRESET_OPTIONS = [
  { id: 'read-only', label: '只读 read-only · 审批：每次询问' },
  { id: 'workspace-write', label: '工作区可写 workspace-write · 审批：每次询问' },
  { id: 'danger-full-access', label: '危险完全权限 danger-full-access · 不询问' },
]

/** 未上线 badge（PRD §6.1）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/** 空回调：未上线控件均 `disabled`，此函数不可达。 */
const noop = () => { /* 控件已禁用，不可达 */ }

/** `permission` 的用户层形。 */
interface PermissionView {
  defaultPreset?: string
}

/**
 * 权限分区：单一三档预设 + 规划中的自动授权 + 未上线的允许/禁止规则。
 *
 * @returns the permissions settings section.
 */
export function PermissionsSection() {
  const settings = useContext(CorumSettingsContext)
  const [, force] = useState(0)
  useEffect(() => {
    if (settings === null) return undefined
    void settings.describe.ensure()
    return settings.describe.subscribe(() => { force(v => v + 1) })
  }, [settings])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (settings === null) return <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>settings 服务未就绪。</p>

  const snapshot = settings.describe.getSnapshot()
  const ns = snapshot.view?.namespaces.find(n => n.ns === PERMISSION_NS)
  const user = (ns?.user ?? {}) as PermissionView
  const resolved = (ns?.value ?? {}) as PermissionView
  const writable = snapshot.view?.writable === true
  const loading = snapshot.status === 'loading' || snapshot.status === 'idle'
  const disabled = !writable || busy || loading

  const current = user.defaultPreset ?? resolved.defaultPreset ?? 'workspace-write'
  const overridden = user.defaultPreset !== undefined

  /**
   * 写入默认预设。
   *
   * @param preset - 预设 id。
   */
  const apply = async (preset: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await settings.mutate(PERMISSION_NS, [{ op: 'set' as const, path: [PRESET_FIELD], value: preset }], ns?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {error !== null && <p style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{error}</p>}
      <SettingGroup title="权限预设（三选一）">
        <SettingRow
          label="新会话默认权限"
          desc="沙箱范围与审批策略是**一个预设的两个面**，不能分别设置：每个预设同时决定能写哪里、以及何时问你。"
          badge={overridden ? <Badge label="已修改" /> : undefined}
        >
          <SelectField
            value={current}
            options={PRESET_OPTIONS}
            disabled={disabled}
            onChange={id => { void apply(id) }}
          />
        </SettingRow>
        <SettingRow
          label="自动授权"
          desc="由模型自动判断并授予权限，无需人工确认。**规划中**：当前不可选。"
          badge={<Badge label="规划中" variant="soon" />}
          divider={false}
        >
          <SelectField value="planned" options={[{ id: 'planned', label: '规划中' }]} onChange={noop} disabled />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="工具规则">
        <SettingRow label="允许规则" desc="这些工具调用无需审批即可执行（fs.read / shell.exec / web.search）" badge={OFFLINE}>
          <GlassButton disabled>编辑</GlassButton>
        </SettingRow>
        <SettingRow label="禁止规则" desc="这些工具调用将被直接拒绝（fs.write:/etc / shell.exec:sudo / net.raw）。⚠️ deny 优先于 allow" badge={OFFLINE} divider={false}>
          <GlassButton disabled>编辑</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
