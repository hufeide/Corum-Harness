/**
 * SettingsPolishSection — 「AI 润色」设置页（设置 → 扩展 → AI 润色）。
 *
 * 2026-09-09 重建：本节曾随宿主端润色实现一起丢失（导航 id `ai-polish` 一直是死引用、
 * `.polishBlock` 系列样式却还在——见 docs/ide-formal/PROGRESS.md 第 50 轮）。本节只做
 * 配置读写（corumAgent.getPolishConfig / setPolishConfig），真正调用在 composer 的
 * sparkle 按钮（InputBar → polishDraft → corumAgent.polishConversation）。
 *
 * 引擎语义（PolishConfig.engine）：
 * - auto   ：本地引擎可用（已装/在跑/内存达标/有模型）走本地，否则线上
 * - local  ：固定本地 Ollama（需在「设置 → 扩展 → Ollama」装引擎并下模型）
 * - online ：固定线上模型（provider + model 来自模型目录）
 * provider/model 在 engine=local 时仍必填——auto 的线上回落与手动切 online 都用它。
 */

import { useCallback, useEffect, useState } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { GlassButton, useCorumRpc } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/** getPolishConfig 的 UI 视图（未配置为 null）。 */
interface PolishConfigView {
  provider: string
  model: string
  engine?: 'auto' | 'local' | 'online'
  localModel?: string
  reasoningEffort?: string
}

