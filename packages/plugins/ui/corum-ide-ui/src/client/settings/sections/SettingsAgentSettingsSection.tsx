/**
 * SettingsAgentSettingsSection — 智能体设置分区（PRD v2 §4.1）。
 *
 * ## 本分区是 M2 重构的核心
 *
 * 原有两个分区**合并**为本分区：
 * - `agent-loop`（「高级 Agent Loop」）—— 改名并扩容
 * - `subagent`（「子 Agent」）—— **并入**（用户 2026-09-16 第二批裁定：
 *   「子 Agent 并入智能体设置」）
 *
 * ⇒ 导航由 24 项收敛为 **23 项**（`nav-子 Agent` 不再单独存在）。
 *
 * ## 本轮同时移除的两个问题项
 *
 * 1. **「系统提示词前缀」（原 AS13）已删除** —— 用户裁定 `B4`
 *    「移除智能体设置的系统提示词前缀功能」+ `C1`「我的设计理念就是
 *    **以 Agent 为单位进行管控**，否则用户错误设置只符合特定场景的提示词，
 *    **会造成污染**」⇒ 全局提示词注入**不提供用户可写出口**，
 *    提示词/人格一律走 **Agent 预设**（§4.16）。⚠️ 不要恢复。
 * 2. **原「重试次数」「重试间隔」已删除** —— 这两项在 PRD §4.1 中**不存在**
 *    任何真源，属自造项；且原「最大并发数」默认值显示 `3`，
 *    与真源 `agent-loop.maxParallelToolCalls` 的默认值 **10** 不符
 *    （PRD §4.1.1：该键默认 10）—— 显示值本身就是错的。
 *
 * ## 真源（三个 settings namespace，字面量均自源码核实，非猜测）
 *
 * | 条目 | namespace | 字段 |
 * |---|---|---|
 * | AS2a 主 Agent 默认模型 | `agent-default-model` | `provider` / `model` / `reasoningEffort` |
 * | AS1 最大并行工具调用 | `agent-loop` | `maxParallelToolCalls` |
 * | AS15 默认 Agent 预设 | `agent-presets` | `default` |
 * | AS2b/AS2c/AS16~AS20 子 Agent | `corum-subagent` | 见下 |
 *
 * @module corum-ide-ui/client/settings/sections/SettingsAgentSettingsSection
 */

import { useEffect, useState } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { Badge } from '../Badge.tsx'
import { useCorumSettings } from '../shared.tsx'
import { ReviewRetentionGroup, AgentStallGroup } from './general-groups.tsx'
import css from '../SettingsSections.module.css'

/* ── 智能体设置（PRD §4.1）──────────────────────────────────────────── */

/** corum 子 Agent 全局配置（三级配置第一级）。 */
const SUBAGENT_NS = 'corum-subagent'
/** 官方：单步内并行安全工具调用上限。 */
const AGENT_LOOP_NS = 'agent-loop'
/** 官方：无会话级选择时的默认模型（`AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE`）。 */
const DEFAULT_MODEL_NS = 'agent-default-model'
/** 官方：默认挂载的 Agent 预设（`SETTINGS_NAMESPACE`）。 */
const PRESETS_NS = 'agent-presets'

/** corum-subagent 全局设置的用户层形（describe 镜像的 value/user 投影）。 */
interface SubagentGlobalView {
  isolationMode?: 'always' | 'write-tasks' | 'off'
  worktreeRoot?: string
  branchPrefix?: string
  autoCleanup?: boolean
  denyDirectFs?: boolean
  maxParallelChildren?: number
  integrateChecks?: string[]
  merger?: 'parent' | 'merger'
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  defaultResearchModel?: { provider: string; model: string; reasoningEffort?: string }
}

/** agent-loop 的用户层形。 */
interface AgentLoopView {
  maxParallelToolCalls?: number
}

