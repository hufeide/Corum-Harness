/**
 * @corum/corum-ollama client half — 设置「扩展」里注册本插件的设置页。
 *
 * 插件启用后，在「扩展」分组自动出现「本地 LLM（Ollama）」设置页：
 * 本地引擎状态（安装/运行/内存/GPU/CPU）+ 按配置分档的模型部署/卸载 + 润色引擎说明。
 * 数据走 host localLlm RPC（connection.rpc.call → /api/localLlm/*）。
 *
 * @module @corum/corum-ollama/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface GpuInfo {
  name: string
  vramGb: number
  vendor: 'nvidia' | 'amd' | 'apple-metal' | 'intel'
}

/** 已拉取模型的 UI 投影。 */
interface PulledModel {
  name: string
  size: string
  sizeBytes: number
  /** 实际量化等级（如 'Q4_K_M'）。 */
  quantization?: string
  /** 是否已激活（加载到内存）。 */
  active?: boolean
  /** 激活后占用的 VRAM（字节）。 */
  vramBytes?: number
  /** 参数量（如 '8.0B'）。 */
  paramSize?: string
  /** 模型架构族（如 'gemma4'）。 */
  family?: string
  /** 上下文长度（token 数）。 */
  contextLength?: number
  /** 能力列表（如 ['completion', 'vision']）。 */
  capabilities?: string[]
}

interface LocalEngineStatus {
  installed: boolean
  running: boolean
  totalMemGb: number
  meetsMinMem: boolean
  modelPulled: boolean
  models: PulledModel[]
  platform: string
  cpuCores: number
  gpu: GpuInfo | null
  gpuEnabled: boolean
  /** 当前已激活（加载到内存）的模型数。 */
  activeModelCount: number
  /** 最大同时激活模型数。 */
  maxActiveModels: number
  /** 引擎是否已内置。 */
  engineBundled: boolean
}

interface RecommendedModel {
  id: string
  name: string
  size: string
  description: string
  tags: string[]
  minMemoryGb: number
  vramGb: number
  cpuOnly: boolean
  tier: 'low' | 'mid' | 'high'
  isMoE: boolean
  quantization: string
}

/** 线上目录搜索结果 tag。 */
interface OnlineModelTag {
  fullName: string
  tag: string
  quantization: string
  paramSize: string
}

