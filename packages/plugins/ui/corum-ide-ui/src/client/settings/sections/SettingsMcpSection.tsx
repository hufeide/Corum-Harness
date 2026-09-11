/**
 * SettingsMcpSection — MCP 与集成设置页（设计稿 2026-09 复刻版）。
 *
 * 数据链路：mcpManager/listServers（列表）+ testConnection（工具数/运行状态）
 * + getServer（编辑回填）+ saveServer/deleteServer + getServerReferences（绑定）。
 * 视图结构按设计稿三态：主列表（v167UO）/ 详情视图（gTFZK，页内非弹窗）/
 * 添加视图（YEGzN，页内表单）/ 删除确认（Jbn7a，居中弹窗）。
 * rpc 为 null 时降级为静态占位提示。
 */

import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, Info, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { Switch } from '../Switch.tsx'
import { GlassButton, useCorumRpc } from '../shared.tsx'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import css from '../SettingsSections.module.css'

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

/** 每服务探测状态（列表卡片 + 详情页共用）。 */
interface ProbeState {
  loading: boolean
  toolCount: number | null
  error: string | null
}

const TRANSPORT_LABEL: Record<McpTransport, string> = {
  'stdio': 'stdio',
  'streamable-http': 'sse',
}

/** 添加页传输 tab（设计稿 YEGzN dEBu7：stdio / SSE·HTTP / WebSocket）。 */
type AddTransport = 'stdio' | 'sse' | 'websocket'
const ADD_TRANSPORT_OPTIONS: Array<{ value: AddTransport; label: string }> = [
  { value: 'stdio', label: 'stdio' },
  { value: 'sse', label: 'SSE / HTTP' },
  { value: 'websocket', label: 'WebSocket' },
]

