/**
 * McpPage — 集成中心 · MCP 页（design.pen bFLLQ「集成中心·MCP 服务器」）。
 *
 * 数据链路不变（RPC 方法名与参数逐字未动）：
 *   mcpManager/listServers（列表）+ testConnection（运行状态/工具数）
 *   + getServer（详情回填）+ saveServer（添加/启停/编辑）+ deleteServer
 *   + getServerReferences + corumAgent/listProfiles（绑定 Agent 头像/昵称）。
 *
 * 视图结构（design.pen bFLLQ）：页头单行（市场|已装 pill tab，本页无搜索框、
 * 无分类 chips）→ 全宽分隔线 → 磁贴群（节头「MCP 服务器」+ 第一张「添加」
 * 磁贴 + 服务器磁贴，角标 = 运行状态点 8×8，小字 = 传输 · 启动地址）
 * + 右侧详情面板（hero 150 + body）。
 *
 * 详情面板两种模式：
 *   查看 — MCP 语义的信息面板：传输 / 连接状态（testConnection 运行中·工具数）/
 *          范围（cwd，空写「全局」）/ 工具清单（前 4 + 展开全部）/ 绑定 Agent
 *          （corumAgent/listProfiles 过滤）；底部居中「删除服务器」（error 描边，
 *          createPortal 确认框）。
 *   新建 — 点「添加」磁贴后表单就地搬进面板（名称 / 传输 tab stdio·SSE·WebSocket
 *          / 启动配置 JSON / 启动·运行超时 / 使用指导），校验逻辑原样保留；
 *          提交成功回「查看」。
 *
 * rpc 为 null 时降级为静态占位提示。
 * @module corum-ide-integrations-pages-ui/client/McpPage
 */

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, FolderTree, Info, Plus, Trash2 } from 'lucide-react'
import { useIntegrationsRpc } from './face.tsx'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import css from './McpPage.module.css'
import shared from './IntegrationsPages.module.css'

/* ── 数据模型（mcpManager RPC 投影） ────────────────────────────────── */

type McpTransport = 'stdio' | 'streamable-http'

interface McpServerSummaryWire {
  name: string
  description?: string
  transport: McpTransport
  endpoint: string
  disabled?: boolean
}

type TestConnectionResultWire =
  | { ok: true; tools: Array<{ name: string; description?: string }> }
  | { ok: false; error: string }

interface McpServerConfigWire {
  name: string
  description?: string
  /** 写给模型的**使用指导**（进提示词；与给人看的 description 不同）。 */
  guidance?: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  disabled?: boolean
}

/** 每服务探测状态（列表磁贴 + 详情面板共用）。 */
interface ProbeState {
  loading: boolean
  toolCount: number | null
  error: string | null
}

const TRANSPORT_LABEL: Record<McpTransport, string> = {
  'stdio': 'stdio',
  'streamable-http': 'sse',
}

/** 各传输方式的 JSON 示例（stdio=命令行启动，SSE/WebSocket=URL）。 */
const MCP_JSON_PLACEHOLDERS: Record<AddTransport, string> = {
  'stdio': `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem",
    "/path/to/your/workspace"],
  "env": {
    "API_KEY": "your-key-here"
  }
}`,
  'sse': `{
  "url": "https://mcp.example.com/sse",
  "headers": {
    "Authorization": "Bearer <token>"
  }
}`,
  'websocket': `{
  "url": "ws://127.0.0.1:7788/mcp",
  "headers": {
    "Authorization": "Bearer <token>"
  }
}`,
}

/** 详情面板「新建」模式的传输 tab（stdio / SSE·HTTP / WebSocket）。 */
type AddTransport = 'stdio' | 'sse' | 'websocket'
const ADD_TRANSPORT_OPTIONS: Array<{ value: AddTransport; label: string }> = [
  { value: 'stdio', label: 'stdio' },
  { value: 'sse', label: 'SSE / HTTP' },
  { value: 'websocket', label: 'WebSocket' },
]

/**
 * 磁贴小字：传输 + 启动地址压缩形（如 `stdio · npx @mcp/fs`）。
 * stdio 取 command 末段 + args 首个非 flag 参数；http 取 URL。
 */