interface ProviderOption {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

/** 已部署的本地模型（corum-ollama status.models 的 UI 投影，字段同 PulledModel）。 */
interface LocalModelView {
  name: string
  size?: string
  sizeBytes?: number
  quantization?: string
  paramSize?: string
  /** 是否已激活（加载到内存）——润色优先用已激活的模型（免冷加载）。 */
  active?: boolean
}

interface LocalLlmStatusView {
  installed: boolean
  running: boolean
  totalMemGb: number
  meetsMinMem: boolean
  activeModelCount?: number
  maxActiveModels?: number
  models: LocalModelView[]
}

/** 下拉标签：参数/量化/占用拼成一行，激活态由调用方加前缀。 */
function localModelLabel(model: LocalModelView): string {
  const bits = [model.paramSize, model.quantization, model.size].filter((v): v is string => typeof v === 'string' && v !== '')
  return bits.length === 0 ? model.name : `${model.name} · ${bits.join(' · ')}`
}

const EFFORT_OPTIONS = [
  { id: '', label: '默认（不指定）' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
] as const

const ENGINE_OPTIONS = [
  { id: 'auto', label: '自动（本地优先，不可用回落线上）' },
  { id: 'local', label: '本地模型（Ollama）' },
  { id: 'online', label: '线上模型' },
] as const

export function PolishSection() {
  const rpc = useCorumRpc()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [local, setLocal] = useState<LocalLlmStatusView | null>(null)
  const [configured, setConfigured] = useState(false)

  const [engine, setEngine] = useState<'auto' | 'local' | 'online'>('auto')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [localModel, setLocalModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (rpc === null) {
      setLoading(false)
      return
    }
    setError(null)
    try {
      const [cfg, catalog] = await Promise.all([
        rpc<{ config: PolishConfigView | null }>('corumAgent', 'getPolishConfig', {}),
        rpc<{ providers: ProviderOption[] }>('corumAgent', 'listModels', {}),
      ])
      const list = catalog.providers ?? []
      setProviders(list)
      const current = cfg.config
      setConfigured(current !== null)
      if (current !== null) {
        setEngine(current.engine ?? 'auto')
        setProvider(current.provider)
        setModel(current.model)
        setLocalModel(current.localModel ?? '')
        setReasoningEffort(current.reasoningEffort ?? '')
      } else {
        // 未配置：预选模型目录里的第一个模型，省一次手动选择。
        const first = list.find(p => p.models.length > 0)
        setProvider(first?.id ?? '')
        setModel(first?.models[0]?.id ?? '')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
    // 本地引擎状态：localLlm 是可选服务（未挂载 corum-ollama 时不存在），失败静默。
    try {
      const status = await rpc<LocalLlmStatusView>('localLlm', 'status', {})
      setLocal(status)
      if (localModel === '') {
        // 默认选中第一个已激活模型（严格已激活：未激活的不进候选）。
        const preferred = status.models.find(m => m.active === true)
        if (preferred !== undefined) setLocalModel(preferred.name)
      }
    } catch {
      setLocal(null)
    }
  }, [rpc, localModel])

  useEffect(() => { void load() }, [load])

  const save = async (): Promise<void> => {
    if (rpc === null) return
    if (provider === '' || model === '') {
      setError('请先选择线上模型（provider + model）')
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const res = await rpc<{ ok: boolean }>('corumAgent', 'setPolishConfig', {
        engine,
        provider,
        model,
        ...(localModel.trim() === '' ? {} : { localModel: localModel.trim() }),
        ...(reasoningEffort === '' ? {} : { reasoningEffort }),
      })
      if (!res.ok) setError('保存失败：provider/model 不能为空')
      else {
        setConfigured(true)
        setSaved(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const modelOptions = providers.flatMap(p => p.models.map(m => ({ id: `${p.id}::${m.id}`, label: `${p.name} · ${m.name}` })))
  // 本地模型下拉：**只列本机已激活（加载到内存）的模型**（用户定调 2026-09-09：
  // 「严格已激活的，确保功能可用」——未激活模型首次调用要冷加载、可用性没保证）。
  // 也不允许手填模型 id：模型必须来自 Ollama 已部署且已激活的集合。
  const activatedModels = (local?.models ?? []).filter(m => m.active === true)
  const localModelOptions = activatedModels.map(m => ({ id: m.name, label: `● 已激活 · ${localModelLabel(m)}` }))
  const activatedCount = activatedModels.length
  const localReady = local !== null && local.installed && local.running && local.meetsMinMem && activatedCount > 0

  if (rpc === null) return <p className={css.hintText}>RPC 未就绪。</p>

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>
          「AI 润色」用于 composer 输入框右上角的 ✨ 按钮：结合最近对话上下文把草稿改写成
          意图更明确的输入。这里只决定「用哪个引擎/模型」。
        </span>
      </div>
      {error !== null && <p className={css.hintText} style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}

      {!configured && !loading && (
        <div className={css.polishChoice}>
          <div className={css.polishChoiceMeta}>
            <span className={css.polishChoiceTitle}>还没配置润色模型</span>
            <span className={css.polishDesc}>
              {localReady
                ? `检测到本地 Ollama 可用（内存 ${local.totalMemGb} GB，${activatedCount} 个已激活模型）——本地跑省钱、离线可用。`
                : '本机没有可用的本地引擎/已激活模型。可直接用线上模型，或先去「设置 → 扩展 → Ollama」装引擎并激活模型。'}
            </span>
          </div>
          <GlassButton
            variant="primary"
            disabled={busy}
            onClick={() => {
              setEngine(localReady ? 'auto' : 'online')
              if (localModel === '' && local !== null) {
                const preferred = local.models.find(m => m.active === true)
                if (preferred !== undefined) setLocalModel(preferred.name)
              }
              void save()
            }}
          >
            用推荐配置
          </GlassButton>
        </div>
      )}

      <SettingGroup title="润色引擎">
        <SettingRow label="引擎" desc="自动 = 本地可用走本地，否则线上；固定档位不受可用性影响（本地不可用会直接报错）。">
          <SelectField
            value={engine}
            options={[...ENGINE_OPTIONS]}
            disabled={busy || loading}
            onChange={id => { setEngine(id as 'auto' | 'local' | 'online'); setSaved(false) }}
          />
        </SettingRow>
        <SettingRow label="线上模型" desc="模型目录里的 provider · model；engine=auto 的线上回落也用它。">
          <SelectField
            value={provider === '' || model === '' ? '' : `${provider}::${model}`}
            options={modelOptions.length === 0 ? [{ id: '', label: '（模型目录为空）' }] : modelOptions}
            disabled={busy || loading || modelOptions.length === 0}
            onChange={(id) => {
              const [p, m] = id.split('::')
              setProvider(p ?? '')
              setModel(m ?? '')
              setSaved(false)
            }}
          />
        </SettingRow>
        <SettingRow
          label="本地模型"
          desc="只列本机**已激活**的 Ollama 模型（加载到内存、随取随用）；未激活的请先到「设置 → 扩展 → Ollama」激活。不提供手填模型 id。"
        >
          <SelectField
            /* 没有可选项时显示占位而不是历史配置值（模型可能已被卸载，别误导） */
            value={localModelOptions.length > 0 ? localModel : ''}
            options={localModelOptions.length > 0
              ? [{ id: '', label: '（自动：优先已激活的模型）' }, ...localModelOptions]
              : [{ id: '', label: local === null ? '（本地引擎未挂载）' : '（没有已激活的本地模型）' }]}
            disabled={busy || loading || localModelOptions.length === 0}
            onChange={(id) => { setLocalModel(id); setSaved(false) }}
          />
        </SettingRow>
        <SettingRow label="推理档位" desc="透传给模型适配器（low/medium/high）；「默认」= 不指定。">
          <SelectField
            value={reasoningEffort}
            options={[...EFFORT_OPTIONS]}
            disabled={busy || loading}
            onChange={(id) => { setReasoningEffort(id); setSaved(false) }}
          />
        </SettingRow>
        <SettingRow label="本地引擎状态" desc="来自「设置 → 扩展 → Ollama」的探测结果；未挂载该插件时不可用。" divider={false}>
          <span className={css.hintText}>
            {local === null
              ? '未安装/未挂载'
              : `${local.installed ? '已安装' : '未安装'} · ${local.running ? '服务运行中' : '服务未运行'} · 内存 ${local.totalMemGb} GB${local.meetsMinMem ? '' : '（不达标）'} · ${local.models.length} 个模型`}
          </span>
        </SettingRow>
      </SettingGroup>

      <div className={css.polishBlock}>
        <div className={css.polishRow}>
          <GlassButton variant="primary" disabled={busy || loading} onClick={() => { void save() }}>
            {busy ? '保存中…' : '保存'}
          </GlassButton>
          <GlassButton disabled={busy || loading} onClick={() => { void load() }}>重新读取</GlassButton>
          <span className={css.polishDesc}>
            {saved ? '已保存' : configured ? '已配置' : '未配置'}
          </span>
        </div>
      </div>
    </>
  )
}
