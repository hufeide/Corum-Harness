/**
 * @corum/corum-artgen client half — 在「扩展」设置分组注册「本地文生图」页。
 *
 * 插件启用后，设置中心「扩展」分组自动出现「本地文生图（Art Generator）」页：
 * 引擎状态（sd-cli 是否已下载 + 已下载模型数）+ 引擎/模型下载 + 生成测试区。
 * 数据走 host corumArtGen RPC（connection.rpc.call → /api/corumArtGen/*）。
 *
 * @module @corum/corum-artgen/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

/** sd-cli 可用模型文件（.safetensors / .gguf）。 */
interface SdModel {
  /** 模型文件名（如 'sd-v1-5-pruned-emaonly-fp16.safetensors'）。 */
  fileName: string
  /** 展示名（如 'SD 1.5'）。 */
  displayName: string
  /** 人类可读大小（如 '2.0 GB'）。 */
  size: string
  /** 磁盘占用（字节）。 */
  sizeBytes: number
  /** 是否已激活。 */
  active?: boolean
}

interface GpuInfo {
  name: string
  vramGb: number
  vendor: 'nvidia' | 'amd' | 'apple-metal' | 'intel'
}

/** 本地文生图引擎状态。 */
interface ArtGenStatus {
  /** sd-cli 是否已下载到本地。 */
  engineBundled: boolean
  /** sd-cli 可执行文件路径（引擎未下载时为空串）。 */
  enginePath: string
  /** 已下载的模型列表。 */
  models: SdModel[]
  /** 运行平台（process.platform）。 */
  platform: string
  /** 物理内存（GB）。 */
  totalMemGb: number
  /** 是否达到最低硬件门槛。 */
  meetsMinReq: boolean
  /** 不达标原因。 */
  minReqReason?: string
  /** GPU 信息。 */
  gpu: GpuInfo | null
  /** CPU 核心数。 */
  cpuCores: number
}

/** txt2img 推理参数。 */
interface Txt2ImgArgs {
  prompt: string
  negativePrompt?: string
  model: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  sampler?: string
  seed?: number
}

/** txt2img 推理结果。 */
interface Txt2ImgResult {
  imageBase64: string
  seed: number
  durationMs: number
}

/** txt2img 任务（startTxt2Img 启动，getTxt2ImgJob 轮询真实进度）。 */
interface Txt2ImgJob {
  id: string
  status: 'running' | 'done' | 'error'
  percent: number
  phase: string
  result?: Txt2ImgResult
  error?: string
}

/** 下载进度（引擎 / 模型下载共用）。 */
interface DownloadProgress {
  percent: number
  totalBytes: number
  downloadedBytes: number
  status: string
  error?: string
}

function makeCall(connection: ConnectionHandle) {
  return async function call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const result = await connection.rpc.call('/api', `corumArtGen/${method}`, { args })
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

/** 通用下载进度条（引擎 / 模型共用）。 */
function DownloadProgressBar({ progress }: { progress: { percent: number; total: string; downloaded: string; status: string } | null }): ReactNode {
  if (progress === null) return null
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--corum-glass-3)', overflow: 'hidden' }}>
          <div style={{
            width: `${progress.percent}%`, height: '100%', borderRadius: 3,
            background: 'var(--dsw-alias-brand-primary)', transition: 'width 0.3s ease',
          }} />
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-brand-primary)', minWidth: 36, textAlign: 'right' }}>{progress.percent}%</span>
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
        <span>已下载：{progress.downloaded} / {progress.total}</span>
        <span>状态：{progress.status === 'downloading' ? '下载中' : progress.status === 'done' ? '完成' : progress.status === 'error' ? '失败' : progress.status}</span>
      </div>
    </div>
  )
}

const SIZES: number[] = [256, 512, 1024]
const RECOMMENDED_MODEL = 'sd-v1-5-pruned-emaonly-fp16.safetensors'
const DEFAULT_PROMPT = 'minimalist flat vector avatar icon for an AI assistant, soft gradient glass style, centered, clean background'

