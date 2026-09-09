/**
 * 添加模型 · 选择模型页（方案 A，单选）：锁定供应商顶栏（只读）+ 单选列表
 * （侦测到的可用模型，已配置的灰化禁选）+ 自定义输入 id + 下一步：配置模型。
 *
 * 与「配置新供应商」向导完全分离：无路径切换、无品牌网格、无 API Key（沿用
 * 供应商已配密钥）。侦测走该供应商的 llm/discoverModels。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { messageOf } from './store.ts'
import type { ModelsSettingsStore, ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelCard, ProviderCard } from './model-cards.ts'
import { formatCapacity } from './model-profile.ts'
import { catalogFallbackModels, isNoDiscoveryError } from './catalog-fallback.ts'
import { BrandLogo } from './brands.tsx'

import {
  BackRow, GlassButton, IconCpu, IconPlus, IconZap,
} from './controls.tsx'
import styles from './ModelsSection.module.css'

type Snapshot = ReturnType<ModelsSettingsStore['store']['getSnapshot']>

export function AddModelSelectView({ provider, state, api, schema, onBack, onNext }: {
  provider: ProviderCard
  state: Snapshot
  api: ModelsWire
  schema: SettingsSchemaOperations
  onBack: () => void
  /** 选定一个模型 id 进入下一步（新模型设置）。 */
  onNext: (modelId: string) => void
}): ReactNode {
  const [models, setModels] = useState<LlmDiscoveredModel[] | undefined>(undefined)
  const [detecting, setDetecting] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [catalog, setCatalog] = useState(false)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [customId, setCustomId] = useState('')

  // 已配置模型 id（灰化禁选）。
  const configured = new Set(provider.cards.map(c => c.modelId))

  const detect = async (): Promise<void> => {
    setDetecting(true)
    setFailure(undefined)
    setCatalog(false)
    try {
      // 自定义路由（pi-ai）需带 baseURL 才能探测；catalog 目录路由不用。
      const req: Record<string, unknown> = { provider: provider.provider }
      if (provider.baseURL !== undefined && provider.baseURL !== '') req.baseURL = provider.baseURL
      const res = await api.llm.discoverModels(provider.settingsNs, req as unknown as Parameters<ModelsWire['llm']['discoverModels']>[1])
      if (!res.ok) {
        // catalog 目录路由：discoverModels 不注册网络发现——读该 provider 自己的
        // 模型目录（profile 已解析 models → 内置 catalog 表），不是失败。
        if (isNoDiscoveryError(res.error.message)) {
          setCatalog(true)
          setModels(catalogFallbackModels(schema, state.namespaces.get(provider.settingsNs), provider.settingsPath, provider.provider))
          return
        }
        // pi-ai 无 catalog 路由且无法网络探测：给「手动输入」提示（非硬错误）。
        if (/ships no catalog/i.test(res.error.message)) {
          setModels([])
          setFailure('该供应商无法在线侦测模型 · 请用下方自定义输入模型 id 添加')
          return
        }
        setFailure(res.error.message)
        return
      }
      setModels(res.value)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setDetecting(false)
    }
  }

  // 进页自动侦测一次（官方目录路由返回内置目录，自定义走网络）。
  useEffect(() => { void detect() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [provider.provider])

  const effectiveSelected = customId.trim() !== '' ? customId.trim() : selected
  const canNext = effectiveSelected !== undefined && effectiveSelected !== '' && !configured.has(effectiveSelected)

  return (
    <div className={styles['section']}>
      <BackRow onBack={onBack} label={`返回 ${provider.providerName}`} />

      {/* 锁定供应商顶栏（只读） */}
      <span className={styles['lockedProvider']}>
        <BrandLogo brand={provider.brand} size={22} fallback={<IconCpu size={13} />} />
        <span className={styles['lockedProviderName']}>{provider.providerName}</span>
        <span className={styles['lockedProviderTag']}>· 已锁定</span>
      </span>

      <span className={styles['btnRowBetween']}>
        <span className={styles['settingGroupTitle']}>选择要添加的模型（单选）</span>
        <GlassButton icon={<IconZap size={12} />} disabled={detecting} onClick={() => { void detect() }}>
          {detecting ? '侦测中…' : '侦测可用模型'}
        </GlassButton>
      </span>

      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      {catalog
        ? <p className={styles['notice']}>该供应商使用内置模型目录（未发网络请求）。</p>
        : null}

      <div className={styles['fieldCol']} style={{ gap: 6 }}>
        {(models ?? []).map((m) => {
          const isConfigured = configured.has(m.id)
          const on = selected === m.id && customId.trim() === ''
          const spec = [
            m.contextWindow !== undefined ? formatCapacity(m.contextWindow) : null,
          ].filter(Boolean).join(' · ')
          return (
            <button
              key={m.id}
              type="button"
              disabled={isConfigured}
              className={`${styles['selRow']} ${on ? styles['selRowActive'] as string : ''} ${isConfigured ? styles['selRowDisabled'] as string : ''}`}
              onClick={() => { if (!isConfigured) { setSelected(m.id); setCustomId('') } }}
            >
              <span className={`${styles['radio']} ${on ? styles['radioOn'] as string : ''}`}>
                {on ? <span className={styles['radioInner']} /> : null}
              </span>
              <span className={styles['selRowId']}>{m.id}</span>
              {spec === '' ? null : <span className={styles['selRowSpec']}>{spec}</span>}
              {isConfigured ? <span className={styles['selRowTag']}>已配置</span> : null}
            </button>
          )
        })}
        <span className={styles['chipAdd']} style={{ alignSelf: 'flex-start' }}>
          <IconPlus size={13} />
          <input
            className={styles['chipInput']}
            value={customId}
            placeholder="自定义输入模型 id…"
            onChange={e => { setCustomId(e.target.value); setSelected(undefined) }}
          />
        </span>
      </div>

      <div className={styles['foot']}>
        <span />
        <span className={styles['footRight']}>
          <GlassButton onClick={onBack}>取消</GlassButton>
          <GlassButton kind="primary" disabled={!canNext} onClick={() => { if (effectiveSelected !== undefined) onNext(effectiveSelected) }}>
            下一步：配置模型
          </GlassButton>
        </span>
      </div>
    </div>
  )
}
