/**
 * LocalLlmService — corum 本地 LLM 服务。
 *
 * 探测/管理本机推理引擎（当前适配 Ollama），为 AI 润色等轻量改写任务提供本地
 * 模型能力：
 *   - status：探测 安装 / 运行 / 内存 / GPU / CPU 核数 / 默认模型是否已拉取；
 *   - ensureServer：启动 `ollama serve`（已跑则跳过）；
 *   - pullModel：拉取模型（首次部署引导）；
 *   - chat：OpenAI 兼容端点推理（keep_alive 常驻消冷启动）。
 *
 * 硬件检测跨平台支持：
 *   - macOS：system_profiler 解析 GPU（Apple Silicon = 统一内存；Intel Mac = 独显）；
 *   - Linux：nvidia-smi / rocm-smi / lspci 逐级探测；
 *   - Windows：nvidia-smi / wmic 逐级探测。
 *
 * 引擎抽象：当前仅 Ollama 一个 backend（localhost:11434，OpenAI 兼容 /v1）。
 * 后续接 MLX / llama.cpp Metal 时在 backend 层扩展，service/RPC 面不变。
 *
 * @module @corum/corum-ollama/local-llm-service
 */

import { spawn } from 'node:child_process'
import { totalmem, cpus, homedir } from 'node:os'
import { existsSync, mkdirSync, renameSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
// P2-7：下载进度事件声明（cordis Events 合并面）。
import type {} from '@corum/corum-api-remotes/corum-events'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { GpuInfo, LocalEngineStatus, LocalChatArgs, LocalChatResult, RecommendedModel, PulledModel, OnlineModelTag } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    localLlm: LocalLlmService
  }
}

/** Ollama 默认端点。 */
const OLLAMA_BASE = 'http://127.0.0.1:11434'
/** 默认润色模型（最小够用：实测 0.8b 无润色能力、2b 是甜点——中文改写稳、2.7 GB、Apple Silicon 速度快）。 */
export const DEFAULT_LOCAL_MODEL = 'qwen3.5:2b'
/** 本地部署最低物理内存门槛（GB）。 */
export const MIN_MEMORY_GB = 16
/** status 探测超时（ms）。 */
const PROBE_TIMEOUT_MS = 2500
/** GPU 检测命令超时（ms；避免卡住）。 */
const GPU_DETECT_TIMEOUT_MS = 5000
/** chat 调用超时（ms；本地小模型 + 小 ctx 通常 < 60s，留足冷启动余量）。 */
const CHAT_TIMEOUT_MS = 180_000
/** 最大同时激活（加载到内存）模型数。 */
const MAX_ACTIVE_MODELS = 2
/** 模型加载超时（ms；大模型冷启动需要时间）。 */
const LOAD_TIMEOUT_MS = 120_000
/** Ollama 二进制下载超时（ms；~150MB，给 5 分钟）。 */
const DOWNLOAD_TIMEOUT_MS = 300_000

/**
 * Ollama 官方下载地址（按平台+架构）。
 * 来源：https://github.com/ollama/ollama/releases
 * 国内加速：通过 gh-proxy.com 镜像转发 GitHub 下载。
 */
function ollamaDownloadUrl(): string {
  const platform = process.platform
  const arch = process.arch // 'arm64' | 'x64'
  // GitHub 原始 URL
  let ghUrl: string
  if (platform === 'darwin') ghUrl = 'https://github.com/ollama/ollama/releases/latest/download/Ollama-darwin.tgz'
  else if (platform === 'linux' && arch === 'arm64') ghUrl = 'https://github.com/ollama/ollama/releases/latest/download/Ollama-linux-arm64.tgz'
  else if (platform === 'linux' && arch === 'x64') ghUrl = 'https://github.com/ollama/ollama/releases/latest/download/Ollama-linux-amd64.tgz'
  else if (platform === 'win32' && arch === 'x64') ghUrl = 'https://github.com/ollama/ollama/releases/latest/download/Ollama-windows-amd64.zip'
  else throw new Error(`不支持的平台：${platform}-${arch}`)
  // 国内加速：先试 gh-proxy.com 镜像，失败则直连 GitHub。
  return `https://gh-proxy.com/${ghUrl}`
}

/** CORUM_HOME 解析（与 desktop shell 一致：env > ~/.corum-dev-home > ~/.corum）。 */
function getCorumHome(): string {
  const env = process.env.CORUM_HOME
  if (env !== undefined && env !== '') return env
  return join(homedir(), '.corum-dev-home')
}

/** 内置 Ollama 二进制路径（CORUM_HOME/bin/ollama 或 .exe）。 */
function getBundledOllamaPath(): string {
  const binDir = join(getCorumHome(), 'bin')
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama'
  return join(binDir, exe)
}

/** 检查内置二进制是否存在。 */
function isBundled(): boolean {
  try { return existsSync(getBundledOllamaPath()) } catch { return false }
}

