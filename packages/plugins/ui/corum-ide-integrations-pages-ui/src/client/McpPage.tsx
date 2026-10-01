/**
 * McpPage — 集成中心 · MCP 页（Metro 磁贴改版）。
 *
 * 数据链路不变（RPC 方法名与参数逐字未动）：
 *   mcpManager/listServers（列表）+ testConnection（运行状态/工具数）
 *   + getServer（详情回填）+ saveServer（启停/编辑）+ deleteServer + getServerReferences
 *   + corumAgent/listProfiles（绑定 Agent 头像/昵称）。
 *
 * 视图改为「Metro 磁贴 + 右侧详情简介面板」（无市场 tab —— MCP 只有已配置
 * 服务器列表 + 「添加服务器」入口）：
 *   - 磁贴：官方参考实现（filesystem 等 stdio 服务器）给大贴 2×2 + 品牌 glow，
 *     带描述的给宽贴 2×1，其余小贴 1×1；角标 = 运行状态点（绿 = 运行中 /
 *     灰 = 已停止）；小字 = 传输 + 启动地址（如 `stdio · npx @mcp/fs`）。
 *   - 详情面板：hero（folder-tree 徽章 + glow）→ 名称/传输 → `发布方 · 传输`
 *     → 描述 → 元信息（传输/状态/范围）→ 启停开关 + 删除服务器（error 描边）。
 *     工具清单与 Agent 绑定概览保留在面板下半部（不跳二级页）。
 *
 * 「添加服务器」沿用原页内表单（McpAddView，JSON 配置 + 超时 + 使用指导）。
 *
 * rpc 为 null 时降级为静态占位提示。
 * @module corum-ide-integrations-pages-ui/client/McpPage
 */

import { useEffect, useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, FolderTree, Info, Plus, Trash2, TriangleAlert } from 'lucide-react'
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

/** 添加页传输 tab（stdio / SSE·HTTP / WebSocket）。 */
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

/**
 * 磁贴尺寸分级：官方参考实现（filesystem / git / fetch / memory 等常见 stdio
 * 服务器）给大贴 2×2 + glow；带描述的给宽贴 2×1；其余小贴 1×1。
 */
function tileSizeOf(s: McpServerSummaryWire): 'big' | 'wide' | 'small' {
  const n = s.name.toLowerCase()
  if (/filesystem|git|fetch|memory|sequential|everything|time/.test(n)) return 'big'
  if ((s.description ?? '').length >= 60) return 'wide'
  return 'small'
}

/* ── 主列表视图：Metro 磁贴 + 右侧详情面板 ──────────────────────────── */

