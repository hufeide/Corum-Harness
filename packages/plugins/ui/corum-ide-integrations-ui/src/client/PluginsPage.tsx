/**
 * PluginsPage —— 集成中心 ·「插件」内容页（design.pen yXkOK F1「状态 F1」）。
 *
 * 1:1 复刻帧 yXkOK › PrU4X「B · 状态 F1」（市场态 GBcjT / 已装态 pfwae /
 * 添加▾ 下拉展开态 vKQ0n）。本组件是**页面本体**，不含集成中心的面板头（标题
 * 「集成中心」+ × 关闭）与左侧子导航（插件 / MCP 服务器 / 技能）——那两层属
 * 集成中心骨架（PR4），由父槽提供；本页经 `corum.integrations.plugins` 槽挂载。
 *
 * 结构（自上而下）：
 *   1) 页头：标题「插件」+ 搜索框 +「添加 ▾」按钮（下拉三选项：从 npm 安装 /
 *      安装本地包… / 从 URL 安装 → 展开内联来源条）；
 *   2) 内部 tab：市场 | 已装；
 *   3) 市场态：分段 chip「公开 | 个人」+ 分类分组卡片流（热门 / Agent 能力 /
 *      界面 / 主题，section 头 = 分类名 + chevron-right）；卡片 = $glass-2 底
 *      r12 padding 12：图标 36 r10 + 名称 + 一行描述 + 右上 28px 圆形「+」即装钮
 *      （$brand-primary 底，已装换 $state-success + check）+ 底部作者·版本小字；
 *   4) 已装态：同款卡片，底部行 = 版本 chip + 启用开关 + 配置 + 卸载；顶部
 *      note 固定声明「系统插件（runtime）不在此列表暴露，仅运行时装配」。
 *
 * 数据面（全部走官方 connection.rpc，方法名与 host 实现一一对应
 * packages/desktop/src/host/plugin-manager.ts）：
 *   - list()                      → { entries, dshVersion? }：已装清单 + 个人范围的
 *                                   本地/开发中插件来源（已装态**过滤 kind==='runtime'**）
 *   - search({ query })           → { results }：npm registry 检索（公开范围）
 *   - detail({ entryId })         → { detail }：「配置」就地展开的详情投影
 *   - install({ spec })           → 即装 / 添加▾ 三来源（host 就是 pnpm add <spec>，
 *                                   天然支持 npm 名 / file: 路径 / git+ URL）
 *   - uninstall({ entryId })      → 卸载
 *   - setEnabled({ entryId, enabled }) → 启用开关
 *
 * RPC caller 由挂载点注入（`PluginsPageProps.callRemote`），本组件不自己取 ctx
 * ——它与宿主插件的 apply 分离，父槽（PR4）注册时把 caller 塞进 inject 面即可。
 *
 * 色值一律走 --corum-* / --dsw-alias-* token（见同目录 PluginsPage.module.css），
 * 本文件不出现裸 hex。
 * @module corum-ide-integrations-ui/client/PluginsPage
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Blocks, BrainCircuit, Cable, Check, ChevronDown, ChevronRight, Cpu, FolderOpen, KeyRound,
  Link2, LoaderCircle, Package, Palette, Plus, Puzzle, Route, Search, Server, ServerCog,
  SquareTerminal, Trash2, WandSparkles, X,
} from 'lucide-react'
import css from './PluginsPage.module.css'

/* ── 数据投影（与 host pluginManager 的 wire 形状对齐）─────────────────────── */

/** pluginManager.list 的一条条目投影（字段见 PluginManagerEntry）。 */
export interface InstalledEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  readonly hasUi: boolean
  readonly version?: string
  readonly description?: string
  /** `plugin` = 用户可插拔的功能插件；`runtime` = cordis/dsh 运行时基元（不在已装页暴露）。 */
  readonly kind: 'plugin' | 'runtime'
}

/** pluginManager.list 的返回投影。 */
interface ListSnapshot {
  readonly entries: readonly InstalledEntry[]
  readonly dshVersion?: string
}