function endpointLabel(s: McpServerSummaryWire): string {
  if (s.transport !== 'stdio') return s.endpoint
  const parts = s.endpoint.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'stdio'
  const bin = parts[0].split('/').pop() ?? parts[0]
  const firstArg = parts.slice(1).find(a => !a.startsWith('-'))
  const argShort = firstArg === undefined ? '' : ` ${firstArg.split('/').pop() ?? firstArg}`
  return `${bin}${argShort}`
}

/* ── 磁贴马赛克：固定种子伪随机「块生成器」 ─────────────────────────────
 *
 * design.pen（bFLLQ / VNH3k）的磁贴群不是 CSS grid，而是**等宽 808 的块上下堆叠**：
 * 块内是一行 flex（列），各列等高，列宽只有 264 / 128 两种。
 *   高 264 块 · 四列 [264,264,128,128] 的某个排列
 *     264+8+264+8+128+8+128 = 808
 *     264 宽列 = 大贴 big (264×264)，或两条宽贴 wide×2 (264×128 ×2)
 *     128 宽列 = 高贴 tall (128×264)，或两条小贴 small×2 (128×128 ×2)
 *   高 128 块 · 三种宽度模式：
 *     [128×6]          768 + 5×8 = 808
 *     [264,128×4]      776 + 4×8 = 808
 *     [264,264,128×2]  784 + 3×8 = 808
 * 旧的 `grid-auto-flow: dense` + 6 拍序号循环把每块排得一模一样，且大贴跨行时
 * 自动放置填不满（实测空洞率 6.3%）——正是「多了以后没有设计感」的根因。
 * 改为逐块抽型：固定种子 ⇒ 每次渲染完全一致、可复现对账。
 */

/** 固定种子：换这个值即换一套排布；同一次运行内恒定。 */
const MOSAIC_SEED = 0x5A17

/** mulberry32：32 位定种子 PRNG（同种子恒定序列，无外部依赖）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 磁贴四档尺寸（由列宽与块高共同决定，见上方几何推导）。 */
type MosaicSize = 'big' | 'wide' | 'tall' | 'small'

/** 生成期的列：列宽 + 列内自上而下 1~2 张贴的尺寸。 */
interface MosaicColSpec {
  width: 264 | 128
  sizes: MosaicSize[]
}

/** 渲染期的列：贴带上全片序号（0 号恒为「添加」磁贴）。 */
interface MosaicCol {
  width: 264 | 128
  tiles: Array<{ size: MosaicSize; index: number }>
}

/** 一个块：块型 = 块高（264 / 128）；列宽加和恒 808（末块截断除外）。 */
interface MosaicBlock {
  kind: '264' | '128'
  cols: MosaicCol[]
}

