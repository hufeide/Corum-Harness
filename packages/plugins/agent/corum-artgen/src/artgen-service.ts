/**
 * ArtGenService — corum 本地文生图服务。
 *
 * 探测/管理本机 stable-diffusion.cpp 推理引擎（sd-cli 单体二进制），
 * 为 AI 文生图任务提供本地推理：
 *   - status：探测 sd-cli 是否已下载 + 列出本地模型；
 *   - downloadEngine：下载 sd-cli 预编译二进制（GitHub releases，三平台）；
 *   - getDownloadProgress：轮询下载进度；
 *   - txt2img：执行文生图（spawn sd-cli，解析 stdout 进度，返回 base64）；
 *   - listModels：列出本地模型文件；
 *   - downloadModel：下载推荐 SD 模型（HuggingFace，国内镜像加速）。
 *
 * 引擎：stable-diffusion.cpp（leejet 版），纯 C/C++ 单体二进制。
 * 三平台预编译 releases：
 *   - macOS ARM64: sd-master-*-bin-Darwin-*-arm64.zip
 *   - Linux x64:   sd-master-*-bin-Linux-*-x86_64.zip
 *   - Windows x64: sd-master-*-win-cpu-x64.zip
 *
 * @module @corum/corum-artgen/artgen-service
 */

import { spawn, execSync } from 'node:child_process'
import { homedir, totalmem, cpus } from 'node:os'
import { existsSync, mkdirSync, renameSync, statSync, rmSync, readdirSync, readFileSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { ArtGenStatus, SdModel, Txt2ImgArgs, Txt2ImgResult, Txt2ImgJob, GpuInfo, RecommendedSdModel, OnlineSdModel } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    corumArtGen: ArtGenService
  }
}

/** 生成超时（ms；5 分钟，大图生成需要时间）。 */
const GEN_TIMEOUT_MS = 300_000
/** 下载超时（ms；sd-cli ~47MB，模型 ~2GB，给 5 分钟）。 */
const DOWNLOAD_TIMEOUT_MS = 300_000
/** GitHub API 请求超时（ms）。 */
const API_TIMEOUT_MS = 15_000
/** 本地文生图最低物理内存门槛（GB）。SD 1.5 推理需要 ~4GB，留余量定 8GB。 */
const MIN_MEMORY_GB = 8
/** GPU 检测命令超时（ms）。 */
const GPU_DETECT_TIMEOUT_MS = 5000

/** CORUM_HOME 解析（与 desktop shell 一致：env > ~/.corum-dev-home）。 */
function getCorumHome(): string {
  const env = process.env.CORUM_HOME
  if (env !== undefined && env !== '') return env
  return join(homedir(), '.corum-dev-home')
}

/** SD 模型目录。 */
const SD_MODELS_DIR = join(getCorumHome(), 'engines', 'sd-models')
/** sd-cli 二进制目录。 */
const SD_BIN_DIR = join(getCorumHome(), 'bin')

/** 平台对应的 sd-cli 可执行文件名。 */
function getSdCliExeName(): string {
  return process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'
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
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* 已退出 */ } }, timeoutMs + 500)
    } catch { resolve('') }
  })
}