function McpListView({ rpc, onOpenAdd }: {
  rpc: CorumRpcCall
  onOpenAdd: () => void
}) {
  const [servers, setServers] = useState<McpServerSummaryWire[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [probeMap, setProbeMap] = useState<Record<string, ProbeState>>({})
  /** 详情面板选中态（null = 默认选第一个）。 */
  const [selectedId, setSelectedId] = useState<string | null>(null)

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

  const toggleDisabled = async (s: McpServerSummaryWire, e: MouseEvent) => {
    e.stopPropagation()
    try {
      const full = await rpc<{ server?: McpServerConfigWire }>('mcpManager', 'getServer', { name: s.name })
      if (full.server === undefined) return
      await rpc('mcpManager', 'saveServer', {
        input: { ...full.server, disabled: s.disabled === true ? false : true },
      })
      void reload()
    } catch { /* 列表页静默；详情面板有完整错误显示 */ }
  }

  /** 详情面板选中项（默认第一个；列表变化后回落）。 */
  const selected = useMemo(() => {
    const pool = servers ?? []
    if (pool.length === 0) return null
    const hit = selectedId !== null ? pool.find(s => s.name === selectedId) : undefined
    return hit ?? pool[0]
  }, [servers, selectedId])

  return (
    <div className={css.page}>
      {/* 页头：标题 + 添加服务器（MCP 无市场，只有已配置列表 + 添加入口） */}
      <div className={css.header}>
        <span className={css.headerTitle}>MCP 服务器</span>
        <span className={css.headerSpacer} />
        <button type="button" className={css.addBtn} onClick={onOpenAdd}>
          <Plus size={14} />添加服务器
        </button>
      </div>

      <div className={css.body}>
        {/* 左：Metro 磁贴群 */}
        <div className={css.tiles}>
          {loadError !== null && <p className={css.hintText}>加载失败：{loadError}</p>}
          {servers !== null && servers.length === 0 && loadError === null && (
            <p className={css.hintText}>暂无 MCP 服务器。点击「添加服务器」注册第一个。</p>
          )}
          <div className={css.tileGrid}>
            {(servers ?? []).map(s => {
              const probe = probeMap[s.name]
              const enabled = s.disabled !== true
              const running = enabled && probe !== undefined && !probe.loading && probe.toolCount !== null
              const active = selected !== null && selected.name === s.name
              const size = tileSizeOf(s)
              const sizeClass = size === 'big' ? ` ${css.tileBig}` : size === 'wide' ? ` ${css.tileWide}` : ''
              return (
                <button
                  key={s.name}
                  type="button"
                  className={`${css.tile}${sizeClass}${size === 'big' ? ' ' + css.tileGlow : ''}${active ? ' ' + css.tileActive : ''}`}
                  aria-pressed={active}
                  title={probe?.error ?? undefined}
                  onClick={() => { setSelectedId(s.name) }}
                >
                  <div className={css.tileTop}>
                    <span className={css.tileIcon}><FolderTree size={size === 'big' ? 24 : 18} /></span>
                    <span className={`${css.tileDot}${running ? '' : ` ${css.tileDotOff}`}`} />
                  </div>
                  <div className={css.tileBottom}>
                    <div className={css.tileNameRow}>
                      <span className={css.tileName}>{s.name}</span>
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
        </div>

        {/* 右：详情简介面板（点击磁贴就地展开；默认选第一个） */}
        <aside className={css.detail} aria-label="服务器详情">
          {selected === null
            ? <DetailEmpty
                title="选择一个 MCP 服务器"
                desc="点左侧任意服务器磁贴，在这里查看它的连接配置、状态与工具；「添加服务器」注册新端点。"
              />
            : (
              <McpDetailSummary
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

/* ── 详情简介面板（磁贴选中项的就地展开，不跳二级页）────────────────────── */

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

function McpDetailSummary({ rpc, server, probe, onToggled, onDeleted }: {  rpc: CorumRpcCall
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
      <div className={css.detailTitleRow}>
        <span className={css.detailName}>{server.name}</span>
        <span className={css.tileVersion}>{TRANSPORT_LABEL[server.transport]}</span>
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
          <span className={css.detailMetaValue}>{config?.cwd ?? '全局'}</span>
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

      {error !== null && <p className={css.hintText}>{error}</p>}

      <div className={css.detailSpacer} />
      <div className={css.detailActions}>
        <button
          type="button"
          className={`${css.actionBtn} ${css.actionDanger}`}
          onClick={() => { setConfirmDelete(true) }}
        >
          <Trash2 size={13} />删除服务器
        </button>
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

/* ── 添加视图（页内表单，RPC 不变） ───────────────────────────────── */

function McpAddView({ rpc, onBack }: {
  rpc: CorumRpcCall
  onBack: () => void
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
      onBack()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.page}>
      <div className={css.header}>
        <span className={css.headerTitle}>添加服务器</span>
        <span className={css.headerSpacer} />
      </div>

      {/* 表单卡片沿 shared 的 mcpCard 形态（迁出副本，不跨包新增依赖） */}
      <div className={css.tiles}>
        <div className={shared.mcpCard} style={{ gap: 12 }}>
          <div className={shared.mcpCardTitleRow}>
            <span className={shared.mcpCardTitle}>服务器信息</span>
            <span className={shared.mcpCardTip}>名称用于 Agent 展示与工具引用</span>
          </div>
          <span className={shared.mcpFieldLbl}>服务器名称</span>
          <input
            className={shared.mcpFieldInput}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="my-mcp-server"
          />
          <span className={shared.mcpFieldLbl}>传输方式</span>
          <div className={shared.mcpTransportTabs}>
            {ADD_TRANSPORT_OPTIONS.map(t => (
              <button
                key={t.value}
                type="button"
                className={t.value === transport ? shared.mcpTransportTabActive : shared.mcpTransportTab}
                onClick={() => setTransport(t.value)}
              >{t.label}</button>
            ))}
          </div>
        </div>

        <div className={shared.mcpCard} style={{ gap: 10 }}>
          <div className={shared.mcpCardTitleRow}>
            <span className={shared.mcpCardTitle}>启动配置 (JSON)</span>
            <span className={shared.mcpCardTip}>stdio 使用命令行启动，SSE/WebSocket 填写 URL</span>
          </div>
          <textarea
            className={shared.mcpJsonEditor}
            value={configJson}
            onChange={e => setConfigJson(e.target.value)}
            placeholder={MCP_JSON_PLACEHOLDERS[transport]}
          />
        </div>

        <div className={shared.mcpCard} style={{ gap: 10 }}>
          <div className={shared.mcpCols}>
            <div className={shared.mcpCol}>
              <span className={shared.mcpColLbl}>启动超时 (ms)</span>
              <input className={shared.mcpColInput} value={startTimeout} onChange={e => setStartTimeout(e.target.value)} />
            </div>
            <div className={shared.mcpCol}>
              <span className={shared.mcpColLbl}>运行超时 (ms)</span>
              <input className={shared.mcpColInput} value={runTimeout} onChange={e => setRunTimeout(e.target.value)} />
            </div>
          </div>
          <span className={shared.mcpHintDim}>超时后该服务器将被标记为未连接，并自动尝试重连。</span>
        </div>

        <div className={shared.mcpCard} style={{ gap: 10 }}>
          <span className={shared.mcpColLbl}>使用指导（写给模型）</span>
          <textarea
            className={shared.mcpJsonEditor}
            style={{ minHeight: 96 }}
            value={guidance}
            onChange={e => setGuidance(e.target.value)}
            placeholder={'一句话用途；典型调用顺序；坑。例如：\n先 get_app_state 看当前打开的文件，再 batch_design；同一 .pen 文件不要并发改。'}
          />
          <span className={shared.mcpHintDim}>
            这段会进提示词，仅对**授权了该服务**的 Agent 生效（保存后即时生效，不必重启）。留空则不注入。
          </span>
        </div>

        {error !== null && <p className={css.hintText}>{error}</p>}

        <div className={shared.mcpActions}>
          <button type="button" className={shared.mcpActionCancel} onClick={onBack}>取消</button>
          <button type="button" className={shared.mcpActionPrimary} disabled={busy} onClick={() => { void submit() }}>
            <Plus size={14} />{busy ? '添加中…' : '添加服务器'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Section 入口：列表 / 添加两态 ─────────────────────────────────── */

export function McpPage() {
  const rpc = useIntegrationsRpc()
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'add' }>({ kind: 'list' })

  if (rpc === null) return <p className={shared.hintText}>RPC 服务未就绪。</p>

  if (view.kind === 'add') {
    return <McpAddView rpc={rpc} onBack={() => setView({ kind: 'list' })} />
  }
  return <McpListView rpc={rpc} onOpenAdd={() => setView({ kind: 'add' })} />
}