/** Fisher–Yates 洗牌（用同一 PRNG，结果可复现）。 */
function shuffleMosaic<T>(list: T[], rand: () => number): T[] {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/**
 * 高 264 块的四列：宽度恒为 [264,264,128,128] 的某个排列
 * （264+8+264+8+128+8+128 = 808）；
 *   264 宽列随机 big（1 张 264×264）或 wide×2（2 张 264×128），**至少一个 big**；
 *   128 宽列随机 tall（1 张 128×264）或 small×2（2 张 128×128）。
 * pinnedFirst：首块把第一列钉成 128 宽两小贴竖叠（128×128 ×2 = 264 高），
 * 这样 0 号「添加」磁贴恰以 small 尺寸落在左上角（264 宽的列装不下方贴）。
 */
function cols264(rand: () => number, pinnedFirst: boolean): MosaicColSpec[] {
  const widths: Array<264 | 128> = pinnedFirst
    ? [128, ...shuffleMosaic<264 | 128>([264, 264, 128], rand)]
    : shuffleMosaic<264 | 128>([264, 264, 128, 128], rand)
  const bigAt = Math.floor(rand() * 2)
  let seen264 = 0
  return widths.map((width, i) => {
    if (width === 264) {
      const isBig = seen264 === bigAt
      seen264 += 1
      const sizes: MosaicSize[] = isBig ? ['big'] : ['wide', 'wide']
      return { width, sizes }
    }
    if (pinnedFirst && i === 0) return { width, sizes: ['small', 'small'] }
    const sizes: MosaicSize[] = rand() < 0.5 ? ['tall'] : ['small', 'small']
    return { width, sizes }
  })
}

/** 高 128 块：三种宽度模式随机取一（加和恒 808），264 宽列位置洗牌。 */
function cols128(rand: () => number): MosaicColSpec[] {
  const mode = Math.floor(rand() * 3)
  const widths: Array<264 | 128> = mode === 0
    ? [128, 128, 128, 128, 128, 128]
    : mode === 1
      ? shuffleMosaic<264 | 128>([264, 128, 128, 128, 128], rand)
      : shuffleMosaic<264 | 128>([264, 264, 128, 128], rand)
  return widths.map(width => ({ width, sizes: [width === 264 ? 'wide' : 'small'] }))
}

/** 收下一块的列：装不下的那一列连同其后所有列一并丢弃（不留空占位）。 */
function keepCols(cols: MosaicColSpec[], room: number): MosaicColSpec[] {
  const kept: MosaicColSpec[] = []
  let left = room
  for (const col of cols) {
    if (left < col.sizes.length) break
    kept.push(col)
    left -= col.sizes.length
  }
  return kept
}

/**
 * 生成整片磁贴群（贴数 = 数据条数 + 1，索引 0 恒为「添加」磁贴）：
 *  - 首块恒为高 264 块（设计稿 row1），首列钉成 128 宽两小贴 —— 这样「添加」磁贴
 *    恰以 small 尺寸落在左上角（264 宽的列装不下 128×128 的方贴）；
 *  - 之后逐块抽型，**相邻两块必须不同型**（同型重抽）；块型只有两种取值，
 *    故等价于交替出现而每块的内部排布仍逐块随机；
 *  - 末块装不满时丢掉多余的列；只剩 1 张贴而首列要 2 张时换单张贴列型。
 */
function buildMosaic(count: number): MosaicBlock[] {
  const rand = mulberry32(MOSAIC_SEED)
  const specs: Array<{ kind: '264' | '128'; cols: MosaicColSpec[] }> = []
  let left = count

  /** 入块成功返回 true；首列就装不下则整块丢弃（返回 false）。 */
  const emit = (kind: '264' | '128', cols: MosaicColSpec[]): boolean => {
    const kept = keepCols(cols, left)
    if (kept.length === 0) return false
    specs.push({ kind, cols: kept })
    left -= kept.reduce((n, col) => n + col.sizes.length, 0)
    return true
  }

  if (count === 1) {
    // 只有「添加」磁贴：单列一张小贴（128 高块），不留空洞。
    emit('128', [{ width: 128, sizes: ['small'] }])
  } else if (count > 1) {
    // 首块恒为高 264 块（设计稿 row1），且首列钉死为「添加」+ 第一张数据贴。
    emit('264', cols264(rand, true))
  }

  while (left > 0) {
    let kind: '264' | '128' = rand() < 0.5 ? '264' : '128'
    const last = specs.length === 0 ? null : specs[specs.length - 1]!.kind
    if (last !== null) {
      while (kind === last) kind = rand() < 0.5 ? '264' : '128'   // 同型重抽
    }
    if (!emit(kind, kind === '264' ? cols264(rand, false) : cols128(rand))) {
      // 剩余贴数装不下整块：退化为单张贴的窄块，不产生空占位。
      emit(kind, [{ width: 128, sizes: [kind === '264' ? 'tall' : 'small'] }])
    }
  }

  // 编号：块 → 列 → 列内自上而下；0 号是「添加」磁贴。
  let index = 0
  return specs.map(spec => ({
    kind: spec.kind,
    cols: spec.cols.map(col => ({
      width: col.width,
      tiles: col.sizes.map((size) => {
        const tile = { size, index }
        index += 1
        return tile
      }),
    })),
  }))
}

/**
 * 磁贴 tint 档（design.pen bFLLQ 的四档真实色值 token）：
 * 大贴深紫 + glow、宽贴堇色、小贴紫、「添加」/未连接态给灰蓝。
 */
function tileTintClassOf(size: MosaicSize): string {
  if (size === 'big') return css.tintDeep
  if (size === 'wide') return css.tintMauve
  if (size === 'tall') return css.tintSlate
  return css.tintViolet
}

/* ── 主列表视图：Metro 磁贴 + 右侧详情面板 ──────────────────────────── */

function McpListView({ rpc }: {
  rpc: CorumRpcCall
}) {
  const [servers, setServers] = useState<McpServerSummaryWire[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [probeMap, setProbeMap] = useState<Record<string, ProbeState>>({})
  /** 详情面板选中态（null = 未选中，展示空态）。 */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 详情面板模式：查看选中服务器 / 新建（「添加」磁贴触发）。 */
  const [panelMode, setPanelMode] = useState<'view' | 'create'>('view')

  const reload = async () => {
    try {
      const r = await rpc<{ servers: McpServerSummaryWire[] }>('mcpManager', 'listServers', {})
      setServers(r.servers)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void reload() }, [rpc])

  // 逐服务探测工具数（停用的跳过，与编译语义一致）
  useEffect(() => {
    if (servers === null) return
    let cancelled = false
    for (const s of servers) {
      if (s.disabled === true) continue
      setProbeMap(prev => (prev[s.name] === undefined
        ? { ...prev, [s.name]: { loading: true, toolCount: null, error: null } }
        : prev))
      void (async () => {
        try {
          const r = await rpc<TestConnectionResultWire>('mcpManager', 'testConnection', { name: s.name })
          if (cancelled) return
          setProbeMap(prev => ({
            ...prev,
            [s.name]: r.ok
              ? { loading: false, toolCount: r.tools.length, error: null }
              : { loading: false, toolCount: null, error: r.error },
          }))
        } catch (e) {
          if (cancelled) return
          setProbeMap(prev => ({
            ...prev,
            [s.name]: { loading: false, toolCount: null, error: e instanceof Error ? e.message : String(e) },
          }))
        }
      })()
    }
    return () => { cancelled = true }
  }, [rpc, servers])

  /** 页头 tab 选中态（两个 tab 目前指向同一份服务器列表，见上方页头注释）。 */
  const [tab, setTab] = useState<'market' | 'installed'>('market')
  /** 详情面板选中项（默认选第一个；列表变化后回落——与插件页同一口径）。 */
  const selected = useMemo(() => {
    const pool = servers ?? []
    if (pool.length === 0) return undefined
    if (selectedId === null) return pool[0]
    return pool.find(s => s.name === selectedId) ?? pool[0]
  }, [servers, selectedId])

  /**
   * 磁贴马赛克块（「添加」磁贴 + 服务器序列）。
   * 种子固定 ⇒ 同一份数据每次渲染排布完全一致；数据条数变化才会重排。
   */
  const mosaic = useMemo(() => buildMosaic(1 + (servers ?? []).length), [servers])

  return (
    <div className={css.page}>
      {/* 页头单行：市场|已装 pill tab（design.pen bFLLQ 画了这两个 tab；MCP
          目前只有已配置服务器这一份数据，「市场」态尚未接入 ⇒ 两个 tab 都指向
          同一列表，选中态仍按稿呈现，将来接市场时在此分叉）。 */}
      <div className={css.headerRow} role="tablist" aria-label="MCP 分区">
        <button type="button" role="tab" aria-selected={tab === 'market'} className={`${css.tab}${tab === 'market' ? ' ' + css.tabActive : ''}`} onClick={() => { setTab('market') }}>市场</button>
        <button type="button" role="tab" aria-selected={tab === 'installed'} className={`${css.tab}${tab === 'installed' ? ' ' + css.tabActive : ''}`} onClick={() => { setTab('installed') }}>已装</button>
        <span className={css.headerSpacer} />
      </div>

      {/* 全宽分隔线（页头行与磁贴群之间） */}
      <div className={css.divider} />

      <div className={css.body}>
        {/* 左：Metro 磁贴群（节头 + 添加磁贴 + 服务器磁贴） */}
        <div className={css.tiles}>
          <span className={css.sectionHead}>MCP 服务器</span>
          {loadError !== null && <p className={css.hintText}>加载失败：{loadError}</p>}
          <div className={css.tileGrid}>
            {mosaic.map((block, bi) => (
              <div key={bi} className={css.mosaicBlock} data-mosaic-block={block.kind}>
                {block.cols.map((col, ci) => (
                  <div key={ci} className={`${css.mosaicCol} ${col.width === 264 ? css.mosaicCol264 : css.mosaicCol128}`}>
                    {col.tiles.map(({ size, index }) => {
                      /* 尺寸样式走 data-tile-size 属性选择器（见 .module.css），无需尺寸类名。 */
                      /* 0 号恒为「添加」磁贴（块生成器把首列钉成两小贴竖叠 ⇒ 它必在左上角）。 */
                      if (index === 0) {
                        return (
                          <button
                            key="add"
                            type="button"
                            data-tile-size={size}
                            className={`${css.tile} ${css.tintSlate}`}
                            aria-label="添加服务器"
                            onClick={() => { setPanelMode('create'); setSelectedId(null) }}
                          >
                            {/* 角标用停止态状态点的视觉形态（不可交互占位，只表达「尚未存在」）。 */}
                            <span className={css.tileCorner}>
                              <span className={`${css.tileDot} ${css.tileDotOff}`} aria-hidden="true" />
                            </span>
                            <div className={css.tileTop}>
                              <span className={css.tileIcon}><Plus size={24} /></span>
                            </div>
                            <div className={css.tileBottom}>
                              <div className={css.tileNameRow}>
                                <span className={css.tileName}>添加</span>
                                <span className={css.tileVersion}>MCP</span>
                              </div>
                              <span className={css.tileSub}>新端点</span>
                            </div>
                          </button>
                        )
                      }
                      const s = (servers ?? [])[index - 1]
                      if (s === undefined) return null
                      const probe = probeMap[s.name]
                      const enabled = s.disabled !== true
                      const running = enabled && probe !== undefined && !probe.loading && probe.toolCount !== null
                      const active = panelMode === 'view' && selected !== undefined && selected.name === s.name
                      return (
                        <button
                          key={s.name}
                          type="button"
                          data-tile-size={size}
                          className={`${css.tile} ${tileTintClassOf(size)}${size === 'big' ? ' ' + css.tileGlow : ''}${active ? ' ' + css.tileActive : ''}`}
                          aria-pressed={active}
                          title={probe?.error ?? undefined}
                          onClick={() => { setPanelMode('view'); setSelectedId(s.name) }}
                        >
                          {/* 角标：状态点 8×8（运行中绿 / 停止灰），绝对定位于右上角。 */}
                          <span className={css.tileCorner}>
                            <span className={`${css.tileDot}${running ? '' : ` ${css.tileDotOff}`}`} />
                          </span>
                          <div className={css.tileTop}>
                            <span className={css.tileIcon}><FolderTree size={size === 'big' ? 30 : 24} /></span>
                          </div>
                          <div className={css.tileBottom}>
                            <div className={css.tileNameRow}>
                              <span className={css.tileName}>{s.name}</span>
                              {/* 版本徽章位承载传输方式（wire 无版本字段，占位口径）。 */}
                              <span className={css.tileVersion}>{TRANSPORT_LABEL[s.transport]}</span>
                            </div>
                            {(size === 'big' || size === 'wide') && s.description !== undefined && s.description !== '' && (
                              <span className={css.tileDesc}>{s.description}</span>
                            )}
                            <span className={css.tileSub}>
                              {TRANSPORT_LABEL[s.transport]} · {endpointLabel(s)}
                            </span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
          {servers !== null && servers.length === 0 && loadError === null && (
            <p className={css.hintText}>暂无 MCP 服务器。点击「添加」磁贴注册第一个。</p>
          )}
        </div>

        {/* 右：详情面板（查看选中服务器 / 新建模式两态） */}
        <aside className={css.detail} aria-label="服务器详情">
          {panelMode === 'create'
            ? (
              <McpPanelCreate
                rpc={rpc}
                onSaved={(name) => { setPanelMode('view'); setSelectedId(name); void reload() }}
                onCancel={() => { setPanelMode('view'); setSelectedId(null) }}
              />
            )
            : selected === undefined
              ? <DetailEmpty
                  title="选择一个 MCP 服务器"
                  desc="点左侧任意服务器磁贴，在这里查看它的连接状态、工具与绑定；「添加」磁贴在此新建端点。"
                />
              : (
                <McpPanelView
                  rpc={rpc}
                  server={selected}
                  probe={probeMap[selected.name]}
                  onToggled={() => { void reload() }}
                  onDeleted={() => { setSelectedId(null); void reload() }}
                />
              )}
        </aside>
      </div>
    </div>
  )
}

/* ── 详情面板共用：空态 + 底部操作行（居中）──────────────────────────── */

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

/* ── 详情面板 · 查看模式（MCP 语义信息面板）──────────────────────────── */

function McpPanelView({ rpc, server, probe, onToggled, onDeleted }: {
  rpc: CorumRpcCall
  server: McpServerSummaryWire
  probe: ProbeState | undefined
  onToggled: () => void
  onDeleted: () => void
}) {
  const [config, setConfig] = useState<McpServerConfigWire | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [tools, setTools] = useState<Array<{ name: string; description?: string }>>([])
  const [expanded, setExpanded] = useState(false)
  const [references, setReferences] = useState<string[] | null>(null)
  /** 绑定 Agent 的展示投影（真实头像 + 昵称-岗位），来自 corumAgent/listProfiles。 */
  const [boundAgents, setBoundAgents] = useState<Array<{ id: string; nickname?: string; title?: string; avatar?: string }>>([])

  // 选中服务器变化：拉完整配置（传输/命令/范围）+ 工具清单 + 绑定关系。
  useEffect(() => {
    let cancelled = false
    setConfig(null)
    setError(null)
    void (async () => {
      try {
        const r = await rpc<{ server?: McpServerConfigWire }>('mcpManager', 'getServer', { name: server.name })
        if (!cancelled) setConfig(r.server ?? null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
      try {
        const r = await rpc<TestConnectionResultWire>('mcpManager', 'testConnection', { name: server.name })
        if (!cancelled && r.ok) setTools(r.tools)
      } catch { /* 工具清单失败不阻塞详情 */ }
      try {
        const r = await rpc<{ references: string[] }>('mcpManager', 'getServerReferences', { name: server.name })
        if (!cancelled) setReferences(r.references)
      } catch { /* 引用列表失败不阻塞详情 */ }
      try {
        const r = await rpc<{ profiles: Array<{ id: string; nickname?: string; title?: string; avatar?: string; mcpServers: string[] }> }>('corumAgent', 'listProfiles', {})
        if (!cancelled) setBoundAgents(r.profiles.filter(p => Array.isArray(p.mcpServers) && p.mcpServers.includes(server.name)))
      } catch { /* 头像/昵称拉取失败时退回 id 首字占位 */ }
    })()
    return () => { cancelled = true }
  }, [rpc, server.name])

  const enabled = server.disabled !== true
  const running = enabled && probe !== undefined && !probe.loading && probe.toolCount !== null
  const startCommand = config === null
    ? ''
    : config.transport === 'stdio'
      ? [config.command, ...(config.args ?? [])].join(' ')
      : config.url ?? ''
  const statusText = !enabled
    ? '已停止'
    : probe === undefined || probe.loading
      ? '检测中…'
      : probe.toolCount !== null
        ? `运行中 · ${probe.toolCount} 个工具`
        : `未连接 · ${probe?.error ?? '探测失败'}`

  /** 启停开关（面板内一行）：saveServer disabled 翻转，RPC 不变。 */
  const toggleDisabled = async () => {
    if (busy || config === null) return
    setBusy(true)
    setError(null)
    try {
      const next = { ...config, disabled: config.disabled === true ? false : true }
      await rpc('mcpManager', 'saveServer', { input: next })
      setConfig(next)
      onToggled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    try {
      await rpc('mcpManager', 'deleteServer', { name: server.name })
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const visibleTools = expanded ? tools : tools.slice(0, 4)
  const hiddenCount = tools.length - visibleTools.length

  return (
    <>
      <div className={css.detailHero}>
        <span className={css.detailHeroBadge}><FolderTree size={30} /></span>
      </div>
      <div className={css.detailBody}>
        <div>
          <div className={css.detailTitleRow}>
            <span className={css.detailName}>{server.name}</span>
            {/* 版本徽章位承载传输方式标签（wire 无版本字段，占位口径）。 */}
            <span className={css.detailVersion}>{TRANSPORT_LABEL[server.transport]}</span>
          </div>
          <span className={css.detailSub}>modelcontextprotocol · {TRANSPORT_LABEL[server.transport]}</span>
          <p className={css.detailDesc}>{server.description ?? '该服务器未提供描述。'}</p>

          <div className={css.detailMeta}>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>传输</span>
              <span className={css.detailMetaValue}>{TRANSPORT_LABEL[server.transport]}{startCommand !== '' ? ` · ${startCommand}` : ''}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>状态</span>
              <span className={css.detailMetaValue}>{statusText}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>范围</span>
              <span className={css.detailMetaValue}>{config?.cwd !== undefined && config.cwd !== '' ? config.cwd : '全局'}</span>
            </div>
          </div>

          {/* 工具清单概览（前 4 个 + 展开全部） */}
          {tools.length > 0 && (
            <div className={css.detailSwitchRow}>
              <span className={css.detailSwitchLabel}>工具 {tools.length} 个</span>
              {hiddenCount > 0 && !expanded && (
                <button type="button" className={css.sharedPlainBtn} onClick={() => setExpanded(true)}>
                  <ChevronDown size={13} />展开全部
                </button>
              )}
              {expanded && (
                <button type="button" className={css.sharedPlainBtn} onClick={() => setExpanded(false)}>
                  <ChevronUp size={13} />收起
                </button>
              )}
            </div>
          )}
          {visibleTools.map(tool => (
            <div key={tool.name} className={css.detailMetaRow} title={tool.description ?? ''}>
              <span className={css.detailMetaKey}>{running ? '可用' : '工具'}</span>
              <span className={css.detailMetaValue}>{tool.name}</span>
            </div>
          ))}

          {/* Agent 绑定概览 */}
          {references !== null && (
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>绑定</span>
              <span className={css.detailMetaValue}>
                {boundAgents.length > 0
                  ? boundAgents.map(a => `${a.nickname ?? a.id}${a.title !== undefined && a.title !== '' ? '-' + a.title : ''}`).join('、')
                  : `已绑定 ${references.length} 个 Agent 预设`}
              </span>
            </div>
          )}

          {/* 启停开关（面板内一行；磁贴角标只读展示状态点）。 */}
          <div className={css.detailSwitchRow}>
            <span className={css.detailSwitchLabel}>启用此服务器</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={`${server.name} 启用开关`}
              className={css.tileSwitch}
              data-off={enabled ? undefined : ''}
              disabled={busy || config === null}
              onClick={e => { e.stopPropagation(); void toggleDisabled() }}
            >
              <span className={css.tileSwitchKnob} />
            </button>
          </div>
        </div>

        <div>
          {error !== null && <p className={css.hintText}>{error}</p>}
          {/* 底部操作行：居中（删除服务器，error 描边）。 */}
          <div className={css.detailActions}>
            <button
              type="button"
              className={`${css.actionBtn} ${css.actionDanger}`}
              onClick={() => { setConfirmDelete(true) }}
            >
              <Trash2 size={13} />删除服务器
            </button>
          </div>
        </div>
      </div>

      {confirmDelete && createPortal(
        <div className={shared.modalOverlay} onClick={() => setConfirmDelete(false)}>
          <div className={shared.modalDialog} onClick={e => e.stopPropagation()}>
            <div className={shared.modalHeader}>
              <span className={shared.modalTitle}>删除服务器「{server.name}」？</span>
              <button type="button" className={shared.modalClose} onClick={() => setConfirmDelete(false)}><Info size={16} /></button>
            </div>
            <div className={shared.modalBody}>
              <p className={css.hintText}>
                该服务器当前状态：{statusText}。删除后相关工具立即失效，正在执行的任务可能中断；绑定它的 Agent 预设将失去其工具。
              </p>
              <p className={css.hintText}>若需保留配置，建议改为停用而非删除。此操作不可撤销。</p>
            </div>
            <div className={shared.modalFooter}>
              <div className={shared.footerLeft} />
              <div className={shared.footerRight}>
                <button type="button" className={shared.btnDefault} onClick={() => setConfirmDelete(false)}>取消</button>
                <button type="button" className={`${css.actionBtn} ${css.actionDanger}`} onClick={() => { setConfirmDelete(false); void doDelete() }}>
                  <Trash2 size={13} />删除服务器
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/* ── 详情面板 · 新建模式（原 McpAddView 表单就地搬进面板，RPC 与校验不变）── */

function McpPanelCreate({ rpc, onSaved, onCancel }: {
  rpc: CorumRpcCall
  onSaved: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<AddTransport>('stdio')
  const [configJson, setConfigJson] = useState('')
  const [startTimeout, setStartTimeout] = useState('60000')
  const [runTimeout, setRunTimeout] = useState('60000')
  const [busy, setBusy] = useState(false)
  // 使用指导（写给模型）：何时用 / 怎么组合 / 坑。
  const [guidance, setGuidance] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (busy) return
    setError(null)
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      setError('服务名仅限 1-32 位字母/数字/下划线/连字符')
      return
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(configJson) as Record<string, unknown>
    } catch (e) {
      setError(`配置 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const timeout = Number(runTimeout)
    if (!Number.isFinite(timeout) || timeout <= 0) { setError('运行超时必须是正数（ms）'); return }
    const input: McpServerConfigWire = transport === 'stdio'
      ? {
          name,
          transport: 'stdio',
          command: String(parsed.command ?? ''),
          ...(Array.isArray(parsed.args) ? { args: parsed.args.map(String) } : {}),
          ...(parsed.env !== undefined && typeof parsed.env === 'object' && parsed.env !== null
            ? { env: parsed.env as Record<string, string> } : {}),
          ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
          toolCallTimeoutMs: timeout,
          ...(guidance.trim() !== '' ? { guidance: guidance.trim() } : {}),
        }
      : {
          name,
          transport: 'streamable-http',
          url: String(parsed.url ?? ''),
          ...(parsed.headers !== undefined && typeof parsed.headers === 'object' && parsed.headers !== null
            ? { headers: parsed.headers as Record<string, string> } : {}),
          toolCallTimeoutMs: timeout,
          ...(guidance.trim() !== '' ? { guidance: guidance.trim() } : {}),
        }
    if (transport === 'stdio' && input.command === '') { setError('stdio 配置缺少 command 字段'); return }
    if (transport !== 'stdio' && !input.url) { setError('SSE/WebSocket 配置缺少 url 字段'); return }
    setBusy(true)
    try {
      await rpc('mcpManager', 'saveServer', { input })
      onSaved(name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* 面板头：添加模式标题（对应 hero 位）。 */}
      <div className={css.detailHero}>
        <span className={css.detailHeroBadge}><Plus size={30} /></span>
      </div>
      <div className={css.detailBody}>
        <div className={css.detailFormStack}>
          <span className={css.detailFormTitle}>添加 MCP 服务</span>

          <span className={css.detailFormLbl}>服务器名称</span>
          <input
            className={css.detailFormInput}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="my-mcp-server"
          />

          <span className={css.detailFormLbl}>传输方式</span>
          <div className={css.detailFormTabs} role="tablist" aria-label="传输方式">
            {ADD_TRANSPORT_OPTIONS.map(t => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={t.value === transport}
                className={t.value === transport ? css.detailFormTabActive : css.detailFormTab}
                onClick={() => setTransport(t.value)}
              >{t.label}</button>
            ))}
          </div>

          <span className={css.detailFormLbl}>启动配置 (JSON)</span>
          <textarea
            className={css.detailFormJson}
            value={configJson}
            onChange={e => setConfigJson(e.target.value)}
            placeholder={MCP_JSON_PLACEHOLDERS[transport]}
          />
          <span className={css.detailFormHint}>stdio 使用命令行启动，SSE/WebSocket 填写 URL。</span>

          <div className={css.detailFormCols}>
            <div className={css.detailFormCol}>
              <span className={css.detailFormLbl}>启动超时 (ms)</span>
              <input className={css.detailFormInput} value={startTimeout} onChange={e => setStartTimeout(e.target.value)} />
            </div>
            <div className={css.detailFormCol}>
              <span className={css.detailFormLbl}>运行超时 (ms)</span>
              <input className={css.detailFormInput} value={runTimeout} onChange={e => setRunTimeout(e.target.value)} />
            </div>
          </div>
          <span className={css.detailFormHint}>超时后该服务器将被标记为未连接，并自动尝试重连。</span>

          <span className={css.detailFormLbl}>使用指导（写给模型）</span>
          <textarea
            className={css.detailFormJson}
            value={guidance}
            onChange={e => setGuidance(e.target.value)}
            placeholder={'一句话用途；典型调用顺序；坑。例如：\n先 get_app_state 看当前打开的文件，再 batch_design；同一 .pen 文件不要并发改。'}
          />
          <span className={css.detailFormHint}>
            这段会进提示词，仅对授权了该服务的 Agent 生效（保存后即时生效，不必重启）。留空则不注入。
          </span>

          {error !== null && <p className={css.hintText}>{error}</p>}
        </div>

        {/* 底部操作行：居中（取消 + 提交主按钮）。 */}
        <div className={css.detailActions}>
          <button type="button" className={css.actionBtn} onClick={onCancel}>取消</button>
          <button
            type="button"
            className={css.actionPrimary}
            disabled={busy}
            onClick={() => { void submit() }}
          >
            <Plus size={14} />{busy ? '添加中…' : '添加服务器'}
          </button>
        </div>
      </div>
    </>
  )
}

/* ── Section 入口 ─────────────────────────────────────────────────── */

export function McpPage() {
  const rpc = useIntegrationsRpc()
  if (rpc === null) return <p className={css.hintText}>RPC 服务未就绪。</p>
  return <McpListView rpc={rpc} />
}