/**
 * 解析 Ollama 可执行文件路径：优先内置，fallback 到 PATH。
 * @returns 二进制路径（内置有则返回绝对路径，否则返回 'ollama' 让 PATH 解析）。
 */
function resolveOllamaBin(): string {
  const bundled = getBundledOllamaPath()
  if (existsSync(bundled)) {
    try { statSync(bundled) } catch { /* stat 失败继续 */ }
    return bundled
  }
  return 'ollama'
}

/**
 * 推荐模型精选列表（含 VRAM 需求，Q4_K_M 默认量化；优先最新 + MoE 架构）。
 * 分三档：low（8-16GB 内存 / 2-6GB VRAM）/ mid（16-32GB / 8-12GB）/ high（24GB+ / 16GB+）。
 */
const RECOMMENDED_MODELS: RecommendedModel[] = [
  // ── 低配档（8-16 GB 内存，2-6 GB VRAM）──────────────────────────
  { id: 'qwen3.5:0.8b', name: 'Qwen3.5 0.8B', size: '1.0 GB', description: '最新多模态，极轻量润色/快速响应首选', tags: ['最新', '多模态', '极轻量'], minMemoryGb: 8, vramGb: 1.5, cpuOnly: true, tier: 'low', isMoE: false, quantization: 'Q4_K_M' },
  { id: 'qwen3.5:2b', name: 'Qwen3.5 2B', size: '2.7 GB', description: '最新多模态，中文润色甜点模型', tags: ['最新', '多模态', '中文'], minMemoryGb: 8, vramGb: 3, cpuOnly: true, tier: 'low', isMoE: false, quantization: 'Q4_K_M' },
  { id: 'qwen3.5:4b', name: 'Qwen3.5 4B', size: '3.4 GB', description: '最新多模态，轻量高质量，低配首选', tags: ['最新', '多模态', '轻量'], minMemoryGb: 8, vramGb: 4, cpuOnly: true, tier: 'low', isMoE: false, quantization: 'Q4_K_M' },
  { id: 'gemma4:e2b', name: 'Gemma 4 E2B', size: '7.2 GB', description: 'Google 最新边缘模型，text+image+audio，设备端优化', tags: ['最新', '多模态', '边缘'], minMemoryGb: 8, vramGb: 5, cpuOnly: true, tier: 'low', isMoE: false, quantization: 'Q4_K_M' },
  { id: 'mistral-nemo', name: 'Mistral Nemo 12B', size: '约 7 GB', description: 'Mistral×NVIDIA 合作，128K 上下文，多语言强', tags: ['128K', '多语言'], minMemoryGb: 8, vramGb: 6, cpuOnly: true, tier: 'low', isMoE: false, quantization: 'Q4_K_M' },
  // ── 中配档（16-32 GB 内存，8-12 GB VRAM）────────────────────────
  { id: 'qwen3.5:9b', name: 'Qwen3.5 9B', size: '6.6 GB', description: '最新多模态，中等质量全面，支持 vision + tools', tags: ['最新', '多模态', 'vision'], minMemoryGb: 16, vramGb: 8, cpuOnly: true, tier: 'mid', isMoE: false, quantization: 'Q4_K_M' },
  { id: 'gemma4:12b', name: 'Gemma 4 12B', size: '7.6 GB', description: 'Google 最新，reasoning + coding + agentic + vision，256K 上下文', tags: ['最新', 'reasoning', '256K'], minMemoryGb: 16, vramGb: 9, cpuOnly: true, tier: 'mid', isMoE: false, quantization: 'Q4_K_M' },
  { id: 'mistral-small3.1', name: 'Mistral Small 3.1 24B', size: '约 14 GB', description: 'Mistral 24B，vision + tools + 128K 上下文，企业级', tags: ['vision', 'tools', '128K'], minMemoryGb: 16, vramGb: 12, cpuOnly: true, tier: 'mid', isMoE: false, quantization: 'Q4_K_M' },
  // ── 高配档（24GB+ 内存，16GB+ VRAM）────────────────────────────
  { id: 'qwen3.8:27b', name: 'Qwen3.8 27B', size: '18 GB', description: '最新旗舰！coding/research/agentic 全面提升，vision-language', tags: ['最新旗舰', 'vision', 'agentic'], minMemoryGb: 24, vramGb: 20, cpuOnly: true, tier: 'high', isMoE: false, quantization: 'Q4_K_M' },
  { id: 'gemma4:26b', name: 'Gemma 4 26B (MoE)', size: '19 GB', description: 'Google 最新 MoE！25.2B 总参 / 3.8B 活跃，reasoning 顶级', tags: ['最新', 'MoE', 'reasoning'], minMemoryGb: 24, vramGb: 21, cpuOnly: true, tier: 'high', isMoE: true, quantization: 'Q4_K_M' },
  { id: 'qwen3.6:35b', name: 'Qwen3.6 35B (MoE)', size: '23 GB', description: 'agentic coding 专项提升 + thinking preservation', tags: ['最新', 'MoE', 'coding'], minMemoryGb: 32, vramGb: 24, cpuOnly: true, tier: 'high', isMoE: true, quantization: 'Q4_K_M' },
]

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }>
}

