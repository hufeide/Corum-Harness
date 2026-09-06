/**
 * localLlm 服务的窄能力接口（跨 bundle 类型面收敛，见 AGENTS.md 红线 3）。
 * corum-agent 只依赖这个 face，不耦合 @corum/corum-ollama 的实现包。
 * @module @corum/corum-agent/local-llm-face
 */

/** 本地引擎探测结果（与 @corum/corum-ollama 对齐的只读投影）。 */
export interface LocalEngineStatus {
  installed: boolean
  running: boolean
  totalMemGb: number
  meetsMinMem: boolean
  modelPulled: boolean
  models: string[]
  version?: string
}

/** 本地 chat 调用入参。 */
export interface LocalChatArgs {
  model: string
  prompt: string
  temperature?: number
  numCtx?: number
  numPredict?: number
}

/** 本地 chat 返回。 */
export interface LocalChatResult {
  text: string
  durationMs: number
}

/** localLlm 服务能力接口（corum-agent 消费子集）。 */
export interface LocalLlmFace {
  status(): Promise<LocalEngineStatus>
  ensureServer(): Promise<{ ok: boolean; error?: string }>
  chat(args: LocalChatArgs): Promise<LocalChatResult>
}
