/**
 * SettingsExtensionsSection — 设置 › 扩展 ›「插件管理」（= 已装插件管理）。
 *
 * 2026-09-12 重建：把插件中心浮层（corum-ide-plugin-manager-ui 的 list 视图）的
 * 行为与视觉迁进设置 section，视觉对齐 doc/UXDesign/design.pen 帧 zOmcc 的
 * w8h6DG content 的 body（Gyvyc）。设置壳的 content 容器自带 header（标题 56 +
 * 分隔线），故本 section 只画 body 三段（tabs / scope+filter / 卡片网格）+
 * 顶部「发现更多插件」行。
 *
 * 分区：
 *   - 已装插件（kind=plugin）：pluginManager.list 投影，卡片 = icon-box + 名称/
 *     版本/徽标 + 介绍 + 开关/设置/卸载。
 *   - 系统插件（kind=runtime）：cordis/dsh 运行时基元，只读（开关禁用、无卸载）。
 *   - 「视图管理」tab 未迁入：设置页没有网格注入面，它留在浮层。
 *   - 详情视图：点卡片进，数据走 pluginManager/detail（页面初始不批量拉）。
 *
 * 顶部「发现更多插件」保留原行为：关闭设置 + 打开插件中心浮层。
 *
 * 色值一律走 --corum-* / --dsw-alias-* token（见 SettingsSections.module.css 的
 * .plg* 块），本文件不出现裸 hex。
 * @module corum-ide-ui/client/settings/sections/SettingsExtensionsSection
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Cable, ChevronDown, ChevronLeft, Cpu, KeyRound, Puzzle, Search, Server, ServerCog,
  Terminal, Trash2,
} from 'lucide-react'
import { GlassButton, useCorumRpc, useSectionNav } from '../shared.tsx'
import { fallbackName, pluginMeta } from '../plugin-meta.ts'
import css from '../SettingsSections.module.css'

/* ── 数据投影（与 desktop host pluginManager 的 wire 形状对齐）─────────────── */

/** pluginManager.list 的一条条目投影。 */
interface InstalledPluginEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  readonly hasUi: boolean
  readonly version?: string
  readonly description?: string
  readonly kind: 'plugin' | 'runtime'
}

/** pluginManager.detail 的详情投影。 */
interface PluginDetail {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: InstalledPluginEntry['fiberPhase']
  readonly hasUi: boolean
  readonly kind: 'plugin' | 'runtime'
  readonly origin: 'official' | 'corum' | 'third-party'
  readonly version?: string
  readonly description?: string
  readonly publisher?: string
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly keywords?: readonly string[]
}

/** 变更类操作的结果（restartRequired = 需重启 host 生效）。 */
interface MutationResult {
  readonly ok: boolean
  readonly restartRequired: boolean
  readonly log?: string
}

/** 桌面 preload 桥上本 section 用到的面。 */
interface RestartBridge {
  restartHost?: () => Promise<{ ok: boolean }>
}

/** 列表视图的两个 tab。 */
type PanelTab = 'installed' | 'system'

/** scope 分段：全局（全部条目）/ 本项目（@corum/* 自带插件）。 */
type ScopeMode = 'global' | 'project'

/** 状态下拉的三档。 */
type StatusFilter = 'all' | 'on' | 'off'

/** 状态下拉文案（design.pen：值「全部状态」）。 */
const STATUS_LABEL: Readonly<Record<StatusFilter, string>> = {
  all: '全部状态',
  on: '已启用',
  off: '已停用',
}

/* ── 展示映射（与插件中心同口径）─────────────────────────────────────────── */

/** 展示名：优先中文元数据表，否则回退格式化包名。 */
function displayName(moduleName: string): string {
  return pluginMeta(moduleName)?.zhName ?? fallbackName(moduleName)
}

/** 展示介绍：优先中文，否则回退英文 description。 */
function displayDesc(moduleName: string, description?: string): string {
  return pluginMeta(moduleName)?.zhDesc ?? description ?? ''
}