function makeCall(connection: ConnectionHandle) {
  return async function call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const result = await connection.rpc.call('/api', `localLlm/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12 }

function Row({ label, desc, children }: { label: string; desc?: string; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 2px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{label}</span>
        {desc !== undefined && <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{desc}</span>}
      </div>
      {children}
    </div>
  )
}

function platformName(p: string): string {
  if (p === 'darwin') return 'macOS'
  if (p === 'win32') return 'Windows'
  if (p === 'linux') return 'Linux'
  return p
}

/** 字节数 → 人类可读大小（renderer 端）。 */
function formatBytesClient(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[i]}`
}

const TIER_LABELS: Record<RecommendedModel['tier'], string> = {
  low: '低配可用（8-16 GB 内存）',
  mid: '中配推荐（16-32 GB 内存 / 8-12 GB VRAM）',
  high: '高配旗舰（32 GB+ 内存 / 16 GB+ VRAM）',
}

function checkCompatible(model: RecommendedModel, status: LocalEngineStatus | null): { memOk: boolean; vramOk: boolean; hasGpu: boolean } {
  if (status === null) return { memOk: false, vramOk: false, hasGpu: false }
  const memOk = status.totalMemGb >= model.minMemoryGb
  const hasGpu = status.gpu !== null
  const vramOk = hasGpu && (status.gpu!.vramGb >= model.vramGb)
  return { memOk, vramOk, hasGpu }
}

function detectTier(status: LocalEngineStatus | null): RecommendedModel['tier'] {
  if (status === null) return 'low'
  const memGb = status.totalMemGb
  const vramGb = status.gpu?.vramGb ?? 0
  if (memGb >= 32 && vramGb >= 16) return 'high'
  if (memGb >= 16 && vramGb >= 8) return 'mid'
  return 'low'
}

/** 确认删除弹窗。 */
function DeleteConfirm({ model, onConfirm, onCancel, busy }: {
  model: string
  onConfirm: () => void
  onCancel: () => void
  busy: boolean
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.4)', zIndex: 10000,
    }} onClick={onCancel}>
      <div style={{
        background: 'var(--corum-glass-1, #1D112B)', border: '1px solid var(--corum-glass-border)',
        borderRadius: 16, padding: 20, maxWidth: 400, width: '90%',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 8 }}>删除模型</div>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 16 }}>
          确认删除 <span style={{ ...MONO, color: 'var(--dsw-alias-label-primary)' }}>{model}</span>？<br />
          这将释放该模型占用的磁盘空间，不可撤销。
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--corum-glass-border)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: 'pointer' }}>取消</button>
          <button type="button" onClick={onConfirm} disabled={busy} style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-error-primary, #FF5C8A)', background: 'var(--dsw-alias-state-error-primary, #FF5C8A)', color: '#fff', fontSize: 12, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModelCard({ m, status, deployed, busy, onDeploy, onDelete }: {
  m: RecommendedModel
  status: LocalEngineStatus | null
  deployed: boolean
  busy: boolean
  onDeploy: (id: string) => void
  onDelete: (id: string) => void
}) {
  const { memOk, vramOk, hasGpu } = checkCompatible(m, status)
  const canDeploy = memOk && (vramOk || m.cpuOnly) && status !== null && status.installed
  const vramWarn = hasGpu && !vramOk
  const notReadyReason = !memOk ? `内存不足（需 ${m.minMemoryGb} GB）`
    : vramWarn ? `GPU VRAM 不足（需 ${m.vramGb} GB，本机 ${(status?.gpu?.vramGb ?? 0)} GB）`
    : null

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
      borderRadius: 8, border: '1px solid var(--corum-glass-border)',
      background: 'var(--corum-glass-2)',
      opacity: canDeploy || deployed ? 1 : 0.6,
    }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{m.name}</span>
          <span style={{ ...MONO, padding: '2px 6px', borderRadius: 4, background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-tertiary)' }}>{m.id}</span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{m.size}</span>
          <span style={{ ...MONO, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-tertiary)' }}>{m.quantization}</span>
          {m.isMoE && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--corum-glass-border-active)', color: 'var(--dsw-alias-brand-primary)', fontWeight: 600 }}>MoE</span>}
          {m.tags.map(t => (
            <span key={t} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--corum-glass-border)', color: 'var(--dsw-alias-label-tertiary)' }}>{t}</span>
          ))}
        </div>
        <span style={{ fontSize: 11, color: notReadyReason ? 'var(--dsw-alias-state-warn-primary, #E07A00)' : 'var(--dsw-alias-label-tertiary)' }}>
          {m.description} · 需 {m.minMemoryGb} GB 内存 / {m.vramGb} GB VRAM
          {notReadyReason ? ` · ⚠ ${notReadyReason}` : ''}
          {!hasGpu && m.cpuOnly && ' · 纯 CPU 推理（慢 5-10x）'}
        </span>
      </div>
      {deployed
        ? <DeleteButton busy={busy} modelId={m.id} onDelete={() => onDelete(m.id)} />
        : <button
            type="button"
            disabled={!canDeploy || busy}
            onClick={() => onDeploy(m.id)}
            style={{
              padding: '5px 12px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
              background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-primary)', fontSize: 12, cursor: canDeploy ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap',
            }}
          >
            {busy ? '部署中…' : canDeploy ? '部署' : '配置不足'}
          </button>}
    </div>
  )
}