/** GPU 检测（跨平台）。检测失败返回 null。 */
async function detectGpu(): Promise<GpuInfo | null> {
  const platform = process.platform
  if (platform === 'darwin') {
    const out = await execCmd('system_profiler', ['SPDisplaysDataType', '-json'], GPU_DETECT_TIMEOUT_MS)
    if (out === '') return null
    try {
      const j = JSON.parse(out) as { SPDisplaysDataType?: Array<{ sppci_model?: string; spdisplays_vram?: string; spdisplays_vendor?: string; spdisplays_metal_support?: string }> }
      const gpu = j.SPDisplaysDataType?.[0]
      if (gpu === undefined) return null
      const model = gpu.sppci_model ?? 'Unknown GPU'
      const isAppleSilicon = /Apple\s+(M\d|Silicon)/i.test(model) || (gpu.spdisplays_metal_support !== undefined && gpu.spdisplays_vram === undefined)
      if (isAppleSilicon) {
        return { name: model, vramGb: Math.round(totalmem() / 1073741824), vendor: 'apple-metal' }
      }
      const vramMatch = gpu.spdisplays_vram?.match(/(\d+)\s*GB/i)
      const vramGb = vramMatch ? parseInt(vramMatch[1], 10) : 0
      if (vramGb > 0) {
        const vendor = /AMD|ATI/i.test(gpu.spdisplays_vendor ?? '') ? 'amd' : 'intel'
        return { name: model, vramGb, vendor: vendor as GpuInfo['vendor'] }
      }
      return null
    } catch { return null }
  }
  if (platform === 'linux') {
    const nvidiaOut = await execCmd('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], GPU_DETECT_TIMEOUT_MS)
    if (nvidiaOut !== '') {
      const parts = nvidiaOut.split(',').map(s => s.trim())
      if (parts.length >= 2) {
        const name = parts[0]
        const vramMb = parseInt(parts[1], 10)
        if (!isNaN(vramMb) && vramMb > 0) return { name, vramGb: Math.round(vramMb / 1024), vendor: 'nvidia' }
      }
    }
    return null
  }
  if (platform === 'win32') {
    const nvidiaOut = await execCmd('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], GPU_DETECT_TIMEOUT_MS)
    if (nvidiaOut !== '') {
      const parts = nvidiaOut.split(',').map(s => s.trim())
      if (parts.length >= 2) {
        const name = parts[0]
        const vramMb = parseInt(parts[1], 10)
        if (!isNaN(vramMb) && vramMb > 0) return { name, vramGb: Math.round(vramMb / 1024), vendor: 'nvidia' }
      }
    }
    return null
  }
  return null
}

function getSdCliPath(): string {
  return join(SD_BIN_DIR, getSdCliExeName())
}

/** 检查 sd-cli 是否已下载。 */
function isBundled(): boolean {
  try { return existsSync(getSdCliPath()) } catch { return false }
}

/** 字节数 → 人类可读大小（如 2934003212 → '2.7 GB'）。 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[i]}`
}

/**
 * 匹配当前平台对应的 GitHub release asset 名称关键词。
 * release 文件名格式：sd-master-<hash>-bin-Darwin-macOS-<ver>-arm64.zip
 */
function matchPlatformAsset(assetName: string): boolean {
  const platform = process.platform
  const arch = process.arch
  const name = assetName.toLowerCase()
  if (platform === 'darwin' && arch === 'arm64') {
    return name.includes('darwin') && name.includes('arm64')
  }
  if (platform === 'darwin' && arch === 'x64') {
    return name.includes('darwin') && name.includes('x86_64')
  }
  if (platform === 'linux' && arch === 'x64') {
    return name.includes('linux') && name.includes('x86_64')
  }
  if (platform === 'linux' && arch === 'arm64') {
    return name.includes('linux') && name.includes('arm64')
  }
  if (platform === 'win32' && arch === 'x64') {
    // Windows 优先 CPU 版（Vulkan 版需要 GPU 驱动，CPU 版兼容性更好）。
    return name.includes('win') && name.includes('cpu') && name.includes('x64')
  }
  return false
}

/** GitHub API release asset 结构（部分字段）。 */
interface GitHubAsset {
  name: string
  browser_download_url: string
  size: number
}

/** GitHub API latest release 响应结构（部分字段）。 */
interface GitHubRelease {
  assets?: GitHubAsset[]
}

/** 从模型文件名推断架构。 */
function inferArchitecture(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.includes('flux')) return 'Flux'
  if (lower.includes('sdxl')) return 'SDXL'
  if (lower.includes('sd3') || lower.includes('sd-3')) return 'SD3'
  if (lower.includes('qwen')) return 'Qwen-Image'
  if (lower.includes('chroma')) return 'Chroma'
  if (lower.includes('wan')) return 'Wan'
  if (lower.includes('sd-v2') || lower.includes('sd2') || lower.includes('-v2')) return 'SD 2.x'
  if (lower.includes('sd-v1-5') || lower.includes('v1-5') || lower.includes('v1_5') || lower.includes('dreamshaper') || lower.includes('realisticvision') || lower.includes('deliberate') || lower.includes('anything')) return 'SD 1.5'
  return 'SD'
}

/** 从模型文件名推断量化/精度。 */
function inferQuantization(fileName: string): string {
  const lower = fileName.toLowerCase()
  const map: Record<string, string> = {
    'q4_k_m': 'Q4_K_M', 'q4_k_s': 'Q4_K_S', 'q4_0': 'Q4_0', 'q4_1': 'Q4_1',
    'q5_k_m': 'Q5_K_M', 'q5_k_s': 'Q5_K_S', 'q5_0': 'Q5_0', 'q5_1': 'Q5_1',
    'q6_k': 'Q6_K', 'q8_0': 'Q8_0', 'q3_k_s': 'Q3_K_S', 'q3_k_m': 'Q3_K_M', 'q2_k': 'Q2_K',
    'f16': 'F16', 'fp16': 'F16', 'bf16': 'BF16', 'f32': 'F32', 'fp32': 'F32',
  }
  for (const [k, v] of Object.entries(map)) {
    if (lower.includes(k)) return v
  }
  return lower.endsWith('.gguf') ? 'GGUF' : 'F16'
}

/** 估算 VRAM 需求（GB，按架构 + 量化粗略估算）。 */
function inferVramGb(arch: string, quant: string, sizeBytes: number): number {
  const sizeGb = sizeBytes / 1073741824
  // Flux/SD3/Qwen 等大模型基础开销更高；粗略按文件大小上浮。
  const big = ['Flux', 'SD3', 'Qwen-Image', 'Chroma', 'Wan'].includes(arch)
  const overhead = big ? 6 : 3
  return Math.max(big ? 8 : 4, Math.round((sizeGb + overhead) * 10) / 10)
}

/** 推荐采样步数（按架构）。 */
function inferSteps(arch: string): number {
  if (arch === 'Flux') return 4 // schnell 蒸馏 1-4 步
  return 20
}

/** 推荐分辨率短边（按架构）。 */
function inferSize(arch: string): number {
  if (arch === 'SDXL') return 1024
  if (arch === 'Flux' || arch === 'SD3') return 1024
  return 512
}

/** 从模型文件名推断显示名。 */
function inferDisplayName(fileName: string): string {
  return fileName.replace(/\.(safetensors|gguf|ckpt|pt|bin)$/i, '')
}

/** 列出 SD_MODELS_DIR 下的模型文件（.safetensors / .gguf），含推断元数据。 */
function listLocalModels(): SdModel[] {
  try {
    if (!existsSync(SD_MODELS_DIR)) return []
    const files = readdirSync(SD_MODELS_DIR)
    const models: SdModel[] = []
    for (const f of files) {
      if (f.toLowerCase().endsWith('.safetensors') || f.toLowerCase().endsWith('.gguf')) {
        try {
          const stat = statSync(join(SD_MODELS_DIR, f))
          const arch = inferArchitecture(f)
          const quant = inferQuantization(f)
          models.push({
            fileName: f,
            displayName: inferDisplayName(f),
            size: formatBytes(stat.size),
            sizeBytes: stat.size,
            architecture: arch,
            quantization: quant,
            vramGb: inferVramGb(arch, quant, stat.size),
            recommendedSteps: inferSteps(arch),
            recommendedSize: inferSize(arch),
          })
        } catch { /* stat 失败跳过 */ }
      }
    }
    return models
  } catch {
    return []
  }
}

/** 单个下载槽位的进度（engine / model 各自独立，互不覆盖）。 */
interface DownloadSlot {
  percent: number
  downloadedBytes: number
  totalBytes: number
  status: 'idle' | 'downloading' | 'done' | 'error'
  error?: string
}

/** 新建空闲下载槽。 */
function idleSlot(): DownloadSlot {
  return { percent: 0, downloadedBytes: 0, totalBytes: 0, status: 'idle' }
}

/** 推荐模型下载配置（按档位，含完整参数）。 */
interface ModelDownloadCfg {
  url: string
  fileName: string
  name: string
  architecture: string
  quantization: string
  size: string
  vramGb: number
  minMemGb: number
  recommendedSteps: number
  recommendedSize: number
  description: string
  /** Flux 等模型需要的配套 VAE 下载地址（可选）。 */
  vaeUrl?: string
  vaeFileName?: string
}

const MODEL_DOWNLOADS: Record<'low' | 'mid' | 'high', ModelDownloadCfg> = {
  low: {
    url: 'https://hf-mirror.com/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors',
    fileName: 'DreamShaper_8_pruned.safetensors',
    name: 'DreamShaper 8',
    architecture: 'SD 1.5',
    quantization: 'F16',
    size: '1.99 GB',
    vramGb: 4,
    minMemGb: 8,
    recommendedSteps: 20,
    recommendedSize: 512,
    description: 'SD 1.5 经典微调，人像/头像优化，轻量快速，低配首选',
  },
  mid: {
    url: 'https://hf-mirror.com/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q2_K.gguf',
    fileName: 'flux1-schnell-Q2_K.gguf',
    name: 'FLUX.1-schnell',
    architecture: 'Flux',
    quantization: 'Q2_K',
    size: '3.7 GB',
    vramGb: 8,
    minMemGb: 16,
    recommendedSteps: 4,
    recommendedSize: 1024,
    description: 'Flux 蒸馏加速版，1-4 步出图，质量远超 SD1.5',
    vaeUrl: 'https://hf-mirror.com/second-state/FLUX.1-schnell-GGUF/resolve/main/ae.safetensors',
    vaeFileName: 'ae.safetensors',
  },
  high: {
    url: 'https://hf-mirror.com/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q3_K_S.gguf',
    fileName: 'flux1-schnell-Q3_K_S.gguf',
    name: 'FLUX.1-schnell',
    architecture: 'Flux',
    quantization: 'Q3_K_S',
    size: '4.8 GB',
    vramGb: 10,
    minMemGb: 24,
    recommendedSteps: 4,
    recommendedSize: 1024,
    description: 'Flux 蒸馏加速版更高量化，细节更好，高配推荐',
    vaeUrl: 'https://hf-mirror.com/second-state/FLUX.1-schnell-GGUF/resolve/main/ae.safetensors',
    vaeFileName: 'ae.safetensors',
  },
}

/** Flux 官方 VAE（ae.safetensors）—— Flux GGUF 只含 diffusion 权重，必须另配 VAE 才能解码。 */
const FLUX_VAE_FILE = 'ae.safetensors'

/** 解析 Flux 模型所需的 VAE 路径（存在才返回，否则 undefined）。 */
function resolveFluxVae(): string | undefined {
  const p = join(SD_MODELS_DIR, FLUX_VAE_FILE)
  return existsSync(p) ? p : undefined
}

export class ArtGenService extends TypertRemoteService {
  static inject: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'corumArtGen')
  }

  /** 当前激活的模型名（undefined = 无激活）。 */
  private activeModel: string | undefined

  /**
   * 下载进度按 key 分槽（'engine' / 'model'），彼此独立——
   * 修复引擎与模型同时下载时共用单字段互相覆盖的缺陷。
   */
  private downloadSlots: Record<'engine' | 'model', DownloadSlot> = {
    engine: idleSlot(),
    model: idleSlot(),
  }

  // ── RPC 方法 ─────────────────────────────────────────────────────

  /** 引擎状态 + 模型列表 + 硬件检测。 */
  @Remote('status')
  async status(): Promise<ArtGenStatus> {
    const engineBundled = isBundled()
    const models = listLocalModels()
    // 激活互斥：若当前激活模型已被删除/不存在，回落到第一个模型；一个都没有则无激活。
    if (this.activeModel !== undefined && !models.some(m => m.fileName === this.activeModel)) {
      this.activeModel = models.length > 0 ? models[0]!.fileName : undefined
    }
    // 有模型但未激活任何 → 默认激活第一个（保证「有且仅一个生效」的可用默认）。
    if (this.activeModel === undefined && models.length > 0) {
      this.activeModel = models[0]!.fileName
    }
    if (this.activeModel !== undefined) {
      for (const m of models) {
        if (m.fileName === this.activeModel) m.active = true
      }
    }
    // 硬件检测
    const totalMemGb = Math.round(totalmem() / 1073741824)
    const gpu = await detectGpu()
    const cpuCores = (() => { try { return cpus().length } catch { return 0 } })()
    const meetsMinReq = totalMemGb >= MIN_MEMORY_GB
    const minReqReason = !meetsMinReq ? `内存不足（需 ≥${MIN_MEMORY_GB} GB，当前 ${totalMemGb} GB），本地文生图需要至少 ${MIN_MEMORY_GB} GB 内存` : undefined
    return {
      engineBundled,
      enginePath: engineBundled ? getSdCliPath() : '',
      models,
      platform: process.platform,
      ...(this.activeModel !== undefined ? { activeModel: this.activeModel } : {}),
      totalMemGb,
      meetsMinReq,
      ...(minReqReason !== undefined ? { minReqReason } : {}),
      gpu,
      cpuCores,
    }
  }

  /**
   * 下载 sd-cli 二进制。
   * 调 GitHub API 获取 latest release assets，按平台匹配正确 asset 下载。
   * 下载（ghproxy 镜像）→ 写入临时文件 → 解压 zip → 提取 sd-cli → chmod 755。
   */
  @Remote('downloadEngine')
  async downloadEngine(): Promise<{ ok: boolean; error?: string }> {
    if (isBundled()) return { ok: true } // 已下载
    try { mkdirSync(SD_BIN_DIR, { recursive: true }) } catch { /* 已存在 */ }
    const slot = this.downloadSlots.engine
    // 立即标记为 downloading（让前端轮询能看到状态变化）。
    this.downloadSlots.engine = { percent: 0, downloadedBytes: 0, totalBytes: 0, status: 'downloading' }
    try {
      // 1. 调 GitHub API 获取 latest release assets 列表（通过 ghproxy 镜像）。
      const apiUrl = 'https://gh-proxy.com/https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest'
      const apiRes = await fetch(apiUrl, {
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: { 'Accept': 'application/json', 'User-Agent': 'corum-artgen' },
      })
      if (!apiRes.ok) {
        this.downloadSlots.engine = { ...this.downloadSlots.engine, status: 'error', error: `GitHub API HTTP ${apiRes.status}` }
        return { ok: false, error: `查询 release 失败（HTTP ${apiRes.status}）` }
      }
      const release = (await apiRes.json()) as GitHubRelease
      const assets = release.assets ?? []
      // 2. 按平台匹配正确的 asset。
      const asset = assets.find(a => matchPlatformAsset(a.name))
      if (asset === undefined) {
        this.downloadSlots.engine = { ...this.downloadSlots.engine, status: 'error', error: '未找到匹配平台的 asset' }
        return { ok: false, error: `未找到匹配平台 ${process.platform}-${process.arch} 的预编译二进制` }
      }
      // 3. 下载（ghproxy 镜像转发 GitHub 下载 URL）。
      const downloadUrl = `https://gh-proxy.com/${asset.browser_download_url}`
      const r = await fetch(downloadUrl, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!r.ok) {
        this.downloadSlots.engine = { ...this.downloadSlots.engine, status: 'error', error: `下载 HTTP ${r.status}` }
        return { ok: false, error: `下载失败（HTTP ${r.status}）` }
      }
      if (!r.body) return { ok: false, error: '下载返回空响应体' }
      // 从 Content-Length 获取总大小。
      const totalBytes = parseInt(r.headers.get('content-length') ?? '0', 10)
      this.downloadSlots.engine = { percent: 0, downloadedBytes: 0, totalBytes, status: 'downloading' }
      // 流式写入临时 zip 文件。
      const tmpZipPath = join(SD_BIN_DIR, 'sd-cli-download.zip')
      const fileStream = (await import('node:fs')).createWriteStream(tmpZipPath)
      const reader = r.body.getReader()
      let downloaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!fileStream.write(Buffer.from(value))) {
          await new Promise<void>(resolve => fileStream.once('drain', () => resolve()))
        }
        downloaded += value.byteLength
        const percent = totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0
        this.downloadSlots.engine = { percent, downloadedBytes: downloaded, totalBytes, status: 'downloading' }
      }
      fileStream.end()
      await new Promise<void>(resolve => fileStream.on('finish', () => resolve()))
      // 4. 解压 zip → 提取全部文件到 SD_BIN_DIR（sd-cli 依赖 dylib/so/dll）。
      const exeName = getSdCliExeName()
      const destPath = getSdCliPath()
      try {
        const extractDir = join(SD_BIN_DIR, 'sd-cli-extract')
        try { mkdirSync(extractDir, { recursive: true }) } catch { /* 已存在 */ }
        if (process.platform === 'win32') {
          execSync(`tar -xf "${tmpZipPath}" -C "${extractDir}"`, { timeout: 30_000 })
        } else {
          execSync(`unzip -o "${tmpZipPath}" -d "${extractDir}"`, { timeout: 30_000 })
        }
        // 将解压目录里的所有文件移动到 SD_BIN_DIR（保留 dylib/so/dll 等依赖）。
        const entries = readdirSync(extractDir)
        for (const entry of entries) {
          const srcFile = join(extractDir, entry)
          const destFile = join(SD_BIN_DIR, entry)
          try {
            if (existsSync(destFile)) rmSync(destFile, { force: true })
            renameSync(srcFile, destFile)
          } catch { /* 跳过无法移动的文件 */ }
        }
        // 清理解压临时目录。
        try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
      } catch {
        // 解压失败兜底。
      }
      // 清理临时 zip 文件。
      try { rmSync(tmpZipPath, { force: true }) } catch { /* 忽略 */ }
      // macOS/Linux 加可执行权限。
      if (process.platform !== 'win32') {
        try { (await import('node:fs')).chmodSync(destPath, 0o755) } catch { /* 忽略 */ }
      }
      // 验证 sd-cli 是否就位。
      if (!existsSync(destPath)) {
        this.downloadSlots.engine = { ...this.downloadSlots.engine, status: 'error', error: '解压后未找到 sd-cli 二进制' }
        return { ok: false, error: '解压后未找到 sd-cli 二进制文件' }
      }
      this.downloadSlots.engine = { percent: 100, downloadedBytes: downloaded, totalBytes: totalBytes > 0 ? totalBytes : downloaded, status: 'done' }
      return { ok: true }
    } catch (e) {
      this.downloadSlots.engine = { ...this.downloadSlots.engine, status: 'error', error: e instanceof Error ? e.message : String(e) }
      return { ok: false, error: `下载引擎失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /**
   * 下载进度轮询。
   * @param key 槽位：'engine'（sd-cli 二进制）或 'model'（SD 模型）。
   *   省略时返回 engine 槽（向后兼容旧调用方）。
   */
  @Remote('getDownloadProgress')
  getDownloadProgress(key?: string): { percent: number; downloadedBytes: number; totalBytes: number; status: string; error?: string } {
    const k = key === 'model' ? 'model' : 'engine'
    return { ...this.downloadSlots[k] }
  }

  /** 进行中的文生图任务表（startTxt2Img 创建，getTxt2ImgJob 轮询）。 */
  private txt2imgJobs = new Map<string, {
    status: 'running' | 'done' | 'error'
    percent: number
    phase: string
    result?: Txt2ImgResult
    error?: string
  }>()

  /**
   * 启动文生图任务（立即返回 jobId，不阻塞）。
   * spawn sd-cli 后台运行，逐行解析 stdout 的 `N%|` 进度行写入任务表；
   * 前端用 getTxt2ImgJob(jobId) 轮询真实进度（替代旧的定时器假进度）。
   */
  @Remote('startTxt2Img')
  startTxt2Img(args: Txt2ImgArgs): { jobId: string } {
    const cliPath = getSdCliPath()
    if (!existsSync(cliPath)) throw new Error('sd-cli 未下载，请先点击「下载引擎」')
    // 确保模型目录存在。
    try { mkdirSync(SD_MODELS_DIR, { recursive: true }) } catch { /* 已存在 */ }
    // 解析生成模型：显式指定 > 当前激活 > 第一个本地模型（激活互斥后默认走激活模型）。
    const resolved = this.resolveModelForGen(args.model)
    if ('error' in resolved) throw new Error(resolved.error)
    const modelPath = resolved.path
    const started = Date.now()
    // 生成输出路径（临时 PNG 文件）。
    const outputDir = join(getCorumHome(), 'tmp', 'artgen')
    try { mkdirSync(outputDir, { recursive: true }) } catch { /* 已存在 */ }
    const outputPath = join(outputDir, `output-${Date.now()}.png`)
    // 构造 sd-cli 参数。GGUF 模型用 --diffusion-model，safetensors 用 -m。
    const isGguf = modelPath.endsWith('.gguf')
    const modelArg = isGguf ? '--diffusion-model' : '-m'
    const arch = inferArchitecture(resolved.fileName)
    const cliArgs: string[] = [
      modelArg, modelPath,
      '-p', args.prompt,
      '-o', outputPath,
      '-H', String(args.height ?? 512),
      '-W', String(args.width ?? 512),
      '--steps', String(args.steps ?? 20),
      '--cfg-scale', String(args.cfgScale ?? (arch === 'Flux' ? 1 : 7)),
      '--sampling-method', args.sampler ?? 'euler',
      '--seed', String(args.seed ?? -1),
    ]
    // Flux 需要配套 VAE（GGUF 只含 diffusion 权重）。
    if (arch === 'Flux') {
      const vae = resolveFluxVae()
      if (vae === undefined) {
        throw new Error('Flux 模型需要配套 VAE（ae.safetensors）。请重新下载该模型（会自动带上 VAE），或把 ae.safetensors 导入模型目录')
      }
      cliArgs.push('--vae', vae)
    }
    // 有反向提示词则加 -n 参数。
    if (args.negativePrompt !== undefined && args.negativePrompt !== '') {
      cliArgs.push('-n', args.negativePrompt)
    }
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const job: { status: 'running' | 'done' | 'error'; percent: number; phase: string; result?: Txt2ImgResult; error?: string } = { status: 'running', percent: 0, phase: 'starting' }
    this.txt2imgJobs.set(jobId, job)
    // spawn sd-cli，逐行解析 stdout 进度（真实百分比）。
    const proc = spawn(cliPath, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      try { clearTimeout(killTimer) } catch { /* 已清理 */ }
      fn()
      // 任务保留 5 分钟供前端取结果，之后清理防泄漏。
      setTimeout(() => { this.txt2imgJobs.delete(jobId) }, 5 * 60_000)
    }
    /**
     * 解析 sd-cli 进度输出（stdout/stderr 同格式， carriage-return 重写同行）。
     * sd-cli 不打 `N%` 百分比，而是打「步数进度条」：
     *   采样阶段：`|==>       | 3/20 - 6.80it/s`（cur/total = 采样步数）
     *   模型加载/解码：`|####...| 686/686 - 3.91GB/s`（字节吞吐，非采样，不映射）
     * 只把「it/s 的采样步数条」映射到 5-95%（前 5% 留给加载，95-100% 留给解码）。
     */
    const totalSteps = args.steps ?? 20
    const parseProgress = (text: string): void => {
      // 采样进度：cur/total + it/s 标志。取本行最后一个匹配（进度条重写同行）。
      const stepMatches = [...text.matchAll(/(\d+)\/(\d+)\s*-\s*[\d.]+it\/s/g)]
      if (stepMatches.length > 0) {
        const m = stepMatches[stepMatches.length - 1]!
        const cur = parseInt(m[1]!, 10)
        const tot = parseInt(m[2]!, 10)
        if (tot > 0 && tot <= totalSteps && cur <= tot) {
          const pct = 5 + Math.round((cur / tot) * 90)
          if (pct > job.percent) {
            job.percent = pct
            job.phase = 'sampling'
          }
        }
      }
      // 解码阶段标志（decoding / decoded），把进度推进到 ≥96%。
      if (/decoding|decoded|decode_first_stage/i.test(text) && job.percent < 96) {
        job.percent = 96
        job.phase = 'decoding'
      }
    }
    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      stdout += text
      parseProgress(text)
    })
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text
      parseProgress(text)
    })
    const onDone = (code: number) => finish(() => {
      if (code !== 0) {
        job.status = 'error'
        job.error = `sd-cli 执行失败（exit ${code}）：${stderr.trim() !== '' ? stderr.trim().slice(0, 400) : stdout.trim().slice(0, 400)}`
        return
      }
      if (!existsSync(outputPath)) {
        job.status = 'error'
        job.error = 'sd-cli 执行完成但未生成输出文件'
        return
      }
      try {
        const imageBuffer = readFileSync(outputPath)
        const imageBase64 = imageBuffer.toString('base64')
        // 解析使用的种子（sd-cli stdout 通常含 `seed = <number>` 行）。
        let seed = args.seed ?? -1
        const seedMatch = stdout.match(/seed\s*[:=]\s*(\d+)/i) ?? stderr.match(/seed\s*[:=]\s*(\d+)/i)
        if (seedMatch !== null) seed = parseInt(seedMatch[1], 10)
        job.status = 'done'
        job.percent = 100
        job.phase = 'done'
        job.result = { imageBase64, seed, durationMs: Date.now() - started }
      } catch (e) {
        job.status = 'error'
        job.error = `读取输出失败：${e instanceof Error ? e.message : String(e)}`
      } finally {
        try { rmSync(outputPath, { force: true }) } catch { /* 忽略 */ }
      }
    })
    proc.on('close', code => onDone(code ?? -1))
    proc.on('error', err => finish(() => {
      job.status = 'error'
      job.error = `启动 sd-cli 失败：${err.message}`
    }))
    // 兜底超时杀进程。
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* 已退出 */ }
      finish(() => {
        job.status = 'error'
        job.error = `生成超时（${GEN_TIMEOUT_MS / 1000}s）`
      })
    }, GEN_TIMEOUT_MS)
    return { jobId }
  }

  /** 轮询文生图任务状态/进度。任务不存在（已过期清理）返回 null。 */
  @Remote('getTxt2ImgJob')
  getTxt2ImgJob(jobId: string): Txt2ImgJob | null {
    const j = this.txt2imgJobs.get(jobId)
    if (j === undefined) return null
    return {
      id: jobId,
      status: j.status,
      percent: j.percent,
      phase: j.phase,
      ...(j.result !== undefined ? { result: j.result } : {}),
      ...(j.error !== undefined ? { error: j.error } : {}),
    }
  }

  /**
   * 执行文生图（阻塞式，保留向后兼容：设置页头像等一次性调用）。
   * 内部走 startTxt2Img + 轮询 getTxt2ImgJob，与前端实时进度同一条路径。
   */
  @Remote('txt2img')
  async txt2img(args: Txt2ImgArgs): Promise<Txt2ImgResult> {
    const { jobId } = this.startTxt2Img(args)
    // 轮询任务直到完成/失败。
    for (;;) {
      const job = this.txt2imgJobs.get(jobId)
      if (job === undefined) throw new Error('文生图任务已过期')
      if (job.status === 'done') {
        const r = job.result!
        this.txt2imgJobs.delete(jobId)
        return r
      }
      if (job.status === 'error') {
        const err = job.error ?? '未知错误'
        this.txt2imgJobs.delete(jobId)
        throw new Error(err)
      }
      await new Promise(r => setTimeout(r, 300))
    }
  }

  /** 列出模型文件。 */
  @Remote('listModels')
  async listModels(): Promise<SdModel[]> {
    return listLocalModels()
  }

  /**
   * 下载推荐模型（按档位选择）。
   * tier=low: DreamShaper 8 (SD 1.5 微调, 2GB, 头像/人像优化)
   * tier=mid: FLUX.1-schnell Q2_K GGUF (3.7GB, 高质量)
   * tier=high: FLUX.1-schnell Q3_K_S GGUF (4.8GB, 很高质量)
   */
  @Remote('downloadModel')
  async downloadModel(tier: 'low' | 'mid' | 'high' = 'low'): Promise<{ ok: boolean; error?: string }> {
    try { mkdirSync(SD_MODELS_DIR, { recursive: true }) } catch { /* 已存在 */ }
    const cfg = MODEL_DOWNLOADS[tier] ?? MODEL_DOWNLOADS.low
    const destPath = join(SD_MODELS_DIR, cfg.fileName)
    if (existsSync(destPath)) return { ok: true }
    // 若已有后台下载在跑，直接等待它完成；否则同步执行下载。
    if (this.downloadSlots.model.status !== 'downloading') {
      this.startDownloadModel(tier)
    }
    // 轮询槽位直到完成/失败。
    for (;;) {
      const s = this.downloadSlots.model
      if (s.status === 'done') return { ok: true }
      if (s.status === 'error') return { ok: false, error: s.error ?? '下载失败' }
      await new Promise(r => setTimeout(r, 400))
    }
  }

  /**
   * 启动后台模型下载（立即返回，不阻塞 RPC 连接）。
   * 模型文件 ~2-5 GB，长时间下载若挂在阻塞 RPC 上会被 UI 网关超时/断连中止，
   * 导致进度槽永远停在 downloading。后台任务与连接解耦，前端用
   * getDownloadProgress('model') 轮询真实进度。
   */
  @Remote('startDownloadModel')
  startDownloadModel(tier?: string): { started: boolean; already?: boolean } {
    try { mkdirSync(SD_MODELS_DIR, { recursive: true }) } catch { /* 已存在 */ }
    const key = (tier === 'mid' || tier === 'high') ? tier : 'low'
    const cfg = MODEL_DOWNLOADS[key]
    const destPath = join(SD_MODELS_DIR, cfg.fileName)
    if (existsSync(destPath)) return { started: false, already: true }
    if (this.downloadSlots.model.status === 'downloading') return { started: true }
    // 后台跑（不 await），进度写 downloadSlots.model；Flux 等模型下载后自动补配套 VAE。
    void this.runModelDownload(cfg.url, cfg.fileName, destPath, cfg.vaeUrl, cfg.vaeFileName)
    return { started: true }
  }

  /** 后台下载模型到 destPath，进度写 downloadSlots.model；可选配套 VAE（Flux）。 */
  private async runModelDownload(url: string, fileName: string, destPath: string, vaeUrl?: string, vaeFileName?: string): Promise<void> {
    this.downloadSlots.model = { percent: 0, downloadedBytes: 0, totalBytes: 0, status: 'downloading' }
    try {
      const r = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      })
      if (!r.ok) {
        this.downloadSlots.model = { ...this.downloadSlots.model, status: 'error', error: `HTTP ${r.status}` }
        return
      }
      if (!r.body) {
        this.downloadSlots.model = { ...this.downloadSlots.model, status: 'error', error: '下载返回空响应体' }
        return
      }
      const totalBytes = parseInt(r.headers.get('content-length') ?? '0', 10)
      this.downloadSlots.model = { percent: 0, downloadedBytes: 0, totalBytes, status: 'downloading' }
      // 流式写入临时文件 → 重命名为最终文件名（原子操作）。
      const tmpPath = join(SD_MODELS_DIR, `${fileName}.tmp`)
      const fileStream = (await import('node:fs')).createWriteStream(tmpPath)
      const reader = r.body.getReader()
      let downloaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!fileStream.write(Buffer.from(value))) {
          await new Promise<void>(resolve => fileStream.once('drain', () => resolve()))
        }
        downloaded += value.byteLength
        const percent = totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0
        this.downloadSlots.model = { percent, downloadedBytes: downloaded, totalBytes, status: 'downloading' }
      }
      fileStream.end()
      await new Promise<void>(resolve => fileStream.on('finish', () => resolve()))
      renameSync(tmpPath, destPath)
      this.downloadSlots.model = { percent: 100, downloadedBytes: downloaded, totalBytes: totalBytes > 0 ? totalBytes : downloaded, status: 'downloading' }
      // 配套 VAE（Flux GGUF 必需）—— 主模型下载完成后补下，失败仅记错误不影响主模型。
      if (vaeUrl !== undefined && vaeFileName !== undefined) {
        const vaeDest = join(SD_MODELS_DIR, vaeFileName)
        if (!existsSync(vaeDest)) {
          try {
            const vr = await fetch(vaeUrl, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
            if (vr.ok && vr.body) {
              const vtmp = join(SD_MODELS_DIR, `${vaeFileName}.tmp`)
              const vstream = (await import('node:fs')).createWriteStream(vtmp)
              const vreader = vr.body.getReader()
              for (;;) {
                const { done, value } = await vreader.read()
                if (done) break
                if (!vstream.write(Buffer.from(value))) await new Promise<void>(res => vstream.once('drain', () => res()))
              }
              vstream.end()
              await new Promise<void>(res => vstream.on('finish', () => res()))
              renameSync(vtmp, vaeDest)
            }
          } catch { /* VAE 下载失败不阻塞主模型 */ }
        }
      }
      this.downloadSlots.model = { ...this.downloadSlots.model, percent: 100, status: 'done' }
    } catch (e) {
      this.downloadSlots.model = { ...this.downloadSlots.model, status: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 删除模型（从磁盘删除 .safetensors/.gguf 文件）。 */
  @Remote('deleteModel')
  async deleteModel(fileName: string): Promise<{ ok: boolean; error?: string }> {
    const name = fileName.trim()
    if (name === '') return { ok: false, error: '模型名不能为空' }
    const modelPath = join(SD_MODELS_DIR, name)
    if (!existsSync(modelPath)) return { ok: false, error: '模型文件不存在' }
    try {
      rmSync(modelPath, { force: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `删除模型失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /**
   * 激活模型（单选互斥：全局有且仅一个激活模型）。
   * sd-cli 是无状态 CLI，激活 = 标记当前生成模型。生成（txt2img/startTxt2Img）
   * 强制使用激活模型；未指定时回落到激活模型，再回落到第一个模型。
   */
  @Remote('activateModel')
  async activateModel(fileName: string): Promise<{ ok: boolean; error?: string }> {
    const name = fileName.trim()
    if (name === '') return { ok: false, error: '模型名不能为空' }
    const modelPath = join(SD_MODELS_DIR, name)
    if (!existsSync(modelPath)) return { ok: false, error: '模型文件不存在' }
    // 幂等：已激活同名直接成功。
    if (this.activeModel === name) return { ok: true }
    // 单选互斥：直接切换激活标记（激活新模型即取消旧模型，全局唯一）。
    this.activeModel = name
    return { ok: true }
  }

  /** 取消激活（清空当前激活模型；之后生成需显式指定模型或重新激活）。 */
  @Remote('deactivateModel')
  async deactivateModel(_fileName: string): Promise<{ ok: boolean; error?: string }> {
    this.activeModel = undefined
    return { ok: true }
  }

  /** 解析生成应使用的模型文件名：显式指定 > 当前激活 > 第一个本地模型。 */
  private resolveModelForGen(requested?: string): { fileName: string; path: string } | { error: string } {
    const models = listLocalModels()
    if (models.length === 0) return { error: '暂无模型，请先下载或导入模型' }
    const pick = (fileName: string) => {
      const m = models.find(x => x.fileName === fileName)
      if (m === undefined) return { error: `模型「${fileName}」不存在` }
      return { fileName: m.fileName, path: join(SD_MODELS_DIR, m.fileName) }
    }
    if (requested !== undefined && requested.trim() !== '') return pick(requested.trim())
    if (this.activeModel !== undefined) return pick(this.activeModel)
    return { fileName: models[0]!.fileName, path: join(SD_MODELS_DIR, models[0]!.fileName) }
  }

  /** 返回推荐模型列表（含完整参数 + 本机兼容性判定）。 */
  @Remote('listRecommendedModels')
  async listRecommendedModels(): Promise<RecommendedSdModel[]> {
    const totalMemGb = Math.round(totalmem() / 1073741824)
    const gpu = await detectGpu()
    const vramGb = gpu?.vramGb ?? 0
    const out: RecommendedSdModel[] = []
    for (const tier of ['low', 'mid', 'high'] as const) {
      const c = MODEL_DOWNLOADS[tier]
      let compatible = true
      let incompatibleReason: string | undefined
      if (totalMemGb < c.minMemGb) {
        compatible = false
        incompatibleReason = `内存不足（需 ≥${c.minMemGb} GB，当前 ${totalMemGb} GB）`
      } else if (gpu === null) {
        // 无独立 GPU：CPU 推理可用但慢，标警告不禁止。
        compatible = true
        incompatibleReason = '无独立 GPU，将用 CPU 推理（较慢）'
      } else if (vramGb < c.vramGb) {
        compatible = false
        incompatibleReason = `VRAM 不足（需 ≥${c.vramGb} GB，当前 ${vramGb} GB）`
      }
      out.push({
        tier: c === MODEL_DOWNLOADS.low ? 'low' : c === MODEL_DOWNLOADS.mid ? 'mid' : 'high',
        name: c.name,
        fileName: c.fileName,
        architecture: c.architecture,
        quantization: c.quantization,
        size: c.size,
        vramGb: c.vramGb,
        recommendedSteps: c.recommendedSteps,
        recommendedSize: c.recommendedSize,
        description: c.description,
        compatible,
        ...(incompatibleReason !== undefined ? { incompatibleReason } : {}),
      })
    }
    return out
  }

  /**
   * 导入本地模型文件到 sd-models 目录（复制，不移动源文件）。
   * 仅接受 .safetensors / .gguf；重名则拒绝（避免覆盖）。
   */
  @Remote('importModel')
  async importModel(sourcePath: string): Promise<{ ok: boolean; fileName?: string; error?: string }> {
    const src = sourcePath.trim()
    if (src === '') return { ok: false, error: '源路径不能为空' }
    if (!existsSync(src)) return { ok: false, error: `源文件不存在：${src}` }
    const lower = src.toLowerCase()
    if (!lower.endsWith('.safetensors') && !lower.endsWith('.gguf')) {
      return { ok: false, error: '仅支持 .safetensors / .gguf 模型文件' }
    }
    try { mkdirSync(SD_MODELS_DIR, { recursive: true }) } catch { /* 已存在 */ }
    const fileName = basename(src)
    const destPath = join(SD_MODELS_DIR, fileName)
    if (existsSync(destPath)) return { ok: false, error: `模型「${fileName}」已存在` }
    try {
      copyFileSync(src, destPath)
      return { ok: true, fileName }
    } catch (e) {
      return { ok: false, error: `导入失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /**
   * 查询 HuggingFace 官方/社区 SD 模型目录（按 stable-diffusion 库 + 关键词搜索）。
   * 返回可下载的 safetensors/gguf 主模型文件，按热度排序。
   */
  @Remote('searchOnlineModels')
  async searchOnlineModels(query?: string): Promise<{ results: OnlineSdModel[]; error?: string }> {
    const q = (query ?? '').trim()
    try {
      // HF models API：library=stable-diffusion（diffusers 格式）+ 全文搜索。
      const url = `https://hf-mirror.com/api/models?search=${encodeURIComponent(q === '' ? 'stable-diffusion' : q)}&filter=safetensors&sort=downloads&direction=-1&limit=12`
      const r = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'Accept': 'application/json', 'User-Agent': 'corum-artgen' },
      })
      if (!r.ok) return { results: [], error: `查询失败（HTTP ${r.status}）` }
      const arr = (await r.json()) as Array<{ id?: string; downloads?: number; likes?: number; tags?: string[] }>
      // 列表响应不含 siblings → 对每个 repo 查 model 详情拿文件列表（并发）。
      const results: OnlineSdModel[] = []
      const detailed = await Promise.all(arr.map(async (m) => {
        const repoId = m.id ?? ''
        if (repoId === '') return null
        try {
          // 注意：repoId 的 '/' 不能 encode（HF 对 url-encoded slash 报 400）。
          const dr = await fetch(`https://hf-mirror.com/api/models/${repoId}`, {
            signal: AbortSignal.timeout(12_000),
            headers: { 'Accept': 'application/json', 'User-Agent': 'corum-artgen' },
          })
          if (!dr.ok) return null
          const dj = (await dr.json()) as { siblings?: Array<{ rfilename?: string }> }
          // 挑主模型文件：根目录单文件 .safetensors/.gguf（排除子目录 diffusers 拆件）。
          // 只排除明确的「专用小件」前缀（vae/lora/controlnet/encoder/clip）——
          // 这些会以独立文件名出现（如 vae.safetensors、text_encoder/...）。
          const files = (dj.siblings ?? []).map(x => x.rfilename ?? '').filter(f => {
            if (f.includes('/')) return false // 只要根目录单文件
            const lf = f.toLowerCase()
            if (!(lf.endsWith('.safetensors') || lf.endsWith('.gguf'))) return false
            // 排除专用小件（前缀/独立词匹配，不误伤 'inpainting'/'fp16' 等主模型变体）。
            if (/^(vae|lora|controlnet|control_net|clip|text_encoder|unet|encoder|ae)[._-]/.test(lf)) return false
            return true
          })
          if (files.length === 0) return null
          // 优先标准主文件（非 inpainting、非 fp16 重复变体），否则第一个。
          const preferred = files.find(f => !/inpainting|inpaint/i.test(f) && !/\.safetensors\.safetensors$/i.test(f))
          const fileName = preferred ?? files[0]!
          const arch = inferArchitecture(fileName) !== 'SD' ? inferArchitecture(fileName) : inferArchitecture(repoId)
          return {
            repoId,
            name: repoId.split('/').pop() ?? repoId,
            fileName,
            architecture: arch,
            downloads: m.downloads ?? 0,
            likes: m.likes ?? 0,
            downloadUrl: `https://hf-mirror.com/${repoId}/resolve/main/${fileName}`,
          } as OnlineSdModel
        } catch { return null }
      }))
      for (const d of detailed) { if (d !== null) results.push(d) }
      return { results }
    } catch (e) {
      return { results: [], error: `搜索失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /**
   * 从线上 URL 下载模型（后台任务，进度写 model 槽位）。
   * 供 searchOnlineModels 结果一键下载。
   */
  @Remote('downloadModelFromUrl')
  downloadModelFromUrl(url: string, fileName: string): { started: boolean; already?: boolean; error?: string } {
    const u = url.trim()
    const fn = fileName.trim()
    if (u === '' || fn === '') return { started: false, error: 'URL / 文件名不能为空' }
    const lower = fn.toLowerCase()
    if (!lower.endsWith('.safetensors') && !lower.endsWith('.gguf')) {
      return { started: false, error: '仅支持 .safetensors / .gguf 模型文件' }
    }
    try { mkdirSync(SD_MODELS_DIR, { recursive: true }) } catch { /* 已存在 */ }
    const destPath = join(SD_MODELS_DIR, fn)
    if (existsSync(destPath)) return { started: false, already: true }
    if (this.downloadSlots.model.status === 'downloading') return { started: false, error: '已有模型下载在进行中，请等待完成' }
    void this.runModelDownload(u, fn, destPath)
    return { started: true }
  }
}
