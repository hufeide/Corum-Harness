/**
 * PluginsPage —— 集成中心 ·「插件」内容页（Metro 磁贴改版）。
 *
 * 保留 PR5 的数据面（RPC 方法名与参数逐字未动）：
 *   - list() / search({query}) / detail({entryId}) / install({spec})
 *     / uninstall({entryId}) / setEnabled({entryId, enabled})。
 * 视图改为「Metro 磁贴 + 右侧详情简介面板」：
 *   - 市场态：搜索框 + 分类筛选 chips（全部 / Agent 能力 / 界面 / 主题）+
 *     磁贴混排（官方/主推 = 大贴 264×264 + 品牌 glow，长描述 = 宽贴 264×128，
 *     其余 = 小贴 128×128），角标 = 火焰 + 周下载量；详情面板操作 =
 *     安装（品牌实色）/ 查看详情（玻璃描边）。
 *   - 已装态：磁贴角标 = 启停开关（pluginManager/setEnabled）；详情面板
 *     操作 = 配置（pluginManager/detail 投影就地展示）/ 卸载（error 描边）。
 *     系统插件（runtime）不在此列表暴露，仅 note 声明。
 *
 * 磁贴选中态 = React state（每 tab 各记一个 id，默认选第一个）；
 * 详情面板与磁贴群同级（flex 横排：左磁贴 fill / 右详情 510px 固定宽）。
 *
 * 色值一律走 --corum-* / --dsw-alias-* token（见同目录 PluginsPage.module.css），
 * 本文件不出现裸 hex。
 * @module corum-ide-integrations-ui/client/PluginsPage
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Blocks, BrainCircuit, Cable, Check, ChevronDown, Cpu, ExternalLink, Flame, FolderOpen, KeyRound,
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

/** pluginManager.detail 的详情投影（详情面板「配置」用）。 */
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

/** 一个分类筛选 chip（设计稿：全部 / Agent 能力 / 界面 / 主题）。 */
interface Section {
  readonly id: string
  readonly label: string
  /**
   * 归类关键词（小写，命中包名或描述即归入本分类；「全部」不参与归类筛选，
   * 选中它显示所有结果）。热门是兜底分类，关键词为空——未被具名分类认领的
   * 结果全归热门，从而同一张磁贴不会被归入两个分类。
   */
  readonly keywords: readonly string[]
}

/**
 * 四个分类筛选 + 归类关键词。关键词取 corum 生态的真实分组口径（Agent 能力 =
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

/** 每个分类的磁贴数上限（磁贴群是「概览」，不是完整列表页）。 */
const SECTION_LIMIT = 6

/** 检索词（挂载即检索一次；分类归类在本页做，不额外打 registry）。 */
const INITIAL_QUERY = 'corum plugin'

/** 输入防抖时长（毫秒）。 */
const SEARCH_DEBOUNCE_MS = 300

/**
 * 插件市场假卡片（展示用占位数据）：检索无结果时兜底，看最终磁贴效果。
 * 覆盖大贴（记忆，官方 glow）/ 宽贴（终端面板/霓虹紫主题）/ 小贴（技能管理/MCP 文件/Git 工具），
 * 含热度数值（weeklyDownloads → heatLabel）与版本徽章，数据结构同 SearchResult。
 */
const FAKE_MARKET_TILES: readonly SearchResult[] = [
  { name: '@corum/corum-memory', version: '1.4.2', description: '为 Agent 提供长期记忆存储与检索，跨会话记住你的偏好与项目上下文。', weeklyDownloads: 12400 },
  { name: '@corum/corum-terminal-panel', version: '1.2.0', description: '集成终端 / 串口 / SSH 三合一底部面板，支持分屏与会话持久化。', weeklyDownloads: 3800 },
  { name: '@corum/corum-neon-purple-theme', version: '3.0.1', description: '深色紫调主题包，含语法高亮与玻璃拟态图层定制。', weeklyDownloads: 2100 },
  { name: '@corum/corum-skill-manager', version: '2.1.0', description: '声明式技能包：为 Agent 装配可复用的领域工作流与验证跑器。', weeklyDownloads: 8100 },
  { name: '@corum/corum-mcp-filesystem', version: '0.9.1', description: '让 Agent 读写本地文件系统，支持目录监视与增量同步。', weeklyDownloads: 6700 },
  { name: '@corum/corum-git-tools', version: '1.1.0', description: '分支 / 提交 / 差异审查一体化，Agent 可直接操作仓库。', weeklyDownloads: 5200 },
] as unknown as readonly SearchResult[]

