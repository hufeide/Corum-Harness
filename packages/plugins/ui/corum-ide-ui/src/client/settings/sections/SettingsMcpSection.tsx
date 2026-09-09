/**
 * SettingsMcpSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { useState } from 'react'
import type { MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, Package, Trash2, X } from 'lucide-react'
import { Switch } from '../Switch.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── MCP 与集成 ────────────────────────────────────────────────────── */

type McpTransport = 'stdio' | 'SSE / HTTP' | 'WebSocket'

interface McpTool {
  name: string
  enabled: boolean
}

interface McpServerData {
  id: string
  name: string
  transport: McpTransport
  desc: string
  workdir: string
  tools: McpTool[]
  enabled: boolean
}

const FILESYSTEM_TOOLS: McpTool[] = [
  'read_file', 'write_file', 'list_directory', 'search_files', 'move_file',
  'create_directory', 'delete_file', 'get_file_info', 'read_multiple', 'edit_file',
  'copy_file', 'rename_file', 'stat_directory', 'watch_directory',
].map(name => ({ name, enabled: true }))

const WEB_SEARCH_TOOLS: McpTool[] = [
  'search', 'fetch_page', 'extract_text', 'summarize', 'crawl_site', 'query_news',
].map(name => ({ name, enabled: true }))

const DB_INSPECTOR_TOOLS: McpTool[] = [
  'list_tables', 'describe_table', 'run_query', 'run_select', 'explain_plan',
  'list_indexes', 'table_stats', 'export_csv', 'inspect_schema',
].map(name => ({ name, enabled: true }))

const INITIAL_MCP_SERVERS: McpServerData[] = [
  {
    id: 'filesystem', name: 'filesystem', transport: 'stdio',
    desc: '本地文件系统读写', workdir: '/Users/kukucai/work',
    tools: FILESYSTEM_TOOLS, enabled: true,
  },
  {
    id: 'web-search', name: 'web-search', transport: 'SSE / HTTP',
    desc: '联网搜索', workdir: 'https://mcp.corum.dev/search',
    tools: WEB_SEARCH_TOOLS, enabled: true,
  },
  {
    id: 'db-inspector', name: 'db-inspector', transport: 'WebSocket',
    desc: '数据库结构检查', workdir: 'ws://127.0.0.1:7788/inspect',
    tools: DB_INSPECTOR_TOOLS, enabled: false,
  },
]

const TRANSPORT_OPTIONS: McpTransport[] = ['stdio', 'SSE / HTTP', 'WebSocket']

/* 不同传输方式对应不同的配置示例 */
const MCP_JSON_PLACEHOLDERS: Record<McpTransport, string> = {
  'stdio': `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
}`,
  'SSE / HTTP': `{
  "url": "https://mcp.example.com/sse",
  "headers": { "Authorization": "Bearer <token>" }
}`,
  'WebSocket': `{
  "url": "ws://127.0.0.1:7788/mcp",
  "protocols": ["mcp.v1"]
}`,
}

/* 添加 MCP 服务器对话框（设计稿 sIDC1） */
function AddMcpServerDialog({ onClose, onAdd }: {
  onClose: () => void
  onAdd: (server: McpServerData) => void
}) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [configJson, setConfigJson] = useState('')
  const [startTimeout, setStartTimeout] = useState('60000')
  const [runTimeout, setRunTimeout] = useState('60000')

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>添加 MCP 服务器</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <div className={css.formGroup}>
            <label className={css.fieldLabel}>服务器名称</label>
            <input className={css.fieldInput} value={name} onChange={e => setName(e.target.value)} placeholder="my-mcp-server" />
          </div>
          <div className={css.formGroup}>
            <label className={css.fieldLabel}>传输方式</label>
            <div className={css.transportPills}>
              {TRANSPORT_OPTIONS.map(t => (
                <button
                  key={t}
                  type="button"
                  className={`${css.transportPill}${t === transport ? ' ' + css.transportPillActive : ''}`}
                  onClick={() => setTransport(t)}
                >{t}</button>
              ))}
            </div>
          </div>
          <div className={css.formGroup}>
            <label className={css.fieldLabel}>配置（JSON）</label>
            <textarea
              className={css.jsonTextarea}
              value={configJson}
              onChange={e => setConfigJson(e.target.value)}
              placeholder={MCP_JSON_PLACEHOLDERS[transport]}
            />
          </div>
          <div className={css.formGroup}>
            <div className={css.formCols}>
              <div className={css.formCol}>
                <label className={css.fieldLabel}>启动超时（ms）</label>
                <input className={css.fieldInput} value={startTimeout} onChange={e => setStartTimeout(e.target.value)} />
              </div>
              <div className={css.formCol}>
                <label className={css.fieldLabel}>运行超时（ms）</label>
                <input className={css.fieldInput} value={runTimeout} onChange={e => setRunTimeout(e.target.value)} />
              </div>
            </div>
          </div>
          <div className={css.marketRow}>
            <Package size={14} />
            <span>或从 MCP 市场一键安装</span>
            <button type="button" className={css.marketLink}>浏览市场 →</button>
          </div>
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => onAdd({
              id: name || 'my-mcp-server',
              name: name || 'my-mcp-server',
              transport,
              desc: '',
              workdir: '',
              tools: [],
              enabled: true,
            })}>添加</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* MCP 服务器详情对话框（设计稿 fw8aK） */