/** pluginManager.search 的一条结果（npm registry 候选）。 */
interface SearchResult {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly installed: boolean
  /** 最后更新日期（ISO）。 */
  readonly date?: string
  /** 周下载量。 */
  readonly weeklyDownloads?: number
  /** 综合评分 0-1。 */
  readonly score?: number
}

/** pluginManager.detail 的详情投影（卡片底部「配置」就地展开用）。 */
interface PluginDetail {
  readonly entryId: string
  readonly moduleName: string
  readonly version?: string
  readonly description?: string
  readonly publisher?: string
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly origin: 'official' | 'corum' | 'third-party'
  readonly installedFrom?: string
  readonly keywords?: readonly string[]
}

/** install / uninstall 的结果（restartRequired = 需重启 host 生效）。 */
interface MutationResult {
  readonly ok: boolean
  readonly restartRequired: boolean
  readonly log?: string
}

/** 本页对外依赖：挂载点（父槽 occupant 注册时）注入的 RPC caller。 */
export interface PluginsPageProps {
  /** `pluginManager` 命名空间的 RPC caller（connection.rpc.call('/api', 'pluginManager/'+method, {args}) 的封装）。 */
  callRemote: <T>(method: string, args: Record<string, unknown>) => Promise<T>
}

/* ── 桌面 preload 桥的窄化面（红线 3：本地能力接口，不 import 壳实现包）────── */

/** `window.corumDesktop` 上本页用到的两项（安装本地包选目录 / 重启 host）。 */
interface DesktopBridge {
  pickDirectory?: (options?: { title?: string }) => Promise<{ path: string | null; cancelled?: boolean; error?: string }>
  restartHost?: () => Promise<{ ok: boolean }>
}

/** 取 preload 桥（非桌面壳 / 老 preload 下返回 undefined，调用方静默降级）。 */
function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { corumDesktop?: DesktopBridge }).corumDesktop
}

/* ── 展示常量 ─────────────────────────────────────────────────────────────── */

/** 内部 tab。 */
type Tab = 'market' | 'installed'

/** 市场范围分段：公开 = npm registry 上的包；个人 = 本地/开发中插件。 */
type MarketScope = 'public' | 'personal'

/** 「添加 ▾」的三个安装来源。 */
type AddSource = 'npm' | 'local' | 'url'

/** 添加来源的文案（菜单项 + 来源条标签 / 输入提示）。 */
const ADD_SOURCE_LABEL: Readonly<Record<AddSource, string>> = {
  npm: '从 npm 安装',
  local: '安装本地包…',
  url: '从 URL 安装',
}

/** 来源条输入框的提示语（三来源各自的 spec 形态）。 */
const ADD_SOURCE_PLACEHOLDER: Readonly<Record<AddSource, string>> = {
  npm: '包名或带版本范围，如 @corum/corum-ide-panel-bottom-ui@0.1.0',
  local: '包目录，如 file:/Users/me/dev/my-plugin',
  url: 'npm 支持的 URL，如 https://github.com/me/plugin.git 或 tarball 地址',
}

/** 一个分类 section（design.pen：热门 / Agent 能力 / 界面 / 主题）。 */
interface Section {
  readonly id: string
  readonly label: string
  /**
   * 归类关键词（小写，命中包名或描述即归入本 section）。热门是兜底节，关键词为空
   * ——未被具名分类认领的结果全进热门，从而同一张卡不会在两节重复出现。
   */
  readonly keywords: readonly string[]
}

/**
 * 四个分类节 + 归类关键词。关键词取 corum 生态的真实分组口径（Agent 能力 =
 * 编排/技能/子智能体/MCP，界面 = 面板/侧栏/编辑器/终端，主题 = 主题/图标/字体）。
 */
const SECTIONS: readonly Section[] = [
  { id: 'popular', label: '热门', keywords: [] },
  {
    id: 'agent',
    label: 'Agent 能力',
    keywords: ['agent', 'subagent', 'orchestrat', 'skill', 'mcp', 'llm', 'model', 'tool', '记忆', 'memory', 'goal'],
  },
  {
    id: 'ui',
    label: '界面',
    keywords: ['ui', 'panel', 'sidebar', 'editor', 'conversation', 'chat', 'terminal', 'explorer', 'status', '界面', '面板'],
  },
  { id: 'theme', label: '主题', keywords: ['theme', 'palette', 'color', 'icon', 'font', '主题'] },
]

