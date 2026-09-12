/**
 * PluginManagerPanel —— 「设置中心 › 扩展 › 插件管理」content 区。
 *
 * 1:1 复刻 doc/UXDesign/design.pen 帧 zOmcc「设置 · 扩展面板-已装插件 · 深色」
 * 的 w8h6DG content（840×820）：header 56（标题 + scope 分段 + 关闭 + 发现更多
 * 插件）→ 1px 分隔线 → body（tabs / filter / 卡片网格，gap 14、padding
 * [20,24,24,24]，一排两张卡）。
 *
 * 本组件只画 content：FloatingLayer 遮罩 / SettingsShell / 左 nav 不由本包
 * 渲染（面板经壳的 openPluginManager 信号打开，见 index.tsx；遮罩类名 overlay
 * 由 index.tsx 挂载时使用）。
 *
 * 分区：
 *   - 已装插件（kind=plugin）：真实 pluginManager.list 投影，卡片 = icon-box +
 *     名称/版本/徽标 + 介绍 + 开关/设置/卸载。
 *   - 系统插件（kind=runtime）：cordis/dsh 运行时基元与不可关闭的基础能力插件，
 *     只读（开关禁用、无卸载）——保留既有语义，非设计稿帧内容。
 *   - 视图管理：网格区域显隐（既有能力保留，追加在两张设计稿 tab 之后）。
 *   - 插件市场：「发现更多插件」进入，npm registry 检索 + 安装。
 *
 * 所有色值走本包 --pm-* 变量（design.pen variables 的深/浅双值，见 module.css），
 * 组件内不出现裸 hex。
 *
 * 数据面：安装/更新/卸载成功后提示重启（restartHost bridge），不做免重启热载。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  Cable, ChevronDown, ChevronLeft, Cpu, KeyRound, Puzzle, Search, Server, ServerCog,
  Terminal, Trash2, X,
} from 'lucide-react'
import { getAllRegisteredSlots, getSlotMeta } from '@corum/corum-ui-base/client'
import { fallbackName, pluginMeta } from './plugin-meta.ts'
import css from './PluginManagerPanel.module.css'

/** pluginManager.list 的一条条目投影（Host 侧 wire 形状）。 */
export interface PluginManagerEntry {
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
export interface PluginDetail {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: PluginManagerEntry['fiberPhase']
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

/** 检索结果行。 */
interface PluginSearchResult {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly installed: boolean
  /** 发布/最后更新日期（ISO 字符串，Host 取自 npm search 的 package.date）。 */
  readonly date?: string
}

/** 变更类操作的结果（restartRequired = 需重启 host 生效）。 */
interface MutationResult {
  readonly ok: boolean
  readonly restartRequired: boolean
  readonly log?: string
}

/** 面板对外依赖：网格隐藏集投影 + 区域显隐写入 + pluginManager RPC caller，全部注入。 */
export interface PluginManagerPanelProps {
  /** 网格 hidden 槽位集合的订阅（useSyncExternalStore 契约）。 */
  subscribeGrid: (listener: () => void) => () => void
  /** 当前 hidden 槽位快照（稳定引用，变更后换引用）。 */
  getHiddenSnapshot: () => readonly string[]
  /** 判定某注册槽位是否当前网格里的区域（过滤 cordis 内部 slot）。 */
  isRegionSlot: (slot: string) => boolean
  /** 区域显隐写入（壳内 = ctx.layout.setRegionHidden 直连网格）。 */
  onSetRegionHidden: (slot: string, hidden: boolean) => void
  /** 面板关闭（FloatingLayer closeFloating）。 */
  onClose: () => void
  /** pluginManager 命名空间的 RPC caller（0.1.2 起走官方 connection.rpc）。 */
  callRemote: <T>(method: string, args: Record<string, unknown>) => Promise<T>
}

/** 桌面 preload 桥上本面板用到的面。 */
interface RestartBridge {
  restartHost?: () => Promise<{ ok: boolean }>
}

/** content 的两个视图（list = 已装/系统/视图；market = 插件市场）。 */
type PanelView = 'list' | 'market'

/** 列表视图的三个 tab。 */
type PanelTab = 'installed' | 'system' | 'views'

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
function phaseLabel(entry: { fiberPhase: PluginManagerEntry['fiberPhase']; enabled: boolean }): string {
  if (!entry.enabled) return '已停用'
  if (entry.fiberPhase === 'active') return '运行中'
  return entry.fiberPhase ?? '已启用'
}

/**
 * 卡片徽标（design.pen：可选徽标 fill $brand-primary）。只给有真实依据的两类：
 * 基础能力 = 不可关闭的 corum 基础能力插件（kind=runtime 且有界面半）；
 * 第三方 = 非官方/非本项目的包。其余卡片不带徽标（设计稿亦然，六张里只有三张有）。
 */
function badgeOf(entry: PluginManagerEntry): string | null {
  if (entry.kind === 'runtime' && entry.hasUi) return '基础能力'
  if (!entry.moduleName.startsWith('@corum/') && !entry.moduleName.startsWith('@deepseek-ai/')) return '第三方'
  return null
}

/** 卡片图标（lucide glyph，17px，按包名语义映射；design.pen 用 cpu/puzzle/terminal/plug/server）。 */
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

/** 检索卡片图标（npm 包无固定图标，按名称关键词映射语义图标，默认 Puzzle）。 */
function searchResultIcon(name: string, size: number): ReactNode {
  const n = name.toLowerCase()
  if (/mcp/.test(n)) return <ServerCog size={size} />
  if (/serial|uart|modbus/.test(n)) return <Cable size={size} />
  if (/ssh|sftp|key/.test(n)) return <KeyRound size={size} />
  if (/terminal|shell|bash|tty|pty/.test(n)) return <Terminal size={size} />
  if (/theme|color|dark|light|aurora/.test(n)) return <Terminal size={size} />
  if (/ai|llm|model|gpt|agent/.test(n)) return <Cpu size={size} />
  if (/search|find|grep|server|api/.test(n)) return <Server size={size} />
  return <Puzzle size={size} />
}

/** 格式化 ISO 日期为 YYYY-MM-DD；非法输入回退原串。 */
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 插件管理 content 区主体。 */
export function PluginManagerPanel({
  subscribeGrid, getHiddenSnapshot, isRegionSlot, onSetRegionHidden, onClose, callRemote,
}: PluginManagerPanelProps) {
  const [view, setView] = useState<PanelView>('list')
  const [tab, setTab] = useState<PanelTab>('installed')
  const [scope, setScope] = useState<ScopeMode>('global')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [statusOpen, setStatusOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<readonly PluginManagerEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)

  // 详情视图：非 null 时替换列表区（detail = 选中条目的详情）。
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // 插件市场（view='market'）的检索态。
  const [mktQuery, setMktQuery] = useState('')
  const [mktResults, setMktResults] = useState<readonly PluginSearchResult[] | null>(null)
  const [mktSearching, setMktSearching] = useState(false)
  const [mktError, setMktError] = useState<string | null>(null)

  // 状态下拉：点外部关闭（无全局状态，纯组件本地 effect）。
  const selectRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!statusOpen) return
    const onDown = (e: MouseEvent): void => {
      if (selectRef.current !== null && !selectRef.current.contains(e.target as Node)) setStatusOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [statusOpen])