/** 已部署模型的卸载按钮（带二次确认）。 */
function DeleteButton({ busy, modelId, onDelete }: { busy: boolean; modelId: string; onDelete: () => void }) {
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setConfirm(true)}
        disabled={busy}
        style={{
          padding: '5px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-error-primary, #FF5C8A)',
          background: 'transparent', color: 'var(--dsw-alias-state-error-primary, #FF5C8A)', fontSize: 12, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
        }}
      >
        {busy ? '卸载中…' : '卸载'}
      </button>
      {confirm && (
        <DeleteConfirm
          model={modelId}
          onConfirm={() => { setConfirm(false); onDelete() }}
          onCancel={() => setConfirm(false)}
          busy={busy}
        />
      )}
    </>
  )
}

function OllamaSection({ call }: { call: ReturnType<typeof makeCall> }): ReactNode {
  const [status, setStatus] = useState<LocalEngineStatus | null>(null)
  const [recommended, setRecommended] = useState<RecommendedModel[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedTier, setExpandedTier] = useState<RecommendedModel['tier'] | 'all'>('all')
  // 引擎下载状态
  const [downloading, setDownloading] = useState(false)
  const [dlProgress, setDlProgress] = useState<{ percent: number; downloaded: string; total: string; status: string } | null>(null)
  // 线上搜索状态
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<OnlineModelTag[] | null>(null)
  const searchRef = useRef<HTMLDivElement | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  // 部署进度状态（renderer 直接调 Ollama /api/pull 流式 API）
  const [pullProgress, setPullProgress] = useState<{ model: string; status: string; percent: number; total?: string; completed?: string } | null>(null)

  const refresh = async () => {
    try {
      const [s, recs] = await Promise.all([
        call<LocalEngineStatus>('status', {}),
        call<RecommendedModel[]>('listRecommendedModels', {}),
      ])
      setStatus(s)
      setRecommended(recs)
      // 首次加载时按机器配置选默认档位；后续刷新不覆盖用户手选的 tab。
      setExpandedTier(prev => prev === 'all' && status === null ? detectTier(s) : prev)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  /**
   * 直接调 Ollama /api/pull（stream:true），解析 NDJSON 实时更新进度。
   * 绕过 host RPC——renderer 直接 fetch localhost:11434。
   */
  const pullModelStream = async (modelId: string): Promise<void> => {
    const r = await fetch('http://127.0.0.1:11434/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelId, stream: true }),
    })
    if (!r.ok) throw new Error(`拉取失败（HTTP ${r.status}）：${await r.text()}`)
    if (!r.body) throw new Error('Ollama 返回空响应体')
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const j = JSON.parse(trimmed) as { status?: string; total?: number; completed?: number; digest?: string }
          const status = j.status ?? ''
          let percent = 0
          let totalStr: string | undefined
          let completedStr: string | undefined
          if (j.total !== undefined && j.total > 0 && j.completed !== undefined) {
            percent = Math.round((j.completed / j.total) * 100)
            totalStr = formatBytesClient(j.total)
            completedStr = formatBytesClient(j.completed)
          } else if (status === 'success') {
            percent = 100
          }
          setPullProgress({ model: modelId, status, percent, ...(totalStr !== undefined ? { total: totalStr } : {}), ...(completedStr !== undefined ? { completed: completedStr } : {}) })
        } catch { /* 跳过非 JSON 行 */ }
      }
    }
  }
  useEffect(() => { void refresh() }, [])

  // click-away：点击搜索区域外时收起搜索结果。
  useEffect(() => {
    if (searchResults === null) return
    const onClick = (e: MouseEvent) => {
      if (searchRef.current !== null && !searchRef.current.contains(e.target as Node)) {
        setSearchResults(null)
        setSearchError(null)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => { document.removeEventListener('mousedown', onClick) }
  }, [searchResults])

  const isDeployed = (modelId: string): boolean => {
    if (status === null) return false
    // 精确匹配模型名（如 'qwen3.5:2b'），不做 base 前缀匹配——
    // 否则删了 qwen3.5:2b 后 qwen3.5:0.8b 仍被误判为已部署。
    return status.models.some(m => m.name === modelId)
  }

  /** 部署模型（renderer 直连 Ollama /api/pull 流式 API，实时显示进度）。 */
  const deploy = async (modelId: string) => {
    setBusyId(modelId)
    setError(null)
    try {
      await call('ensureServer', {})
      await pullModelStream(modelId)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
      setPullProgress(null)
    }
  }

  const deleteModel = async (modelId: string) => {
    setBusyId(modelId)
    setError(null)
    try {
      const r = await call<{ ok: boolean; error?: string }>('deleteModel', { model: modelId })
      if (!r.ok) setError(r.error ?? '删除失败')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  // 激活模型（加载到内存，触发空推理）
  const activateModel = async (modelId: string) => {
    setBusyId(modelId)
    setError(null)
    try {
      const r = await call<{ ok: boolean; error?: string }>('activateModel', { model: modelId })
      if (!r.ok) setError(r.error ?? '激活失败')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  // 卸载模型（从内存移除）
  const deactivateModel = async (modelId: string) => {
    setBusyId(modelId)
    setError(null)
    try {
      const r = await call<{ ok: boolean; error?: string }>('deactivateModel', { model: modelId })
      if (!r.ok) setError(r.error ?? '卸载失败')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  // 线上搜索：调 searchOnlineModels RPC 查询 ollama.com/library/<query>/tags
  const doSearch = async () => {
    const q = searchQuery.trim().toLowerCase()
    if (q === '') { setSearchResults(null); setSearchError(null); return }
    setSearching(true)
    setSearchError(null)
    try {
      const r = await call<{ results: OnlineModelTag[]; error?: string }>('searchOnlineModels', { query: q })
      if (r.error !== undefined && r.results.length === 0) {
        setSearchResults([])
        setSearchError(r.error)
      } else {
        setSearchResults(r.results)
      }
    } catch (e) {
      setSearchResults([])
      setSearchError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  // 搜索结果中部署任意 tag（部署后收起搜索结果）
  const deployTag = async (fullName: string) => {
    setBusyId(fullName)
    setError(null)
    setSearchResults(null)
    setSearchError(null)
    try {
      await call('ensureServer', {})
      await pullModelStream(fullName)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
      setPullProgress(null)
    }
  }

  // 下载引擎二进制（调 host downloadEngine RPC，轮询 getDownloadProgress 显示进度）
  const downloadEngine = async () => {
    setDownloading(true)
    setError(null)
    setDlProgress({ percent: 0, downloaded: '0 B', total: '0 B', status: 'downloading' })
    // 启动轮询
    const poll = setInterval(async () => {
      try {
        const p = await call<{ percent: number; downloadedBytes: number; totalBytes: number; status: string; error?: string }>('getDownloadProgress', {})
        setDlProgress({
          percent: p.percent,
          downloaded: formatBytesClient(p.downloadedBytes),
          total: formatBytesClient(p.totalBytes),
          status: p.status,
        })
        if (p.status === 'done' || p.status === 'error') clearInterval(poll)
      } catch { /* 忽略 */ }
    }, 500)
    try {
      const r = await call<{ ok: boolean; error?: string }>('downloadEngine', {})
      clearInterval(poll)
      if (!r.ok) setError(r.error ?? '下载失败')
      setDlProgress(null)
      await refresh()
    } catch (e) {
      clearInterval(poll)
      setError(e instanceof Error ? e.message : String(e))
      setDlProgress(null)
    } finally {
      setDownloading(false)
    }
  }

  const engineStatusText = (): string => {
    if (status === null) return '检测中…'
    if (!status.installed) return '未安装 Ollama — 安装 https://ollama.com 后即可本地部署'
    const parts = [`已安装 · ${status.running ? '服务运行中' : '服务未启动'}`]
    parts.push(`${platformName(status.platform)} · ${status.cpuCores} 核 · 内存 ${status.totalMemGb} GB${status.meetsMinMem ? '（达标 ≥16 GB）' : '（< 16 GB，建议线上模型）'}`)
    if (status.gpu !== null) {
      parts.push(`GPU ${status.gpu.name} · ${status.gpu.vramGb} GB VRAM${status.gpuEnabled ? ' · GPU 加速已就绪' : ''}`)
    } else {
      parts.push('无独立 GPU · 将使用 CPU 推理（速度慢 5-10x）')
    }
    return parts.join(' · ')
  }

  // 已部署模型的总磁盘占用。
  const totalDisk = status?.models.reduce((sum, m) => sum + m.sizeBytes, 0) ?? 0
  const totalDiskStr = totalDisk > 0 ? `（共 ${status!.models.length} 个 · ${Math.round(totalDisk / 1073741824 * 10) / 10} GB）` : ''

  const tiers: RecommendedModel['tier'][] = ['low', 'mid', 'high']
  const grouped = tiers.map(t => ({
    tier: t,
    label: TIER_LABELS[t],
    models: recommended.filter(m => m.tier === t),
  })).filter(g => g.models.length > 0)

  const machineTier = detectTier(status)
  const machineTierLabel = machineTier === 'high' ? '高配' : machineTier === 'mid' ? '中配' : '低配'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      <Row label="本地引擎（Ollama）" desc="在本机部署小模型，供 AI 润色 / 提示词优化 / 本地 Agent 驱动使用">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{engineStatusText()}</span>
          {/* 未内置引擎时显示下载按钮（无论 PATH 是否有 ollama） */}
          {status !== null && !status.engineBundled && (
            <button type="button" disabled={downloading} onClick={() => void downloadEngine()} style={{
              padding: '5px 12px', borderRadius: 8, fontSize: 12, cursor: downloading ? 'wait' : 'pointer',
              border: '1px solid var(--corum-glass-border-active)', background: 'var(--corum-glass-3)',
              color: 'var(--dsw-alias-brand-primary)', whiteSpace: 'nowrap',
            }}>{downloading ? '下载中…' : '下载引擎到本地'}</button>
          )}
          {/* 已内置标记 */}
          {status !== null && status.engineBundled && (
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 600,
              color: 'var(--dsw-alias-state-success-primary, #3EE6B0)',
              border: '1px solid var(--dsw-alias-state-success-primary, #3EE6B0)',
            }}>已内置</span>
          )}
        </div>
        {/* 下载进度条 */}
        {dlProgress !== null && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--corum-glass-3)', overflow: 'hidden' }}>
                <div style={{
                  width: `${dlProgress.percent}%`, height: '100%', borderRadius: 3,
                  background: 'var(--dsw-alias-brand-primary)', transition: 'width 0.3s ease',
                }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-brand-primary)', minWidth: 36, textAlign: 'right' }}>{dlProgress.percent}%</span>
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
              <span>已下载：{dlProgress.downloaded} / {dlProgress.total}</span>
              <span>状态：{dlProgress.status === 'downloading' ? '下载中' : dlProgress.status === 'done' ? '完成' : dlProgress.status === 'error' ? '失败' : dlProgress.status}</span>
            </div>
          </div>
        )}
      </Row>
      <Row label="本地模型" desc={`当前配置判定为「${machineTierLabel}」· 不满足要求的模型将标记"配置不足"并禁用部署`}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button type="button" onClick={() => setExpandedTier('all')} style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: '1px solid var(--corum-glass-border)', background: expandedTier === 'all' ? 'var(--corum-glass-3)' : 'transparent', color: 'var(--dsw-alias-label-secondary)' }}>全部</button>
          {grouped.map(g => (
            <button key={g.tier} type="button" onClick={() => setExpandedTier(g.tier)} style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: '1px solid var(--corum-glass-border)', background: expandedTier === g.tier ? 'var(--corum-glass-3)' : 'transparent', color: 'var(--dsw-alias-label-secondary)' }}>
              {g.tier === 'low' ? '低配' : g.tier === 'mid' ? '中配' : '高配'}{g.tier === machineTier ? ' · 本机' : ''}
            </button>
          ))}
        </div>
        {grouped.length === 0
          ? <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }}>加载推荐列表…</span>
          : grouped.filter(g => expandedTier === 'all' || g.tier === expandedTier).map(g => (
              <div key={g.tier} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)', padding: '2px 0' }}>{g.label}</div>
                {g.models.map(m => (
                  <ModelCard key={m.id} m={m} status={status} deployed={isDeployed(m.id)} busy={busyId === m.id} onDeploy={id => void deploy(id)} onDelete={id => void deleteModel(id)} />
                ))}
              </div>
            ))}
      </Row>
      {/* ── 线上搜索 ── */}
      <Row label="线上搜索" desc="输入模型名搜索 Ollama 线上目录（如 qwen3.8、gemma4、mistral-nemo），选择不同量化版本部署">
        <div ref={searchRef} style={{ position: 'relative' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 8, fontSize: 12,
              border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)',
              color: 'var(--dsw-alias-label-primary)', outline: 'none',
            }}
            placeholder="输入模型名（如 qwen3.8）…"
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); if (e.target.value === '') { setSearchResults(null); setSearchError(null) } }}
            onKeyDown={e => { if (e.key === 'Enter') void doSearch() }}
          />
          <button
            type="button"
            onClick={() => void doSearch()}
            disabled={searching || searchQuery.trim() === ''}
            style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
              border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-3)',
              color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap',
            }}
          >
            {searching ? '搜索中…' : '搜索'}
          </button>
        </div>
        {searchError !== null && <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-warn-primary, #E07A00)', marginBottom: 6, display: 'block' }}>{searchError}</span>}
        {searchResults !== null && searchResults.length === 0 && searchError === null && (
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }}>无搜索结果</span>
        )}
        {searchResults !== null && searchResults.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 400, overflowY: 'auto' }}>
            {searchResults.map(t => {
              const deployed = status !== null && status.models.some(m => m.name === t.fullName)
              const busy = busyId === t.fullName
              return (
                <div key={t.fullName} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
                  borderRadius: 8, border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)',
                }}>
                  <span style={{ ...MONO, fontSize: 12, color: 'var(--dsw-alias-label-primary)' }}>{t.fullName}</span>
                  <span style={{ ...MONO, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-tertiary)' }}>{t.quantization}</span>
                  {t.paramSize !== '-' && <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>{t.paramSize}</span>}
                  <span style={{ flex: 1 }} />
                  {deployed
                    ? <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-state-success-primary, #34a853)', whiteSpace: 'nowrap' }}>✓ 已部署</span>
                    : <button type="button" disabled={busy || status === null || !status.installed} onClick={() => void deployTag(t.fullName)} style={{
                        padding: '4px 10px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                        background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-primary)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                      }}>{busy ? '部署中…' : '部署'}</button>}
                </div>
              )
            })}
          </div>
        )}
        </div>
      </Row>
      {status !== null && status.models.length > 0 && (
        <Row label="已部署模型" desc={`共 ${status.models.length} 个 · ${Math.round(totalDisk / 1073741824 * 10) / 10} GB · 已激活 ${status.activeModelCount}/${status.maxActiveModels} 个`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {status.models.map(m => (
              <div key={m.name} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
                borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                background: m.active ? 'var(--corum-glass-3)' : 'var(--corum-glass-2)',
              }}>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
                  color: m.active ? 'var(--dsw-alias-state-success-primary, #3EE6B0)' : 'var(--dsw-alias-label-dimmed)',
                  border: `1px solid ${m.active ? 'var(--dsw-alias-state-success-primary, #3EE6B0)' : 'var(--corum-glass-border)'}`,
                }}>{m.active ? '● 已激活' : '○ 未激活'}</span>
                <span style={{ ...MONO, fontSize: 12, color: 'var(--dsw-alias-label-primary)' }}>{m.name}</span>
                {m.quantization !== undefined && <span style={{ ...MONO, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-tertiary)' }}>{m.quantization}</span>}
                {m.paramSize !== undefined && <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>{m.paramSize}</span>}
                {m.family !== undefined && <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>{m.family}</span>}
                {m.contextLength !== undefined && <span style={{ fontSize: 10, color: 'var(--dsw-alias-brand-primary)' }}>{(m.contextLength / 1024).toFixed(0)}K ctx</span>}
                {m.capabilities?.includes('vision') && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 8, border: '1px solid var(--corum-glass-border)', color: 'var(--dsw-alias-label-tertiary)' }}>vision</span>}
                <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{m.size}</span>
                {m.active && m.vramBytes !== undefined && <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-success-primary, #3EE6B0)' }}>内存 {formatBytesClient(m.vramBytes)}</span>}
                <span style={{ flex: 1 }} />
                {/* 激活/停止按钮 */}
                {m.active
                  ? <button type="button" disabled={busyId === m.name} onClick={() => void deactivateModel(m.name)} style={{
                      padding: '4px 10px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                      background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: busyId === m.name ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                    }}>{busyId === m.name ? '停止中…' : '停止'}</button>
                  : <button type="button" disabled={busyId === m.name || (status.activeModelCount >= status.maxActiveModels)} onClick={() => void activateModel(m.name)} style={{
                      padding: '4px 10px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                      background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-primary)', fontSize: 12,
                      cursor: (busyId === m.name || status.activeModelCount >= status.maxActiveModels) ? 'not-allowed' : 'pointer',
                      opacity: status.activeModelCount >= status.maxActiveModels ? 0.5 : 1, whiteSpace: 'nowrap',
                    }} title={status.activeModelCount >= status.maxActiveModels ? `已达上限 ${status.maxActiveModels} 个，请先停止一个` : ''}>{busyId === m.name ? '激活中…' : '激活'}</button>}
                <DeleteButton busy={busyId === m.name} modelId={m.name} onDelete={() => void deleteModel(m.name)} />
              </div>
            ))}
          </div>
        </Row>
      )}
      {/* ── 部署进度 ── */}
      {pullProgress !== null && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px',
          borderRadius: 12, border: '1px solid var(--corum-glass-border-active)',
          background: 'var(--corum-glass-2)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>部署进度</span>
            <span style={{ ...MONO, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{pullProgress.model}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--corum-glass-3)', overflow: 'hidden' }}>
              <div style={{
                width: `${pullProgress.percent}%`, height: '100%', borderRadius: 3,
                background: 'var(--dsw-alias-brand-primary)', transition: 'width 0.3s ease',
              }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-brand-primary)', minWidth: 36, textAlign: 'right' }}>{pullProgress.percent}%</span>
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
            <span>状态：{pullProgress.status}</span>
            {pullProgress.completed !== undefined && pullProgress.total !== undefined && (
              <span>已下载：{pullProgress.completed} / {pullProgress.total}</span>
            )}
          </div>
        </div>
      )}
      <Row label="润色引擎" desc="「扩展 → AI 润色」里选择：自动（≥16 GB 用本地，否则线上）/ 本地模型 / 线上模型" />
      {error !== null && <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</span>}
    </div>
  )
}

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  let slots: ClientContext['slots'] | undefined
  try {
    slots = ctx.slots
  } catch {
    return
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const call = makeCall(connection)
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'ollama',
    order: 195,
    label: '本地 LLM（Ollama）',
  }, () => <OllamaSection call={call} />))
}