/** 各传输方式的 JSON 示例（设计稿 YEGzN jIHGu：stdio=命令行启动，SSE/WebSocket=URL）。 */
const MCP_JSON_PLACEHOLDERS: Record<AddTransport, string> = {
  'stdio': `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem",
    "/Users/kukucai/work"],
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

/* ── 主列表视图（设计稿 v167UO · body/t5i7A） ─────────────────────── */

function McpListView({ rpc, onOpenDetail, onOpenAdd }: {
  rpc: CorumRpcCall
  onOpenDetail: (name: string) => void
  onOpenAdd: () => void
}) {
  const [servers, setServers] = useState<McpServerSummaryWire[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [probeMap, setProbeMap] = useState<Record<string, ProbeState>>({})

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
    } catch { /* 列表页静默；详情页有完整错误显示 */ }
  }

  return (
    <>
      <div className={css.mcpIntro}>
        <span className={css.mcpIntroTip}>连接外部 MCP 服务器，为 Agent 提供工具与数据源。</span>
        <button type="button" className={css.mcpAddBtn} onClick={onOpenAdd}>+ 添加服务器</button>
      </div>
      {loadError !== null && <p className={css.hintText}>加载失败：{loadError}</p>}
      {servers !== null && servers.length === 0 && loadError === null && (
        <p className={css.mcpEmptyHint}>暂无 MCP 服务器。点击「+ 添加服务器」注册第一个。</p>
      )}
      <div className={css.mcpServers}>
        {(servers ?? []).map(s => {
          const probe = probeMap[s.name]
          const enabled = s.disabled !== true
          const connected = enabled && probe !== undefined && !probe.loading && probe.toolCount !== null
          const toolLabel = !enabled
            ? '已停用'
            : probe === undefined || probe.loading
              ? '探测中…'
              : probe.toolCount !== null ? `${probe.toolCount} 个工具` : '未连接'
          return (
            <button
              key={s.name}
              type="button"
              className={css.mcpSrvCard}
              onClick={() => onOpenDetail(s.name)}
              title={probe?.error ?? undefined}
            >
              <div className={css.mcpSrvLeft}>
                <span className={connected ? css.mcpSrvDot : css.mcpSrvDotOff} />
                <div className={css.mcpSrvMeta}>
                  <div className={css.mcpSrvLrow}>
                    <span className={css.mcpSrvName}>{s.name}</span>
                    <span className={css.mcpChip}>{TRANSPORT_LABEL[s.transport]}</span>
                  </div>
                  <span className={css.mcpSrvDesc}>
                    {s.description !== undefined && s.description !== ''
                      ? s.endpoint !== undefined && s.endpoint !== ''
                        ? `${s.description} · ${s.endpoint}`
                        : s.description
                      : s.endpoint}
                  </span>
                </div>
              </div>
              <div className={css.mcpSrvRight}>
                <span className={css.mcpSrvTools}>{toolLabel}</span>
                <span onClick={e => { void toggleDisabled(s, e) }}>
                  <Switch checked={enabled} onChange={() => { /* toggleDisabled 直接触发 */ }} />
                </span>
                <ChevronDown size={14} className={css.mcpSrvChev} style={{ transform: 'rotate(-90deg)' }} />
              </div>
            </button>
          )
        })}
      </div>
    </>
  )
}

/* ── 详情视图（设计稿 gTFZK · body/nUKnR，页内非弹窗） ─────────────── */

function McpDetailView({ rpc, name, onBack }: {
  rpc: CorumRpcCall
  name: string
  onBack: () => void
}) {
  const [server, setServer] = useState<McpServerSummaryWire | null>(null)
  const [config, setConfig] = useState<McpServerConfigWire | null>(null)
  const [probe, setProbe] = useState<ProbeState>({ loading: true, toolCount: null, error: null })
  const [tools, setTools] = useState<Array<{ name: string; description?: string }>>([])
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState(false)
  const [references, setReferences] = useState<string[] | null>(null)
  /** 绑定 Agent 的展示投影（真实头像 + 昵称-岗位），来自 corumAgent/listProfiles。 */
  const [boundAgents, setBoundAgents] = useState<Array<{ id: string; nickname?: string; title?: string; avatar?: string; disabled?: boolean }>>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const full = await rpc<{ server?: McpServerConfigWire }>('mcpManager', 'getServer', { name })
        if (cancelled) return
        if (full.server === undefined) { setError(`服务 "${name}" 未注册`); return }
        setConfig(full.server)
        setServer({
          name: full.server.name,
          ...(full.server.description !== undefined ? { description: full.server.description } : {}),
          transport: full.server.transport,
          endpoint: full.server.transport === 'stdio' ? full.server.command ?? '' : full.server.url ?? '',
          ...(full.server.disabled === true ? { disabled: true } : {}),
        })
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
      try {
        const r = await rpc<TestConnectionResultWire>('mcpManager', 'testConnection', { name })
        if (cancelled) return
        if (r.ok) {
          setTools(r.tools)
          setProbe({ loading: false, toolCount: r.tools.length, error: null })
        } else {
          setProbe({ loading: false, toolCount: null, error: r.error })
        }
      } catch (e) {
        if (!cancelled) setProbe({ loading: false, toolCount: null, error: e instanceof Error ? e.message : String(e) })
      }
      try {
        const r = await rpc<{ references: string[] }>('mcpManager', 'getServerReferences', { name })
        if (!cancelled) setReferences(r.references)
      } catch { /* 引用列表失败不阻塞详情 */ }
      // 绑定 Agent 的真实头像/昵称/岗位（listProfiles 全量拉取后按 mcpServers 引用过滤）
      try {
        const r = await rpc<{ profiles: Array<{ id: string; nickname?: string; title?: string; avatar?: string; mcpServers: string[]; disabled?: boolean }> }>('corumAgent', 'listProfiles', {})
        if (cancelled) return
        setBoundAgents(r.profiles.filter(p => Array.isArray(p.mcpServers) && p.mcpServers.includes(name)))
      } catch { /* 头像/昵称拉取失败时退回 id 首字占位 */ }
    })()
    return () => { cancelled = true }
  }, [rpc, name])

  const reprobe = async () => {
    setProbe({ loading: true, toolCount: null, error: null })
    try {
      const r = await rpc<TestConnectionResultWire>('mcpManager', 'testConnection', { name })
      if (r.ok) {
        setTools(r.tools)
        setProbe({ loading: false, toolCount: r.tools.length, error: null })
      } else {
        setProbe({ loading: false, toolCount: null, error: r.error })
      }
    } catch (e) {
      setProbe({ loading: false, toolCount: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const toggleDisabled = async () => {
    if (busy || config === null) return
    setBusy(true)
    setError(null)
    try {
      const next = { ...config, disabled: config.disabled === true ? false : true }
      await rpc('mcpManager', 'saveServer', { input: next })
      setConfig(next)
      setServer(prev => prev === null ? prev : next.disabled === true
        ? { ...prev, disabled: true }
        : { name: prev.name, ...(prev.description !== undefined ? { description: prev.description } : {}), transport: prev.transport, endpoint: prev.endpoint })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    try {
      await rpc('mcpManager', 'deleteServer', { name })
      onBack()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (server === null && error === null) {
    return <p className={css.hintText}>加载中…</p>
  }
  if (server === null) {
    return (
      <>
        <div className={css.mcpToolbar}>
          <button type="button" className={css.mcpBackBtn} onClick={onBack}>
            <span className={css.mcpBackArrow}>←</span>返回列表
          </button>
        </div>
        <p className={css.hintText}>{error}</p>
      </>
    )
  }

  const enabled = server.disabled !== true
  const connected = enabled && !probe.loading && probe.toolCount !== null
  // 启动命令（stdio：command + args；http：url）
  const startCommand = config === null
    ? ''
    : config.transport === 'stdio'
      ? [config.command, ...(config.args ?? [])].join(' ')
      : config.url ?? ''
  const statusText = !enabled
    ? '已停用'
    : probe.loading
      ? '检测中…'
      : probe.toolCount !== null
        ? '运行中 · 刚刚完成检测'
        : `未连接 · ${probe.error ?? '探测失败'}`

  const visibleTools = expanded ? tools : tools.slice(0, 4)
  const hiddenCount = tools.length - visibleTools.length
  const enabledToolCount = tools.length - disabledTools.size

  return (
    <>
      {/* toolbar：返回列表 + 删除服务器（设计稿 gTFZK EzSxE） */}
      <div className={css.mcpToolbar}>
        <button type="button" className={css.mcpBackBtn} onClick={onBack}>
          <span className={css.mcpBackArrow}>←</span>返回列表
        </button>
        <button type="button" className={css.mcpDelBtn} onClick={() => setConfirmDelete(true)}>
          <Trash2 size={13} />删除服务器
        </button>
      </div>

      {/* 卡 1：基本信息（JxHct） */}
      <div className={css.mcpCard}>
        <div className={css.mcpIdRow}>
          <div className={css.mcpIdLeft}>
            <span className={connected ? css.mcpIdDot : css.mcpIdDotOff} />
            <span className={css.mcpIdName}>{server.name}</span>
            <span className={css.mcpIdChip}>{TRANSPORT_LABEL[server.transport]}</span>
          </div>
          <Switch checked={enabled} onChange={() => { void toggleDisabled() }} disabled={busy} />
        </div>
        <div className={css.mcpDivider} />
        <div className={css.mcpKv}>
          <span className={css.mcpKvKey}>描述</span>
          <span className={css.mcpKvVal}>{server.description ?? '—'}</span>
        </div>
        <div className={css.mcpKv}>
          <span className={css.mcpKvKey}>运行状态</span>
          <span className={connected ? css.mcpKvValSuccess : css.mcpKvValError}>{statusText}</span>
        </div>
        <div className={css.mcpKv}>
          <span className={css.mcpKvKey}>工作目录</span>
          <span className={css.mcpKvValMono}>{config?.cwd ?? '—'}</span>
        </div>
        <div className={css.mcpKv}>
          <span className={css.mcpKvKey}>启动命令</span>
          <span className={css.mcpKvValMono}>{startCommand || '—'}</span>
        </div>
      </div>

      {/* 卡 2：工具列表（d28VYN） */}
      <div className={css.mcpCard}>
        <div className={css.mcpCardTitleRow}>
          <span className={css.mcpCardTitle}>工具列表</span>
          <span className={css.mcpToolCount}>
            {probe.loading ? '检测中…' : `共 ${tools.length} 个 · ${enabledToolCount} 个启用`}
          </span>
        </div>
        {probe.loading && <p className={css.hintText}>正在握手并列出工具…</p>}
        {!probe.loading && probe.error !== null && (
          <p className={css.hintText}>无法获取工具列表：{probe.error}</p>
        )}
        {visibleTools.map((tool, i) => {
          const toolOn = !disabledTools.has(tool.name)
          return (
            <div key={tool.name}>
              <div className={css.mcpToolRow} title={tool.description ?? ''}>
                <div className={css.mcpToolLeft}>
                  <span className={toolOn ? css.mcpToolDot : css.mcpToolDotOff} />
                  <span className={css.mcpToolName}>{tool.name}</span>
                </div>
                <button
                  type="button"
                  className={toolOn ? css.mcpToolSw : css.mcpToolSwOff}
                  onClick={() => setDisabledTools(prev => {
                    const next = new Set(prev)
                    if (next.has(tool.name)) next.delete(tool.name); else next.add(tool.name)
                    return next
                  })}
                >
                  <span className={toolOn ? css.mcpToolSwKnob : css.mcpToolSwKnobOff} />
                </button>
              </div>
              {i < visibleTools.length - 1 && <div className={css.mcpDivider} />}
            </div>
          )
        })}
        {hiddenCount > 0 && (
          <div className={css.mcpMoreRow}>
            <button type="button" className={css.mcpMoreBtn} onClick={() => setExpanded(true)}>
              <ChevronDown size={13} />展开全部 {tools.length} 个工具
            </button>
          </div>
        )}
        {expanded && tools.length > 4 && (
          <div className={css.mcpMoreRow} style={{ justifyContent: 'center' }}>
            <button type="button" className={css.mcpMoreBtn} onClick={() => setExpanded(false)}>
              <ChevronUp size={13} />收起
            </button>
          </div>
        )}
      </div>

      {/* 卡 3：Agent 绑定（N2ZxV） */}
      <div className={css.mcpCard}>
        <div className={css.mcpCardTitleRow}>
          <span className={css.mcpCardTitle}>Agent 绑定</span>
          <span className={css.mcpBindCountChip}>{references === null ? '…' : `${references.length} 个`}</span>
        </div>
        {(references ?? []).map(ref => {
          const agent = boundAgents.find(a => a.id === ref)
          const displayName = agent === undefined
            ? ref
            : `${agent.nickname ?? agent.id}${agent.title !== undefined && agent.title !== '' ? '-' + agent.title : ''}`
          return (
            <div key={ref} className={css.mcpBindRow}>
              <span className={css.mcpBindAvatar}>
                {agent?.avatar !== undefined && agent.avatar !== ''
                  ? <img className={css.mcpBindAvatarImg} src={agent.avatar} alt="" />
                  : displayName.slice(0, 1)}
              </span>
              <span className={css.mcpBindName}>{displayName}</span>
              <span className={css.mcpBindState}>已启用</span>
            </div>
          )
        })}
        {references !== null && references.length === 0 && (
          <p className={css.hintText}>暂无 Agent 预设绑定此服务器。</p>
        )}
        <span className={css.mcpHintDim}>工具级授权与绑定关系在「Agent 预设」中管理，此处仅展示概览。</span>
      </div>

      {error !== null && <p className={css.hintText}>{error}</p>}

      {/* 删除确认弹窗（Jbn7a） */}
      {confirmDelete && createPortal(
        <div className={css.mcpConfirmOverlay} onClick={() => setConfirmDelete(false)}>
          <div className={css.mcpConfirmCard} onClick={e => e.stopPropagation()}>
            <div className={css.mcpConfirmHd}>
              <span className={css.mcpConfirmBadge}><TriangleAlert size={17} /></span>
              <span className={css.mcpConfirmTitle}>删除服务器「{server.name}」？</span>
            </div>
            <p className={css.mcpConfirmMsg}>
              该服务器提供 {probe.toolCount ?? 0} 个工具，当前已绑定 {references?.length ?? 0} 个 Agent 预设。删除后：
            </p>
            <div className={css.mcpConfirmBullets}>
              <span className={css.mcpConfirmBullet}>相关工具将立即失效，正在执行的任务可能中断</span>
              <span className={css.mcpConfirmBullet}>{references !== null && references.length > 0 ? `「${references.join('」「')}」等绑定将失去该服务器的工具` : '已绑定该服务器的 Agent 预设将失去其工具'}</span>
              <span className={css.mcpConfirmBullet}>若需保留数据请先停用服务器，而非删除</span>
            </div>
            <div className={css.mcpConfirmWarn}>
              <Info size={14} />
              <span className={css.mcpConfirmWarnTxt}>此操作不可撤销。删除后可重新添加服务器并恢复配置。</span>
            </div>
            <div className={css.mcpConfirmBtns}>
              <button type="button" className={css.mcpActionCancel} onClick={() => setConfirmDelete(false)}>取消</button>
              <button type="button" className={css.mcpDelBtn} onClick={() => { setConfirmDelete(false); void doDelete() }}>
                <Trash2 size={13} />删除服务器
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/* ── 添加视图（设计稿 YEGzN · body/YSoPV，页内表单） ───────────────── */

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
        }
      : {
          name,
          transport: 'streamable-http',
          url: String(parsed.url ?? ''),
          ...(parsed.headers !== undefined && typeof parsed.headers === 'object' && parsed.headers !== null
            ? { headers: parsed.headers as Record<string, string> } : {}),
          toolCallTimeoutMs: timeout,
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
    <>
      <div className={css.mcpToolbar}>
        <button type="button" className={css.mcpBackBtn} onClick={onBack}>
          <span className={css.mcpBackArrow}>←</span>返回列表
        </button>
      </div>

      {/* 卡 1：服务器信息（gqpRs） */}
      <div className={css.mcpCard} style={{ gap: 12 }}>
        <div className={css.mcpCardTitleRow}>
          <span className={css.mcpCardTitle}>服务器信息</span>
          <span className={css.mcpCardTip}>名称用于 Agent 展示与工具引用</span>
        </div>
        <span className={css.mcpFieldLbl}>服务器名称</span>
        <input
          className={css.mcpFieldInput}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="my-mcp-server"
        />
        <span className={css.mcpFieldLbl}>传输方式</span>
        <div className={css.mcpTransportTabs}>
          {ADD_TRANSPORT_OPTIONS.map(t => (
            <button
              key={t.value}
              type="button"
              className={t.value === transport ? css.mcpTransportTabActive : css.mcpTransportTab}
              onClick={() => setTransport(t.value)}
            >{t.label}</button>
          ))}
        </div>
      </div>

      {/* 卡 2：启动配置 JSON（jIHGu） */}
      <div className={css.mcpCard} style={{ gap: 10 }}>
        <div className={css.mcpCardTitleRow}>
          <span className={css.mcpCardTitle}>启动配置 (JSON)</span>
          <span className={css.mcpCardTip}>stdio 使用命令行启动，SSE/WebSocket 填写 URL</span>
        </div>
        <textarea
          className={css.mcpJsonEditor}
          value={configJson}
          onChange={e => setConfigJson(e.target.value)}
          placeholder={MCP_JSON_PLACEHOLDERS[transport]}
        />
      </div>

      {/* 卡 3：超时（E5x90） */}
      <div className={css.mcpCard} style={{ gap: 10 }}>
        <div className={css.mcpCols}>
          <div className={css.mcpCol}>
            <span className={css.mcpColLbl}>启动超时 (ms)</span>
            <input className={css.mcpColInput} value={startTimeout} onChange={e => setStartTimeout(e.target.value)} />
          </div>
          <div className={css.mcpCol}>
            <span className={css.mcpColLbl}>运行超时 (ms)</span>
            <input className={css.mcpColInput} value={runTimeout} onChange={e => setRunTimeout(e.target.value)} />
          </div>
        </div>
        <span className={css.mcpHintDim}>超时后该服务器将被标记为未连接，并自动尝试重连。</span>
      </div>

      {error !== null && <p className={css.hintText}>{error}</p>}

      {/* 底部 actions（cC4mz）：取消 + 添加服务器 */}
      <div className={css.mcpActions}>
        <button type="button" className={css.mcpActionCancel} onClick={onBack}>取消</button>
        <button type="button" className={css.mcpActionPrimary} disabled={busy} onClick={() => { void submit() }}>
          <Plus size={14} />{busy ? '添加中…' : '添加服务器'}
        </button>
      </div>
    </>
  )
}

/* ── Section 入口：三视图切换 ──────────────────────────────────────── */

export function McpSection() {
  const rpc = useCorumRpc()
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'detail'; name: string } | { kind: 'add' }>({ kind: 'list' })

  if (rpc === null) return <p className={css.hintText}>RPC 服务未就绪。</p>

  if (view.kind === 'detail') {
    return <McpDetailView rpc={rpc} name={view.name} onBack={() => setView({ kind: 'list' })} />
  }
  if (view.kind === 'add') {
    return <McpAddView rpc={rpc} onBack={() => setView({ kind: 'list' })} />
  }
  return (
    <McpListView
      rpc={rpc}
      onOpenDetail={name => setView({ kind: 'detail', name })}
      onOpenAdd={() => setView({ kind: 'add' })}
    />
  )
}
