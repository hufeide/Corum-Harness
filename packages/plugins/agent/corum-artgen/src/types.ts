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
  /** 是否已激活（加载到内存）。 */
  active?: boolean
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
  /** 当前已激活的模型名（sd-cli 是进程式调用，激活=最近使用的模型）。 */
  activeModel?: string
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
  /** 模型文件名（从 models 里选）。 */
  model: string
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