/** 每节的卡数上限（分组流是「概览」，不是完整列表页）。 */
const SECTION_LIMIT = 4

/** 热门节的卡数上限（兜底节，比具名节多两张）。 */
const POPULAR_LIMIT = 6

/** 检索词（挂载即检索一次；分类归类在本页做，不额外打 registry）。 */
const INITIAL_QUERY = 'corum plugin'

/** 输入防抖时长（毫秒）。 */
const SEARCH_DEBOUNCE_MS = 300

/* ── 展示映射 ─────────────────────────────────────────────────────────────── */

/** 展示名：包名末段（去 scope），如 @corum/corum-ide-sidebar-ui → corum-ide-sidebar-ui。 */
function shortName(moduleName: string): string {
  return moduleName.split('/').pop() ?? moduleName
}

/**
 * 作者/发布者小字（design.pen 卡片底部「corum · v0.1.0」）。npm 检索结果不带
 * author 字段，故按包域反推：@corum/* → corum，@deepseek-ai/* → deepseek-ai，
 * 无域（第三方散包）→ community。已装条目的详情投影里有真 publisher 时优先用真值。
 */
function authorOf(moduleName: string, publisher?: string): string {
  if (publisher !== undefined && publisher !== '') return publisher
  if (moduleName.startsWith('@corum/')) return 'corum'
  if (moduleName.startsWith('@deepseek-ai/')) return 'deepseek-ai'
  if (moduleName.startsWith('@')) return moduleName.slice(1).split('/')[0] ?? 'community'
  return 'community'
}

/**
 * 本地/开发中包的判定（市场「个人」范围）：「未从 registry 发布」的包 ——
 * workspace 的本项目包（@corum/* / corum-desktop*）+ file:/相对/绝对路径 spec。
 * 公开范围 = npm registry 检索结果；两者互补覆盖。
 */
function isLocalSpec(moduleName: string): boolean {
  return moduleName.startsWith('@corum/')
    || moduleName.startsWith('corum-desktop')
    || moduleName.startsWith('file:')
    || moduleName.startsWith('./')
    || moduleName.startsWith('/')
}

/** 卡片图标（lucide glyph，按包名语义映射；与设置页插件卡片同口径 + 设计稿 glyph）。 */
function pluginIcon(moduleName: string, size: number): ReactNode {
  const n = moduleName.toLowerCase()
  if (/memory|记忆/.test(n)) return <BrainCircuit size={size} />
  if (/skill|技能|wand/.test(n)) return <WandSparkles size={size} />
  if (/mcp/.test(n)) return <ServerCog size={size} />
  if (/theme|palette|color|主题/.test(n)) return <Palette size={size} />
  if (/route|router|路由/.test(n)) return <Route size={size} />
  if (/terminal|shell|pty|panel-bottom|terminal/.test(n)) return <SquareTerminal size={size} />
  if (/serial|uart|modbus/.test(n)) return <Cable size={size} />
  if (/ssh|sftp|key|credential/.test(n)) return <KeyRound size={size} />
  if (/model|llm|ollama|artgen/.test(n)) return <Cpu size={size} />
  if (/agent|orchestrat|subagent|goal/.test(n)) return <Puzzle size={size} />
  if (/search|find|grep|server|api/.test(n)) return <Server size={size} />
  if (/ui|ide-|panel|sidebar|explorer|conversation|chat/.test(n)) return <Blocks size={size} />
  return <Puzzle size={size} />
}

/** 归类：返回该结果应当落在的 section id（具名节优先，未命中归热门）。 */
function sectionOf(name: string, description?: string): string {
  const hay = `${name} ${description ?? ''}`.toLowerCase()
  for (const section of SECTIONS) {
    if (section.keywords.length === 0) continue
    if (section.keywords.some(keyword => hay.includes(keyword))) return section.id
  }
  return 'popular'
}

/** 空值不渲染的详情字段行。 */
function detailField(label: string, value: ReactNode): ReactNode {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className={css.detailRow}>
      <span className={css.detailLabel}>{label}</span>
      <span className={css.detailValue}>{value}</span>
    </div>
  )
}

