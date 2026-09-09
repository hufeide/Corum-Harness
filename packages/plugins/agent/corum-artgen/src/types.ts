/**
 * @corum/corum-artgen 类型定义。
 * @module @corum/corum-artgen/types
 */

/** 本地 SD 模型。 */
export interface SdModel {
  /** 模型文件名（如 'sd-v1-5-pruned-emaonly-fp16.safetensors'）。 */
  fileName: string
  /** 模型名/显示名（如 'SD 1.5'）。 */
  displayName: string
  /** 文件大小（人类可读）。 */
  size: string
  /** 文件大小（字节）。 */
  sizeBytes: number
  /** 是否已激活（当前选中的生成模型，全局唯一）。 */
  active?: boolean
  /** 模型架构（如 'SD 1.5' / 'SDXL' / 'Flux' / 'SD3' / 'Qwen-Image'）。 */
  architecture?: string
  /** 量化/精度（如 'F16' / 'Q4_K_M' / 'Q8_0'）。 */
  quantization?: string
  /** 估算 VRAM 需求（GB，按架构+量化估算）。 */
  vramGb?: number
  /** 推荐采样步数。 */
  recommendedSteps?: number
  /** 推荐分辨率（短边）。 */
  recommendedSize?: number
}

/** GPU 信息。 */
export interface GpuInfo {
  /** 显卡名称（如 'Apple M5 Max'）。 */
  name: string
  /** 显存/统一内存（GB）。 */
  vramGb: number
  /** GPU 类型。 */
  vendor: 'nvidia' | 'amd' | 'apple-metal' | 'intel'
}

/** 引擎状态。 */
export interface ArtGenStatus {
  /** sd-cli 是否已下载。 */
  engineBundled: boolean
  /** sd-cli 路径（已下载则有值）。 */
  enginePath: string
  /** 已下载的模型列表。 */
  models: SdModel[]
  /** 平台。 */
  platform: string
  /** 当前已激活的模型名（全局唯一；生成强制使用该模型）。 */
  activeModel?: string
  /**
   * 断点残片（fileName → 已下载字节）：>0 表示该文件可「继续下载」（2026-09-09 断点续传）。
   * 引擎残片用固定名 'sd-cli-download.zip'。
   */
  partials: Array<{ fileName: string; bytes: number }>
  /** 物理内存（GB）。 */
  totalMemGb: number
  /** 是否达到最低硬件门槛（8GB 内存）。 */
  meetsMinReq: boolean
  /** 不达标原因（如 "内存不足（需 ≥8 GB，当前 4 GB）"）。 */
  minReqReason?: string
  /** GPU 信息（null = 无独立 GPU，CPU 推理可用但慢）。 */
  gpu: GpuInfo | null
  /** CPU 核心数。 */
  cpuCores: number
}

/** 文生图请求参数。 */
export interface Txt2ImgArgs {
  /** 正向提示词。 */
  prompt: string
  /** 反向提示词。 */
  negativePrompt?: string
  /** 模型文件名（可选：不填用当前激活模型，再回落第一个本地模型）。 */
  model?: string
  /** 宽度（默认 512）。 */
  width?: number
  /** 高度（默认 512）。 */
  height?: number
  /** 采样步数（默认 20）。 */
  steps?: number
  /** 引导强度（默认 7）。 */
  cfgScale?: number
  /** 采样方法（默认 'euler'）。 */
  sampler?: string
  /** 随机种子（-1 = 随机）。 */
  seed?: number
}

/** 文生图返回结果。 */
export interface Txt2ImgResult {
  /** 生成图片的 base64（不含 data: 前缀）。 */
  imageBase64: string
  /** 使用的种子。 */
  seed: number
  /** 生成耗时（ms）。 */
  durationMs: number
}

/** 推荐模型（低/中/高配档位，含完整参数）。 */
export interface RecommendedSdModel {
  /** 档位。 */
  tier: 'low' | 'mid' | 'high'
  /** 显示名。 */
  name: string
  /** 下载后的文件名。 */
  fileName: string
  /** 架构。 */
  architecture: string
  /** 量化/精度。 */
  quantization: string
  /** 文件大小（人类可读）。 */
  size: string
  /** 估算 VRAM 需求（GB）。 */
  vramGb: number
  /** 推荐采样步数。 */
  recommendedSteps: number
  /** 推荐分辨率（短边）。 */
  recommendedSize: number
  /** 一句话说明。 */
  description: string
  /** 本机是否满足最低要求（内存/VRAM）。 */
  compatible?: boolean
  /** 不满足原因。 */
  incompatibleReason?: string
}

/** 线上模型目录条目（从 HuggingFace API 查询）。 */
export interface OnlineSdModel {
  /** HF repo id（如 'Lykon/DreamShaper'）。 */
  repoId: string
  /** 显示名。 */
  name: string
  /** 可下载的主模型文件名。 */
  fileName: string
  /** 架构（从 tags/文件名推断）。 */
  architecture: string
  /** 下载数（热度排序依据）。 */
  downloads: number
  /** 点赞数。 */
  likes: number
  /** 直接下载 URL（hf-mirror 加速）。 */
  downloadUrl: string
}

/** 文生图任务状态（startTxt2Img 后立即返回，getTxt2ImgJob 轮询）。 */
export interface Txt2ImgJob {
  /** 任务 id。 */
  id: string
  /** 状态。 */
  status: 'running' | 'done' | 'error'
  /** 真实进度百分比（0-100，解析自 sd-cli stdout 的 `N%|` 行；未到时为 0）。 */
  percent: number
  /** 当前阶段描述（如 'sampling' / 'decoding' / 'done'）。 */
  phase: string
  /** 完成时的结果（仅 status='done'）。 */
  result?: Txt2ImgResult
  /** 失败原因（仅 status='error'）。 */
  error?: string
}
