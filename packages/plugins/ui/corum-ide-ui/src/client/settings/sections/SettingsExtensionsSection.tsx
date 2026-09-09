/**
 * SettingsExtensionsSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Switch } from '../Switch.tsx'
import { GlassButton, useCorumRpc, useSectionNav } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 扩展面板 ──────────────────────────────────────────────────────── */

/* ── 插件管理（已装插件卡片 + 系统插件 + 详情；设置 section，原扩展面板重构）───── */

/** 已装插件条目投影（与 desktop host pluginManager.list 对齐）。 */
interface InstalledPluginEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  hasUi: boolean
  version?: string
  description?: string
  kind: 'plugin' | 'runtime'
}

/** 插件图标（JPG/PNG 头像，text_to_image 按名称生成；与 Agent 头像同机制，占位后续接真实图标）。 */
function pluginAvatarUrl(name: string): string {
  const prompt = encodeURIComponent(`minimalist flat app icon for a software plugin named "${name}", rounded square, soft gradient, centered, clean, high quality`)
  return `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${prompt}&image_size=square`
}

export function ExtensionsSection(props?: { renderTabSlot?: () => ReactNode }) {
  const renderTabSlot = props?.renderTabSlot
  const rpc = useCorumRpc()
  const sectionNav = useSectionNav()
  const [tab, setTab] = useState<'installed' | 'system'>('installed')
  const [entries, setEntries] = useState<InstalledPluginEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [detailId, setDetailId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (rpc === null) return
    try {
      const r = await rpc<{ entries: InstalledPluginEntry[] }>('pluginManager', 'list', {})
      setEntries(r.entries)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [rpc])

  useEffect(() => { void refresh() }, [refresh])

  const withBusy = useCallback(async (key: string, op: () => Promise<void>) => {
    setBusy(prev => new Set(prev).add(key))
    try { await op() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(key); return n })
    }
  }, [])

  const toggleEnabled = useCallback((entry: InstalledPluginEntry) => withBusy(entry.entryId, async () => {
    if (rpc === null) return
    await rpc('pluginManager', 'setEnabled', { entryId: entry.entryId, enabled: !entry.enabled })
    await refresh()
  }), [withBusy, rpc, refresh])

  const uninstall = useCallback((entry: InstalledPluginEntry) => withBusy(entry.entryId, async () => {
    if (rpc === null) return
    await rpc('pluginManager', 'uninstall', { entryId: entry.entryId })
    setDetailId(null)
    await refresh()
  }), [withBusy, rpc, refresh])

  const update = useCallback((entry: InstalledPluginEntry) => withBusy(entry.entryId, async () => {
    if (rpc === null) return
    await rpc('pluginManager', 'update', { spec: entry.moduleName })
  }), [withBusy, rpc])

  // 已装插件（kind=plugin，用户可插拔）与系统插件（kind=runtime，内置基元）分组。
  const installed = (entries ?? []).filter(e => e.kind === 'plugin')
  const system = (entries ?? []).filter(e => e.kind === 'runtime')

  // 「发现更多插件」：关闭设置面板 + 经 section 操作面打开插件中心市场浮层
  //（三-2 服务化：同 bundle 内 context 下发 → ctx.layout.openPluginManager
  // → grid actions 订阅面，原跨 bundle CustomEvent 广播已退役）。
  const discoverMore = useCallback(() => {
    sectionNav?.close()
    sectionNav?.openPluginManager()
  }, [sectionNav])

  const detailEntry = detailId !== null ? (entries ?? []).find(e => e.entryId === detailId) ?? null : null

  // ── 详情视图（点卡片进入）：图标 + 名称 + 版本号 + 更新日志占位 + 启停/更新/卸载 ──
  if (detailEntry !== null) {
    const entry = detailEntry
    return (
      <div className={css.pluginDetail}>
        <button type="button" className={css.backRowGhost} onClick={() => setDetailId(null)}>
          <ChevronLeft size={14} />返回插件管理
        </button>
        <div className={css.pluginDetailHead}>
          <img className={css.pluginDetailIcon} src={pluginAvatarUrl(entry.moduleName)} alt="" />
          <div className={css.pluginDetailNameCol}>
            <span className={css.pluginDetailName}>{entry.moduleName}</span>
            <span className={css.pluginDetailMeta}>{entry.version !== undefined ? `v${entry.version}` : '版本未知'}{entry.description !== undefined && entry.description !== '' ? ` · ${entry.description}` : ''}</span>
          </div>
        </div>
        {/* 更新日志（占位结构，后续接真实 changelog/版本历史） */}
        <div className={css.formGroup}>
          <div className={css.formGroupTitle}>更新日志</div>
          <div className={css.pluginChangelog}>
            <span className={css.hintText}>暂无更新日志（后续接入版本历史与 changelog）。</span>
          </div>
        </div>
        {/* 操作行：启用/禁用 + 更新 + 卸载 */}
        <div className={css.pluginDetailActions}>
          <GlassButton onClick={() => void toggleEnabled(entry)} disabled={busy.has(entry.entryId)}>
            {entry.enabled ? '禁用' : '启用'}
          </GlassButton>
          <GlassButton onClick={() => void update(entry)} disabled={busy.has(entry.entryId)}>更新</GlassButton>
          <GlassButton variant="danger" onClick={() => void uninstall(entry)} disabled={busy.has(entry.entryId)}>卸载</GlassButton>
        </div>
        {error !== null && <p className={css.hintText}>{error}</p>}
      </div>
    )
  }

  // ── 列表视图：标题行（发现更多插件）+ tab（已装/系统）+ 卡片网格 ──
  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>管理已安装与内置插件。点击卡片查看详情与操作。</span>
        <GlassButton variant="primary" onClick={discoverMore}>发现更多插件</GlassButton>
      </div>
      {/* 插件配置/列表 tab（Bash/Agent Loop/Web Search 配置卡 + 官方插件清单，
          经 settings.plugins.tab 槽由 corum-ui-settings-plugins + plugin-inventory
          注册——重构 2 决策 2：去掉独立「插件」入口，内容并入「插件管理」）。 */}
      {renderTabSlot !== undefined && renderTabSlot()}
      <div className={css.agentFilterRow}>
        {([['installed', '已装插件'], ['system', '系统插件']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`${css.agentDimPill}${tab === id ? ' ' + css.agentDimPillActive : ''}`}
            onClick={() => setTab(id)}
          >{label}</button>
        ))}
      </div>
      {error !== null && entries === null && <p className={css.hintText}>加载失败:{error}</p>}
      {entries === null && error === null && <p className={css.hintText}>加载中…</p>}
      {entries !== null && (
        <div className={css.pluginCardGrid}>
          {(tab === 'installed' ? installed : system).map(entry => (
            <div key={entry.entryId} className={css.pluginCard} onClick={() => setDetailId(entry.entryId)} role="button">
              <div className={css.pluginCardHead}>
                <img className={css.pluginCardIcon} src={pluginAvatarUrl(entry.moduleName)} alt="" />
                <div className={css.pluginCardNameCol}>
                  <span className={css.pluginCardName}>{entry.moduleName}</span>
                  <span className={css.pluginCardVer}>{entry.version !== undefined ? `v${entry.version}` : '—'}</span>
                </div>
                <ChevronRight size={14} className={css.agentChevron} />
              </div>
              {entry.description !== undefined && entry.description !== '' && (
                <span className={css.pluginCardDesc}>{entry.description}</span>
              )}
              <div className={css.pluginCardFoot} onClick={e => e.stopPropagation()}>
                <span className={`${css.pluginStateDot}${entry.enabled ? ' ' + css.pluginStateOn : ''}`} />
                <span className={css.pluginStateText}>{entry.enabled ? '已启用' : '已禁用'}</span>
                <div style={{ flex: 1 }} />
                <Switch checked={entry.enabled} onChange={() => void toggleEnabled(entry)} />
              </div>
            </div>
          ))}
          {(tab === 'installed' ? installed : system).length === 0 && (
            <p className={css.hintText}>{tab === 'installed' ? '暂无已装插件。' : '暂无系统插件。'}</p>
          )}
        </div>
      )}
    </>
  )
}
