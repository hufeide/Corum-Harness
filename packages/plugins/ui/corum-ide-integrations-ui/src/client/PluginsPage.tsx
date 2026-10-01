/**
 * PluginsPage —— 集成中心 ·「插件」内容页（Metro 磁贴版）。
 *
 * 对应 design.pen 定稿：iYTAN「集成中心·插件市场」+ fngID「已装插件」。
 *
 * 保留 PR5 的数据面（RPC 方法名与参数逐字未动）：
 *   - list() / search({query}) / detail({entryId}) / install({spec})
 *     / uninstall({entryId}) / setEnabled({entryId, enabled})。
 *
 * 视图结构：
 *   - 页头一行：tab·市场 / tab·已装（pill 形态）+ 搜索框 280×31 + 分类 chips
 *     （全部 / Agent 能力 / 界面 / 主题），下接一条全宽 1px 分隔线。
 *   - 市场态磁贴群分两节：「最热门」（节头 = flame 15 + 文字 13/600，其下
 *     196×120 热排 ×4，取该分类下载量最高 4 条）+「全部插件」（块生成器混排：
 *     固定种子伪随机选块型，块行高 264/128、列宽 264/128 —— 几何由共享包
 *     corum-ui-base/client 的 buildMosaic + MosaicWall 提供，排布只有一个事实源）。
 *     选中具名分类时只渲染该分类的节（节头文字 = 分类名）。
 *   - 磁贴群首张即第一个插件磁贴（设计稿无「添加」磁贴；本地包 / URL 安装入口
 *     在设置中心「插件管理」页）。
 *   - 磁贴底色 = 四档语义 tint（紫/深紫/灰蓝/堇），直接消费 --corum-tile-* token；
 *     热度角标（火焰 + 周下载量）只出现在市场态；已装态角标位 = 启停开关。
 *   - 磁贴自身没有任何操作按钮（点磁贴只做选中）；安装 / 卸载 / 启停统一只在
 *     右侧详情面板底部，按「类型 × 状态」分派：未安装 = 单个「安装」（品牌实色）；
 *     已安装 =「卸载」（error 描边）+ 启停开关。
 *   - 详情面板 510 固定宽 = hero(150) + body(padding[16,18], space-between)；
 *     三个视图（市场未装 / 市场已装 / 已装 tab）共用同一套字段顺序 —— 名称（大标题）
 *     / id / 版本 / 发布日期 / 作者 / 日志（更新日志）；其余有真值的字段（描述 /
 *     许可证 / 主页 / 仓库 / 安装自 / 关键词 / 热度 / 分类 / 状态）排在「日志」之后。
 *     全部信息就地展示，无二级跳转。
 *     系统插件（runtime）不在此列表暴露，仅 note 声明。
 *
 * 色值一律走 --corum-* / --dsw-alias-* token（见同目录 PluginsPage.module.css），
 * 本文件不出现裸 hex。
 * @module corum-ide-integrations-ui/client/PluginsPage
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Blocks, BrainCircuit, Cable, Cpu, Flame, KeyRound,
  LoaderCircle, Palette, Plus, Puzzle, Route, Search, Server, ServerCog,
  SquareTerminal, Trash2, WandSparkles, X,
} from 'lucide-react'
import {
  buildMosaic, mosaicStyles, mosaicTileClass, MosaicWall, useMosaicColumns,
  type MosaicItemHint, type MosaicSize, type MosaicTint,
} from '@corum/corum-ui-base/client'
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

/** 一条更新日志（详情面板「日志」区的一行）。 */
interface ChangelogEntry {
  readonly version: string
  readonly date: string
  readonly note: string
}

/**
 * 详情面板主体的统一字段面（三个视图共用）：名称 + 固定的六项字段 + 可选补充行。
 * 六项 = 名称（大标题）/ id / 版本 / 发布日期 / 作者 / 日志，顺序与文案逐字固定；
 * `extras` 是其余有真值的字段（来源 / 状态 / 许可证 / 主页 / 仓库 / 安装自 /
 * 关键词 / 热度 / 分类），一律排在「日志」之后。
 */
interface DetailFields {
  /** 名称（大标题）：包名末段。 */
  readonly name: string
  /** id：包名全称（等宽展示）。 */
  readonly moduleName: string
  readonly version?: string | undefined
  /** 发布日期（ISO 或 YYYY-MM-DD；截前 10 位展示）。 */
  readonly date?: string | undefined
  /** 作者（真 publisher 优先，否则按包域反推）。 */
  readonly author: string
  /** 日志：该插件自己的版本变更记录。 */
  readonly changelog?: readonly ChangelogEntry[] | undefined
  readonly description?: string | undefined
  readonly extras?: ReadonlyArray<readonly [string, ReactNode]> | undefined
  readonly loading?: boolean | undefined
}