/** Ollama GET /api/ps 返回（当前加载到内存的模型）。 */
interface OllamaPsResponse {
  models?: Array<{ name?: string; model?: string; size?: number; size_vram?: number; digest?: string; expires_at?: string }>
}

/** Ollama /api/show 返回结构（部分字段）。 */
interface OllamaShowResponse {
  details?: { parent_model?: string; format?: string; family?: string; families?: string[]; parameter_size?: string; quantization_level?: string }
  capabilities?: string[]
  model_info?: Record<string, unknown>
}

/** 从 model_info 中提取上下文长度（不同模型族 key 不同，如 gemma4.context_length / llama.context_length）。 */
function findContextLength(modelInfo?: Record<string, unknown>): number | undefined {
  if (modelInfo === undefined) return undefined
  for (const [key, val] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof val === 'number') return val
  }
  return undefined
}
/** 执行命令并返回 stdout（超时静默返回空字符串）。 */
function execCmd(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    try {
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs })
      let out = ''
      proc.stdout.on('data', d => { out += d.toString() })
      proc.on('close', () => resolve(out.trim()))
      proc.on('error', () => resolve(''))
      // 兜底超时杀进程（spawn timeout 在某些平台不可靠）。
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* 已退出 */ } }, timeoutMs + 500)
    } catch {
      resolve('')
    }
  })
}

/** 字节数 → 人类可读大小（如 2934003212 → '2.7 GB'）。 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[i]}`
}

/** 从 Ollama tag 名推断量化等级和参数量。
 * 如 '27b-q4_K_M' → { quantization: 'Q4_K_M', paramSize: '27B' }
 * 如 '35b-a3b-mlx-bf16' → { quantization: 'BF16', paramSize: '35B-A3B' }
 */
function parseTag(tag: string): { quantization: string; paramSize: string } {
  const lower = tag.toLowerCase()
  // 量化等级关键词（按优先级匹配）。
  const quantMap: Record<string, string> = {
    'q4_k_m': 'Q4_K_M',
    'q4_k_s': 'Q4_K_S',
    'q4_0': 'Q4_0',
    'q5_k_m': 'Q5_K_M',
    'q5_k_s': 'Q5_K_S',
    'q5_0': 'Q5_0',
    'q6_k': 'Q6_K',
    'q8_0': 'Q8_0',
    'q3_k_m': 'Q3_K_M',
    'q3_k_s': 'Q3_K_S',
    'q2_k': 'Q2_K',
    'bf16': 'BF16',
    'fp16': 'FP16',
    'f16': 'FP16',
    'mxfp4': 'MXFP4',
    'mxfp8': 'MXFP8',
    'nvfp4': 'NVFP4',
    'int4': 'INT4',
    'int8': 'INT8',
    'mlx-bf16': 'BF16 (MLX)',
    'mlx': 'MLX',
    'mtp': 'MTP',
  }
  let quantization = '默认'
  for (const [key, val] of Object.entries(quantMap)) {
    if (lower.includes(key)) { quantization = val; break }
  }
  // 参数量：取 tag 开头的参数标识（如 '27b'、'35b-a3b'、'0.8b'）。
  const sizeMatch = tag.match(/^(\d+\.?\d*b(?:-a\d+b)?)/i)
  const paramSize = sizeMatch ? sizeMatch[1].toUpperCase() : tag === 'latest' ? '默认' : '-'
  return { quantization, paramSize }
}