/** 来源标签的中文。 */
function originLabel(origin: PluginDetail['origin']): string {
  return origin === 'official' ? '官方' : origin === 'corum' ? '本项目' : '第三方'
}

/** 运行态文案。 */
function phaseLabel(entry: { fiberPhase: InstalledPluginEntry['fiberPhase']; enabled: boolean }): string {
  if (!entry.enabled) return '已停用'
  if (entry.fiberPhase === 'active') return '运行中'
  return entry.fiberPhase ?? '已启用'
}

/**
 * 卡片徽标（design.pen：可选徽标 fill $brand-primary）。只给有真实依据的两类：
 * 基础能力 = 不可关闭的 corum 基础能力插件（kind=runtime 且有界面半）；
 * 第三方 = 非官方/非本项目的包。其余卡片不带徽标。
 */
function badgeOf(entry: InstalledPluginEntry): string | null {
  if (entry.kind === 'runtime' && entry.hasUi) return '基础能力'
  if (!entry.moduleName.startsWith('@corum/') && !entry.moduleName.startsWith('@deepseek-ai/')) return '第三方'
  return null
}

/** 卡片图标（lucide glyph，17px，按包名语义映射）。 */
function entryIcon(moduleName: string, size: number): ReactNode {
  const n = moduleName.toLowerCase()
  if (/mcp/.test(n)) return <ServerCog size={size} />
  if (/serial|uart|modbus/.test(n)) return <Cable size={size} />
  if (/ssh|sftp/.test(n)) return <KeyRound size={size} />
  if (/terminal|shell|pty|panel-bottom/.test(n)) return <Terminal size={size} />
  if (/model|llm|ollama|artgen/.test(n)) return <Cpu size={size} />
  if (/skill|agent|orchestrat|subagent/.test(n)) return <Puzzle size={size} />
  if (/server|api|remote|connection|desktop|session/.test(n)) return <Server size={size} />
  return <Puzzle size={size} />
}

/* ── section ──────────────────────────────────────────────────────────────── */