  // 网格 hidden 集投影（壳的 useSyncExternalStore 源）。
  const hidden = useSyncExternalStore(subscribeGrid, getHiddenSnapshot)
  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  // 只列当前网格里的区域 leaf（过滤 cordis 内部 slot）。visibility 'fixed'/'hidden'
  // 的槽不进视图管理（fixed = 壳固定占位槽，hidden = 无独立 UI 的插件）。
  const regionSlots = useMemo(
    () => getAllRegisteredSlots()
      .filter(isRegionSlot)
      .filter((slot) => (getSlotMeta(slot)?.visibility ?? 'addable') === 'addable'),
    [isRegionSlot],
  )

  const refresh = useCallback(async () => {
    try {
      const snapshot = await callRemote<{ entries: PluginManagerEntry[] }>('list', {})
      setEntries(snapshot.entries)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [callRemote])

  useEffect(() => { void refresh() }, [refresh])

  const withBusy = useCallback(async (key: string, op: () => Promise<void>) => {
    setBusy(prev => new Set(prev).add(key))
    try {
      await op()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [])

  const onToggleEnabled = useCallback((entry: PluginManagerEntry) => withBusy(entry.entryId, async () => {
    await callRemote('setEnabled', { entryId: entry.entryId, enabled: !entry.enabled })
    await refresh()
  }), [withBusy, refresh, callRemote])

  const onUninstall = useCallback((entry: PluginManagerEntry) => withBusy(entry.entryId, async () => {
    const result = await callRemote<MutationResult>('uninstall', { entryId: entry.entryId })
    if (!result.ok) {
      setNotice(`卸载失败：${result.log ?? 'unknown error'}`)
      return
    }
    setNotice(`已卸载 ${entry.moduleName}，重启后生效`)
    await refresh()
  }), [withBusy, refresh, callRemote])

  const onUpdate = useCallback((entry: PluginManagerEntry | PluginDetail) => withBusy(entry.entryId, async () => {
    const result = await callRemote<MutationResult>('update', { spec: entry.moduleName })
    if (!result.ok) {
      setNotice(`更新失败：${result.log ?? 'unknown error'}`)
      return
    }
    setNotice(`已更新 ${entry.moduleName}，重启后生效`)
  }), [withBusy, callRemote])

  // 打开详情页：拉 detail 投影。entryId 来自 list（「设置」按钮）。
  const openDetail = useCallback(async (entryId: string) => {
    setDetailLoading(true)
    try {
      const { detail: d } = await callRemote<{ detail: PluginDetail }>('detail', { entryId })
      setDetail(d)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setDetailLoading(false)
    }
  }, [callRemote])

  const closeDetail = useCallback(() => { setDetail(null) }, [])

  const onInstall = useCallback((name: string) => withBusy(`install:${name}`, async () => {
    const result = await callRemote<MutationResult>('install', { spec: name })
    if (!result.ok) {
      setNotice(`安装失败：${result.log ?? 'unknown error'}`)
      return
    }
    setNotice(`已安装 ${name}，重启后生效`)
    setMktResults(prev => prev?.map(r => (r.name === name ? { ...r, installed: true } : r)) ?? prev)
    await refresh()
  }), [withBusy, refresh, callRemote])

  const onSearch = useCallback(async () => {
    setMktSearching(true)
    setMktError(null)
    try {
      const { results: rows } = await callRemote<{ results: PluginSearchResult[] }>('search', { query: mktQuery })
      setMktResults(rows)
    } catch (error) {
      setMktError(error instanceof Error ? error.message : String(error))
      setMktResults(null)
    } finally {
      setMktSearching(false)
    }
  }, [mktQuery, callRemote])

  // 区域显隐切换：经注入的 onSetRegionHidden 直连网格。
  const onToggleRegion = useCallback((slot: string, currentlyHidden: boolean) => {
    onSetRegionHidden(slot, !currentlyHidden)
  }, [onSetRegionHidden])

  const onRestart = useCallback(() => {
    const bridge = (window as unknown as { corumDesktop?: RestartBridge }).corumDesktop
    void bridge?.restartHost?.().then(() => { setNotice(null) })
  }, [])

  // ── 列表投影：tab 分组 → scope → 状态 → 关键字 ──
  const plugins = useMemo(() => (entries ?? []).filter(e => e.kind === 'plugin'), [entries])
  const runtimes = useMemo(() => (entries ?? []).filter(e => e.kind === 'runtime'), [entries])
  const visibleEntries = useMemo(() => {
    const base = tab === 'system' ? runtimes : plugins
    const scoped = scope === 'project' ? base.filter(e => e.moduleName.startsWith('@corum/')) : base
    const q = query.trim().toLowerCase()
    return scoped
      .filter(e => (status === 'all' ? true : status === 'on' ? e.enabled : !e.enabled))
      .filter(e => q === '' || e.moduleName.toLowerCase().includes(q) || displayName(e.moduleName).includes(q) || displayDesc(e.moduleName, e.description).includes(q))
  }, [tab, plugins, runtimes, scope, status, query])

  const emptyText = tab === 'system' ? '没有系统插件' : '没有已装插件'
  const filteredEmptyText = query.trim() !== '' || status !== 'all' || scope === 'project'
    ? '没有符合条件的插件'
    : emptyText

  // 详情视图：整个 content 让位给详情（返回按钮回到列表）。
  if (detail !== null) {
    return (
      <div className={css.panel} role="dialog" aria-modal="true" aria-label="插件管理">
        <div className={css.header}>
          <span className={css.headerTitle}>插件管理</span>
          <div className={css.headerRight}>
            <CloseButton onClose={onClose} />
          </div>
        </div>
        <div className={css.divider} />
        <div className={css.body}>
          <PluginDetailView
            detail={detail}
            busy={busy.has(detail.entryId)}
            onBack={closeDetail}
            onUpdate={onUpdate}
            onUninstall={() => { void onUninstall(detail).then(() => { closeDetail() }) }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className={css.panel} role="dialog" aria-modal="true" aria-label="插件管理">
      {/* ── header xQFRJ：标题 + scope 分段 + 关闭 + 发现更多插件 ── */}
      <div className={css.header}>
        <span className={css.headerTitle}>插件管理</span>
        <div className={css.headerRight}>
          <div className={css.scope} role="group" aria-label="插件作用域">
            {([['global', '全局'], ['project', '本项目']] as ReadonlyArray<readonly [ScopeMode, string]>).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={css.scopeSeg}
                data-active={scope === id || undefined}
                aria-pressed={scope === id}
                onClick={() => { setScope(id) }}
              >{label}</button>
            ))}
          </div>
          <CloseButton onClose={onClose} />
          <button
            type="button"
            className={css.discoverBtn}
            onClick={() => { setView('market') }}
          >发现更多插件</button>
        </div>
      </div>
      <div className={css.divider} />

      {/* ── body Gyvyc：严格三段 = tabs → filter → 卡片网格 ── */}
      <div className={css.body}>
        {view === 'market' ? (
          <>
            <button type="button" className={css.backRow} onClick={() => { setView('list') }}>
              <ChevronLeft size={14} /> 返回插件管理
            </button>
            <div className={css.tabs} role="tablist" aria-label="插件分区">
              <button
                type="button"
                role="tab"
                aria-selected={false}
                className={css.tab}
                onClick={() => { setView('list') }}
              >已装插件</button>
              <button type="button" role="tab" aria-selected className={`${css.tab} ${css.tabActive}`}>插件市场</button>
            </div>
            <div className={css.filter}>
              <div className={css.searchWrap}>
                <Search size={13} className={css.searchIcon} />
                <input
                  className={css.searchInput}
                  value={mktQuery}
                  placeholder="搜索插件，如 git、theme、terminal…"
                  onChange={e => { setMktQuery(e.target.value) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void onSearch() }}
                />
              </div>
              <button type="button" className={css.setBtn} disabled={mktSearching} onClick={() => { void onSearch() }}>
                {mktSearching ? '检索中…' : '检索'}
              </button>
            </div>
            {mktError !== null && <div className={css.errorText}>检索失败：{mktError}</div>}
            {mktResults !== null && mktResults.length === 0 && <div className={css.hintText}>没有匹配的包</div>}
            <div className={css.grid}>
              {mktResults?.map(row => (
                <div key={row.name} className={css.card}>
                  <div className={css.cardIcon}>{searchResultIcon(row.name, 17)}</div>
                  <div className={css.cardMeta}>
                    <div className={css.cardNameRow}>
                      <span className={css.cardName}>{row.name}</span>
                      <span className={css.cardVer}>v{row.version}</span>
                      {row.date !== undefined && row.date !== '' && (
                        <span className={css.cardVer}>{formatDate(row.date)}</span>
                      )}
                    </div>
                    {row.description !== undefined && row.description !== '' && (
                      <span className={css.cardDesc}>{row.description}</span>
                    )}
                  </div>
                  <div className={css.cardOps}>
                    {row.installed
                      ? <span className={css.hintText}>已安装</span>
                      : (
                        <button
                          type="button"
                          className={css.installBtn}
                          disabled={busy.has(`install:${row.name}`)}
                          onClick={() => { void onInstall(row.name) }}
                        >安装</button>
                      )}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            {/* tabs h5Hckf：设计稿两张（已装插件 / 系统插件）+ 视图管理（既有能力） */}
            <div className={css.tabs} role="tablist" aria-label="插件分区">
              {([
                ['installed', '已装插件'],
                ['system', '系统插件'],
                ['views', '视图管理'],
              ] as ReadonlyArray<readonly [PanelTab, string]>).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={`${css.tab}${tab === id ? ' ' + css.tabActive : ''}`}
                  onClick={() => { setTab(id) }}
                >{label}</button>
              ))}
            </div>

            {/* filter Z6xac：search（220 宽）+ 状态下拉（140 宽）；视图管理 tab 无设计稿
                对应行，沿用同一 filter 行承载区域说明。 */}
            <div className={css.filter}>
              {tab === 'views' ? (
                <span className={css.hintText}>控制各区域在窗口中的显示/隐藏，隐藏后插件仍在后台运行。</span>
              ) : (
                <>
                  <input
                    className={css.searchField}
                    value={query}
                    placeholder="搜索已装插件…"
                    aria-label="搜索已装插件"
                    onChange={e => { setQuery(e.target.value) }}
                  />
                  <div className={css.select} ref={selectRef}>
                    <button
                      type="button"
                      className={css.selectBtn}
                      aria-haspopup="listbox"
                      aria-expanded={statusOpen}
                      onClick={() => { setStatusOpen(open => !open) }}
                    >
                      <span className={css.selectValue}>{STATUS_LABEL[status]}</span>
                      <ChevronDown size={18} className={css.selectChevron} />
                    </button>
                    {statusOpen && (
                      <div className={css.selectMenu} role="listbox" aria-label="插件状态">
                        {(Object.keys(STATUS_LABEL) as StatusFilter[]).map(id => (
                          <button
                            key={id}
                            type="button"
                            role="option"
                            aria-selected={status === id}
                            className={css.selectOption}
                            data-active={status === id || undefined}
                            onClick={() => { setStatus(id); setStatusOpen(false) }}
                          >{STATUS_LABEL[id]}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {tab === 'views' ? (
              <>
                {regionSlots.length === 0 && <div className={css.hintText}>没有可管理的区域</div>}
                <div className={css.grid}>
                  {regionSlots.map((slot): ReactNode => {
                    const isHidden = hiddenSet.has(slot)
                    const label = getSlotMeta(slot)?.label ?? slot
                    return (
                      <div key={slot} className={css.card}>
                        <div className={css.cardMeta}>
                          <div className={css.cardNameRow}>
                            <span className={css.cardName}>{label}</span>
                            <span className={css.cardVer}>{slot}</span>
                          </div>
                        </div>
                        <div className={css.cardOps}>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={!isHidden}
                            aria-label={`${label} 显示开关`}
                            className={css.switch}
                            data-off={isHidden || undefined}
                            onClick={() => { onToggleRegion(slot, isHidden) }}
                          >
                            <span className={css.switchKnob} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              <>
                {loadError !== null && <div className={css.errorText}>加载失败：{loadError}</div>}
                {entries === null && loadError === null && <div className={css.hintText}>加载中…</div>}
                {detailLoading && <div className={css.hintText}>加载详情…</div>}
                {entries !== null && visibleEntries.length === 0 && (
                  <div className={css.hintText}>{filteredEmptyText}</div>
                )}
                <div className={css.grid}>
                  {visibleEntries.map(entry => (
                    <PluginCard
                      key={entry.entryId}
                      entry={entry}
                      busy={busy.has(entry.entryId)}
                      readOnly={entry.kind === 'runtime'}
                      onToggle={() => { void onToggleEnabled(entry) }}
                      onOpenDetail={() => { void openDetail(entry.entryId) }}
                      onUninstall={() => { void onUninstall(entry) }}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* 操作反馈条：body 严格三段之外的 footer（仅在有提示时渲染） */}
      {notice !== null && (
        <div className={css.notice}>
          <span className={css.noticeText}>{notice}</span>
          {notice.includes('重启') && (
            <button type="button" className={css.noticeAction} onClick={onRestart}>立即重启</button>
          )}
          <button type="button" className={css.noticeClose} aria-label="关闭提示" onClick={() => { setNotice(null) }}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

/** header 右侧关闭按钮（18×18，lucide x 20px）。 */
function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className={css.closeBtn} aria-label="关闭" onClick={onClose}>
      <X size={20} />
    </button>
  )
}

/** 插件卡片（design.pen：icon-box + meta + ops，一排两张）。 */
function PluginCard({ entry, busy, readOnly, onToggle, onOpenDetail, onUninstall }: {
  entry: PluginManagerEntry
  busy: boolean
  readOnly: boolean
  onToggle: () => void
  onOpenDetail: () => void
  onUninstall: () => void
}) {
  const name = displayName(entry.moduleName)
  const desc = displayDesc(entry.moduleName, entry.description)
  const badge = badgeOf(entry)
  return (
    <div className={css.card} data-off={!entry.enabled || undefined}>
      <div className={css.cardIcon}>{entryIcon(entry.moduleName, 17)}</div>
      <div className={css.cardMeta}>
        <div className={css.cardNameRow}>
          <span className={css.cardName}>{name}</span>
          {entry.version !== undefined && <span className={css.cardVer}>v{entry.version}</span>}
          {badge !== null && <span className={css.cardBadge}>{badge}</span>}
        </div>
        {desc !== '' && <span className={css.cardDesc}>{desc}</span>}
      </div>
      <div className={css.cardOps}>
        <button
          type="button"
          role="switch"
          aria-checked={entry.enabled}
          aria-label={`${name} ${readOnly ? '状态（运行时组件不可停用）' : '启用开关'}`}
          className={css.switch}
          data-off={!entry.enabled || undefined}
          disabled={busy || readOnly}
          onClick={onToggle}
        >
          <span className={css.switchKnob} />
        </button>
        <button type="button" className={css.setBtn} disabled={busy} onClick={onOpenDetail}>设置</button>
        {!readOnly && (
          <button type="button" className={css.delBtn} aria-label={`卸载 ${name}`} disabled={busy} onClick={onUninstall}>
            <Trash2 size={20} />
          </button>
        )}
      </div>
    </div>
  )
}

/** 详情视图：来源/版本/发布者/操作（运行时基元只读）。 */
function PluginDetailView({ detail, busy, onBack, onUpdate, onUninstall }: {
  detail: PluginDetail
  busy: boolean
  onBack: () => void
  onUpdate: (d: PluginDetail) => void
  onUninstall: (d: PluginDetail) => void
}) {
  const readOnly = detail.kind === 'runtime'
  const meta = pluginMeta(detail.moduleName)
  const field = (label: string, value: ReactNode): ReactNode =>
    value === undefined || value === null || value === '' ? null : (
      <div className={css.detailField}>
        <span className={css.detailLabel}>{label}</span>
        <span className={css.detailValue}>{value}</span>
      </div>
    )
  return (
    <section className={css.detail}>
      <button type="button" className={css.backRow} onClick={onBack}>
        <ChevronLeft size={14} /> 返回插件管理
      </button>
      <div className={css.card}>
        <div className={css.cardIcon}>{entryIcon(detail.moduleName, 17)}</div>
        <div className={css.cardMeta}>
          <div className={css.cardNameRow}>
            <span className={css.cardName}>{meta?.zhName ?? fallbackName(detail.moduleName)}</span>
            {detail.version !== undefined && <span className={css.cardVer}>v{detail.version}</span>}
            <span className={css.cardBadge}>{originLabel(detail.origin)}</span>
            {readOnly && <span className={css.cardVer}>运行时组件 · 只读</span>}
          </div>
          <span className={css.cardDesc}>{meta?.zhDesc ?? detail.description ?? detail.moduleName}</span>
        </div>
        <div className={css.cardOps}>
          <span className={css.hintText}>{phaseLabel(detail)}</span>
        </div>
      </div>
      <div className={css.detailGrid}>
        {field('包名', detail.moduleName)}
        {field('版本', detail.version !== undefined ? `v${detail.version}` : undefined)}
        {field('发布者', detail.publisher)}
        {field('许可证', detail.license)}
        {field('主页', detail.homepage !== undefined ? <a className={css.detailLink} href={detail.homepage} target="_blank" rel="noreferrer">{detail.homepage}</a> : undefined)}
        {field('仓库', detail.repository !== undefined ? <a className={css.detailLink} href={detail.repository} target="_blank" rel="noreferrer">{detail.repository}</a> : undefined)}
        {field('界面', detail.hasUi ? '有界面' : '无界面（后台能力）')}
        {field('状态', phaseLabel(detail))}
        {detail.keywords !== undefined && detail.keywords.length > 0 && field('标签', detail.keywords.join('、'))}
      </div>
      {!readOnly && (
        <div className={css.detailActions}>
          <button type="button" className={css.setBtn} disabled={busy} onClick={() => { onUpdate(detail) }}>更新</button>
          <button type="button" className={css.setBtn} disabled={busy} onClick={() => { onUninstall(detail) }}>卸载</button>
        </div>
      )}
    </section>
  )
}