function ArtGenSection({ call }: { call: ReturnType<typeof makeCall> }): ReactNode {
  const [status, setStatus] = useState<ArtGenStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 引擎下载
  const [dlEngine, setDlEngine] = useState(false)
  const [dlEngineProgress, setDlEngineProgress] = useState<{ percent: number; total: string; downloaded: string; status: string } | null>(null)

  // 模型下载
  const [dlModel, setDlModel] = useState(false)
  const [dlModelProgress, setDlModelProgress] = useState<{ percent: number; total: string; downloaded: string; status: string } | null>(null)

  // 生成测试区
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [size, setSize] = useState(512)
  const [steps, setSteps] = useState(20)
  const [generating, setGenerating] = useState(false)
  const [genProgress, setGenProgress] = useState(0)
  const [resultImage, setResultImage] = useState<string | null>(null)
  const [genDuration, setGenDuration] = useState<number | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const s = await call<ArtGenStatus>('status', {})
      setStatus(s)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void refresh() }, [])

  const downloadEngine = async (): Promise<void> => {
    setDlEngine(true)
    setError(null)
    setDlEngineProgress({ percent: 0, total: '0 B', downloaded: '0 B', status: 'downloading' })
    const poll = setInterval(async () => {
      try {
        const p = await call<DownloadProgress>('getDownloadProgress', { key: 'engine' })
        setDlEngineProgress({
          percent: p.percent,
          total: formatBytesClient(p.totalBytes),
          downloaded: formatBytesClient(p.downloadedBytes),
          status: p.status,
        })
        if (p.status === 'done' || p.status === 'error') clearInterval(poll)
      } catch { /* 忽略轮询错误 */ }
    }, 500)
    try {
      const r = await call<{ ok: boolean; error?: string }>('downloadEngine', {})
      clearInterval(poll)
      if (!r.ok) setError(r.error ?? '引擎下载失败')
      setDlEngineProgress(null)
      await refresh()
    } catch (e) {
      clearInterval(poll)
      setError(e instanceof Error ? e.message : String(e))
      setDlEngineProgress(null)
    } finally {
      setDlEngine(false)
    }
  }

  const downloadModel = async (tier: 'low' | 'mid' | 'high'): Promise<void> => {
    setDlModel(true)
    setError(null)
    setDlModelProgress({ percent: 0, total: '0 B', downloaded: '0 B', status: 'downloading' })
    // 后台下载（不阻塞 RPC 连接），轮询进度槽直到完成/失败。
    const poll = setInterval(async () => {
      try {
        const p = await call<DownloadProgress>('getDownloadProgress', { key: 'model' })
        setDlModelProgress({
          percent: p.percent,
          total: formatBytesClient(p.totalBytes),
          downloaded: formatBytesClient(p.downloadedBytes),
          status: p.status,
        })
        if (p.status === 'done' || p.status === 'error') clearInterval(poll)
      } catch { /* 忽略轮询错误 */ }
    }, 500)
    try {
      await call<{ started: boolean }>('startDownloadModel', { tier })
      // 等待后台下载结束（轮询槽位状态）。
      for (;;) {
        await new Promise(r => setTimeout(r, 600))
        const p = await call<DownloadProgress>('getDownloadProgress', { key: 'model' })
        if (p.status === 'done') break
        if (p.status === 'error') throw new Error(p.error ?? '模型下载失败')
      }
      clearInterval(poll)
      setDlModelProgress(null)
      await refresh()
    } catch (e) {
      clearInterval(poll)
      setError(e instanceof Error ? e.message : String(e))
      setDlModelProgress(null)
    } finally {
      setDlModel(false)
    }
  }

  // 删除模型
  const [busyModel, setBusyModel] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const deleteModel = async (fileName: string) => {
    setBusyModel(fileName)
    setError(null)
    try {
      const r = await call<{ ok: boolean; error?: string }>('deleteModel', { fileName })
      if (!r.ok) setError(r.error ?? '删除失败')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyModel(null)
      setConfirmDelete(null)
    }
  }

  // 激活模型（预热加载到内存）
  const activateModel = async (fileName: string) => {
    setBusyModel(fileName)
    setError(null)
    try {
      const r = await call<{ ok: boolean; error?: string }>('activateModel', { fileName })
      if (!r.ok) setError(r.error ?? '激活失败')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyModel(null)
    }
  }

  // 停止模型
  const deactivateModel = async (fileName: string) => {
    setBusyModel(fileName)
    setError(null)
    try {
      const r = await call<{ ok: boolean; error?: string }>('deactivateModel', { fileName })
      if (!r.ok) setError(r.error ?? '停止失败')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyModel(null)
    }
  }

  const generate = async (): Promise<void> => {
    if (prompt.trim() === '') return
    if (status === null || !status.engineBundled || status.models.length === 0) return
    setGenerating(true)
    setError(null)
    setResultImage(null)
    setGenDuration(null)
    setGenProgress(0)
    try {
      const model = status.models[0]!.fileName
      const args: Txt2ImgArgs = { prompt: prompt.trim(), model, width: size, height: size, steps }
      // 启动任务 → 轮询真实进度（解析自 sd-cli 输出），替代旧的定时器假进度。
      const { jobId } = await call<{ jobId: string }>('startTxt2Img', { args: args as unknown as Record<string, unknown> })
      for (;;) {
        await new Promise(r => setTimeout(r, 400))
        const job = await call<Txt2ImgJob | null>('getTxt2ImgJob', { jobId })
        if (job === null) throw new Error('文生图任务已过期')
        setGenProgress(job.percent)
        if (job.status === 'done') {
          setResultImage(job.result!.imageBase64)
          setGenDuration(job.result!.durationMs)
          setGenProgress(100)
          break
        }
        if (job.status === 'error') throw new Error(job.error ?? '生成失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  const engineReady = status !== null && status.engineBundled && status.meetsMinReq
  const hasModels = status !== null && status.models.length > 0
  const canGenerate = engineReady && hasModels && !generating && prompt.trim() !== ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      <Row label="本地文生图（Art Generator）" desc="基于 stable-diffusion.cpp 单体二进制，三平台本地文生图（macOS / Windows / Linux）" />

      {/* ── 引擎状态 ── */}
      <Row label="引擎状态" desc="sd-cli 是否已下载到本地 · 硬件配置检测">
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '10px 12px', borderRadius: 10,
          border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)',
        }}>
          {status === null ? (
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>检测中…</span>
          ) : !status.meetsMinReq ? (
            <>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
                color: 'var(--dsw-alias-state-error-primary, #FF5C8A)',
                border: '1px solid var(--dsw-alias-state-error-primary, #FF5C8A)',
              }}>⚠ 配置不足</span>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #FF5C8A)' }}>
                {status.minReqReason ?? '硬件配置不满足要求'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                {platformName(status.platform)} · {status.cpuCores} 核 · 内存 {status.totalMemGb} GB
                {status.gpu !== null ? ` · GPU ${status.gpu.name} · ${status.gpu.vramGb} GB VRAM` : ' · 无独立 GPU（CPU 推理可用但慢）'}
              </span>
            </>
          ) : engineReady ? (
            <>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
                color: 'var(--dsw-alias-state-success-primary, #3EE6B0)',
                border: '1px solid var(--dsw-alias-state-success-primary, #3EE6B0)',
              }}>● 就绪</span>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
                引擎已就绪 · {status.models.length} 个模型 · {platformName(status.platform)} · {status.cpuCores} 核 · 内存 {status.totalMemGb} GB
                {status.gpu !== null ? ` · GPU ${status.gpu.name}` : ' · CPU 推理'}
              </span>
              <span style={{ ...MONO, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{status.enginePath}</span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
                color: 'var(--dsw-alias-label-dimmed)',
                border: '1px solid var(--corum-glass-border)',
              }}>○ 未下载</span>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>引擎未下载到本地</span>
              <button type="button" disabled={dlEngine} onClick={() => void downloadEngine()} style={{
                padding: '5px 12px', borderRadius: 8, fontSize: 12, cursor: dlEngine ? 'wait' : 'pointer',
                border: '1px solid var(--corum-glass-border-active)', background: 'var(--corum-glass-3)',
                color: 'var(--dsw-alias-brand-primary)', whiteSpace: 'nowrap',
              }}>{dlEngine ? '下载中…' : '下载引擎到本地'}</button>
            </>
          )}
        </div>
        <DownloadProgressBar progress={dlEngineProgress} />
      </Row>

      {/* ── 已下载模型 ── */}
      <Row label="已下载模型" desc="sd-cli 模型目录中的 .safetensors / .gguf 文件">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {status === null ? (
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }}>加载中…</span>
          ) : status.models.length === 0 ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
              borderRadius: 8, border: '1px solid var(--corum-glass-border)',
              background: 'var(--corum-glass-2)',
            }}>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', flex: 1 }}>暂无模型，选择一个档位下载</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" disabled={dlModel || !engineReady} onClick={() => void downloadModel('low')} style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, cursor: dlModel ? 'wait' : 'pointer', border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', opacity: dlModel ? 0.5 : 1, }} title="DreamShaper 8 (SD 1.5 微调, 2GB)">低配 (2GB)</button>
                <button type="button" disabled={dlModel || !engineReady} onClick={() => void downloadModel('mid')} style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, cursor: dlModel ? 'wait' : 'pointer', border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', opacity: dlModel ? 0.5 : 1, }} title="FLUX.1-schnell Q2_K (3.7GB)">中配 (3.7GB)</button>
                <button type="button" disabled={dlModel || !engineReady} onClick={() => void downloadModel('high')} style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, cursor: dlModel ? 'wait' : 'pointer', border: '1px solid var(--corum-glass-border-active)', background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-brand-primary)', whiteSpace: 'nowrap', opacity: dlModel ? 0.5 : 1, }} title="FLUX.1-schnell Q3_K_S (4.8GB)">高配 (4.8GB)</button>
              </div>
            </div>
          ) : (
            <>
              {status.models.map(m => {
                const isActive = m.active === true
                const busy = busyModel === m.fileName
                return (
                  <div key={m.fileName} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                    borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                    background: isActive ? 'var(--corum-glass-3)' : 'var(--corum-glass-2)',
                  }}>
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
                      color: isActive ? 'var(--dsw-alias-state-success-primary, #3EE6B0)' : 'var(--dsw-alias-label-dimmed)',
                      border: `1px solid ${isActive ? 'var(--dsw-alias-state-success-primary, #3EE6B0)' : 'var(--corum-glass-border)'}`,
                    }}>{isActive ? '● 已激活' : '○ 未激活'}</span>
                    <span style={{ ...MONO, fontSize: 12, color: 'var(--dsw-alias-label-primary)' }}>{m.fileName}</span>
                    <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{m.displayName}</span>
                    <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{m.size}</span>
                    <span style={{ flex: 1 }} />
                    {isActive ? (
                      <button type="button" disabled={busy} onClick={() => void deactivateModel(m.fileName)} style={{
                        padding: '4px 10px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                        background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                      }}>{busy ? '停止中…' : '停止'}</button>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => void activateModel(m.fileName)} style={{
                        padding: '4px 10px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                        background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-primary)', fontSize: 12, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                      }}>{busy ? '激活中…' : '激活'}</button>
                    )}
                    {confirmDelete === m.fileName ? (
                      <span style={{ display: 'flex', gap: 4 }}>
                        <button type="button" disabled={busy} onClick={() => void deleteModel(m.fileName)} style={{
                          padding: '4px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-error-primary, #FF5C8A)',
                          background: 'var(--dsw-alias-state-error-primary, #FF5C8A)', color: '#fff', fontSize: 12, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                        }}>确认</button>
                        <button type="button" onClick={() => setConfirmDelete(null)} style={{
                          padding: '4px 10px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                          background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                        }}>取消</button>
                      </span>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => setConfirmDelete(m.fileName)} style={{
                        padding: '4px 10px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                        background: 'transparent', color: 'var(--dsw-alias-state-error-primary, #FF5C8A)', fontSize: 12, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                      }}>删除</button>
                    )}
                  </div>
                )
              })}
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button type="button" disabled={dlModel} onClick={() => void downloadModel('low')} style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, cursor: dlModel ? 'wait' : 'pointer', border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', }}>+ 低配 (2GB)</button>
                <button type="button" disabled={dlModel} onClick={() => void downloadModel('mid')} style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, cursor: dlModel ? 'wait' : 'pointer', border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', }}>+ 中配 (3.7GB)</button>
                <button type="button" disabled={dlModel} onClick={() => void downloadModel('high')} style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, cursor: dlModel ? 'wait' : 'pointer', border: '1px solid var(--corum-glass-border-active)', background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-brand-primary)', whiteSpace: 'nowrap', }}>+ 高配 (4.8GB)</button>
              </div>
            </>
          )}
        </div>
        <DownloadProgressBar progress={dlModelProgress} />
      </Row>

      {/* ── 生成测试 ── */}
      <Row label="生成测试" desc="输入提示词，生成图片预览">
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px',
          borderRadius: 12, border: '1px solid var(--corum-glass-border)',
          background: 'var(--corum-glass-2)',
        }}>
          <textarea
            style={{
              width: '100%', minHeight: 64, padding: '8px 10px', borderRadius: 8, fontSize: 12,
              border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-1, transparent)',
              color: 'var(--dsw-alias-label-primary)', outline: 'none', resize: 'vertical',
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
            placeholder="输入提示词（如：a cute cat, digital art, highly detailed）"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            disabled={generating}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginRight: 2 }}>尺寸</span>
            {SIZES.map(s => (
              <button key={s} type="button" disabled={generating} onClick={() => setSize(s)} style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: generating ? 'not-allowed' : 'pointer',
                border: '1px solid var(--corum-glass-border)',
                background: size === s ? 'var(--corum-glass-3)' : 'transparent',
                color: size === s ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
                fontWeight: size === s ? 600 : 400, whiteSpace: 'nowrap',
              }}>{s}×{s}</button>
            ))}
            <span style={{ flex: 1 }} />
            <label style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
              步数
              <input type="number" min={1} max={100} value={steps} disabled={generating}
                onChange={e => {
                  const v = parseInt(e.target.value, 10)
                  setSteps(Number.isNaN(v) ? 20 : Math.max(1, Math.min(100, v)))
                }}
                style={{
                  width: 56, padding: '4px 6px', borderRadius: 6, fontSize: 12,
                  border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-1, transparent)',
                  color: 'var(--dsw-alias-label-primary)', outline: 'none', ...MONO,
                }}
              />
            </label>
            <button type="button" disabled={!canGenerate} onClick={() => void generate()} style={{
              padding: '6px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: canGenerate ? 'pointer' : 'not-allowed',
              border: '1px solid var(--corum-glass-border-active)', background: 'var(--dsw-alias-brand-primary)',
              color: 'var(--dsw-alias-label-on-brand, #fff)', whiteSpace: 'nowrap',
              opacity: canGenerate ? 1 : 0.5,
            }}>{generating ? '生成中…' : '生成'}</button>
          </div>
          {/* 生成进度条 */}
          {generating && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--corum-glass-3)', overflow: 'hidden' }}>
                <div style={{
                  width: `${genProgress}%`, height: '100%', borderRadius: 3,
                  background: 'var(--dsw-alias-brand-primary)', transition: 'width 0.3s ease',
                }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-brand-primary)', minWidth: 36, textAlign: 'right' }}>{genProgress}%</span>
            </div>
          )}
          {/* 结果预览 */}
          {resultImage !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
              <img src={`data:image/png;base64,${resultImage}`} alt="生成结果"
                style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--corum-glass-border)' }} />
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                {genDuration !== null && <span>耗时：{(genDuration / 1000).toFixed(1)}s</span>}
                <span>{size}×{size} · {steps} 步</span>
              </div>
            </div>
          )}
        </div>
      </Row>

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
    id: 'artgen',
    order: 197,
    label: '本地文生图',
  }, () => <ArtGenSection call={call} />))
}