export class LocalLlmService extends TypertRemoteService {
  static inject: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'localLlm')
  }

  /** 物理内存（GB，四舍五入）。 */
  private memoryGb(): number {
    return Math.round(totalmem() / 1073741824)
  }

  /** CPU 逻辑核心数。 */
  private cpuCores(): number {
    try { return cpus().length } catch { return 0 }
  }

  /** 探测 Ollama 服务是否可达（GET /api/version，短超时）。 */
  private async probeRunning(): Promise<{ ok: boolean; version?: string }> {
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!r.ok) return { ok: false }
      const j = (await r.json()) as { version?: string }
      return { ok: true, ...(j.version !== undefined ? { version: j.version } : {}) }
    } catch {
      return { ok: false }
    }
  }

  /** 列出已拉取模型（合并 GET /api/tags + GET /api/ps，标注激活状态和 VRAM 占用）。 */
  private async listPulledModels(): Promise<PulledModel[]> {
    try {
      // /api/tags 和 /api/ps 并行请求。
      const [tagsRes, psRes] = await Promise.allSettled([
        fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
        fetch(`${OLLAMA_BASE}/api/ps`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
      ])
      if (tagsRes.status !== 'fulfilled' || !tagsRes.value.ok) return []
      const j = (await tagsRes.value.json()) as OllamaTagsResponse
      // 解析 /api/ps 已激活模型 → name → size_vram 映射。
      const activeMap = new Map<string, number>()
      if (psRes.status === 'fulfilled' && psRes.value.ok) {
        try {
          const ps = (await psRes.value.json()) as OllamaPsResponse
          for (const m of ps.models ?? []) {
            const name = m.name ?? m.model ?? ''
            if (name !== '') activeMap.set(name, m.size_vram ?? 0)
          }
        } catch { /* /api/ps 解析失败不影响主流程 */ }
      }
      // 对每个模型并行调 /api/show 获取详细信息（上下文长度、参数量、架构族、能力）。
      const models = (j.models ?? []).map(m => m.name ?? m.model ?? '').filter(n => n !== '')
      const details = await Promise.all(models.map(async (name) => {
        try {
          const sr = await fetch(`${OLLAMA_BASE}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          })
          if (!sr.ok) return null
          const sj = (await sr.json()) as OllamaShowResponse
          const ctxLen = findContextLength(sj.model_info)
          return {
            paramSize: sj.details?.parameter_size,
            family: sj.details?.family ?? sj.details?.families?.[0],
            contextLength: ctxLen,
            capabilities: sj.capabilities,
          }
        } catch { return null }
      }))

      return models.map((name, i) => {
        const tagModel = (j.models ?? []).find(m => (m.name ?? m.model ?? '') === name)
        const sizeBytes = tagModel?.size ?? 0
        const quant = tagModel?.details?.quantization_level
        const vramBytes = activeMap.get(name)
        const d = details[i]
        return {
          name,
          size: formatBytes(sizeBytes),
          sizeBytes,
          ...(quant !== undefined && quant !== '' ? { quantization: quant } : {}),
          ...(vramBytes !== undefined ? { active: true, vramBytes } : {}),
          ...(d?.paramSize !== undefined ? { paramSize: d.paramSize } : {}),
          ...(d?.family !== undefined ? { family: d.family } : {}),
          ...(d?.contextLength !== undefined ? { contextLength: d.contextLength } : {}),
          ...(d?.capabilities !== undefined && d.capabilities.length > 0 ? { capabilities: d.capabilities } : {}),
        }
      })
    } catch {
      return []
    }
  }

  /** 探测 Ollama 是否已安装（内置二进制 或 PATH）。 */
  private async detectInstalled(): Promise<boolean> {
    // 先检查内置二进制
    if (isBundled()) return true
    // 再检查 PATH
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      const proc = spawn(cmd, ['ollama'], { stdio: 'ignore' })
      return await new Promise<boolean>(resolve => {
        proc.on('close', code => resolve(code === 0))
        proc.on('error', () => resolve(false))
      })
    } catch {
      return false
    }
  }

  // ── GPU 检测（跨平台）──────────────────────────────────────────────

  /** 检测 GPU（跨平台调度）。检测失败返回 null。 */
  private async detectGpu(): Promise<GpuInfo | null> {
    const platform = process.platform
    if (platform === 'darwin') return this.detectGpuMac()
    if (platform === 'linux') return this.detectGpuLinux()
    if (platform === 'win32') return this.detectGpuWindows()
    return null
  }

  /** macOS GPU 检测：system_profiler SPDisplaysDataType -json。 */
  private async detectGpuMac(): Promise<GpuInfo | null> {
    const out = await execCmd('system_profiler', ['SPDisplaysDataType', '-json'], GPU_DETECT_TIMEOUT_MS)
    if (out === '') return null
    try {
      const j = JSON.parse(out) as { SPDisplaysDataType?: Array<{ sppci_model?: string; spdisplays_vram?: string; spdisplays_vendor?: string; spdisplays_metal_support?: string }> }
      const gpu = j.SPDisplaysDataType?.[0]
      if (gpu === undefined) return null
      const model = gpu.sppci_model ?? 'Unknown GPU'
      // Apple Silicon：统一内存架构，VRAM = 总内存（Ollama 按需分配，不固定占用）。
      const isAppleSilicon = /Apple\s+(M\d|Silicon)/i.test(model) || (gpu.spdisplays_metal_support !== undefined && gpu.spdisplays_vram === undefined)
      if (isAppleSilicon) {
        return { name: model, vramGb: this.memoryGb(), vendor: 'apple-metal' }
      }
      // Intel Mac 独立 GPU：解析 VRAM 字段（如 "4 GB"）。
      const vramMatch = gpu.spdisplays_vram?.match(/(\d+)\s*GB/i)
      const vramGb = vramMatch ? parseInt(vramMatch[1], 10) : 0
      if (vramGb > 0) {
        const vendor = /AMD|ATI/i.test(gpu.spdisplays_vendor ?? '') ? 'amd' : 'intel'
        return { name: model, vramGb, vendor: vendor as GpuInfo['vendor'] }
      }
      return null
    } catch {
      return null
    }
  }

  /** Linux GPU 检测：nvidia-smi → rocm-smi 逐级探测。 */
  private async detectGpuLinux(): Promise<GpuInfo | null> {
    // NVIDIA
    const nvidiaOut = await execCmd('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], GPU_DETECT_TIMEOUT_MS)
    if (nvidiaOut !== '') {
      const parts = nvidiaOut.split(',').map(s => s.trim())
      if (parts.length >= 2) {
        const name = parts[0]
        const vramMb = parseInt(parts[1], 10)
        if (!isNaN(vramMb) && vramMb > 0) {
          return { name, vramGb: Math.round(vramMb / 1024), vendor: 'nvidia' }
        }
      }
    }
    // AMD ROCm
    const rocmOut = await execCmd('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json'], GPU_DETECT_TIMEOUT_MS)
    if (rocmOut !== '') {
      try {
        const j = JSON.parse(rocmOut) as Record<string, { 'Card series'?: string; 'Card model'?: string; 'VRAM Total Memory (B)'?: string }>
        const cards = Object.values(j)
        const card = cards.find(c => c['VRAM Total Memory (B)'] !== undefined)
        if (card) {
          const vramBytes = parseInt(card['VRAM Total Memory (B)'] ?? '0', 10)
          const name = card['Card series'] ?? card['Card model'] ?? 'AMD GPU'
          if (vramBytes > 0) {
            return { name, vramGb: Math.round(vramBytes / 1073741824), vendor: 'amd' }
          }
        }
      } catch { /* 静默 */ }
    }
    return null
  }

  /** Windows GPU 检测：nvidia-smi → wmic 逐级探测。 */
  private async detectGpuWindows(): Promise<GpuInfo | null> {
    // NVIDIA
    const nvidiaOut = await execCmd('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], GPU_DETECT_TIMEOUT_MS)
    if (nvidiaOut !== '') {
      const parts = nvidiaOut.split(',').map(s => s.trim())
      if (parts.length >= 2) {
        const name = parts[0]
        const vramMb = parseInt(parts[1], 10)
        if (!isNaN(vramMb) && vramMb > 0) {
          return { name, vramGb: Math.round(vramMb / 1024), vendor: 'nvidia' }
        }
      }
    }
    // wmic 兜底（AMD/Intel 集成显卡，VRAM 从 AdapterRAM 读，单位 bytes）
    const wmicOut = await execCmd('wmic', ['path', 'win32_VideoController', 'get', 'name,AdapterRAM', '/format:csv'], GPU_DETECT_TIMEOUT_MS)
    if (wmicOut !== '') {
      const lines = wmicOut.split('\n').filter(l => l.trim() !== '' && !l.startsWith('Node,'))
      for (const line of lines) {
        const parts = line.split(',').map(s => s.trim())
        if (parts.length >= 2) {
          const name = parts[1]
          const adapterRam = parseInt(parts[0], 10)
          if (name !== '' && adapterRam > 0) {
            const vramGb = Math.max(1, Math.round(adapterRam / 1073741824))
            const vendor = /AMD|ATI|Radeon/i.test(name) ? 'amd' : /Intel/i.test(name) ? 'intel' : 'nvidia'
            return { name, vramGb, vendor: vendor as GpuInfo['vendor'] }
          }
        }
      }
    }
    return null
  }

  // ── RPC 方法 ─────────────────────────────────────────────────────

  /** 汇总引擎状态（含硬件信息 + 激活模型数）。 */
  @Remote('status')
  async status(): Promise<LocalEngineStatus> {
    const totalMemGb = this.memoryGb()
    const [installed, running, gpu] = await Promise.all([
      this.detectInstalled(),
      this.probeRunning(),
      this.detectGpu(),
    ])
    const models = running.ok ? await this.listPulledModels() : []
    const activeModelCount = models.filter(m => m.active === true).length
    return {
      installed,
      running: running.ok,
      totalMemGb,
      meetsMinMem: totalMemGb >= MIN_MEMORY_GB,
      modelPulled: models.some(m => m.name === DEFAULT_LOCAL_MODEL || m.name.startsWith(`${DEFAULT_LOCAL_MODEL.split(':')[0]}:`)),
      models,
      platform: process.platform,
      cpuCores: this.cpuCores(),
      gpu,
      gpuEnabled: gpu !== null && running.ok,
      activeModelCount,
      maxActiveModels: MAX_ACTIVE_MODELS,
      engineBundled: isBundled(),
      ...(running.version !== undefined ? { version: running.version } : {}),
    }
  }

  /** 仅探测本机内存是否达标（插件未装时也可调，供设置页「安装」按钮的前置门槛判定）。 */
  @Remote('probe')
  probe(): { totalMemGb: number; meetsMinMem: boolean } {
    const totalMemGb = this.memoryGb()
    return { totalMemGb, meetsMinMem: totalMemGb >= MIN_MEMORY_GB }
  }

  /** 返回推荐模型精选列表（供设置页展示，无需联网）。 */
  @Remote('listRecommendedModels')
  async listRecommendedModels(): Promise<RecommendedModel[]> {
    return RECOMMENDED_MODELS
  }

  /**
   * 搜索 Ollama 线上目录（ollama.com/library/<query>/tags），返回所有可用 tag。
   * 用户输入模型名（如 'qwen3.8'），返回该模型的所有量化版本 + 参数量。
   */
  @Remote('searchOnlineModels')
  async searchOnlineModels(query: string): Promise<{ results: OnlineModelTag[]; error?: string }> {
    const name = query.trim().toLowerCase()
    if (name === '') return { results: [] }
    try {
      const r = await fetch(`https://ollama.com/library/${encodeURIComponent(name)}/tags`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': 'application/json' },
      })
      if (r.status === 404) return { results: [], error: `未找到模型「${name}」。请检查名称（如 qwen3.8、gemma4、mistral-nemo）。` }
      if (!r.ok) return { results: [], error: `查询失败（HTTP ${r.status}）` }
      const j = (await r.json()) as { tags?: string[] }
      const tags = j.tags ?? []
      const results: OnlineModelTag[] = tags.map(tag => ({
        fullName: `${name}:${tag}`,
        tag,
        ...parseTag(tag),
      }))
      return { results }
    } catch (e) {
      return { results: [], error: `搜索失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** 启动 Ollama 服务（已跑则直接返回）。优先用内置二进制。 */
  @Remote('ensureServer')
  async ensureServer(): Promise<{ ok: boolean; error?: string }> {
    const running = await this.probeRunning()
    if (running.ok) return { ok: true }
    const bin = resolveOllamaBin()
    const installed = bin !== 'ollama' ? true : await this.detectInstalled()
    if (!installed) return { ok: false, error: '未安装 Ollama。请在设置页点击「下载引擎」自动安装，或手动安装 https://ollama.com' }
    try {
      const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore' })
      child.unref()
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 400))
        if ((await this.probeRunning()).ok) return { ok: true }
      }
      return { ok: false, error: 'Ollama 服务启动超时。可手动运行 `ollama serve` 后重试。' }
    } catch (e) {
      return { ok: false, error: `启动 Ollama 失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /**
   * 下载 Ollama 引擎二进制到 CORUM_HOME/bin/。
   * 下载完成后自动启动服务。下载进度可通过 getDownloadProgress 轮询。
   */
  private downloadProgress: { percent: number; downloadedBytes: number; totalBytes: number; status: 'idle' | 'downloading' | 'done' | 'error'; error?: string } = { percent: 0, downloadedBytes: 0, totalBytes: 0, status: 'idle' }

  /**
   * P2-7：写下载进度并推送 `corum/ollama/download-progress`（取代设置页 500ms
   * 轮询 getDownloadProgress）。所有进度写入都经本方法，保证帧与槽状态一致。
   */
  private setDownloadProgress(next: typeof this.downloadProgress): void {
    this.downloadProgress = next
    this.ctx.emit('corum/ollama/download-progress', {
      percent: next.percent,
      downloadedBytes: next.downloadedBytes,
      totalBytes: next.totalBytes,
      status: next.status,
      ...(next.error !== undefined ? { error: next.error } : {}),
    })
  }

  @Remote('getDownloadProgress')
  getDownloadProgress(): { percent: number; downloadedBytes: number; totalBytes: number; status: string; error?: string } {
    return { ...this.downloadProgress }
  }

  @Remote('downloadEngine')
  async downloadEngine(): Promise<{ ok: boolean; error?: string }> {
    if (isBundled()) return { ok: true } // 已下载
    const binDir = join(getCorumHome(), 'bin')
    const exeName = process.platform === 'win32' ? 'ollama.exe' : 'ollama'
    const destPath = join(binDir, exeName)
    try { mkdirSync(binDir, { recursive: true }) } catch { /* 已存在 */ }
    // 立即标记为 downloading（让前端轮询能看到状态变化）
    this.setDownloadProgress({ percent: 0, downloadedBytes: 0, totalBytes: 0, status: 'downloading' })
    try {
      const url = ollamaDownloadUrl()
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!r.ok) { this.downloadProgress = { ...this.downloadProgress, status: 'error', error: `HTTP ${r.status}` }; return { ok: false, error: `下载失败（HTTP ${r.status}）` }
      }
      if (!r.body) return { ok: false, error: '下载返回空响应体' }
      // 从 Content-Length 获取总大小
      const totalBytes = parseInt(r.headers.get('content-length') ?? '0', 10)
      this.setDownloadProgress({ percent: 0, downloadedBytes: 0, totalBytes, status: 'downloading' })
      // 流式写入临时文件 → 重命名为最终文件名（原子操作）
      const tmpPath = join(binDir, `${exeName}.tmp`)
      const fileStream = (await import('node:fs')).createWriteStream(tmpPath)
      const reader = r.body.getReader()
      let downloaded = 0
      // pump: ReadableStream → Node WriteStream，更新进度
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!fileStream.write(Buffer.from(value))) {
          await new Promise<void>(resolve => fileStream.once('drain', () => resolve()))
        }
        downloaded += value.byteLength
        const percent = totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0
        this.setDownloadProgress({ percent, downloadedBytes: downloaded, totalBytes, status: 'downloading' })
      }
      fileStream.end()
      await new Promise<void>(resolve => fileStream.on('finish', () => resolve()))
      // macOS/Linux 加可执行权限
      if (process.platform !== 'win32') {
        try { (await import('node:fs')).chmodSync(tmpPath, 0o755) } catch { /* 忽略 */ }
      }
      renameSync(tmpPath, destPath)
      // macOS/Linux：下载的是 .tgz 压缩包，需解压提取 ollama 二进制。
      if (process.platform !== 'win32') {
        try {
          // 解压到临时目录，找到 ollama 二进制后移动到最终位置。
          const extractDir = join(binDir, `${exeName}-extract`)
          try { mkdirSync(extractDir, { recursive: true }) } catch { /* 已存在 */ }
          execSync(`tar xzf "${destPath}" -C "${extractDir}"`, { timeout: 30_000 })
          // 查找解压后的 ollama 可执行文件
          const findResult = execSync(`find "${extractDir}" -name "ollama" -type f | head -1`, { encoding: 'utf-8' }).trim()
          if (findResult !== '') {
            rmSync(destPath, { force: true })
            renameSync(findResult, destPath)
            try { (await import('node:fs')).chmodSync(destPath, 0o755) } catch { /* 忽略 */ }
          }
          // 清理解压临时目录
          try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
        } catch (extractErr) {
          // 解压失败：可能已经是裸二进制（直接用），或 tar 不可用
          try { (await import('node:fs')).chmodSync(destPath, 0o755) } catch { /* 忽略 */ }
        }
      }
      this.setDownloadProgress({ percent: 100, downloadedBytes: downloaded, totalBytes: totalBytes > 0 ? totalBytes : downloaded, status: 'done' })
      // 启动服务
      const startResult = await this.ensureServer()
      if (!startResult.ok) return { ok: false, error: `下载成功但启动失败：${startResult.error ?? '未知错误'}` }
      return { ok: true }
    } catch (e) {
      this.setDownloadProgress({ ...this.downloadProgress, status: 'error', error: e instanceof Error ? e.message : String(e) })
      return { ok: false, error: `下载引擎失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** 拉取模型（首次部署引导；ollama pull，流式等待完成）。 */
  @Remote('pullModel')
  async pullModel(model?: string): Promise<{ ok: boolean; error?: string }> {
    const name = model !== undefined && model.trim() !== '' ? model.trim() : DEFAULT_LOCAL_MODEL
    const ensured = await this.ensureServer()
    if (!ensured.ok) return { ok: false, error: ensured.error ?? 'Ollama 服务不可用' }
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, stream: false }),
        signal: AbortSignal.timeout(30 * 60_000),
      })
      if (!r.ok) return { ok: false, error: `拉取失败（HTTP ${r.status}）：${await r.text()}` }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `拉取模型失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** 删除已拉取模型（DELETE /api/delete，释放磁盘空间）。 */
  @Remote('deleteModel')
  async deleteModel(model: string): Promise<{ ok: boolean; error?: string }> {
    const name = model.trim()
    if (name === '') return { ok: false, error: '模型名不能为空' }
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!r.ok) return { ok: false, error: `删除失败（HTTP ${r.status}）：${await r.text()}` }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `删除模型失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** 查询当前已激活（加载到内存）的模型名列表（GET /api/ps）。 */
  private async listActiveModels(): Promise<string[]> {
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/ps`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!r.ok) return []
      const j = (await r.json()) as OllamaPsResponse
      return (j.models ?? [])
        .map(m => m.name ?? m.model ?? '')
        .filter(n => n !== '')
    } catch {
      return []
    }
  }

  /**
   * 激活模型（加载到内存，可运行推理）。
   * 限制：最多同时激活 MAX_ACTIVE_MODELS 个；资源不足（内存/VRAM）则拒绝。
   */
  @Remote('activateModel')
  async activateModel(model: string): Promise<{ ok: boolean; error?: string }> {
    const name = model.trim()
    if (name === '') return { ok: false, error: '模型名不能为空' }
    const ensured = await this.ensureServer()
    if (!ensured.ok) return { ok: false, error: ensured.error ?? 'Ollama 服务不可用' }

    // 1. 检查当前已激活数量（已激活同名模型则直接返回成功）。
    const active = await this.listActiveModels()
    if (active.includes(name)) return { ok: true }
    if (active.length >= MAX_ACTIVE_MODELS) {
      return { ok: false, error: `最多同时激活 ${MAX_ACTIVE_MODELS} 个模型，请先卸载其他模型` }
    }

    // 2. 资源检查：仅对推荐列表内的模型做硬门槛（用户自行部署的模型交给 Ollama
    //    自己判定——它的加载错误信息比我们的静态表更准，且不拦合理的自定义模型）。
    const rec = RECOMMENDED_MODELS.find(r => r.id === name)
    if (rec !== undefined) {
      const totalMemGb = this.memoryGb()
      if (totalMemGb < rec.minMemoryGb) {
        return { ok: false, error: `资源不足：内存 ${totalMemGb} GB < 模型要求 ${rec.minMemoryGb} GB` }
      }
      const gpu = await this.detectGpu()
      if (gpu === null) {
        // 无独立 GPU：仅当模型要求 VRAM > 0 且不支持纯 CPU 时拒绝（当前所有模型 cpuOnly=true，故不拦）。
        if (rec.vramGb > 0 && !rec.cpuOnly) {
          return { ok: false, error: `资源不足：无独立 GPU，模型要求 ${rec.vramGb} GB VRAM` }
        }
      } else if (gpu.vramGb < rec.vramGb) {
        return { ok: false, error: `资源不足：VRAM ${gpu.vramGb} GB < 模型要求 ${rec.vramGb} GB` }
      }
    }

    // 3. POST /api/generate 发空推理请求触发加载（keep_alive=-1 常驻）。
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, prompt: '', stream: false, keep_alive: -1 }),
        signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
      })
      if (!r.ok) return { ok: false, error: `激活失败（HTTP ${r.status}）：${await r.text()}` }
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('timeout') || msg.includes('Timeout') || msg.includes('aborted')) {
        return { ok: false, error: `模型加载超时（${LOAD_TIMEOUT_MS / 1000}s）` }
      }
      return { ok: false, error: `激活模型失败：${msg}` }
    }
  }

  /**
   * 卸载模型（从内存移除，释放 VRAM）。
   * Ollama 无 REST API 卸载内存模型，用 CLI `ollama stop <model>` 实现。
   */
  @Remote('deactivateModel')
  async deactivateModel(model: string): Promise<{ ok: boolean; error?: string }> {
    const name = model.trim()
    if (name === '') return { ok: false, error: '模型名不能为空' }
    const ensured = await this.ensureServer()
    if (!ensured.ok) return { ok: false, error: ensured.error ?? 'Ollama 服务不可用' }

    try {
      // 用与 ensureServer 一致的二进制解析（内置优先，fallback PATH），
      // 避免只装了内置引擎时 spawn 'ollama' 找不到命令。
      const bin = resolveOllamaBin()
      const result = await new Promise<{ code: number; stderr: string }>(resolve => {
        const proc = spawn(bin, ['stop', name], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        proc.stderr?.on('data', d => { stderr += d.toString() })
        proc.on('close', code => resolve({ code: code ?? -1, stderr: stderr.trim() }))
        proc.on('error', err => resolve({ code: -1, stderr: err.message }))
        // 兜底超时。
        setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* 已退出 */ } }, 15_000)
      })
      if (result.code === 0) return { ok: true }
      return { ok: false, error: `卸载失败（exit ${result.code}）${result.stderr !== '' ? `：${result.stderr}` : ''}` }
    } catch (e) {
      return { ok: false, error: `卸载模型失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /**
   * 本地 chat 推理（OpenAI 兼容 /v1/chat/completions）。
   * keep_alive=-1 常驻模型消冷启动；小 num_ctx 抑制本地推理冗长思考。
   */
  @Remote('chat')
  async chat(args: LocalChatArgs): Promise<LocalChatResult> {
    const model = args.model.trim() === '' ? DEFAULT_LOCAL_MODEL : args.model.trim()
    const ensured = await this.ensureServer()
    if (!ensured.ok) throw new Error(ensured.error !== undefined ? ensured.error : 'Ollama 服务不可用')
    const started = Date.now()
    const r = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: args.prompt }],
        temperature: args.temperature ?? 0.2,
        stream: false,
        keep_alive: -1,
        options: {
          num_ctx: args.numCtx ?? 2048,
          num_predict: args.numPredict ?? 512,
        },
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    })
    if (!r.ok) throw new Error(`本地模型推理失败（HTTP ${r.status}）：${await r.text()}`)
    const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = j.choices?.[0]?.message?.content?.trim() ?? ''
    if (text === '') throw new Error('本地模型返回为空')
    return { text, durationMs: Date.now() - started }
  }
}