/** pluginManager.search 的一条结果（npm registry 候选）。 */
interface SearchResult {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly installed: boolean
  /** 最后更新日期（ISO），详情面板的「发布日期」。 */
  readonly date?: string
  /** 周下载量。 */
  readonly weeklyDownloads?: number
  /** 综合评分 0-1。 */
  readonly score?: number
  /** 发布者（详情面板「作者」；缺省时按包域反推）。 */
  readonly publisher?: string
  /** 许可证（详情面板可选行）。 */
  readonly license?: string
  /**
   * 更新日志：该插件自己的版本变更记录。host 的 registry 接口目前不返回，
   * 展示用假数据先填；真值接入后此处替换为 wire 字段即可。
   */
  readonly changelog?: readonly ChangelogEntry[]
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

/** `window.corumDesktop` 上的重启 host 入口。 */
interface DesktopBridge {
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
 * 「热门」不再是 chip（design.pen 分类只有这四个），它只作兜底归类 + 「最热门」节。
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

/** 「最热门」热排的张数（design.pen：196×120 ×4）。 */
const HOT_ROW_LIMIT = 4

/** 检索词（挂载即检索一次；分类归类在本页做，不额外打 registry）。 */
const INITIAL_QUERY = 'corum plugin'

/** 输入防抖时长（毫秒）。 */
const SEARCH_DEBOUNCE_MS = 300

/**
 * 插件市场假数据（展示用）：检索无结果时兜底，用于看磁贴排布与详情面板的最终效果。
 *
 * 覆盖全部分类（Agent 能力 / 界面 / 主题 / 工具）+ 三种来源（官方 / 本项目 / 第三方），
 * 让块生成器有足够素材排出错落形态、详情面板的每个字段也都有值可看。
 * 结构同 SearchResult；`date`（发布日期）与 `changelog`（更新日志）为展示字段。
 */
const FAKE_MARKET_TILES: readonly SearchResult[] = [
  {
    name: '@corum/corum-memory', version: '1.4.2', weeklyDownloads: 12400,
    description: '为 Agent 提供长期记忆存储与检索。跨会话记住你的偏好、项目上下文与历史决策，支持按主题归档与语义检索。',
    date: '2026-09-28', publisher: 'corum', license: 'MIT',
    changelog: [
      { version: '1.4.2', date: '2026-09-28', note: '语义检索支持按项目命名空间过滤' },
      { version: '1.4.0', date: '2026-09-11', note: '新增主题归档与跨会话召回' },
      { version: '1.3.0', date: '2026-08-22', note: '记忆写入改为异步，不再阻塞轮次' },
    ],
  },
  {
    name: '@corum/corum-terminal-panel', version: '1.2.0', weeklyDownloads: 3800,
    description: '集成终端 / 串口 / SSH 三合一底部面板，支持分屏与会话持久化。',
    date: '2026-09-19', publisher: 'corum', license: 'MIT',
    changelog: [
      { version: '1.2.0', date: '2026-09-19', note: '分屏布局可拖拽，会话重启后恢复' },
      { version: '1.1.0', date: '2026-09-02', note: '串口参数表单补齐校验位与流控' },
    ],
  },
  {
    name: '@corum/corum-neon-purple-theme', version: '3.0.1', weeklyDownloads: 2100,
    description: '深色紫调主题包，含语法高亮与玻璃拟态图层定制。',
    date: '2026-09-30', publisher: 'corum', license: 'CC-BY-4.0',
    changelog: [
      { version: '3.0.1', date: '2026-09-30', note: '修正浅色下代码块对比度不足' },
      { version: '3.0.0', date: '2026-09-14', note: '全量重做，换液态玻璃图层' },
    ],
  },
  {
    name: '@corum/corum-skill-manager', version: '2.1.0', weeklyDownloads: 8100,
    description: '声明式技能包：为 Agent 装配可复用的领域工作流与验证跑器。',
    date: '2026-09-12', publisher: 'corum', license: 'MIT',
    changelog: [
      { version: '2.1.0', date: '2026-09-12', note: '技能可绑定到 Agent 预设并锁版本' },
      { version: '2.0.0', date: '2026-08-28', note: '改用 SKILL.md 单一入口，弃用 JSON 描述' },
    ],
  },
  {
    name: '@corum/corum-mcp-filesystem', version: '0.9.1', weeklyDownloads: 6700,
    description: '让 Agent 读写本地文件系统，支持目录监视与增量同步。',
    date: '2026-09-24', publisher: 'modelcontextprotocol', license: 'Apache-2.0',
    changelog: [
      { version: '0.9.1', date: '2026-09-24', note: '路径白名单支持 glob 通配' },
      { version: '0.9.0', date: '2026-09-08', note: '增量同步改为 inotify 事件驱动' },
    ],
  },
  {
    name: '@corum/corum-git-tools', version: '1.1.0', weeklyDownloads: 5200,
    description: '分支 / 提交 / 差异审查一体化，Agent 可直接操作仓库。',
    date: '2026-09-21', publisher: 'corum', license: 'MIT',
    changelog: [
      { version: '1.1.0', date: '2026-09-21', note: '差异审查支持按文件折叠与逐段评论' },
    ],
  },
  {
    name: '@corum/corum-orchestrate-flow', version: '0.6.2', weeklyDownloads: 4400,
    description: '把多步任务编排成可复现的工作流：阶段、扇出与汇总一体，失败可断点重跑。',
    date: '2026-09-26', publisher: 'corum', license: 'MIT',
    changelog: [
      { version: '0.6.2', date: '2026-09-26', note: '扇出阶段支持并发上限' },
      { version: '0.6.0', date: '2026-09-05', note: '工作流可在画布上可视化编辑' },
    ],
  },
  {
    name: '@corum/corum-ide-explorer-ui', version: '1.0.4', weeklyDownloads: 2900,
    description: '资源管理器界面：文件树 / 拖拽 / 右键菜单，与编辑器联动。',
    date: '2026-09-18', publisher: 'corum', license: 'MIT',
    changelog: [
      { version: '1.0.4', date: '2026-09-18', note: '大仓库下文件树懒加载不再卡顿' },
    ],
  },
  {
    name: '@corum/corum-statusbar-ui', version: '0.4.1', weeklyDownloads: 1600,
    description: '底部状态栏：分支、错误数、连接状态与当前模型一目了然。',
    date: '2026-09-15', publisher: 'corum', license: 'MIT',
    changelog: [
      { version: '0.4.1', date: '2026-09-15', note: '新增连接延迟指示' },
    ],
  },
  {
    name: '@corum/corum-token-counter', version: '0.3.0', weeklyDownloads: 980,
    description: '实时统计每轮会话的 token 消耗与成本，按模型分别记账。',
    date: '2026-09-09', publisher: 'corum', license: 'MIT',
    changelog: [
      { version: '0.3.0', date: '2026-09-09', note: '支持按模型配置单价' },
    ],
  },
  {
    name: '@community/corum-prompt-lint', version: '2.4.0', weeklyDownloads: 3100,
    description: '提示词静态检查：发现歧义、缺失约束与自相矛盾的指令，给出改写建议。',
    date: '2026-09-23', publisher: 'community', license: 'MIT',
    changelog: [
      { version: '2.4.0', date: '2026-09-23', note: '新增矛盾检测规则集' },
      { version: '2.3.0', date: '2026-09-01', note: '规则可通过配置文件关闭' },
    ],
  },
  {
    name: '@community/corum-screenshot-diff', version: '1.0.0', weeklyDownloads: 780,
    description: '视觉回归：对同一页面截图做逐像素比对，输出差异热力图。',
    date: '2026-09-17', publisher: 'community', license: 'BSD-3-Clause',
    changelog: [
      { version: '1.0.0', date: '2026-09-17', note: '首个稳定版：像素比对 + 差异热力图' },
    ],
  },
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

/** 详情补充行：只保留有真值的那几条（无值 / 空串的直接丢掉），顺序即入参顺序。 */
function extraRows(
  ...rows: ReadonlyArray<readonly [string, ReactNode | undefined]>
): ReadonlyArray<readonly [string, ReactNode]> {
  return rows.filter((row): row is readonly [string, ReactNode] => row[1] !== undefined && row[1] !== '')
}

/**
 * 磁贴底色的四档语义 tint（design.pen：紫 / 深紫 / 灰蓝 / 堇），按包名语义稳定
 * 映射到共享包的档位：官方/主推 = violet、主题/调色 = deep、MCP/服务类 = slate、
 * 工具/数据/终端 = mauve；同一张磁贴每次渲染取到同一档。
 */
function tileTintOf(name: string): MosaicTint {
  const n = name.toLowerCase()
  if (/theme|palette|color|主题/.test(n)) return 'deep'
  if (/mcp|server|servercog|service|服务/.test(n)) return 'slate'
  if (/tool|git|terminal|data|search|find|记忆|memory|技能|skill/.test(n)) return 'mauve'
  return 'violet'
}

/** 「最热门」热排贴的尺寸标注：热排是 196×120 的独立形态，不在块几何的尺寸序列里。 */
const HOT_TILE_MARK = 'hot' as const


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

  /** 安装（大贴底部主按钮 / 详情面板主操作）。 */
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

  /** 「最热门」热排：当前市场磁贴里下载量最高的前 4 条（不足 4 条有几条画几条）。 */
  const hotTiles = useMemo(() => {
    if (filter !== 'all') return []
    return [...marketTiles]
      .sort((a, b) => (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0))
      .slice(0, HOT_ROW_LIMIT)
  }, [marketTiles, filter])

  /** 「全部插件」网格：全量视图排除热排已展示的那几张，具名分类视图直接用全量。 */
  const gridTiles = useMemo(() => {
    if (filter !== 'all') return marketTiles
    const hotNames = new Set(hotTiles.map(r => r.name))
    return marketTiles.filter(r => !hotNames.has(r.name))
  }, [marketTiles, hotTiles, filter])

  /** 市场「个人」范围的磁贴数据（与已装同构）。 */
  const personalTiles = personalEntries

  const installedSet = useMemo(
    () => new Set((entries ?? []).map(entry => entry.moduleName)),
    [entries],
  )

  /**
   * 磁贴群列数：`ref` 挂在下面 `css.tiles` 那个容器上，窄窗（单位宽撑不住长名字）
   * 自动降 3 列、宽窗回 6 列；两种模式的块宽恒等，故切换不改整墙宽度。
   */
  const tilesRef = useRef<HTMLDivElement>(null)
  const columns = useMosaicColumns(tilesRef)

  /**
   * 排布提示（与磁贴数据同序）：算法据此把**名字长的**放进 264 宽的槽，不再随机
   * 落进 128 窄贴被截断。名字长度按**实际渲染的那个名字**算——本页贴面一律走
   * `shortName(...)`（包名末段），故长度与贴面所见一致。
   */
  const marketHints = useMemo<MosaicItemHint[]>(
    () => gridTiles.map(r => ({
      nameLength: shortName(r.name).length,
      hasDescription: r.description !== undefined && r.description !== '',
    })),
    [gridTiles],
  )
  const personalHints = useMemo<MosaicItemHint[]>(
    () => personalTiles.map(e => ({
      nameLength: shortName(e.moduleName).length,
      hasDescription: e.description !== undefined && e.description !== '',
    })),
    [personalTiles],
  )
  const installedHints = useMemo<MosaicItemHint[]>(
    () => visibleInstalled.map(e => ({
      nameLength: shortName(e.moduleName).length,
      hasDescription: e.description !== undefined && e.description !== '',
    })),
    [visibleInstalled],
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

  /**
   * 详情面板的已装条目兜底：已装态 = 选中条目；市场态已安装的卡片也走「已安装」
   * 形态（卸载 + 启停开关），按包名在已装清单里对回条目。
   */
  const selectedEntry = useMemo<InstalledEntry | null>(() => {
    if (tab === 'installed') return selectedInstalled
    if (selectedMarket === null) return null
    const name = 'name' in selectedMarket ? selectedMarket.name : selectedMarket.moduleName
    return (entries ?? []).find(entry => entry.moduleName === name) ?? null
  }, [tab, selectedInstalled, selectedMarket, entries])

  // 已装态选中项变化：拉一次 pluginManager/detail（失败静默——详情投影是增强面）。
  useEffect(() => {
    if (selectedEntry === null) return
    let cancelled = false
    setDetail(null)
    setDetailLoading(true)
    void (async () => {
      try {
        const r = await callRemote<{ detail: PluginDetail }>('detail', { entryId: selectedEntry.entryId })
        if (!cancelled) setDetail(r.detail)
      } catch {
        if (!cancelled) setDetail(null)
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedEntry, callRemote])

  /** 搜索框提示语随当前视图切换（一个搜索框服务三个视图，不重复画框）。 */
  const searchPlaceholder = tab === 'installed'
    ? '搜索已装插件'
    : scope === 'personal' ? '搜索本地/开发中插件' : '搜索插件…'

  const bridge = typeof window === 'undefined'
    ? undefined
    : (window as unknown as { corumDesktop?: DesktopBridge }).corumDesktop
  const canRestart = typeof bridge?.restartHost === 'function'

  /** 分类 chips（全部 + 具名分类；「热门」不再是 chip，改为节标题）。 */
  const filterChips: ReadonlyArray<readonly [string, string]> = [['all', '全部'], ...SECTIONS.filter(s => s.id !== 'popular').map(s => [s.id, s.label] as const)]

  /* ── 磁贴渲染 ── */

  /**
   * 「最热门」热排贴（196×120 ×4）：热排不进块几何（`.hotRow` 是独立的一行），
   * 故尺寸档固定 small、底色/选中态仍走共享表的拼装，`data-tile-size` 标记 hot。
   */
  const renderHotTile = (row: SearchResult): ReactNode => {
    const active = selectedMarket !== null && 'name' in selectedMarket && selectedMarket.name === row.name
    const heat = heatLabel(row.weeklyDownloads)
    return (
      <button
        key={row.name}
        type="button"
        className={mosaicTileClass({ size: 'small', tint: tileTintOf(row.name), active, className: css.hotTile })}
        data-tile-size={HOT_TILE_MARK}
        aria-pressed={active}
        onClick={() => { setMarketId(row.name) }}
      >
        <div className={mosaicStyles.tileTop}>
          <span className={mosaicStyles.tileIcon}>{pluginIcon(row.name, 22)}</span>
        </div>
        {heat !== null && (
          <span className={mosaicStyles.tileCorner}>
            <Flame size={12} className={css.tileHeatIcon} />
            <span className={css.tileHeatValue}>{heat}</span>
          </span>
        )}
        <div className={mosaicStyles.tileBottom}>
          <div className={mosaicStyles.tileNameRow}>
            <span className={`${mosaicStyles.tileName} ${css.hotName}`}>{shortName(row.name)}</span>
            <span className={`${mosaicStyles.tileVersion} ${css.hotVersion}`}>v{row.version}</span>
          </div>
          <span className={mosaicStyles.tileSub}>{authorOf(row.name)}</span>
        </div>
      </button>
    )
  }

  /** 市场磁贴（检索结果条目 → 磁贴；尺寸由块几何给定）。贴自身无操作按钮。 */
  const renderMarketTile = (row: SearchResult, size: MosaicSize): ReactNode => {
    const active = selectedMarket !== null && 'name' in selectedMarket && selectedMarket.name === row.name
    const heat = heatLabel(row.weeklyDownloads)
    return (
      <button
        key={row.name}
        type="button"
        className={mosaicTileClass({ size, tint: tileTintOf(row.name), active, glow: size === 'big' })}
        data-tile-size={size}
        aria-pressed={active}
        onClick={() => { setMarketId(row.name) }}
      >
        <div className={mosaicStyles.tileTop}>
          <span className={mosaicStyles.tileIcon}>{pluginIcon(row.name, size === 'big' ? 34 : 24)}</span>
        </div>
        {heat !== null && (
          <span className={mosaicStyles.tileCorner}>
            <Flame size={12} className={css.tileHeatIcon} />
            <span className={css.tileHeatValue}>{heat}</span>
          </span>
        )}
        <div className={mosaicStyles.tileBottom}>
          <div className={mosaicStyles.tileNameRow}>
            <span className={mosaicStyles.tileName}>{shortName(row.name)}</span>
            <span className={mosaicStyles.tileVersion}>v{row.version}</span>
          </div>
          {(size === 'big' || size === 'wide') && row.description !== undefined && row.description !== '' && (
            <span className={mosaicStyles.tileDesc}>{row.description}</span>
          )}
          <span className={mosaicStyles.tileSub}>{authorOf(row.name)}</span>
        </div>
      </button>
    )
  }

  /** 市场「个人」范围磁贴（已装条目 → 磁贴，无热度角标）。 */
  const renderPersonalTile = (entry: InstalledEntry, size: MosaicSize): ReactNode => {
    const active = selectedMarket !== null && 'entryId' in selectedMarket && selectedMarket.entryId === entry.entryId
    return (
      <button
        key={entry.entryId}
        type="button"
        className={mosaicTileClass({ size, tint: tileTintOf(entry.moduleName), active, glow: size === 'big' })}
        data-tile-size={size}
        aria-pressed={active}
        onClick={() => { setMarketId(entry.entryId) }}
      >
        <div className={mosaicStyles.tileTop}>
          <span className={mosaicStyles.tileIcon}>{pluginIcon(entry.moduleName, size === 'big' ? 34 : 24)}</span>
        </div>
        <div className={mosaicStyles.tileBottom}>
          <div className={mosaicStyles.tileNameRow}>
            <span className={mosaicStyles.tileName}>{shortName(entry.moduleName)}</span>
            {entry.version !== undefined && <span className={mosaicStyles.tileVersion}>v{entry.version}</span>}
          </div>
          {(size === 'big' || size === 'wide') && entry.description !== undefined && entry.description !== '' && (
            <span className={mosaicStyles.tileDesc}>{entry.description}</span>
          )}
          <span className={mosaicStyles.tileSub}>{authorOf(entry.moduleName)}</span>
        </div>
      </button>
    )
  }

  /** 已装磁贴（角标位 = 启停开关；停用态名称降一档）。 */
  const renderInstalledTile = (entry: InstalledEntry, size: MosaicSize): ReactNode => {
    const active = selectedInstalled !== null && selectedInstalled.entryId === entry.entryId
    return (
      <div
        key={entry.entryId}
        className={mosaicTileClass({
          size,
          tint: tileTintOf(entry.moduleName),
          active,
          glow: size === 'big',
          className: entry.enabled ? '' : css.installedOff,
        })}
        data-tile-size={size}
        data-off={!entry.enabled || undefined}
        role="button"
        tabIndex={0}
        aria-pressed={active}
        onClick={() => { setInstalledId(entry.entryId) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setInstalledId(entry.entryId) } }}
      >
        <div className={mosaicStyles.tileTop}>
          <span className={mosaicStyles.tileIcon}>{pluginIcon(entry.moduleName, size === 'big' ? 34 : 24)}</span>
          <button
            type="button"
            role="switch"
            aria-checked={entry.enabled}
            aria-label={`${shortName(entry.moduleName)} 启用开关`}
            className={mosaicStyles.tileSwitch}
            data-off={!entry.enabled || undefined}
            disabled={busy.has(`toggle:${entry.entryId}`)}
            onClick={(e) => { e.stopPropagation(); void onToggleEnabled(entry) }}
          ><span className={mosaicStyles.tileSwitchKnob} /></button>
        </div>
        <div className={mosaicStyles.tileBottom}>
          <div className={mosaicStyles.tileNameRow}>
            <span className={`${mosaicStyles.tileName}${entry.enabled ? '' : ' ' + css.installedOffName}`}>{shortName(entry.moduleName)}</span>
            {entry.version !== undefined && <span className={mosaicStyles.tileVersion}>v{entry.version}</span>}
          </div>
          {(size === 'big' || size === 'wide') && entry.description !== undefined && entry.description !== '' && (
            <span className={mosaicStyles.tileDesc}>{entry.description}</span>
          )}
          <span className={mosaicStyles.tileSub}>{authorOf(entry.moduleName)} · {entry.enabled ? '已启用' : '已停用'}</span>
        </div>
      </div>
    )
  }

  /**
   * 块行渲染：共享包的 `MosaicWall` 负责「块行 → 列 → 贴」的全部结构与排布
   * （块行 data-mosaic-block、列 data-col、列的宽度与行高都在那边），本页只提供
   * 块序列与单张贴的渲染。贴是列的直接子元素（DOM 里由 Fragment 承载，不产生壳层），
   * 故 CSS 的 `.mosaicCol > [data-tile-size]` 分档列高仍然成立。
   * 本页无入口贴（市场/已装两个 tab 都没有「添加」贴）⇒ 不传 pinFirstTwoSmalls。
   * 落位由算法按 `hints` 决定（长名字占 264 宽槽），数据下标走 `MosaicWall` 的
   * `itemIndex` ⇒ 调用方不再需要「第 i 张贴 = 第 i 条数据」这个假设。
   */
  const renderMosaic = <X,>(
    tiles: readonly X[],
    hints: readonly MosaicItemHint[],
    renderTile: (item: X, size: MosaicSize) => ReactNode,
  ): ReactNode => (
    <MosaicWall
      items={tiles}
      blocks={buildMosaic(tiles, { columns, hints })}
      columns={columns}
      renderTile={renderTile}
    />
  )

  /* ── 详情面板 ── */

  /** 已安装态的底部操作：居中的「卸载」（error 描边）+ 启停开关（iYTAN 操作区）。 */
  const renderInstalledActions = (entry: InstalledEntry): ReactNode => (
    <div className={css.detailActions}>
      <button
        type="button"
        className={`${css.actionBtn} ${css.actionDanger}`}
        disabled={busy.has(`uninstall:${entry.entryId}`)}
        onClick={() => { void onUninstall(entry) }}
      >
        {busy.has(`uninstall:${entry.entryId}`) ? <LoaderCircle size={14} className={css.spin} /> : <Trash2 size={14} />}
        卸载
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={entry.enabled}
        aria-label={`${shortName(entry.moduleName)} 启用开关`}
        className={css.detailSwitch}
        data-off={!entry.enabled || undefined}
        disabled={busy.has(`toggle:${entry.entryId}`)}
        onClick={() => { void onToggleEnabled(entry) }}
      ><span className={css.detailSwitchKnob} /></button>
    </div>
  )

  /** 未安装态的底部操作：单个「安装」主按钮（品牌实色）。 */
  const renderInstallAction = (name: string): ReactNode => (
    <div className={css.detailActions}>
      <button
        type="button"
        className={`${css.actionBtn} ${css.actionPrimary}`}
        disabled={busy.has(`install:${name}`)}
        onClick={() => { void onInstall(name) }}
      >
        {busy.has(`install:${name}`) ? <LoaderCircle size={14} className={css.spin} /> : <Plus size={14} />}
        安装
      </button>
    </div>
  )

  /** 一条键值行（小字 label + 值）；`mono` 用于包名一类需要等宽展示的值。 */
  const metaRow = (key: string, value: ReactNode, mono = false): ReactNode => (
    <div className={css.detailMetaRow} key={key}>
      <span className={css.detailMetaKey}>{key}</span>
      <span className={`${css.detailMetaValue}${mono ? ' ' + css.detailMono : ''}`}>{value}</span>
    </div>
  )

  /** 「日志」行（更新日志）：每条 = 版本号 + 日期 + 说明；缺失或为空给一句占位。 */
  const changelogRow = (log?: readonly ChangelogEntry[]): ReactNode => (
    <div className={css.detailMetaRow} key="日志">
      <span className={css.detailMetaKey}>日志</span>
      <span className={css.detailMetaValue}>
        {log === undefined || log.length === 0 ? (
          <span className={css.detailLogEmpty}>暂无更新日志</span>
        ) : (
          <span className={css.detailLogList}>
            {log.map(item => (
              <span className={css.detailLogEntry} key={`${item.version}@${item.date}`}>
                <span className={css.detailLogHead}>
                  <span className={css.detailLogVersion}>v{item.version}</span>
                  <span className={css.detailLogDate}>{item.date.slice(0, 10)}</span>
                </span>
                <span className={css.detailLogNote}>{item.note}</span>
              </span>
            ))}
          </span>
        )}
      </span>
    </div>
  )

  /**
   * 详情面板主体（三个视图共用）：「名称（大标题）+ 六项字段 + 可选补充行 + 底部操作」。
   * 六项字段的顺序在此统一且逐字固定 —— id / 版本 / 发布日期 / 作者 / 日志（名称即大标题），
   * 补充行（许可证 / 热度 / 分类 / 状态 / 主页 / 仓库 / 安装自 / 关键词 / 来源）一律排在
   * 「日志」之后，不插进六项之间；描述作为一句话简介落在这两块之后。
   */
  const renderDetailBody = (fields: DetailFields, actions: ReactNode): ReactNode => (
    <div className={css.detailBody}>
      <div className={css.detailMain}>
        <span className={css.detailName}>{fields.name}</span>
        <div className={css.detailMeta}>
          {metaRow('id', fields.moduleName, true)}
          {metaRow('版本', fields.version !== undefined && fields.version !== '' ? `v${fields.version}` : '—')}
          {metaRow('发布日期', fields.date !== undefined && fields.date !== '' ? fields.date.slice(0, 10) : '—')}
          {metaRow('作者', fields.author)}
          {changelogRow(fields.changelog)}
          {(fields.extras ?? []).map(([key, value]) => metaRow(key, value))}
        </div>
        {fields.description !== undefined && fields.description !== '' && (
          <p className={css.detailDesc}>{fields.description}</p>
        )}
        {fields.loading === true && <span className={css.detailSub}>加载中…</span>}
      </div>
      {actions}
    </div>
  )

  /** 市场态详情面板主体（hero 150 + body padding[16,18] + space-between）。 */
  let marketDetail: ReactNode = null
  if (tab === 'market' && selectedMarket !== null) {
    if (scope === 'public') {
      const row = selectedMarket as SearchResult
      const installed = row.installed || installedSet.has(row.name)
      const installedEntry = installed ? selectedEntry : null
      marketDetail = renderDetailBody({
        name: shortName(row.name),
        moduleName: row.name,
        version: row.version,
        date: row.date,
        author: authorOf(row.name, row.publisher),
        changelog: row.changelog,
        description: row.description ?? '该插件未提供描述。',
        extras: [
          ...extraRows(
            ['许可证', row.license],
            ['热度', row.weeklyDownloads !== undefined
              ? `周下载 ${heatLabel(row.weeklyDownloads) ?? String(row.weeklyDownloads)}`
              : undefined],
            ['状态', installedEntry !== null ? (installedEntry.enabled ? '已启用' : '已停用') : undefined],
          ),
          ['分类', SECTIONS.find(s => s.id === sectionOf(row.name, row.description))?.label ?? '热门'],
        ],
      }, installedEntry !== null
        ? renderInstalledActions(installedEntry)
        /* 已装但已装清单尚未就绪（对不回条目）时不给按钮：不再画禁用态的假「已安装」。 */
        : installed ? null : renderInstallAction(row.name))
    } else {
      const entry = selectedMarket as InstalledEntry
      marketDetail = renderDetailBody({
        name: shortName(entry.moduleName),
        moduleName: entry.moduleName,
        version: entry.version,
        author: authorOf(entry.moduleName),
        description: entry.description ?? '该插件未提供描述。',
        extras: [['来源', '本地/开发中'], ['状态', entry.enabled ? '已启用' : '已停用']],
      }, renderInstalledActions(entry))
    }
  }

  /** 已装态详情面板主体：与市场态同一套字段，补充行取 pluginManager/detail 的真值。 */
  let installedDetail: ReactNode = null
  if (tab === 'installed' && selectedInstalled !== null) {
    const entry = selectedInstalled
    const d = detail
    installedDetail = renderDetailBody({
      name: shortName(entry.moduleName),
      moduleName: d?.moduleName ?? entry.moduleName,
      version: entry.version ?? d?.version,
      author: authorOf(entry.moduleName, d?.publisher),
      loading: detailLoading,
      description: entry.description ?? d?.description ?? '该插件未提供描述。',
      extras: [
        ...extraRows(
          ['来源', d !== null
            ? (d.origin === 'official' ? '官方' : d.origin === 'corum' ? '本项目' : '第三方')
            : undefined],
          ['状态', entry.enabled ? '已启用' : '已停用'],
          ['许可证', d?.license],
          ['主页', d?.homepage],
          ['仓库', d?.repository],
          ['安装自', d?.installedFrom],
          ['关键词', d?.keywords !== undefined && d.keywords.length > 0 ? d.keywords.join('、') : undefined],
        ),
      ],
    }, renderInstalledActions(entry))
  }

  /** 节标题（磁贴群内的分节头，不是 tab / 不是 chip）：flame + 文字（最热门节）或纯文字。 */
  const renderSectionHead = (label: string, withFlame: boolean): ReactNode => (
    <div className={css.sectionHead}>
      {withFlame && <span className={css.sectionHeadIcon}><Flame size={15} /></span>}
      <span className={css.sectionHeadText}>{label}</span>
    </div>
  )

  /** 「全部插件」分类节头文字：全部 = 固定文案；具名分类 = 该分类名。 */
  const gridSectionLabel = filter === 'all'
    ? '全部插件'
    : (SECTIONS.find(s => s.id === filter)?.label ?? '全部插件')

  return (
    <div className={css.page}>
      {/* ── 1. 页头一行：tab pill ×2 + 搜索框 280×31 + 分类 chips（iYTAN o5WYjl）── */}
      <div className={css.header}>
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
        <div className={css.searchBox}>
          <Search size={14} className={css.searchIcon} />
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
      </div>
      <div className={css.headerDivider} />

      {/* ── 2. 内容区：左磁贴群（分节）+ 右详情面板 ── */}
      <div className={css.body}>
        <div className={css.tiles} ref={tilesRef}>
          {tab === 'market' && scope === 'public' && (
            <>
              {searchError !== null && <p className={css.errorText}>检索失败：{searchError}</p>}
              {searchError === null && results === null && <p className={css.hintText}>检索中…</p>}
              {results !== null && marketTiles.length === 0 && <p className={css.hintText}>没有匹配的插件</p>}
              {marketTiles.length > 0 && (
                <>
                  {filter === 'all' && hotTiles.length > 0 && (
                    <div className={css.hotSection}>
                      {renderSectionHead('最热门', true)}
                      <div className={mosaicStyles.hotRow}>
                        {hotTiles.map(row => renderHotTile(row))}
                      </div>
                    </div>
                  )}
                  <div className={css.allSection}>
                    {renderSectionHead(gridSectionLabel, false)}
                    {renderMosaic(gridTiles, marketHints, (row, size) => renderMarketTile(row, size))}
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'market' && scope === 'personal' && (
            <>
              {error !== null && entries === null && <p className={css.errorText}>加载失败：{error}</p>}
              {entries === null && error === null && <p className={css.hintText}>加载中…</p>}
              {entries !== null && personalTiles.length === 0 && <p className={css.hintText}>没有本地/开发中插件</p>}
              {personalTiles.length > 0 && (
                <div className={css.allSection}>
                  {renderSectionHead('本地 / 开发中', false)}
                  {renderMosaic(personalTiles, personalHints, (entry, size) => renderPersonalTile(entry, size))}
                </div>
              )}
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
              {visibleInstalled.length > 0 && (
                <div className={css.allSection}>
                  {renderSectionHead('已装插件', false)}
                  {renderMosaic(visibleInstalled, installedHints, (entry, size) => renderInstalledTile(entry, size))}
                </div>
              )}
            </>
          )}

          {error !== null && entries !== null && <p className={css.errorText}>{error}</p>}
        </div>

        {/* 右侧详情简介面板（点击磁贴就地展开；默认选第一个） */}
        <aside className={css.detail} aria-label="插件详情">
          {/* hero(150) 在面板顶部全宽；body(padding[16,18], space-between) 承担其余内容与操作。 */}
          {tab === 'market' && selectedMarket !== null && (
            <div className={css.detailHero}>
              <span className={css.detailHeroBadge}>{pluginIcon('name' in selectedMarket ? selectedMarket.name : selectedMarket.moduleName, 30)}</span>
            </div>
          )}
          {tab === 'installed' && selectedInstalled !== null && (
            <div className={css.detailHero}>
              <span className={css.detailHeroBadge}>{pluginIcon(selectedInstalled.moduleName, 30)}</span>
            </div>
          )}
          {tab === 'market' && (marketDetail ?? <DetailEmpty title="选择一个插件" desc="点左侧任意插件磁贴，在这里查看它的简介、热度与版本；点「安装」一键装入。" />)}
          {tab === 'installed' && (installedDetail ?? <DetailEmpty title="选择一个已装插件" desc="点左侧任意已装插件磁贴，在这里查看它的版本、状态与操作；开关可就地启停。" />)}
        </aside>
      </div>

      {/* ── 4. 操作反馈条（安装/卸载/启停后的提示 + 可选「立即重启」）── */}
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