function McpServerDetailDialog({ server, onClose, onSave, onDelete }: {
  server: McpServerData
  onClose: () => void
  onSave: (server: McpServerData) => void
  onDelete: (id: string) => void
}) {
  const [draft, setDraft] = useState<McpServerData>(() => JSON.parse(JSON.stringify(server)) as McpServerData)
  const [expanded, setExpanded] = useState(false)

  const visibleTools = expanded ? draft.tools : draft.tools.slice(0, 5)
  const hiddenCount = draft.tools.length - visibleTools.length

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()}>
        <div className={css.modalHeader}>
          <div className={css.detailHead}>
            <span className={draft.enabled ? css.detailDot : css.detailDotOff} />
            <span className={css.detailName}>{draft.name}</span>
            <span className={css.detailChip}>{draft.transport}</span>
          </div>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <div className={css.formGroup}>
            <div className={css.formGroupTitle}>基本信息</div>
            <label className={css.fieldLabel}>描述</label>
            <input
              className={css.fieldInput}
              value={draft.desc}
              onChange={e => setDraft(prev => ({ ...prev, desc: e.target.value }))}
              placeholder="服务器用途说明"
            />
            <div className={css.kvRow}>
              <span className={css.kvLabel}>工作目录</span>
              <span className={css.kvValue}>{draft.workdir || '—'}</span>
            </div>
            <div className={css.kvRow}>
              <span className={css.kvLabel}>已注册工具</span>
              <span className={css.kvValue}>{draft.tools.length} 个</span>
            </div>
          </div>
          <div className={css.formGroup}>
            <div className={css.formGroupTitle}>工具列表</div>
            {visibleTools.map((tool, i) => (
              <div key={tool.name} className={css.toolRow}>
                <span className={css.toolName}>{tool.name}</span>
                <Switch
                  checked={tool.enabled}
                  onChange={v => setDraft(prev => {
                    const tools = prev.tools.slice()
                    tools[i] = { ...tools[i], enabled: v }
                    return { ...prev, tools }
                  })}
                />
              </div>
            ))}
            {hiddenCount > 0 && (
              <div className={css.expandRow}>
                <button type="button" className={css.expandLink} onClick={() => setExpanded(true)}>
                  <ChevronDown size={13} />展开全部 {draft.tools.length} 个工具
                </button>
              </div>
            )}
            {expanded && draft.tools.length > 5 && (
              <div className={css.expandRow}>
                <button type="button" className={css.expandLink} onClick={() => setExpanded(false)}>
                  <ChevronUp size={13} />收起
                </button>
              </div>
            )}
          </div>
          <div className={css.kvRow}>
            <span className={css.kvLabel}>启用此服务器</span>
            <Switch checked={draft.enabled} onChange={v => setDraft(prev => ({ ...prev, enabled: v }))} />
          </div>
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft}>
            <GlassButton variant="danger" onClick={() => onDelete(server.id)}>删除</GlassButton>
          </div>
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => onSave(draft)}>保存</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function McpSection() {
  const [servers, setServers] = useState<McpServerData[]>(INITIAL_MCP_SERVERS)
  const [addOpen, setAddOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = servers.find(s => s.id === selectedId) ?? null

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>连接外部 MCP 服务器，为 Agent 提供工具与数据源。</span>
        <GlassButton variant="primary" onClick={() => setAddOpen(true)}>+ 添加服务器</GlassButton>
      </div>
      {servers.map(s => (
        <button key={s.id} type="button" className={css.serverCardBtn} onClick={() => setSelectedId(s.id)}>
          <div className={css.serverLeft}>
            <span className={s.enabled ? css.serverDotOn : css.serverDotOff} />
            <div className={css.serverMeta}>
              <span className={css.serverName}>{s.name}</span>
              <span className={css.serverDesc}>{s.desc || s.transport}</span>
            </div>
          </div>
          <div className={css.serverRight}>
            <span className={css.serverTools}>{s.tools.length} 个工具</span>
            <span onClick={e => e.stopPropagation()}>
              <Switch
                checked={s.enabled}
                onChange={v => setServers(prev => prev.map(x => x.id === s.id ? { ...x, enabled: v } : x))}
              />
            </span>
            <Trash2
              size={15}
              className={css.memDel}
              onClick={(e: MouseEvent) => { e.stopPropagation(); setServers(prev => prev.filter(x => x.id !== s.id)) }}
            />
          </div>
        </button>
      ))}
      {addOpen && (
        <AddMcpServerDialog
          onClose={() => setAddOpen(false)}
          onAdd={server => { setServers(prev => [...prev, server]); setAddOpen(false) }}
        />
      )}
      {selected && (
        <McpServerDetailDialog
          server={selected}
          onClose={() => setSelectedId(null)}
          onSave={updated => {
            setServers(prev => prev.map(x => x.id === updated.id ? updated : x))
            setSelectedId(null)
          }}
          onDelete={id => {
            setServers(prev => prev.filter(x => x.id !== id))
            setSelectedId(null)
          }}
        />
      )}
    </>
  )
}