/* ── 页面本体 ─────────────────────────────────────────────────────────────── */

/**
 * 集成中心 ·「插件」页（市场 + 已装）。
 * @param props - 挂载点注入的 pluginManager RPC caller。
 */
export function PluginsPage({ callRemote }: PluginsPageProps) {
  const [tab, setTab] = useState<Tab>('market')
  const [scope, setScope] = useState<MarketScope>('public')
  const [query, setQuery] = useState(INITIAL_QUERY)

  // 公开市场检索态（results=null 表示尚未检索完）。
  const [results, setResults] = useState<readonly SearchResult[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  // 已装清单（已装 tab 的数据源；市场「个人」范围也用它）。
  const [entries, setEntries] = useState<readonly InstalledEntry[] | null>(null)

  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 「添加 ▾」下拉 + 来源条（mode=null 表示来源条收起）。
  const [addOpen, setAddOpen] = useState(false)
  const [addSource, setAddSource] = useState<AddSource | null>(null)
  const [addSpec, setAddSpec] = useState('')
  const addRef = useRef<HTMLDivElement | null>(null)

  // 「配置」就地展开：展开的 entryId + 详情投影缓存。
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  /* ── 数据读取 ── */

  const refreshList = useCallback(async () => {
    try {
      const snapshot = await callRemote<ListSnapshot>('list', {})
      setEntries(snapshot.entries)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [callRemote])

  const runSearch = useCallback(async (text: string) => {
    const trimmed = text.trim()
    setSearchError(null)
    if (trimmed === '') {
      setResults([])
      return
    }
    try {
      const { results: rows } = await callRemote<{ results: SearchResult[] }>('search', { query: trimmed })
      setResults(rows)
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e))
      setResults(null)
    }
  }, [callRemote])

  // 挂载：拉已装清单（市场卡片要标已装、个人范围要用）+ 检索一次默认词。
  useEffect(() => { void refreshList() }, [refreshList])
  useEffect(() => { void runSearch(INITIAL_QUERY) }, [runSearch])

  // 输入防抖 300ms（Enter 会先取消挂起的那次再立即检索）。
  const timerRef = useRef<number | null>(null)
  const cancelPending = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  useEffect(() => cancelPending, [cancelPending])

  /** 搜索框只驱动公开范围的 registry 检索；个人/已装两个本地视图按同一关键字本地过滤。 */
  const onQueryChange = useCallback((text: string) => {
    setQuery(text)
    if (tab !== 'market' || scope !== 'public') return
    cancelPending()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void runSearch(text)
    }, SEARCH_DEBOUNCE_MS)
  }, [cancelPending, runSearch, scope, tab])

  // 「添加 ▾」下拉：点外部关闭（纯组件本地 effect）。
  useEffect(() => {
    if (!addOpen) return
    const onDown = (e: MouseEvent): void => {
      if (addRef.current !== null && !addRef.current.contains(e.target as Node)) setAddOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [addOpen])

  /* ── 变更操作 ── */

  const withBusy = useCallback(async (key: string, op: () => Promise<void>) => {
    setBusy(prev => new Set(prev).add(key))
    try {
      await op()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }, [])

  /** 「+」即装（点击只安装、不进详情；已装后按钮变 ✓）。 */
  const onInstall = useCallback((name: string) => withBusy(`install:${name}`, async () => {
    const result = await callRemote<MutationResult>('install', { spec: name })
    if (!result.ok) {
      setNotice(`安装失败：${result.log ?? '未知错误'}`)
      return
    }
    setNotice(`已安装 ${name}，重启后生效`)
    setResults(prev => prev?.map(r => (r.name === name ? { ...r, installed: true } : r)) ?? prev)
    await refreshList()
  }), [withBusy, callRemote, refreshList])

  /** 启用开关（kind==='plugin' 才可达；runtime 条目已被过滤，不出现本页）。 */
  const onToggleEnabled = useCallback((entry: InstalledEntry) => withBusy(`toggle:${entry.entryId}`, async () => {
    await callRemote<{ ok: boolean }>('setEnabled', { entryId: entry.entryId, enabled: !entry.enabled })
    await refreshList()
  }), [withBusy, callRemote, refreshList])

  /** 卸载（restartRequired 一律提示重启）。 */
  const onUninstall = useCallback((entry: InstalledEntry) => withBusy(`uninstall:${entry.entryId}`, async () => {
    const result = await callRemote<MutationResult>('uninstall', { entryId: entry.entryId })
    if (!result.ok) {
      setNotice(`卸载失败：${result.log ?? '未知错误'}`)
      return
    }
    setNotice(`已卸载 ${shortName(entry.moduleName)}，重启后生效`)
    if (detailId === entry.entryId) { setDetailId(null); setDetail(null) }
    await refreshList()
  }), [withBusy, callRemote, refreshList, detailId])

  /** 「配置」：就地展开该插件的详情（pluginManager/detail），再次点击收起。 */
  const onConfigure = useCallback((entry: InstalledEntry) => {
    if (detailId === entry.entryId) {
      setDetailId(null)
      setDetail(null)
      return
    }
    setDetailId(entry.entryId)
    setDetail(null)
    setDetailLoading(true)
    void (async () => {
      try {
        const r = await callRemote<{ detail: PluginDetail }>('detail', { entryId: entry.entryId })
        setDetail(r.detail)
      } catch (e) {
        setDetailId(null)
        setNotice(e instanceof Error ? e.message : String(e))
      } finally {
        setDetailLoading(false)
      }
    })()
  }, [callRemote, detailId])

  const onRestart = useCallback(() => {
    void desktopBridge()?.restartHost?.()?.then(() => { setNotice(null) })
  }, [])

  /** 选一个安装来源：菜单收起 + 打开来源条（本地包先弹原生目录选择器）。 */
  const onPickSource = useCallback((source: AddSource) => {
    setAddOpen(false)
    if (source !== 'local') {
      setAddSource(source)
      setAddSpec('')
      return
    }
    void (async () => {
      const picked = await desktopBridge()?.pickDirectory?.({ title: '选择插件包目录' })
      const path = picked?.path ?? null
      if (path === null) return // 取消：来源条不打开
      setAddSource('local')
      setAddSpec(`file:${path}`)
    })()
  }, [])

  /** 提交来源条的 spec（host install 就是 pnpm add <spec>，file:/git/tarball 天然支持）。 */
  const onSubmitAdd = useCallback(() => {
    const spec = addSpec.trim()
    if (spec === '') return
    void withBusy(`install:${spec}`, async () => {
      const result = await callRemote<MutationResult>('install', { spec })
      if (!result.ok) {
        setNotice(`安装失败：${result.log ?? '未知错误'}`)
        return
      }
      setNotice(`已安装 ${spec}，重启后生效`)
      setAddSpec('')
      setAddSource(null)
      await refreshList()
    })
  }, [addSpec, withBusy, callRemote, refreshList])

  /* ── 视图投影 ── */

  // 已装：**过滤 kind==='runtime'**（系统插件不在本列表暴露，只有 note 声明它）。
  const installedPlugins = useMemo(
    () => (entries ?? []).filter(entry => entry.kind === 'plugin'),
    [entries],
  )

  const keyword = query.trim().toLowerCase()
  const matches = useCallback((moduleName: string, description?: string): boolean => (
    keyword === ''
    || moduleName.toLowerCase().includes(keyword)
    || shortName(moduleName).toLowerCase().includes(keyword)
    || (description ?? '').toLowerCase().includes(keyword)
  ), [keyword])

  /** 已装 tab 的可见集（本地过滤，含描述）。 */
  const visibleInstalled = useMemo(
    () => installedPlugins.filter(entry => matches(entry.moduleName, entry.description)),
    [installedPlugins, matches],
  )

  /** 个人范围 = 已装清单里的本地/开发中插件（本地过滤）。 */
  const personalEntries = useMemo(
    () => installedPlugins.filter(e => isLocalSpec(e.moduleName) && matches(e.moduleName, e.description)),
    [installedPlugins, matches],
  )

  /** 公开范围的分类分组：热门（未被具名分类认领，按周下载量降序，无下载量则保持 host 顺序）+ 三个具名节。 */
  const groups = useMemo(() => {
    const rows = [...(results ?? [])].filter(r => matches(r.name, r.description))
    const buckets = new Map<string, SearchResult[]>(SECTIONS.map(s => [s.id, []]))
    for (const row of rows) {
      const bucket = buckets.get(sectionOf(row.name, row.description))
      if (bucket !== undefined) bucket.push(row)
    }
    const popular = buckets.get('popular') ?? []
    popular.sort((a, b) => (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0))
    return SECTIONS.map(section => ({
      section,
      rows: (section.id === 'popular'
        ? popular.slice(0, POPULAR_LIMIT)
        : (buckets.get(section.id) ?? []).slice(0, SECTION_LIMIT)),
    }))
  }, [results, matches])

  const installedSet = useMemo(
    () => new Set((entries ?? []).map(entry => entry.moduleName)),
    [entries],
  )

  /** 搜索框提示语随当前视图切换（一个搜索框服务三个视图，不重复画框）。 */
  const searchPlaceholder = tab === 'installed'
    ? '搜索已装插件'
    : scope === 'personal' ? '搜索本地/开发中插件' : '搜索插件'

  const bridge = typeof window === 'undefined'
    ? undefined
    : (window as unknown as { corumDesktop?: DesktopBridge }).corumDesktop
  const canRestart = typeof bridge?.restartHost === 'function'

  return (
    <div className={css.page}>
      {/* ── 1. 页头：标题 + 搜索 + 添加▾（design.pen F1 内容区顶部）── */}
      <div className={css.header}>
        <span className={css.headerTitle}>插件</span>
        <div className={css.searchBox}>
          <Search size={13} className={css.searchIcon} />
          <input
            className={css.searchInput}
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={e => { onQueryChange(e.target.value) }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              if (tab !== 'market' || scope !== 'public') return
              cancelPending()
              void runSearch(query)
            }}
          />
        </div>
        <div className={css.addWrap} ref={addRef}>
          <button
            type="button"
            className={css.addBtn}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => { setAddOpen(open => !open) }}
          >
            <span>添加</span>
            <ChevronDown size={14} />
          </button>
          {addOpen && (
            <div className={css.addMenu} role="menu" aria-label="安装来源">
              {(['npm', 'local', 'url'] as const).map(source => (
                <button
                  key={source}
                  type="button"
                  role="menuitem"
                  className={css.addOption}
                  onClick={() => { onPickSource(source) }}
                >
                  <span className={css.addOptionIcon}>
                    {source === 'npm' ? <Package size={14} /> : source === 'local' ? <FolderOpen size={14} /> : <Link2 size={14} />}
                  </span>
                  <span className={css.addOptionText}>{ADD_SOURCE_LABEL[source]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── 2. 内部 tab：市场 | 已装 ── */}
      <div className={css.tabs} role="tablist" aria-label="插件分区">
        {([['market', '市场'], ['installed', '已装']] as ReadonlyArray<readonly [Tab, string]>).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`${css.tab}${tab === id ? ' ' + css.tabActive : ''}`}
            onClick={() => {
              setTab(id)
              // 切到公开市场时若检索结果尚未就绪（例如首检索失败后重进），补一次。
              if (id === 'market' && scope === 'public' && results === null && searchError === null) {
                void runSearch(query)
              }
            }}
          >{label}</button>
        ))}
      </div>

      {/* ── 3. 来源条：添加▾ 选中某一来源后内联展开（npm 名 / 本地包 file: 路径 / URL）── */}
      {addSource !== null && (
        <div className={css.sourceBar}>
          <span className={css.sourceLabel}>{ADD_SOURCE_LABEL[addSource]}</span>
          <input
            className={css.sourceInput}
            value={addSpec}
            placeholder={ADD_SOURCE_PLACEHOLDER[addSource]}
            aria-label={ADD_SOURCE_LABEL[addSource]}
            onChange={e => { setAddSpec(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') onSubmitAdd() }}
          />
          <button
            type="button"
            className={css.sourceBtn}
            disabled={addSpec.trim() === '' || busy.has(`install:${addSpec.trim()}`)}
            onClick={onSubmitAdd}
          >安装</button>
          <button
            type="button"
            className={css.sourceCancel}
            aria-label="取消安装"
            onClick={() => { setAddSource(null); setAddSpec('') }}
          ><X size={14} /></button>
        </div>
      )}

      {/* ── 4. 内容区 ── */}
      <div className={css.body}>
        {tab === 'market' ? (
          <>
            {/* 分段 chip：公开 | 个人 */}
            <div className={css.scopeRow} role="group" aria-label="插件来源范围">
              {([['public', '公开'], ['personal', '个人']] as ReadonlyArray<readonly [MarketScope, string]>).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`${css.scopeChip}${scope === id ? ' ' + css.scopeChipActive : ''}`}
                  aria-pressed={scope === id}
                  onClick={() => { setScope(id) }}
                >{label}</button>
              ))}
            </div>

            {scope === 'public' ? (
              <>
                {searchError !== null && <p className={css.errorText}>检索失败：{searchError}</p>}
                {searchError === null && results === null && <p className={css.hintText}>检索中…</p>}
                {results !== null && groups.every(g => g.rows.length === 0) && (
                  <p className={css.hintText}>没有匹配的插件</p>
                )}
                {groups.map(({ section, rows }) => (
                  <div key={section.id} className={css.section}>
                    <div className={css.sectionHead}>
                      <span className={css.sectionLabel}>{section.label}</span>
                      <ChevronRight size={12} className={css.sectionChev} />
                    </div>
                    {rows.length === 0
                      ? <p className={css.hintText}>本节暂无匹配</p>
                      : (
                        <div className={css.cardGrid}>
                          {rows.map(row => (
                            <div key={row.name} className={css.card}>
                              <div className={css.cardHead}>
                                <div className={css.cardIcon}>{pluginIcon(row.name, 17)}</div>
                                <div className={css.cardMeta}>
                                  <span className={css.cardName}>{shortName(row.name)}</span>
                                  {row.description !== undefined && row.description !== '' && (
                                    <span className={css.cardDesc}>{row.description}</span>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  className={css.installBtn}
                                  data-installed={(row.installed || installedSet.has(row.name)) || undefined}
                                  aria-label={row.installed || installedSet.has(row.name) ? `${row.name} 已安装` : `安装 ${row.name}`}
                                  disabled={row.installed || installedSet.has(row.name) || busy.has(`install:${row.name}`)}
                                  onClick={() => { onInstall(row.name) }}
                                >
                                  {(row.installed || installedSet.has(row.name)) ? <Check size={14} /> : <Plus size={14} />}
                                </button>
                              </div>
                              <div className={css.cardFoot}>
                                <span className={css.cardAuthor}>{authorOf(row.name)} · v{row.version}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                ))}
              </>
            ) : (
              <>
                {error !== null && entries === null && <p className={css.errorText}>加载失败：{error}</p>}
                {entries === null && error === null && <p className={css.hintText}>加载中…</p>}
                {entries !== null && personalEntries.length === 0 && (
                  <p className={css.hintText}>没有本地/开发中插件</p>
                )}
                <div className={css.cardGrid}>
                  {personalEntries.map(entry => (
                    <div key={entry.entryId} className={css.card}>
                      <div className={css.cardHead}>
                        <div className={css.cardIcon}>{pluginIcon(entry.moduleName, 17)}</div>
                        <div className={css.cardMeta}>
                          <span className={css.cardName}>{shortName(entry.moduleName)}</span>
                          {entry.description !== undefined && entry.description !== '' && (
                            <span className={css.cardDesc}>{entry.description}</span>
                          )}
                        </div>
                        <button
                          type="button"
                          className={css.installBtn}
                          data-installed
                          aria-label={`${entry.moduleName} 已安装`}
                          disabled
                        ><Check size={14} /></button>
                      </div>
                      <div className={css.cardFoot}>
                        <span className={css.cardAuthor}>
                          {authorOf(entry.moduleName)}{entry.version !== undefined ? ` · v${entry.version}` : ''}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <>
            {/* 系统插件 note：runtime 条目不进本列表（installedPlugins 已过滤） */}
            <p className={css.note}>系统插件（runtime）不在此列表暴露，仅运行时装配。</p>

            {error !== null && entries === null && <p className={css.errorText}>加载失败：{error}</p>}
            {entries === null && error === null && <p className={css.hintText}>加载中…</p>}
            {entries !== null && visibleInstalled.length === 0 && (
              <p className={css.hintText}>{keyword === '' ? '没有已装插件' : '没有符合条件的插件'}</p>
            )}

            <div className={css.cardGrid}>
              {visibleInstalled.map(entry => (
                <div key={entry.entryId} className={css.card} data-off={!entry.enabled || undefined}>
                  <div className={css.cardHead}>
                    <div className={css.cardIcon}>{pluginIcon(entry.moduleName, 17)}</div>
                    <div className={css.cardMeta}>
                      <span className={css.cardName}>{shortName(entry.moduleName)}</span>
                      {entry.description !== undefined && entry.description !== '' && (
                        <span className={css.cardDesc}>{entry.description}</span>
                      )}
                    </div>
                  </div>
                  {/* 底部行 = 版本 chip + 启用开关 + 配置 + 卸载（design.pen 已装卡片 footer） */}
                  <div className={css.cardFoot}>
                    <span className={css.versionChip}>
                      {entry.version !== undefined ? `v${entry.version}` : '未标版本'}
                    </span>
                    <span className={css.footSpacer} />
                    <button
                      type="button"
                      role="switch"
                      aria-checked={entry.enabled}
                      aria-label={`${shortName(entry.moduleName)} 启用开关`}
                      className={css.switch}
                      data-off={!entry.enabled || undefined}
                      disabled={busy.has(`toggle:${entry.entryId}`)}
                      onClick={() => { void onToggleEnabled(entry) }}
                    ><span className={css.switchKnob} /></button>
                    <button
                      type="button"
                      className={css.setBtn}
                      aria-expanded={detailId === entry.entryId}
                      disabled={detailLoading && detailId === entry.entryId}
                      onClick={() => { onConfigure(entry) }}
                    >
                      {detailLoading && detailId === entry.entryId
                        ? <LoaderCircle size={12} className={css.spin} />
                        : '配置'}
                    </button>
                    <button
                      type="button"
                      className={css.delBtn}
                      aria-label={`卸载 ${shortName(entry.moduleName)}`}
                      disabled={busy.has(`uninstall:${entry.entryId}`)}
                      onClick={() => { void onUninstall(entry) }}
                    ><Trash2 size={14} /></button>
                  </div>

                  {/* 「配置」就地展开：pluginManager/detail 的投影 */}
                  {detailId === entry.entryId && detail !== null && (
                    <div className={css.detailPanel}>
                      {detailField('包名', detail.moduleName)}
                      {detailField('版本', detail.version !== undefined ? `v${detail.version}` : undefined)}
                      {detailField('发布者', detail.publisher)}
                      {detailField('来源', detail.origin === 'official' ? '官方' : detail.origin === 'corum' ? '本项目' : '第三方')}
                      {detailField('安装自', detail.installedFrom)}
                      {detailField('许可证', detail.license)}
                      {detailField('主页', detail.homepage)}
                      {detailField('仓库', detail.repository)}
                      {detail.keywords !== undefined && detail.keywords.length > 0
                        ? detailField('标签', detail.keywords.join('、'))
                        : null}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {error !== null && entries !== null && <p className={css.errorText}>{error}</p>}
      </div>

      {/* ── 5. 操作反馈条（安装/卸载/启停后的提示 + 可选「立即重启」）── */}
      {notice !== null && (
        <div className={css.notice}>
          <span className={css.noticeText}>{notice}</span>
          {canRestart && notice.includes('重启') && (
            <button type="button" className={css.noticeAction} onClick={onRestart}>立即重启</button>
          )}
          <button
            type="button"
            className={css.noticeClose}
            aria-label="关闭提示"
            onClick={() => { setNotice(null) }}
          ><X size={14} /></button>
        </div>
      )}
    </div>
  )
}

/** 供后续「分类完整列表页」复用的分节口径（当前页只做概览分组）。 */
export { SECTIONS }
export type { Section, SearchResult }