/* ── 展示映射 ─────────────────────────────────────────────────────────────── */

/** 展示名：包名末段（去 scope），如 @corum/corum-ide-sidebar-ui → corum-ide-sidebar-ui。 */
function shortName(moduleName: string): string {
  return moduleName.split('/').pop() ?? moduleName
}

/**
 * 作者/发布者小字。npm 检索结果不带 author 字段，故按包域反推：@corum/* → corum，
 * @deepseek-ai/* → deepseek-ai，无域（第三方散包）→ community。
 * 已装条目的详情投影里有真 publisher 时优先用真值。
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

/** 磁贴图标（lucide glyph，按包名语义映射；与设置页插件卡片同口径）。 */
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

/** 归类：返回该结果应当落在的分类 id（具名分类优先，未命中归热门/兜底）。 */
function sectionOf(name: string, description?: string): string {
  const hay = `${name} ${description ?? ''}`.toLowerCase()
  for (const section of SECTIONS) {
    if (section.keywords.length === 0) continue
    if (section.keywords.some(keyword => hay.includes(keyword))) return section.id
  }
  return 'popular'
}

/** 周下载量的展示形（12.4k / 876）。 */
function heatLabel(weeklyDownloads?: number): string | null {
  if (weeklyDownloads === undefined) return null
  if (weeklyDownloads >= 1000) return `${(weeklyDownloads / 1000).toFixed(1)}k`
  return String(weeklyDownloads)
}

/**
 * 磁贴尺寸分级（Metro 混排）：官方/主推（@corum / @deepseek-ai 域）= 大贴 2×2
 * + glow；描述较长的 = 宽贴 2×1；其余 = 小贴 1×1。
 */
function tileSizeOf(name: string, description?: string): 'big' | 'wide' | 'small' {
  if (name.startsWith('@corum/') || name.startsWith('@deepseek-ai/')) return 'big'
  if ((description ?? '').length >= 120) return 'wide'
  return 'small'
}

/* ── 页面本体 ─────────────────────────────────────────────────────────────── */

/**
 * 集成中心 ·「插件」页（市场 + 已装，Metro 磁贴版）。
 * @param props - 挂载点注入的 pluginManager RPC caller。
 */
