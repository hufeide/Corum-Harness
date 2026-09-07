/**
 * 模型配置页（点主页卡片进入，或侦测后配置）：品牌徽标卡头 + 容量（上下文/
 * 最大输出/思考模式）+ 能力（图片输入）+ 费用（缓存命中/未命中/输出）+ 连接
 * （API 地址/连通性测试）+ 底部（删除模型/取消/保存）。
 *
 * 写通路：per-model 字段写回 provider profile 的 models[]（settings/mutate set ops），
 * 费用写自建 pricing 字段，思考模式按协议族侦测档位。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ConfirmDialog } from '@corum/corum-ui-base/client'
import { messageOf } from './store.ts'
import type { ModelsSettingsStore, ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelCard } from './model-cards.ts'
import { formatCapacity, parseCapacity, readModel } from './model-profile.ts'
import { readModelThinking, reasoningEffortsOf, thinkingOptionsOf } from './reasoning.ts'
import { BrandLogo } from './brands.tsx'
import { useConnTest } from './useConnTest.ts'

import {
  BackRow, ConnResult, GlassButton, IconCpu, IconTrash, IconZap,
  SelectField, SettingGroup, SettingRow, StatusPill, Switch,
} from './controls.tsx'
import styles from './ModelsSection.module.css'

type Snapshot = ReturnType<ModelsSettingsStore['store']['getSnapshot']>

export function ModelConfigView({ card, state, api, schema, onBack, onChanged, isNew }: {
  card: ModelCard
  state: Snapshot
  api: ModelsWire
  schema: SettingsSchemaOperations
  onBack: () => void
  onChanged: () => void
  /** 新模型模式（添加模型第二步）：隐藏连接组、无删除钮、保存即把该模型加入 profile。 */
  isNew?: boolean
}): ReactNode {
  const namespace = state.namespaces.get(card.settingsNs)
  const base = namespace === undefined
    ? { id: card.modelId, imageInput: card.imageInput }
    : readModel(schema, namespace, card.settingsPath, card.modelId)

  const [ctx, setCtx] = useState(formatCapacity(base.contextWindow))
  const [maxOut, setMaxOut] = useState(formatCapacity(base.maxTokens))
  const [image, setImage] = useState(base.imageInput)
  const [priceHit, setPriceHit] = useState(base.pricing?.cacheHit?.toString() ?? '')
  const [priceMiss, setPriceMiss] = useState(base.pricing?.cacheMiss?.toString() ?? '')
  const [priceOut, setPriceOut] = useState(base.pricing?.output?.toString() ?? '')
  // API 地址从 provider profile 读（自定义 provider 的 endpoint 存这里；
  // catalog 路由无此字段则空，连通测试走适配器默认地址）。
  const [baseURL, setBaseURL] = useState(() => {
    if (namespace === undefined) return ''
    const url = schema.getPath(namespace.value, [...card.settingsPath, 'baseURL'])
    return typeof url === 'string' ? url : ''
  })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const conn = useConnTest(api)
  // deepseek 官方路由（llm-deepseek 整节）：隐藏 BaseURL、连通测试走 catalog 目录。
  const isDeepSeekOfficial = card.settingsNs === 'llm-deepseek'

  if (namespace === undefined) {
    // fork（corum）：无 settingsNs 的 route provider（如 Ollama 本地模型），
    // 模型由本地引擎管理，无需在设置页配置——显示只读信息而非报错。
    if (card.settingsNs === '') {
      return (
        <div className={styles['section']}>
          <BackRow onBack={onBack} />
          <div className={styles['card']}>
            <span className={styles['cardHead']}>
              <span className={styles['cardHeadLeft']}>
                <BrandLogo brand={card.brand} size={34} fallback={<IconCpu size={17} />} />
                <span className={styles['cardHeadTitle']}>
                  <span className={styles['cardName']}>{card.modelId}</span>
                  <span className={styles['cardDesc']}>本地模型 · 由 Ollama 引擎管理</span>
                </span>
              </span>
              <span className={styles['cardHeadRight']}>
                <StatusPill tone="success" label="已就绪" />
              </span>
            </span>
          </div>
          <SettingGroup title="基本信息">
            <SettingRow label="供应商" desc="本地推理引擎" control={<span style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)' }}>{card.providerName}</span>} />
            <SettingRow label="思考模式" desc="Ollama 支持 关闭/low/medium/high/max 五档思考。在 Agent 预设编辑页选择模型后可设置思考程度。" control={
              <SelectField
                value="off"
                options={[
                  { id: 'off', label: '关闭思考' },
                  { id: 'low', label: 'low · 轻量思考' },
                  { id: 'medium', label: 'medium · 标准思考' },
                  { id: 'high', label: 'high · 深度思考' },
                  { id: 'max', label: 'max · 最大思考' },
                ]}
                onChange={() => {}}
              />
            } />
            <SettingRow label="配置说明" desc="本地模型无需 API 密钥、无需配置端点。激活后在 Agent 预设中可选为驱动模型。" divider={true} control={<span />} />
          </SettingGroup>
        </div>
      )
    }
    return (
      <div className={styles['section']}>
        <BackRow onBack={onBack} />
        <p className={styles['error']}>{card.provider}: 无法解析设置命名空间。</p>
      </div>
    )
  }

  // 思考模式：按单个模型读档位（不翻译）。侦测到→该模型真实档位下拉；
  // 侦测不到→固定档 valuelist（off/low/medium/high/xhigh/max）下拉 + 「自定义…」入口（方案 C）。
  const modelThinking = readModelThinking(schema, namespace, card.settingsPath, card.modelId, card.family, card.provider)
  const [thinking, setThinking] = useState(modelThinking.current)
  const [customThinking, setCustomThinking] = useState('')
  // 仅当用户已配置了一个不在档位集合里的自定义档时，才默认进自定义输入框回显。
  const [showCustomThinking, setShowCustomThinking] = useState(
    !modelThinking.levels.includes(modelThinking.current) && modelThinking.current !== 'off',
  )
  const options = thinkingOptionsOf(modelThinking.levels)
  const thinkingDesc = modelThinking.detected
    ? `该模型支持：${modelThinking.levels.join(' / ')}`
    : '未识别该模型 · 默认档集（可自定义）'
  const disabled = busy || !state.writable

  const writeModels = async (mutate: (arr: Record<string, unknown>[], idx: number, next: Record<string, unknown>) => void): Promise<boolean> => {
    const list = schema.getPath(namespace.value, [...card.settingsPath, 'models'])
    const arr: Record<string, unknown>[] = Array.isArray(list)
      ? list.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null).map(m => ({ ...m }))
      : []
    const idx = arr.findIndex(m => m.id === card.modelId)
    const next: Record<string, unknown> = idx >= 0 ? { ...arr[idx] } : { id: card.modelId }
    mutate(arr, idx, next)
    const res = await api.settings.mutate(
      card.settingsNs,
      [{ op: 'set', path: [...card.settingsPath, 'models'], value: arr as unknown as JsonValue }],
      namespace.revision,
    )
    if (!res.ok) { setFailure(res.error.message); return false }
    return true
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    try {
      const ctxN = parseCapacity(ctx)
      const maxN = parseCapacity(maxOut)
      const ok = await writeModels((arr, idx, next) => {
        if (ctxN !== undefined) next.contextWindow = ctxN
        else delete next.contextWindow
        if (maxN !== undefined) next.maxTokens = maxN
        else delete next.maxTokens
        const inputKey = card.family === 'deepseek' ? 'inputModalities' : 'input'
        if (image) next[inputKey] = ['text', 'image']
        else delete next[inputKey]
        const thinkKey = card.family === 'deepseek' ? 'reasoningEffort' : 'reasoning'
        if (thinking !== '' && thinking !== 'off') next[thinkKey] = thinking
        else delete next[thinkKey]
        // 方案 A：pi-ai 族同步落 reasoningEfforts 能力集合（modelCatalog 的
        // efforts 读取源），让新建任务表单/composer 选择器能读到档位。
        if (card.family !== 'deepseek') {
          const efforts = reasoningEffortsOf(modelThinking.levels, next.reasoningEfforts)
          if (efforts !== undefined) next.reasoningEfforts = efforts
          else delete next.reasoningEfforts
        }
        // 费用（自建 pricing 字段）。
        const pricing: Record<string, number> = {}
        const ph = Number(priceHit)
        const pm = Number(priceMiss)
        const po = Number(priceOut)
        if (priceHit.trim() !== '' && Number.isFinite(ph)) pricing.cacheHit = ph
        if (priceMiss.trim() !== '' && Number.isFinite(pm)) pricing.cacheMiss = pm
        if (priceOut.trim() !== '' && Number.isFinite(po)) pricing.output = po
        if (Object.keys(pricing).length > 0) next.pricing = pricing
        else delete next.pricing
        if (idx >= 0) arr[idx] = next
        else arr.push(next)
      })
      if (!ok) return
      setSaved(true)
      onChanged()
      // 保存成功即返回上一级（主页卡片网格）。
      onBack()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  // 删除模型：点「删除模型」先开统一风格确认弹窗（pendingDelete），确认才执行。
  const [confirmDelete, setConfirmDelete] = useState(false)

  const remove = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const ok = await writeModels((arr, idx) => {
        if (idx >= 0) arr.splice(idx, 1)
      })
      if (!ok) return
      onChanged()
      onBack()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const desc = `${card.providerName} · ${image ? '文本 / 图片输入' : '文本输入'}`

  return (
    <div className={styles['section']}>
      <BackRow onBack={onBack} />

      <div className={styles['card']}>
        <span className={styles['cardHead']}>
          <span className={styles['cardHeadLeft']}>
            <BrandLogo brand={card.brand} size={34} fallback={<IconCpu size={17} />} />
            <span className={styles['cardHeadTitle']}>
              <span className={styles['cardName']}>{card.modelId}</span>
              <span className={styles['cardDesc']}>{desc}</span>
            </span>
          </span>
          <span className={styles['cardHeadRight']}>
            <StatusPill tone="success" label="已启用" />
          </span>
        </span>
      </div>

      <SettingGroup title="容量">
        <SettingRow
          label="上下文窗口"
          desc="单次请求最大 token 数（留空用提供方默认）"
          control={<input className={styles['textField']} value={ctx} placeholder="256K" disabled={disabled} onChange={e => { setCtx(e.target.value); setSaved(false) }} />}
        />
        <SettingRow
          label="最大输出 token 数"
          desc="单次响应最大生成 token 数"
          control={<input className={styles['textField']} value={maxOut} placeholder="32K" disabled={disabled} onChange={e => { setMaxOut(e.target.value); setSaved(false) }} />}
        />
        <SettingRow
          label="默认思考模式"
          desc={thinkingDesc}
          divider={false}
          control={(
            <span className={styles['settingControl']}>
              {showCustomThinking
                ? (
                  <input
                    className={styles['textField']}
                    value={customThinking}
                    placeholder="输入档位（如 high）"
                    disabled={disabled}
                    onChange={e => { setCustomThinking(e.target.value); setThinking(e.target.value || 'off'); setSaved(false) }}
                  />
                )
                : (
                  <SelectField
                    value={thinking}
                    options={[...options, { id: '__custom__', label: '自定义…' }]}
                    disabled={disabled}
                    ariaLabel="默认思考模式"
                    onChange={(id) => {
                      if (id === '__custom__') { setShowCustomThinking(true); setCustomThinking(''); setThinking('off') }
                      else { setThinking(id) }
                      setSaved(false)
                    }}
                  />
                )}
              {showCustomThinking && modelThinking.levels.length > 1
                ? (
                  <button type="button" className={styles['btnGhost']} onClick={() => { setShowCustomThinking(false) }}>
                    返回档位
                  </button>
                )
                : null}
            </span>
          )}
        />
      </SettingGroup>

      <SettingGroup title="能力">
        <SettingRow
          label="支持图片输入"
          desc="允许向该模型发送图片（多模态）"
          divider={false}
          control={<Switch on={image} disabled={disabled} ariaLabel="支持图片输入" onChange={(on) => { setImage(on); setSaved(false) }} />}
        />
      </SettingGroup>

      <SettingGroup title="费用">
        <PriceRow label="输入 · 缓存命中" desc="缓存命中时输入 token 单价" value={priceHit} disabled={disabled} onChange={(v) => { setPriceHit(v); setSaved(false) }} />
        <PriceRow label="输入 · 缓存未命中" desc="缓存未命中时输入 token 单价" value={priceMiss} disabled={disabled} onChange={(v) => { setPriceMiss(v); setSaved(false) }} />
        <PriceRow label="输出" desc="生成 token 单价" value={priceOut} disabled={disabled} divider={false} onChange={(v) => { setPriceOut(v); setSaved(false) }} />
      </SettingGroup>

      {/* 新模型模式：隐藏连接组（API 地址/连通测试是供应商级，沿用供应商的） */}
      {isNew === true ? null : (
        <SettingGroup title="连接">
          {/* deepseek 官方路由：隐藏 BaseURL（用官方默认地址），连通测试走 catalog 目录 */}
          {isDeepSeekOfficial ? null : (
            <SettingRow
              label="API 地址"
              desc="留空使用提供方默认地址"
              control={<input className={`${styles['textField']} ${styles['textFieldWide']}`} value={baseURL} placeholder="https://api.deepseek.com" disabled={disabled} onChange={e => { setBaseURL(e.target.value) }} />}
            />
          )}
          <SettingRow
            label="连通性测试"
            desc={isDeepSeekOfficial ? '官方目录路由 · 读取内置模型目录验证配置' : '向该模型发送一次最小请求验证配置'}
            divider={false}
            control={(
              <>
                <ConnResult conn={conn} inline />
                <GlassButton icon={<IconZap size={12} />} disabled={conn.result.kind === 'busy'} onClick={() => {
                  void conn.run({ settingsNs: card.settingsNs, provider: card.provider, baseURL: baseURL || undefined })
                }}>
                  测试连接
                </GlassButton>
              </>
            )}
          />
        </SettingGroup>
      )}

      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      {saved ? <p className={styles['savedNotice']}>已保存。</p> : null}

      <div className={styles['foot']}>
        {isNew === true
          ? <span />
          : (
            <GlassButton kind="ghost" icon={<IconTrash size={12} />} danger onClick={() => { setConfirmDelete(true) }} disabled={disabled}>
              删除模型
            </GlassButton>
          )}
        <span className={styles['footRight']}>
          <GlassButton onClick={onBack} disabled={busy}>取消</GlassButton>
          <GlassButton kind="primary" onClick={() => { void save() }} disabled={disabled}>
            {busy ? '保存中…' : isNew === true ? '加入模型' : '保存'}
          </GlassButton>
        </span>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="删除模型"
          message={`删除模型 ${card.modelId}？`}
          warning={`将从 ${card.providerName} 的目录中移除。`}
          tone="danger"
          confirmLabel="删除"
          busy={busy}
          busyLabel="删除中…"
          onConfirm={() => { setConfirmDelete(false); void remove() }}
          onCancel={() => { setConfirmDelete(false) }}
        />
      )}
    </div>
  )
}

/* ── 费用行（输入框 + 单位） ── */

function PriceRow({ label, desc, value, disabled, divider, onChange }: {
  label: string
  desc: string
  value: string
  disabled?: boolean
  divider?: boolean
  onChange: (v: string) => void
}): ReactNode {
  return (
    <SettingRow
      label={label}
      desc={desc}
      divider={divider}
      control={(
        <span className={styles['priceInput']}>
          <input
            className={styles['textField']}
            style={{ width: 90 }}
            value={value}
            placeholder="0"
            disabled={disabled}
            onChange={e => { onChange(e.target.value) }}
          />
          <span className={styles['priceUnit']}>¥ / M Token</span>
        </span>
      )}
    />
  )
}
