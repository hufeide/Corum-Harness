/**
 * @corum/corum-ollama 类型定义。
 * @module @corum/corum-ollama/types
 */

/** GPU 信息。 */
export interface GpuInfo {
  /** 显卡名称（如 'NVIDIA GeForce RTX 4090' / 'Apple M2 Pro'）。 */
  name: string
  /** 显存/统一内存（GB）。 */
  vramGb: number
  /** GPU 类型。 */
  vendor: 'nvidia' | 'amd' | 'apple-metal' | 'intel'
}

/** 线上目录模型 tag（来自 ollama.com/library/<name>/tags）。 */
export interface OnlineModelTag {
  /** 完整模型名（如 'qwen3.8:27b-q4_K_M'）。 */
  fullName: string
  /** tag 名（如 '27b-q4_K_M'）。 */
  tag: string
  /** 推断的量化等级（如 'Q4_K_M'、'Q8_0'、'BF16'、'FP16'）。 */
  quantization: string
  /** 推断的参数量描述（如 '27B'、'35B-A3B'）。 */
  paramSize: string
}

/** 已拉取的本地模型（含磁盘占用 + 激活状态 + 详细信息）。 */
export interface PulledModel {
  /** 模型名（如 'qwen3:4b'）。 */
  name: string
  /** 磁盘占用（人类可读，如 '2.7 GB'）。 */
  size: string
  /** 磁盘占用（字节，用于排序/统计）。 */
  sizeBytes: number
  /** 实际量化等级（如 'Q4_K_M'）。 */
  quantization?: string
  /** 是否已激活（加载到内存）。 */
  active?: boolean
  /** 激活后占用的 VRAM（字节；仅 active=true 时有值）。 */
  vramBytes?: number
  /** 参数量（如 '8.0B'、'27B'）。 */
  paramSize?: string
  /** 模型架构族（如 'gemma4'、'qwen3'）。 */
  family?: string
  /** 上下文长度（token 数，如 131072）。 */
  contextLength?: number
  /** 能力列表（如 ['completion', 'vision']）。 */
  capabilities?: string[]
}

/** 本地引擎探测结果。 */
export interface LocalEngineStatus {
  /** 是否安装了推理引擎（当前仅探测 Ollama）。 */
  installed: boolean
  /** 引擎服务是否可达（ollama serve 在跑）。 */
  running: boolean
  /** 物理内存（GB，四舍五入）。 */
  totalMemGb: number
  /** 是否达到本地部署最低内存门槛（16 GB）。 */
  meetsMinMem: boolean
  /** 默认润色模型（qwen3.5:4b）是否已拉取。 */
  modelPulled: boolean
  /** 已拉取的模型列表（含磁盘占用 + 激活状态）。 */
  models: PulledModel[]
  /** 引擎版本（可达时）。 */
  version?: string
  /** 平台（darwin/win32/linux）。 */
  platform: string
  /** CPU 逻辑核心数。 */
  cpuCores: number
  /** GPU 信息（检测到的显卡；null = 无独立 GPU）。 */
  gpu: GpuInfo | null
  /** Ollama 当前是否在使用 GPU 加速（有 GPU 且服务在跑时为 true）。 */
  gpuEnabled: boolean
  /** 当前已激活（加载到内存）的模型数。 */
  activeModelCount: number
  /** 最大同时激活模型数（默认 2）。 */
  maxActiveModels: number
  /** 引擎是否已内置（CORUM_HOME/bin/ollama 存在）。 */
  engineBundled: boolean
  /** 引擎下载状态（仅 downloadEngine 过程中有值）。 */
  downloadStatus?: 'idle' | 'downloading' | 'done' | 'error'
  /** 下载进度（0-100，仅 downloading 时有值）。 */
  downloadProgress?: number
}

/** 推荐本地模型（精选列表，供用户选择部署）。 */
export interface RecommendedModel {
  /** 模型 id（ollama pull 用的名字，如 'qwen3:4b'）。 */
  id: string
  /** 显示名（如 'Qwen3 4B'）。 */
  name: string
  /** 模型大小描述（如 '2.7 GB'）。 */
  size: string
  /** 简介（一句话说明能力/适用场景）。 */
  description: string
  /** 能力标签（如 '中文强', '轻量', '多语言', '推理'）。 */
  tags: string[]
  /** 最低内存要求（GB）。 */
  minMemoryGb: number
  /** 模型所需 VRAM（GB；Q4_K_M 默认量化，0 = 纯 CPU 可跑）。 */
  vramGb: number
  /** 是否支持纯 CPU 推理（所有模型都支持，但标注性能预期）。 */
  cpuOnly: boolean
  /** 性能档位（决定展示分组 + 默认筛选）。 */
  tier: 'low' | 'mid' | 'high'
  /** 是否 MoE 架构。 */
  isMoE: boolean
  /** 量化等级（如 'Q4_K_M'、'FP16'；Ollama 默认拉取的量化）。 */
  quantization: string
}

/** 本地 chat 调用入参。 */
export interface LocalChatArgs {
  model: string
  /** 完整用户指令（含改写要求 + 原文）。 */
  prompt: string
  /** 采样温度（润色场景取低值）。 */
  temperature?: number
  /** 上下文窗口（小值抑制冗长思考）。 */
  numCtx?: number
  /** 最大生成 token。 */
  numPredict?: number
}

/** 本地 chat 返回。 */
export interface LocalChatResult {
  text: string
  /** 生成耗时（ms，含冷启动）。 */
  durationMs: number
}
