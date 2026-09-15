/**
 * SettingsSubagentSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { useEffect, useState } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { useCorumSettings } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 子 Agent（全局默认配置：三级配置第一级；corum-subagent namespace）────────── */

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

const SUBAGENT_NS = 'corum-subagent'

export function SubagentSection() {
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
  const ns = snapshot.view?.namespaces.find(n => n.ns === SUBAGENT_NS)
  const resolved = (ns?.value ?? {}) as SubagentGlobalView
  const user = (ns?.user ?? {}) as SubagentGlobalView
  const writable = snapshot.view?.writable === true

  /** 单键写入（unset 清除回落默认；revision 防并发覆盖）。 */
  const apply = async (field: keyof SubagentGlobalView, value: unknown): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const ops = value === undefined
        ? [{ op: 'unset' as const, path: [field] }]
        : [{ op: 'set' as const, path: [field], value }]
      const res = await settings.mutate(SUBAGENT_NS, ops, ns?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const loading = snapshot.status === 'loading' || snapshot.status === 'idle'

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>
          子 Agent 的全局默认配置（三级配置第一级）。Agent 预设可逐键覆盖；未覆盖的键回落这里的值。
          留空 = 机制内置默认。research 实例（subagent_research）为只读实例，恒挂载、不可移除。
        </span>
      </div>
      {error !== null && <p className={css.hintText} style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}
      <SettingGroup title="隔离与并行">
        <SettingRow label="隔离模式" desc="可能并发的子 Agent 写任务隔离到独立 git worktree；单发前台写任务直接在主工作区改。需 git 工作区。">
          <SelectField
            value={user.isolationMode ?? ''}
            options={[
              { id: '', label: `默认（${resolved.isolationMode ?? 'write-tasks'}）` },
              { id: 'write-tasks', label: 'write-tasks · 并发写任务隔离' },
              { id: 'always', label: 'always · 凡召唤必隔离' },
              { id: 'off', label: 'off · 不隔离' },
            ]}
            disabled={!writable || busy || loading}
            onChange={v => { void apply('isolationMode', v === '' ? undefined : v) }}
          />
        </SettingRow>
        <SettingRow label="并行子 Agent 上限" desc="会话级并行召唤数上限（超出拒绝新召唤）。">
          <input
            className={css.textInput}
            defaultValue={user.maxParallelChildren !== undefined ? String(user.maxParallelChildren) : ''}
            placeholder={String(resolved.maxParallelChildren ?? 4)}
            disabled={!writable || busy || loading}
            onBlur={e => {
              const raw = e.target.value.trim()
              const n = Number.parseInt(raw, 10)
              void apply('maxParallelChildren', raw === '' ? undefined : (Number.isInteger(n) && n > 0 ? n : undefined))
            }}
          />
        </SettingRow>
        <SettingRow label="自动清理" desc="集成或会话结束后自动删除 worktree 与分支。" divider={false}>
          <Switch
            checked={user.autoCleanup ?? resolved.autoCleanup ?? true}
            disabled={!writable || busy || loading}
            onChange={v => { void apply('autoCleanup', v) }}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="集成">
        <SettingRow label="合并者" desc="parent=主 Agent 亲自合并（上下文全）；merger=集成专家身份汇报（当前为汇报格式差异，独立编排后续版本）。">
          <SelectField
            value={user.merger ?? ''}
            options={[
              { id: '', label: `默认（${resolved.merger ?? 'parent'}）` },
              { id: 'parent', label: 'parent · 主 Agent 合并' },
              { id: 'merger', label: 'merger · 集成专家汇报' },
            ]}
            disabled={!writable || busy || loading}
            onChange={v => { void apply('merger', v === '' ? undefined : v) }}
          />
        </SettingRow>
        <SettingRow label="集成核查命令（兜底）" desc="每行一条，仅在主 Agent 未声明验证方式时作为最低限度约束。推荐做法：主 Agent 发起 integrate 时按需声明本仓库的编译/运行/验证命令（它最懂这个仓库）；功能性验收由主 Agent 基于原始目标最终裁决。留空 = 按仓库形态自动探测兜底。" divider={false}>
          <textarea
            className={css.textInput}
            rows={3}
            defaultValue={user.integrateChecks?.join('\n') ?? ''}
            placeholder="（自动探测）"
            disabled={!writable || busy || loading}
            onBlur={e => {
              const lines = e.target.value.split('\n').map(s => s.trim()).filter(s => s !== '')
              void apply('integrateChecks', lines.length > 0 ? lines : undefined)
            }}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="默认模型">
        <SettingRow label="worker 子 Agent" desc="写任务召唤的固定模型（机制锁，设什么跑什么）；留空 = 跟随主 Agent。" divider={false}>
          <ModelPairField
            value={user.defaultModel}
            disabled={!writable || busy || loading}
            onChange={v => { void apply('defaultModel', v) }}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="research 子 Agent（只读实例）">
        <SettingRow label="默认模型" desc="只读研究召唤的固定模型；留空 = 同 worker。" divider={false}>
          <ModelPairField
            value={user.defaultResearchModel}
            disabled={!writable || busy || loading}
            onChange={v => { void apply('defaultResearchModel', v) }}
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/** 模型对字段（provider/model 两列；空 = 未设置跟随兜底）。 */
function ModelPairField({ value, disabled, onChange }: {
  value: { provider: string; model: string; reasoningEffort?: string } | undefined
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