/** agent-default-model 的形。 */
interface DefaultModelView {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** agent-presets 的形。 */
interface PresetsView {
  default?: string
}

/** 模型三元组（provider/model 两列；空 = 未设置跟随兜底）。 */
type ModelTriple = { provider: string; model: string; reasoningEffort?: string }

/**
 * 三级配置第一级：本页全局默认 → Agent 预设可逐键覆盖 → 未覆盖回落本页。
 *
 * 用户 `#3` 裁定的覆盖链：**预设（按角色覆盖） ＞ 本页全局 ＞ 跟随主 Agent**。
 *
 * @returns the merged agent settings section.
 */
export function AgentSettingsSection() {
  const settings = useCorumSettings()
  const [, force] = useState(0)
  // describe 镜像订阅（uSES 源；snapshot 变更即重渲染）。
  useEffect(() => {
    if (settings === null) return undefined
    void settings.describe.ensure()
    return settings.describe.subscribe(() => { force(v => v + 1) })
  }, [settings])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (settings === null) return <p className={css.hintText}>settings 服务未就绪。</p>
  const snapshot = settings.describe.getSnapshot()
  const namespaces = snapshot.view?.namespaces ?? []
  const writable = snapshot.view?.writable === true
  const loading = snapshot.status === 'loading' || snapshot.status === 'idle'

  /** 取某 namespace 的镜像条目（value=合成后值，user=用户层，revision 防并发）。 */
  const entryOf = (ns: string) => namespaces.find(n => n.ns === ns)

  const subEntry = entryOf(SUBAGENT_NS)
  const subResolved = (subEntry?.value ?? {}) as SubagentGlobalView
  const subUser = (subEntry?.user ?? {}) as SubagentGlobalView

  const loopResolved = (entryOf(AGENT_LOOP_NS)?.value ?? {}) as AgentLoopView
  const loopUser = (entryOf(AGENT_LOOP_NS)?.user ?? {}) as AgentLoopView

  const modelResolved = (entryOf(DEFAULT_MODEL_NS)?.value ?? {}) as DefaultModelView
  const modelUser = (entryOf(DEFAULT_MODEL_NS)?.user ?? {}) as DefaultModelView

  const presetsUser = (entryOf(PRESETS_NS)?.user ?? {}) as PresetsView

  /**
   * 单键写入（`unset` 清除回落默认；revision 防并发覆盖）。
   *
   * @param ns - 目标 settings namespace。
   * @param field - 字段名（顶层键）。
   * @param value - 新值；`undefined` 表示清除该键。
   */
  const apply = async (ns: string, field: string, value: unknown): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const ops = value === undefined
        ? [{ op: 'unset' as const, path: [field] }]
        : [{ op: 'set' as const, path: [field], value }]
      const res = await settings.mutate(ns, ops, entryOf(ns)?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 两键同时写入（模型对：provider + model 必须成对）。 */
  const applyPair = async (ns: string, a: string, av: unknown, b: string, bv: unknown): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const ops = av === undefined || bv === undefined
        ? [{ op: 'unset' as const, path: [a] }, { op: 'unset' as const, path: [b] }]
        : [{ op: 'set' as const, path: [a], value: av }, { op: 'set' as const, path: [b], value: bv }]
      const res = await settings.mutate(ns, ops, entryOf(ns)?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const disabled = !writable || busy || loading

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>
          智能体的全局默认配置。**Agent 预设可逐键覆盖本页**（预设 ＞ 本页 ＞ 跟随主 Agent）；
          未覆盖的键回落这里的值。提示词与人格一律走 Agent 预设 —— 本页刻意不提供全局提示词入口。
        </span>
      </div>
      {error !== null && <p className={css.hintText} style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}

      <SettingGroup title="默认模型">
        <SettingRow label="主 Agent 默认模型" desc={`没有会话级选择时的默认模型（必填）。当前：${modelResolved.provider ?? '未设置'} / ${modelResolved.model ?? '未设置'}`}>
          <ModelPairField
            value={modelUser.provider !== undefined && modelUser.model !== undefined
              ? {
                  provider: modelUser.provider,
                  model: modelUser.model,
                  // exactOptionalPropertyTypes：可选属性不能显式传 undefined，故条件展开。
                  ...(modelUser.reasoningEffort === undefined ? {} : { reasoningEffort: modelUser.reasoningEffort }),
                }
              : undefined}
            disabled={disabled}
            onChange={v => {
              void applyPair(DEFAULT_MODEL_NS, 'provider', v?.provider, 'model', v?.model)
            }}
          />
        </SettingRow>
        <SettingRow label="worker 子 Agent 默认模型" desc="写任务召唤的固定模型（机制锁，设什么跑什么）；留空 = 跟随主 Agent。">
          <ModelPairField
            value={subUser.defaultModel}
            disabled={disabled}
            onChange={v => { void apply(SUBAGENT_NS, 'defaultModel', v) }}
          />
        </SettingRow>
        <SettingRow label="research 子 Agent 默认模型" desc="只读研究召唤的固定模型；留空 = 同 worker。" divider={false}>
          <ModelPairField
            value={subUser.defaultResearchModel}
            disabled={disabled}
            onChange={v => { void apply(SUBAGENT_NS, 'defaultResearchModel', v) }}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="运行">
        <SettingRow label="最大并行工具调用" desc={`单步内同时执行的安全工具数上限（真源默认 ${loopResolved.maxParallelToolCalls ?? 10}）。`}>
          <input
            className={css.textInput}
            defaultValue={loopUser.maxParallelToolCalls !== undefined ? String(loopUser.maxParallelToolCalls) : ''}
            placeholder={String(loopResolved.maxParallelToolCalls ?? 10)}
            disabled={disabled}
            onBlur={e => {
              const raw = e.target.value.trim()
              const n = Number.parseInt(raw, 10)
              void apply(AGENT_LOOP_NS, 'maxParallelToolCalls', raw === '' ? undefined : (Number.isInteger(n) && n > 0 ? n : undefined))
            }}
          />
        </SettingRow>
        <SettingRow
          label="单轮工具调用次数上限"
          desc="每轮工具调用总数上限。⚠️ 官方内核**不存在该字段**，需先在 corum 侧新增调度层。"
          badge={<Badge label="未上线" variant="offline" />}
          divider={false}
        >
          <SelectField value="none" options={[{ id: 'none', label: '未上线' }]} onChange={() => { /* 未上线，已禁用 */ }} disabled />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="子 Agent · 隔离与并行">
        <SettingRow label="隔离模式" desc="可能并发的子 Agent 写任务隔离到独立 git worktree；单发前台写任务直接在主工作区改。需 git 工作区。">
          <SelectField
            value={subUser.isolationMode ?? ''}
            options={[
              { id: '', label: `默认（${subResolved.isolationMode ?? 'write-tasks'}）` },
              { id: 'write-tasks', label: 'write-tasks · 并发写任务隔离' },
              { id: 'always', label: 'always · 凡召唤必隔离' },
              { id: 'off', label: 'off · 不隔离' },
            ]}
            disabled={disabled}
            onChange={v => { void apply(SUBAGENT_NS, 'isolationMode', v === '' ? undefined : v) }}
          />
        </SettingRow>
        <SettingRow label="并行子 Agent 上限" desc="会话级并行召唤数上限（超出拒绝新召唤）。">
          <input
            className={css.textInput}
            defaultValue={subUser.maxParallelChildren !== undefined ? String(subUser.maxParallelChildren) : ''}
            placeholder={String(subResolved.maxParallelChildren ?? 4)}
            disabled={disabled}
            onBlur={e => {
              const raw = e.target.value.trim()
              const n = Number.parseInt(raw, 10)
              void apply(SUBAGENT_NS, 'maxParallelChildren', raw === '' ? undefined : (Number.isInteger(n) && n > 0 ? n : undefined))
            }}
          />
        </SettingRow>
        <SettingRow label="自动清理" desc="集成或会话结束后自动删除 worktree 与分支。" divider={false}>
          <Switch
            checked={subUser.autoCleanup ?? subResolved.autoCleanup ?? true}
            disabled={disabled}
            onChange={v => { void apply(SUBAGENT_NS, 'autoCleanup', v) }}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="子 Agent · 集成">
        <SettingRow label="合并者策略" desc="parent=主 Agent 亲自合并（上下文全）；merger=集成专家身份汇报（当前为汇报格式差异，独立编排后续版本）。">
          <SelectField
            value={subUser.merger ?? ''}
            options={[
              { id: '', label: `默认（${subResolved.merger ?? 'parent'}）` },
              { id: 'parent', label: 'parent · 主 Agent 合并' },
              { id: 'merger', label: 'merger · 集成专家汇报' },
            ]}
            disabled={disabled}
            onChange={v => { void apply(SUBAGENT_NS, 'merger', v === '' ? undefined : v) }}
          />
        </SettingRow>
        <SettingRow label="集成核查命令（兜底）" desc="每行一条，仅在主 Agent 未声明验证方式时作为最低限度约束。留空 = 按仓库形态自动探测兜底。" divider={false}>
          <textarea
            className={css.textInput}
            rows={3}
            defaultValue={subUser.integrateChecks?.join('\n') ?? ''}
            placeholder="（自动探测）"
            disabled={disabled}
            onBlur={e => {
              const lines = e.target.value.split('\n').map(s => s.trim()).filter(s => s !== '')
              void apply(SUBAGENT_NS, 'integrateChecks', lines.length > 0 ? lines : undefined)
            }}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Agent 预设">
        <SettingRow label="默认 Agent 预设" desc="新会话默认挂载哪个预设（`agent-presets.default`）。留空 = 用机制内置默认。" divider={false}>
          <input
            className={css.textInput}
            defaultValue={presetsUser.default ?? ''}
            placeholder="预设 id（如 corum-dev）"
            disabled={disabled}
            onBlur={e => {
              const raw = e.target.value.trim()
              void apply(PRESETS_NS, 'default', raw === '' ? undefined : raw)
            }}
          />
        </SettingRow>
      </SettingGroup>

      {/* 自原「通用」页迁入（2026-09-16 重组：通用页拆散，Agent 语义项归智能体）。
          改动审查保留 + Agent 执行阈值——它们是 Agent 行为/留痕，不属于应用级通用。 */}
      <ReviewRetentionGroup />
      <AgentStallGroup />
    </>
  )
}

/**
 * 模型对字段（provider/model 两列；空 = 未设置跟随兜底）。
 *
 * ⚠️ provider 与 model 必须**成对**写入 —— `agent-default-model` 的 schema
 * 把两者都标为 `.required()`，只写一半会留下不合法的半成品。
 *
 * @param props - value / disabled / onChange。
 * @returns the two-column model input.
 */
function ModelPairField({ value, disabled, onChange }: {
  value: ModelTriple | undefined
  disabled: boolean
  onChange: (v: { provider: string; model: string } | undefined) => void
}) {
  const [provider, setProvider] = useState(value?.provider ?? '')
  const [model, setModel] = useState(value?.model ?? '')
  return (
    <div className={css.selectStack}>
      <input
        className={css.textInput}
        value={provider}
        placeholder="provider（如 deepseek-official）"
        disabled={disabled}
        onChange={e => { setProvider(e.target.value) }}
        onBlur={() => {
          const p = provider.trim()
          const m = model.trim()
          onChange(p !== '' && m !== '' ? { provider: p, model: m } : undefined)
        }}
      />
      <input
        className={css.textInput}
        value={model}
        placeholder="model（如 deepseek-v4-flash）"
        disabled={disabled}
        onChange={e => { setModel(e.target.value) }}
        onBlur={() => {
          const p = provider.trim()
          const m = model.trim()
          onChange(p !== '' && m !== '' ? { provider: p, model: m } : undefined)
        }}
      />
    </div>
  )
}
