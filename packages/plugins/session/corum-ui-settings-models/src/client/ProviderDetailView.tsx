/**
 * 供应商详情页（两级结构的中间层）：供应商配置卡（密钥 / API 地址(官方隐藏) /
 * 连通性测试）+ 其下已配置模型卡片网格（点进模型配置页）+ ＋添加模型。
 *
 * 密钥走 credentials/set（值永不过线；存储加密见 host 层 safeStorage 适配）。
 * 连通测试：官方目录路由读内置目录（catalog 友好结果），自定义路由走网络探测。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { deriveKeyRef, messageOf } from './store.ts'
import type { ModelsSettingsStore, ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelCard, ProviderCard } from './model-cards.ts'
import { collectProviderCards, priceOf, specsOf } from './model-cards.ts'
import { BrandLogo } from './brands.tsx'
import { useConnTest } from './useConnTest.ts'
import {
  BackRow, ConnResult, GlassButton, IconCpu, IconPlus, IconTrash, IconZap,
  SettingGroup, SettingRow, StatusPill,
} from './controls.tsx'
import styles from './ModelsSection.module.css'

type Snapshot = ReturnType<ModelsSettingsStore['store']['getSnapshot']>

export function ProviderDetailView({ provider, state, api, schema, onBack, onOpenModel, onAddModel, onChanged }: {
  provider: ProviderCard
  state: Snapshot
  api: ModelsWire
  schema: SettingsSchemaOperations
  onBack: () => void
  onOpenModel: (card: ModelCard) => void
  onAddModel: () => void
  onChanged: () => void
}): ReactNode {
  // 实时按 provider id 从最新 state 取供应商（增删模型后 reload 能反映，不依赖旧快照）。
  const liveProvider = collectProviderCards(state, schema).find(p => p.provider === provider.provider) ?? provider
  provider = liveProvider
  const isOfficial = provider.settingsNs === 'llm-deepseek'
  const keyRef = provider.apiKeyEnv ?? deriveKeyRef(provider.provider)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyConfigured, setKeyConfigured] = useState(provider.row.credential?.configured === true)
  const [baseURL, setBaseURL] = useState(provider.baseURL ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const conn = useConnTest(api)
  const disabled = busy || !state.writable

  /** 删除一个模型（从该供应商 profile.models[] 移除）。 */
  const removeModel = async (card: ModelCard): Promise<void> => {
    if (!window.confirm(`删除模型 ${card.modelId}？将从 ${provider.providerName} 的目录中移除。`)) return
    setBusy(true)
    setFailure(undefined)
    try {
      const namespace = state.namespaces.get(provider.settingsNs)
      const list = namespace === undefined ? [] : schema.getPath(namespace.value, [...provider.settingsPath, 'models'])
      const arr: Record<string, unknown>[] = Array.isArray(list)
        ? list.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && m.id !== card.modelId).map(m => ({ ...m }))
        : []
      const res = await api.settings.mutate(
        provider.settingsNs,
        [{ op: 'set', path: [...provider.settingsPath, 'models'], value: arr as unknown as import('@deepseek-ai/dsh-api-remotes/client').JsonValue }],
        namespace?.revision,
      )
      if (!res.ok) { setFailure(res.error.message); return }
      onChanged()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    try {
      if (keyDraft.trim() !== '') {
        const cred = await api.credentials.set(keyRef, keyDraft.trim())
        if (!cred.ok) { setFailure(cred.error.message); return }
        setKeyDraft('')
        setKeyConfigured(true)
      }
      if (!isOfficial) {
        const namespace = state.namespaces.get(provider.settingsNs)
        const res = await api.settings.mutate(
          provider.settingsNs,
          [{ op: 'set', path: [...provider.settingsPath, 'baseURL'], value: baseURL.trim() }],
          namespace?.revision,
        )
        if (!res.ok) { setFailure(res.error.message); return }
      }
      setSaved(true)
      onChanged()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles['section']}>
      <BackRow onBack={onBack} label="返回供应商列表" />

      {/* ── 供应商配置卡 ── */}
      <div className={styles['card']}>
        <span className={styles['cardHead']}>
          <span className={styles['cardHeadLeft']}>
            <BrandLogo brand={provider.brand} size={34} fallback={<IconCpu size={17} />} />
            <span className={styles['cardHeadTitle']}>
              <span className={styles['cardName']}>{provider.providerName}</span>
              <span className={styles['cardDesc']}>{provider.desc}</span>
            </span>
          </span>
          <span className={styles['cardHeadRight']}>
            <StatusPill tone={keyConfigured || provider.connected ? 'success' : 'dim'} label={keyConfigured || provider.connected ? '已连接' : '未配置'} />
          </span>
        </span>
        <div className={styles['hDivider']} />
        <SettingRow
          label="API 密钥"
          desc={`${keyRef} · ${keyConfigured ? '已配置——输入新值可替换' : '未配置'}`}
          control={(
            <input
              className={`${styles['textField']} ${styles['textFieldWide']}`}
              type="password"
              autoComplete="off"
              value={keyDraft}
              placeholder={keyConfigured ? '••••••••••••••••' : '输入 API 密钥'}
              disabled={disabled}
              onChange={e => { setKeyDraft(e.target.value); setSaved(false) }}
            />
          )}
        />
        {isOfficial ? null : (
          <SettingRow
            label="API 地址"
            desc="该供应商的 endpoint"
            control={(
              <input
                className={`${styles['textField']} ${styles['textFieldWide']}`}
                value={baseURL}
                placeholder="https://gateway.example/v1"
                disabled={disabled}
                onChange={e => { setBaseURL(e.target.value); setSaved(false) }}
              />
            )}
          />
        )}
        <SettingRow
          label="连通性测试"
          desc={isOfficial ? '官方目录路由 · 读取内置模型目录' : '向该供应商发送一次模型列表请求'}
          divider={false}
          control={(
            <>
              <ConnResult conn={conn} inline />
              <GlassButton icon={<IconZap size={12} />} disabled={conn.result.kind === 'busy'} onClick={() => {
                void conn.run({
                  settingsNs: provider.settingsNs,
                  provider: provider.provider,
                  baseURL: baseURL || undefined,
                  apiKey: keyDraft.trim() !== '' ? keyDraft.trim() : undefined,
                })
              }}>
                测试连接
              </GlassButton>
            </>
          )}
        />
        {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
        {saved ? <p className={styles['savedNotice']}>已保存。</p> : null}
        <div className={styles['footRight']}>
          <GlassButton kind="primary" disabled={disabled || (keyDraft.trim() === '' && (isOfficial || baseURL === provider.baseURL))} onClick={() => { void save() }}>
            {busy ? '保存中…' : '保存'}
          </GlassButton>
        </div>
      </div>

      {/* ── 已配置模型 ── */}
      <span className={styles['settingGroupTitle']}>已配置的模型</span>
      <div className={styles['cardGrid']}>
        {provider.cards.map(card => (
          <span key={card.modelId} className={styles['modelCardWrap']}>
            <button type="button" className={styles['modelCard']} onClick={() => { onOpenModel(card) }} aria-label={card.modelId}>
              <span className={styles['modelCardTop']}>
                <BrandLogo brand={card.brand} size={30} fallback={<IconCpu size={16} />} />
                <span className={styles['modelCardProv']}>{card.providerName}</span>
              </span>
              <span className={styles['modelCardName']}>{card.modelId}</span>
              <span className={styles['modelCardSpecs']}>{specsOf(card)}</span>
              <span className={styles['modelCardDiv']} />
              <span className={styles['modelCardPrice']}>{priceOf(card)}</span>
            </button>
            {/* 删除快捷入口（hover 显示，卡片右上） */}
            <button
              type="button"
              className={styles['modelCardDelete']}
              aria-label={`删除 ${card.modelId}`}
              title={`删除 ${card.modelId}`}
              disabled={disabled}
              onClick={(e) => { e.stopPropagation(); void removeModel(card) }}
            >
              <IconTrash size={13} />
            </button>
          </span>
        ))}
        <button type="button" className={styles['modelCardAdd']} onClick={onAddModel}>
          <IconPlus size={18} />
          <span>添加模型</span>
        </button>
      </div>
    </div>
  )
}

export { SettingGroup }