export function PluginsPage({ callRemote }: PluginsPageProps) {
  const [tab, setTab] = useState<Tab>('market')
  const [scope, setScope] = useState<MarketScope>('public')
  const [query, setQuery] = useState(INITIAL_QUERY)
  /** 分类筛选（'all' = 全部分类）。 */
  const [filter, setFilter] = useState<string>('all')

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

  // 详情面板选中态：每个 tab 各记一个选中 id（null = 默认选第一个）。
  const [marketId, setMarketId] = useState<string | null>(null)
  const [installedId, setInstalledId] = useState<string | null>(null)
  // 已装详情投影（pluginManager/detail，选中条目变化时拉取）。
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

  // 挂载：拉已装清单（市场磁贴要标已装、个人范围要用）+ 检索一次默认词。
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

  /** 安装（详情面板主操作；市场角标已装的磁贴不再出安装钮）。 */
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
    if (installedId === entry.entryId) setInstalledId(null)
    await refreshList()
  }), [withBusy, callRemote, refreshList, installedId])

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

  /** 分类筛选（'all' = 全部；否则命中该分类才显示）。 */
  const inFilter = useCallback((moduleName: string, description?: string): boolean => {
    if (filter === 'all') return true
    return sectionOf(moduleName, description) === filter
  }, [filter])

  /** 已装 tab 的可见集（本地过滤，含描述）。 */
  const visibleInstalled = useMemo(
    () => installedPlugins.filter(entry => matches(entry.moduleName, entry.description) && inFilter(entry.moduleName, entry.description)),
    [installedPlugins, matches, inFilter],
  )

  /** 个人范围 = 已装清单里的本地/开发中插件（本地过滤）。 */
  const personalEntries = useMemo(
    () => installedPlugins.filter(e => isLocalSpec(e.moduleName) && matches(e.moduleName, e.description) && inFilter(e.moduleName, e.description)),
    [installedPlugins, matches, inFilter],
  )

  /** 公开市场：按分类筛选 + 排序（下载量降序）+ 分组限量。 */
  const marketTiles = useMemo(() => {
    const rows = [...(results ?? [])].filter(r => matches(r.name, r.description) && inFilter(r.name, r.description))
    // 展示用假卡片：检索无结果时兜底，看最终磁贴效果（FAKE_MARKET_TILES）。
    if (rows.length === 0) return [...FAKE_MARKET_TILES]
    if (filter === 'all') {
      const buckets = new Map<string, SearchResult[]>(SECTIONS.map(s => [s.id, []]))
      for (const row of rows) {
        const bucket = buckets.get(sectionOf(row.name, row.description))
        if (bucket !== undefined) bucket.push(row)
      }
      const popular = buckets.get('popular') ?? []
      popular.sort((a, b) => (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0))
      const picked: SearchResult[] = []
      const seen = new Set<string>()
      // 「全部」视图：热门兜底在前（下载量降序），具名分类按序补充，限量保证磁贴群是概览。
      for (const row of popular) { if (!seen.has(row.name)) { seen.add(row.name); picked.push(row) } }
      for (const section of SECTIONS) {
        if (section.id === 'popular') continue
        for (const row of buckets.get(section.id) ?? []) {
          if (picked.length >= SECTION_LIMIT * 2) break
          if (!seen.has(row.name)) { seen.add(row.name); picked.push(row) }
        }
      }
      return picked.slice(0, SECTION_LIMIT * 2)
    }
    rows.sort((a, b) => (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0))
    return rows.slice(0, SECTION_LIMIT * 2)
  }, [results, matches, inFilter, filter])

  /** 市场「个人」范围的磁贴数据（与已装同构）。 */
  const personalTiles = personalEntries

  const installedSet = useMemo(
    () => new Set((entries ?? []).map(entry => entry.moduleName)),
    [entries],
  )

  /* ── 详情面板选中态 ── */

  /** 市场态选中的检索结果（默认第一个；切换 tab/视图后回落）。 */
  const selectedMarket = useMemo<SearchResult | InstalledEntry | null>(() => {
    const pool: readonly (SearchResult | InstalledEntry)[] = scope === 'public' ? marketTiles : personalTiles
    if (pool.length === 0) return null
    const hit = marketId !== null ? pool.find(r => 'name' in r && r.name === marketId) : undefined
    return hit ?? pool[0]
  }, [marketId, scope, marketTiles, personalTiles])

  /** 已装态选中的条目（默认第一个）。 */
  const selectedInstalled = useMemo(() => {
    if (visibleInstalled.length === 0) return null
    const hit = installedId !== null
      ? visibleInstalled.find(e => e.entryId === installedId)
      : undefined
    return hit ?? visibleInstalled[0]
  }, [installedId, visibleInstalled])

  // 已装选中项变化：拉一次 pluginManager/detail（失败静默——详情投影是增强面）。
  useEffect(() => {
    if (tab !== 'installed' || selectedInstalled === null) return
    let cancelled = false
    setDetail(null)
    setDetailLoading(true)
    void (async () => {
      try {
        const r = await callRemote<{ detail: PluginDetail }>('detail', { entryId: selectedInstalled.entryId })
        if (!cancelled) setDetail(r.detail)
      } catch {
        if (!cancelled) setDetail(null)
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, selectedInstalled, callRemote])

  /** 搜索框提示语随当前视图切换（一个搜索框服务三个视图，不重复画框）。 */
  const searchPlaceholder = tab === 'installed'
    ? '搜索已装插件'
    : scope === 'personal' ? '搜索本地/开发中插件' : '搜索插件'

  const bridge = typeof window === 'undefined'
    ? undefined
    : (window as unknown as { corumDesktop?: DesktopBridge }).corumDesktop
  const canRestart = typeof bridge?.restartHost === 'function'

  /** 分类 chips（全部 + 具名分类）。 */
  const filterChips: ReadonlyArray<readonly [string, string]> = [['all', '全部'], ...SECTIONS.map(s => [s.id, s.label] as const)]

  /* ── 磁贴渲染 ── */

  /** 市场磁贴（检索结果条目 → 磁贴）。 */
  const renderMarketTile = (row: SearchResult & { entryId?: string }): ReactNode => {
    const active = selectedMarket !== null && 'name' in selectedMarket && selectedMarket.name === row.name
    const installed = row.installed || installedSet.has(row.name)
    const size = tileSizeOf(row.name, row.description)
    const heat = heatLabel(row.weeklyDownloads)
    const sizeClass = size === 'big' ? ` ${css.tileBig}` : size === 'wide' ? ` ${css.tileWide}` : ''
    return (
      <button
        key={row.name}
        type="button"
        className={`${css.tile}${sizeClass}${size === 'big' ? ' ' + css.tileGlow : ''}${active ? ' ' + css.tileActive : ''}`}
        aria-pressed={active}
        onClick={() => { setMarketId(row.name) }}
      >
        <div className={css.tileTop}>
          <span className={css.tileIcon}>{pluginIcon(row.name, size === 'big' ? 24 : 18)}</span>
          <span className={css.tileHeat}>
            {heat !== null && (
              <>
                <Flame size={12} className={css.tileHeatIcon} />
                <span className={css.tileHeatValue}>{heat}</span>
              </>
            )}
          </span>
        </div>
        <div className={css.tileBottom}>
          <div className={css.tileNameRow}>
            <span className={css.tileName}>{shortName(row.name)}</span>
            <span className={css.tileVersion}>v{row.version}</span>
          </div>
          {(size === 'big' || size === 'wide') && row.description !== undefined && row.description !== '' && (
            <span className={css.tileDesc}>{row.description}</span>
          )}
          <span className={css.tileSub}>{authorOf(row.name)}</span>
        </div>
      </button>
    )
  }

  /** 市场「个人」范围磁贴（已装条目 → 磁贴，已装徽章）。 */
  const renderPersonalTile = (entry: InstalledEntry): ReactNode => {
    const active = selectedMarket !== null && 'entryId' in selectedMarket && selectedMarket.entryId === entry.entryId
    const size = tileSizeOf(entry.moduleName, entry.description)
    const sizeClass = size === 'big' ? ` ${css.tileBig}` : size === 'wide' ? ` ${css.tileWide}` : ''
    return (
      <button
        key={entry.entryId}
        type="button"
        className={`${css.tile}${sizeClass}${size === 'big' ? ' ' + css.tileGlow : ''}${active ? ' ' + css.tileActive : ''}`}
        aria-pressed={active}
        onClick={() => { setMarketId(entry.entryId) }}
      >
        <div className={css.tileTop}>
          <span className={css.tileIcon}>{pluginIcon(entry.moduleName, size === 'big' ? 24 : 18)}</span>
        </div>
        <div className={css.tileBottom}>
          <div className={css.tileNameRow}>
            <span className={css.tileName}>{shortName(entry.moduleName)}</span>
            {entry.version !== undefined && <span className={css.tileVersion}>v{entry.version}</span>}
          </div>
          {(size === 'big' || size === 'wide') && entry.description !== undefined && entry.description !== '' && (
            <span className={css.tileDesc}>{entry.description}</span>
          )}
          <span className={css.tileSub}>{authorOf(entry.moduleName)}</span>
        </div>
      </button>
    )
  }

  /** 已装磁贴（角标 = 启停开关）。 */
  const renderInstalledTile = (entry: InstalledEntry): ReactNode => {
    const active = selectedInstalled !== null && selectedInstalled.entryId === entry.entryId
    const size = tileSizeOf(entry.moduleName, entry.description)
    const sizeClass = size === 'big' ? ` ${css.tileBig}` : size === 'wide' ? ` ${css.tileWide}` : ''
    return (
      <div
        key={entry.entryId}
        className={`${css.tile}${sizeClass}${size === 'big' ? ' ' + css.tileGlow : ''}${active ? ' ' + css.tileActive : ''}`}
        data-off={!entry.enabled || undefined}
        role="button"
        tabIndex={0}
        aria-pressed={active}
        onClick={() => { setInstalledId(entry.entryId) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setInstalledId(entry.entryId) } }}
      >
        <div className={css.tileTop}>
          <span className={css.tileIcon}>{pluginIcon(entry.moduleName, size === 'big' ? 24 : 18)}</span>
          <button
            type="button"
            role="switch"
            aria-checked={entry.enabled}
            aria-label={`${shortName(entry.moduleName)} 启用开关`}
            className={css.tileSwitch}
            data-off={!entry.enabled || undefined}
            disabled={busy.has(`toggle:${entry.entryId}`)}
            onClick={(e) => { e.stopPropagation(); void onToggleEnabled(entry) }}
          ><span className={css.tileSwitchKnob} /></button>
        </div>
        <div className={css.tileBottom}>
          <div className={css.tileNameRow}>
            <span className={css.tileName}>{shortName(entry.moduleName)}</span>
            {entry.version !== undefined && <span className={css.tileVersion}>v{entry.version}</span>}
          </div>
          {(size === 'big' || size === 'wide') && entry.description !== undefined && entry.description !== '' && (
            <span className={css.tileDesc}>{entry.description}</span>
          )}
          <span className={css.tileSub}>{authorOf(entry.moduleName)} · {entry.enabled ? '已启用' : '已停用'}</span>
        </div>
      </div>
    )
  }

  /* ── 详情面板 ── */

  /** 市场态详情面板主体。 */
  let marketDetail: ReactNode = null
  if (tab === 'market' && selectedMarket !== null) {
    if (scope === 'public') {
      const row = selectedMarket as SearchResult
      const installed = row.installed || installedSet.has(row.name)
      marketDetail = (
        <>
          <div className={css.detailHero}>
            <span className={css.detailHeroBadge}>{pluginIcon(row.name, 30)}</span>
          </div>
          <div className={css.detailTitleRow}>
            <span className={css.detailName}>{shortName(row.name)}</span>
            <span className={css.tileVersion}>v{row.version}</span>
          </div>
          <span className={css.detailSub}>{authorOf(row.name)} · npm</span>
          <p className={css.detailDesc}>{row.description ?? '该插件未提供描述。'}</p>
          <div className={css.detailMeta}>
            {row.date !== undefined && (
              <div className={css.detailMetaRow}>
                <span className={css.detailMetaKey}>更新</span>
                <span className={css.detailMetaValue}>{row.date.slice(0, 10)}</span>
              </div>
            )}
            {row.weeklyDownloads !== undefined && (
              <div className={css.detailMetaRow}>
                <span className={css.detailMetaKey}>热度</span>
                <span className={css.detailMetaValue}>周下载 {heatLabel(row.weeklyDownloads) ?? String(row.weeklyDownloads)}</span>
              </div>
            )}
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>分类</span>
              <span className={css.detailMetaValue}>{SECTIONS.find(s => s.id === sectionOf(row.name, row.description))?.label ?? '热门'}</span>
            </div>
          </div>
          <div className={css.detailSpacer} />
          <div className={css.detailActions}>
            {installed
              ? (
                <button type="button" className={css.actionBtn} disabled>
                  <Check size={13} />已安装
                </button>
              )
              : (
                <button
                  type="button"
                  className={`${css.actionBtn} ${css.actionPrimary}`}
                  disabled={busy.has(`install:${row.name}`)}
                  onClick={() => { void onInstall(row.name) }}
                >
                  {busy.has(`install:${row.name}`) ? <LoaderCircle size={13} className={css.spin} /> : <Plus size={13} />}
                  安装
                </button>
              )}
            <button type="button" className={css.actionBtn} onClick={() => { void onInstall(row.name) }} disabled={installed}>
              <ExternalLink size={13} />查看详情
            </button>
          </div>
        </>
      )
    } else {
      const entry = selectedMarket as InstalledEntry
      marketDetail = (
        <>
          <div className={css.detailHero}>
            <span className={css.detailHeroBadge}>{pluginIcon(entry.moduleName, 30)}</span>
          </div>
          <div className={css.detailTitleRow}>
            <span className={css.detailName}>{shortName(entry.moduleName)}</span>
            {entry.version !== undefined && <span className={css.tileVersion}>v{entry.version}</span>}
          </div>
          <span className={css.detailSub}>{authorOf(entry.moduleName)} · 本地/开发中</span>
          <p className={css.detailDesc}>{entry.description ?? '该插件未提供描述。'}</p>
          <div className={css.detailMeta}>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>包名</span>
              <span className={css.detailMetaValue}>{entry.moduleName}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>状态</span>
              <span className={css.detailMetaValue}>{entry.enabled ? '已启用' : '已停用'}</span>
            </div>
          </div>
          <div className={css.detailSpacer} />
          <div className={css.detailActions}>
            <button type="button" className={css.actionBtn} disabled>
              <Check size={13} />已安装
            </button>
          </div>
        </>
      )
    }
  }

  /** 已装态详情面板主体。 */
  let installedDetail: ReactNode = null
  if (tab === 'installed' && selectedInstalled !== null) {
    const entry = selectedInstalled
    const d = detail
    installedDetail = (
      <>
        <div className={css.detailHero}>
          <span className={css.detailHeroBadge}>{pluginIcon(entry.moduleName, 30)}</span>
        </div>
        <div className={css.detailTitleRow}>
          <span className={css.detailName}>{shortName(entry.moduleName)}</span>
          {entry.version !== undefined && <span className={css.tileVersion}>v{entry.version}</span>}
        </div>
        <span className={css.detailSub}>
          {d?.publisher ?? authorOf(entry.moduleName)}
          {d !== null && d.origin === 'official' ? ' · 官方' : d !== null && d.origin === 'corum' ? ' · 本项目' : d !== null ? ' · 第三方' : ''}
        </span>
        <p className={css.detailDesc}>{entry.description ?? d?.description ?? '该插件未提供描述。'}</p>
        <div className={css.detailMeta}>
          <div className={css.detailMetaRow}>
            <span className={css.detailMetaKey}>状态</span>
            <span className={css.detailMetaValue}>{entry.enabled ? '已启用' : '已停用'}</span>
          </div>
          {d?.license !== undefined && (
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>许可证</span>
              <span className={css.detailMetaValue}>{d.license}</span>
            </div>
          )}
          {d?.homepage !== undefined && (
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>主页</span>
              <span className={css.detailMetaValue}>{d.homepage}</span>
            </div>
          )}
          {d?.installedFrom !== undefined && (
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>安装自</span>
              <span className={css.detailMetaValue}>{d.installedFrom}</span>
            </div>
          )}
        </div>
        <div className={css.detailSpacer} />
        <div className={css.detailActions}>
          <button
            type="button"
            className={css.actionBtn}
            disabled={busy.has(`uninstall:${entry.entryId}`)}
            onClick={() => { void onUninstall(entry) }}
          >
            {busy.has(`uninstall:${entry.entryId}`) ? <LoaderCircle size={13} className={css.spin} /> : <Trash2 size={13} />}
            卸载
          </button>
        </div>
      </>
    )
  }

  return (
    <div className={css.page}>
      {/* ── 1. 页头：标题 + 搜索 + 添加▾ ── */}
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

      {/* ── 3. 来源条：添加▾ 选中某一来源后内联展开 ── */}
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

      {/* ── 4. 内容区：左磁贴群 + 右详情面板 ── */}
      <div className={css.body}>
        <div className={css.tiles}>
          {/* 分类筛选 chips（全部 / Agent 能力 / 界面 / 主题；热门仅在「全部」视图作兜底归类） */}
          <div className={css.filterRow} role="group" aria-label="分类筛选">
            {filterChips.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`${css.filterChip}${filter === id ? ' ' + css.filterChipActive : ''}`}
                aria-pressed={filter === id}
                onClick={() => { setFilter(id) }}
              >{label}</button>
            ))}
          </div>

          {tab === 'market' && scope === 'public' && (
            <>
              {searchError !== null && <p className={css.errorText}>检索失败：{searchError}</p>}
              {searchError === null && results === null && <p className={css.hintText}>检索中…</p>}
              {results !== null && marketTiles.length === 0 && <p className={css.hintText}>没有匹配的插件</p>}
              <div className={css.tileGrid}>
                {marketTiles.map(row => renderMarketTile(row))}
              </div>
            </>
          )}

          {tab === 'market' && scope === 'personal' && (
            <>
              {error !== null && entries === null && <p className={css.errorText}>加载失败：{error}</p>}
              {entries === null && error === null && <p className={css.hintText}>加载中…</p>}
              {entries !== null && personalTiles.length === 0 && <p className={css.hintText}>没有本地/开发中插件</p>}
              <div className={css.tileGrid}>
                {personalTiles.map(entry => renderPersonalTile(entry))}
              </div>
            </>
          )}

          {tab === 'installed' && (
            <>
              <p className={css.note}>系统插件（runtime）不在此列表暴露，仅运行时装配。</p>
              {error !== null && entries === null && <p className={css.errorText}>加载失败：{error}</p>}
              {entries === null && error === null && <p className={css.hintText}>加载中…</p>}
              {entries !== null && visibleInstalled.length === 0 && (
                <p className={css.hintText}>{keyword === '' ? '没有已装插件' : '没有符合条件的插件'}</p>
              )}
              <div className={css.tileGrid}>
                {visibleInstalled.map(entry => renderInstalledTile(entry))}
              </div>
            </>
          )}

          {error !== null && entries !== null && <p className={css.errorText}>{error}</p>}
        </div>

        {/* 右侧详情简介面板（点击磁贴就地展开；默认选第一个） */}
        <aside className={css.detail} aria-label="插件详情">
          {tab === 'market' && (marketDetail ?? <DetailEmpty title="选择一个插件" desc="点左侧任意插件磁贴，在这里查看它的简介、热度与版本；点「安装」一键装入。" />)}
          {tab === 'installed' && (installedDetail ?? <DetailEmpty title="选择一个已装插件" desc="点左侧任意已装插件磁贴，在这里查看它的版本、状态与操作；开关可就地启停。" />)}
        </aside>
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

/** 详情面板空态（未选中任何磁贴）：产品 logo + glow + 引导文案。 */
function DetailEmpty({ title, desc }: { title: string; desc: string }) {
  return (
    <div className={css.detailEmpty}>
      <div className={css.detailEmptyHero}>
        <img className={css.detailEmptyLogo} src="corumapp://app/assets/icon.png" alt="" draggable={false} />
      </div>
      <p className={css.detailEmptyTitle}>{title}</p>
      <p className={css.detailEmptyDesc}>{desc}</p>
    </div>
  )
}