export function ExtensionsSection(props?: { renderTabSlot?: () => ReactNode }) {
  const renderTabSlot = props?.renderTabSlot
  const rpc = useCorumRpc()
  const sectionNav = useSectionNav()

  const [tab, setTab] = useState<PanelTab>('installed')
  const [scope, setScope] = useState<ScopeMode>('global')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [statusOpen, setStatusOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<readonly InstalledPluginEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)

  // 详情视图：detailId 非 null 时替换 tabs / filter / 卡片网格三段。
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // 状态下拉：点外部关闭（纯组件本地 effect，同插件中心 selectRef 模式）。
  const selectRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!statusOpen) return
    const onDown = (e: MouseEvent): void => {
      if (selectRef.current !== null && !selectRef.current.contains(e.target as Node)) setStatusOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [statusOpen])

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
    try { await op() } catch (e) { setNotice(e instanceof Error ? e.message : String(e)) } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(key); return n })
    }
  }, [])

  const onToggleEnabled = useCallback((entry: InstalledPluginEntry) => withBusy(entry.entryId, async () => {
    if (rpc === null) return
    await rpc('pluginManager', 'setEnabled', { entryId: entry.entryId, enabled: !entry.enabled })
    await refresh()
  }), [withBusy, rpc, refresh])

  const onUninstall = useCallback((entry: { entryId: string; moduleName: string }) => withBusy(entry.entryId, async () => {
    if (rpc === null) return
    const result = await rpc<MutationResult>('pluginManager', 'uninstall', { entryId: entry.entryId })
    if (!result.ok) {
      setNotice(`卸载失败：${result.log ?? '未知错误'}`)
      return
    }
    setNotice(`已卸载 ${displayName(entry.moduleName)}，重启后生效`)
    setDetailId(null)
    setDetail(null)
    await refresh()
  }), [withBusy, rpc, refresh])

  const onUpdate = useCallback((entry: { entryId: string; moduleName: string }) => withBusy(entry.entryId, async () => {
    if (rpc === null) return
    const result = await rpc<MutationResult>('pluginManager', 'update', { spec: entry.moduleName })
    if (!result.ok) {
      setNotice(`更新失败：${result.log ?? '未知错误'}`)
      return
    }
    setNotice(`已更新 ${displayName(entry.moduleName)}，重启后生效`)
  }), [withBusy, rpc])

  // 打开详情页：拉 detail 投影（列表只给最小字段，详情按需取）。
  const openDetail = useCallback((entryId: string) => {
    if (rpc === null) return
    setDetailId(entryId)
    setDetail(null)
    setDetailLoading(true)
    void (async () => {
      try {
        const r = await rpc<{ detail: PluginDetail }>('pluginManager', 'detail', { entryId })
        setDetail(r.detail)
      } catch (e) {
        setDetailId(null)
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setDetailLoading(false)
      }
    })()
  }, [rpc])

  const closeDetail = useCallback(() => { setDetailId(null); setDetail(null) }, [])

  const onRestart = useCallback(() => {
    const bridge = (window as unknown as { corumDesktop?: RestartBridge }).corumDesktop
    void bridge?.restartHost?.().then(() => { setNotice(null) })
  }, [])

  // 「发现更多插件」：关闭设置面板 + 经 section 操作面打开插件中心市场浮层。
  const discoverMore = useCallback(() => {
    sectionNav?.close()
    sectionNav?.openPluginManager()
  }, [sectionNav])

  // ── 列表投影：tab 分组 → scope → 状态 → 关键字 ──
  const plugins = (entries ?? []).filter(e => e.kind === 'plugin')
  const runtimes = (entries ?? []).filter(e => e.kind === 'runtime')
  const base = tab === 'system' ? runtimes : plugins
  const scoped = scope === 'project' ? base.filter(e => e.moduleName.startsWith('@corum/')) : base
  const q = query.trim().toLowerCase()
  const visibleEntries = scoped
    .filter(e => (status === 'all' ? true : status === 'on' ? e.enabled : !e.enabled))
    .filter(e => q === ''
      || e.moduleName.toLowerCase().includes(q)
      || displayName(e.moduleName).toLowerCase().includes(q)
      || displayDesc(e.moduleName, e.description).toLowerCase().includes(q))

  const filteredEmptyText = query.trim() !== '' || status !== 'all' || scope === 'project'
    ? '没有符合条件的插件'
    : tab === 'system' ? '没有系统插件' : '没有已装插件'

  const bridge = (window as unknown as { corumDesktop?: RestartBridge }).corumDesktop
  const canRestart = typeof bridge?.restartHost === 'function'

  return (
    <div className={css.plgSection}>
      {/* ── 1. 顶部行：hint + 发现更多插件（行为不变：关设置 + 开浮层）── */}
      <div className={css.topRow}>
        <span className={css.topHint}>管理已安装与内置插件。点击卡片查看详情与操作。</span>
        <GlassButton variant="primary" onClick={discoverMore}>发现更多插件</GlassButton>
      </div>

      {/* ── 2. 插件配置 tab 槽（corum-ui-settings-plugins / plugin-inventory）── */}
      {renderTabSlot !== undefined && renderTabSlot()}

      {detailId !== null ? (
        /* ── 6. 详情视图（替换 tabs / filter / 网格三段）── */
        <div className={css.plgDetail}>
          <button type="button" className={css.plgBackRow} onClick={closeDetail}>
            <ChevronLeft size={14} /> 返回插件管理
          </button>
          {detail === null && <p className={css.plgHint}>{detailLoading ? '加载详情…' : '详情不可用。'}</p>}
          {detail !== null && (
            <>
              <div className={css.plgCard}>
                <div className={css.plgCardIcon}>{entryIcon(detail.moduleName, 17)}</div>
                <div className={css.plgCardMeta}>
                  <div className={css.plgCardNameRow}>
                    <span className={css.plgCardName}>{displayName(detail.moduleName)}</span>
                    {detail.version !== undefined && <span className={css.plgCardVer}>v{detail.version}</span>}
                    <span className={css.plgCardBadge}>{originLabel(detail.origin)}</span>
                    {detail.kind === 'runtime' && <span className={css.plgCardVer}>运行时组件 · 只读</span>}
                  </div>
                  <span className={css.plgCardDesc}>
                    {displayDesc(detail.moduleName, detail.description) !== ''
                      ? displayDesc(detail.moduleName, detail.description)
                      : detail.moduleName}
                  </span>
                </div>
                <div className={css.plgCardOps}>
                  <span className={css.plgHint}>{phaseLabel(detail)}</span>
                </div>
              </div>

              <div className={css.plgDetailGrid}>
                {detailField('包名', detail.moduleName)}
                {detailField('版本', detail.version !== undefined ? `v${detail.version}` : undefined)}
                {detailField('发布者', detail.publisher)}
                {detailField('许可证', detail.license)}
                {detailField('主页', detail.homepage !== undefined
                  ? <a className={css.plgDetailLink} href={detail.homepage} target="_blank" rel="noreferrer">{detail.homepage}</a>
                  : undefined)}
                {detailField('仓库', detail.repository !== undefined
                  ? <a className={css.plgDetailLink} href={detail.repository} target="_blank" rel="noreferrer">{detail.repository}</a>
                  : undefined)}
                {detailField('界面', detail.hasUi ? '有界面' : '无界面（后台能力）')}
                {detailField('状态', phaseLabel(detail))}
                {detail.keywords !== undefined && detail.keywords.length > 0
                  ? detailField('标签', detail.keywords.join('、'))
                  : null}
              </div>

              {detail.kind !== 'runtime' && (
                <div className={css.plgDetailActions}>
                  <button
                    type="button"
                    className={css.plgSetBtn}
                    disabled={busy.has(detail.entryId)}
                    onClick={() => { onUpdate(detail) }}
                  >更新</button>
                  <button
                    type="button"
                    className={css.plgSetBtn}
                    disabled={busy.has(detail.entryId)}
                    onClick={() => { onUninstall(detail) }}
                  >卸载</button>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          {/* ── 3. tabs（已装插件 / 系统插件）── */}
          <div className={css.plgTabs} role="tablist" aria-label="插件分区">
            {([['installed', '已装插件'], ['system', '系统插件']] as ReadonlyArray<readonly [PanelTab, string]>).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`${css.plgTab}${tab === id ? ' ' + css.plgTabActive : ''}`}
                onClick={() => { setTab(id) }}
              >{label}</button>
            ))}
          </div>

          {/* ── 4. scope 分段 + 搜索框 + 状态下拉（同一行，space-between）── */}
          <div className={css.plgFilterRow}>
            <div className={css.plgScope} role="group" aria-label="插件作用域">
              {([['global', '全局'], ['project', '本项目']] as ReadonlyArray<readonly [ScopeMode, string]>).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`${css.plgScopeSeg}${scope === id ? ' ' + css.plgScopeSegActive : ''}`}
                  aria-pressed={scope === id}
                  onClick={() => { setScope(id) }}
                >{label}</button>
              ))}
            </div>
            <div className={css.plgFilterRight}>
              <div className={css.plgSearchWrap}>
                <Search size={13} className={css.plgSearchIcon} />
                <input
                  className={css.plgSearchInput}
                  value={query}
                  placeholder="搜索已装插件…"
                  aria-label="搜索已装插件"
                  onChange={e => { setQuery(e.target.value) }}
                />
              </div>
              <div className={css.plgSelect} ref={selectRef}>
                <button
                  type="button"
                  className={css.plgSelectBtn}
                  aria-haspopup="listbox"
                  aria-expanded={statusOpen}
                  onClick={() => { setStatusOpen(open => !open) }}
                >
                  <span className={css.plgSelectValue}>{STATUS_LABEL[status]}</span>
                  <ChevronDown size={18} className={css.plgSelectChevron} />
                </button>
                {statusOpen && (
                  <div className={css.plgSelectMenu} role="listbox" aria-label="插件状态">
                    {(Object.keys(STATUS_LABEL) as StatusFilter[]).map(id => (
                      <button
                        key={id}
                        type="button"
                        role="option"
                        aria-selected={status === id}
                        className={css.plgSelectOption}
                        data-active={status === id || undefined}
                        onClick={() => { setStatus(id); setStatusOpen(false) }}
                      >{STATUS_LABEL[id]}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {rpc === null && <p className={css.plgHint}>插件服务未就绪。</p>}
          {rpc !== null && error !== null && entries === null && <p className={css.plgError}>加载失败：{error}</p>}
          {rpc !== null && entries === null && error === null && <p className={css.plgHint}>加载中…</p>}
          {entries !== null && visibleEntries.length === 0 && <p className={css.plgHint}>{filteredEmptyText}</p>}

          {/* ── 5. 卡片网格（两列，gap 10）── */}
          <div className={css.plgGrid}>
            {visibleEntries.map(entry => {
              const readOnly = entry.kind === 'runtime'
              const name = displayName(entry.moduleName)
              const desc = displayDesc(entry.moduleName, entry.description)
              const badge = badgeOf(entry)
              return (
                <div
                  key={entry.entryId}
                  className={css.plgCard}
                  data-off={!entry.enabled || undefined}
                  role="button"
                  tabIndex={0}
                  onClick={() => { openDetail(entry.entryId) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(entry.entryId) } }}
                >
                  <div className={css.plgCardIcon}>{entryIcon(entry.moduleName, 17)}</div>
                  <div className={css.plgCardMeta}>
                    <div className={css.plgCardNameRow}>
                      <span className={css.plgCardName}>{name}</span>
                      {entry.version !== undefined && <span className={css.plgCardVer}>v{entry.version}</span>}
                      {badge !== null && <span className={css.plgCardBadge}>{badge}</span>}
                    </div>
                    {desc !== '' && <span className={css.plgCardDesc}>{desc}</span>}
                  </div>
                  <div className={css.plgCardOps} onClick={e => e.stopPropagation()}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={entry.enabled}
                      aria-label={`${name} ${readOnly ? '状态（运行时组件不可停用）' : '启用开关'}`}
                      className={css.plgSwitch}
                      data-off={!entry.enabled || undefined}
                      disabled={busy.has(entry.entryId) || readOnly}
                      onClick={() => { void onToggleEnabled(entry) }}
                    >
                      <span className={css.plgSwitchKnob} />
                    </button>
                    <button
                      type="button"
                      className={css.plgSetBtn}
                      disabled={busy.has(entry.entryId)}
                      onClick={() => { openDetail(entry.entryId) }}
                    >设置</button>
                    {!readOnly && (
                      <button
                        type="button"
                        className={css.plgDelBtn}
                        aria-label={`卸载 ${name}`}
                        disabled={busy.has(entry.entryId)}
                        onClick={() => { void onUninstall(entry) }}
                      >
                        <Trash2 size={20} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── 7. notice：操作反馈（一行 hint）+ 可选「立即重启」── */}
      {notice !== null && (
        <div className={css.plgNotice}>
          <span className={css.plgNoticeText}>{notice}</span>
          {canRestart && notice.includes('重启') && (
            <button type="button" className={css.plgNoticeAction} onClick={onRestart}>立即重启</button>
          )}
          <button type="button" className={css.plgNoticeClose} aria-label="关闭提示" onClick={() => { setNotice(null) }}>×</button>
        </div>
      )}
      {error !== null && entries !== null && <p className={css.plgError}>{error}</p>}
    </div>
  )
}

/** 详情字段行（空值不渲染）。 */
function detailField(label: string, value: ReactNode): ReactNode {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className={css.plgDetailField}>
      <span className={css.plgDetailLabel}>{label}</span>
      <span className={css.plgDetailValue}>{value}</span>
    </div>
  )
}
