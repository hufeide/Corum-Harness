/**
 * OllamaAdapter — 把本地 Ollama 注册成 dsh `llm` 的一个 provider。
 *
 * 使插件启用后，本地模型（默认 qwen3.5:2b）自动出现在「模型」配置目录，
 * 可作为 Agent 的驱动 LLM（默认模型 / 子 Agent 模型 / 润色模型均可选）。
 *
 * 实现面：
 *   - providerInfo/listModels/resolveModel：把已拉取模型暴露为 provider `ollama` 的目录；
 *   - stream：OpenAI 兼容 /v1/chat/completions（stream:true），把 SSE chunk
 *     翻译成 harness StreamChunk（text-delta / usage / finish）。Ollama 本地
 *     模型不走 reasoningEffort（reasoning 元数据缺省），也不发工具调用——
 *     用作 Agent 驱动 LLM 时，工具编排由 dsh agentOptions 侧负责。
 *
 * @module @corum/corum-ollama/ollama-adapter
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

/** Ollama 默认端点。 */
const OLLAMA_BASE = 'http://127.0.0.1:11434'
/** provider 路由 id（模型目录里显示为「Ollama」）。 */
export const OLLAMA_PROVIDER = 'ollama'
/** 默认暴露的本地模型（与润色默认一致；listModels 实际返回已拉取全集）。 */
export const OLLAMA_DEFAULT_MODEL = 'qwen3.5:2b'

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>
}

interface OllamaChatChunk {
  choices?: Array<{
    delta?: { content?: string }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** 拉取本地已部署模型目录。 */
async function pulledModels(): Promise<string[]> {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return []
    const j = (await r.json()) as OllamaTagsResponse
    return (j.models ?? []).map(m => m.name ?? m.model ?? '').filter(n => n !== '')
  } catch {
    return []
  }
}

export class OllamaAdapter extends LlmAdapter {
  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Ollama（本地）' }
  }

  async listModels(provider: string) {
    const names = await pulledModels()
    const catalog = names.length > 0 ? names : [OLLAMA_DEFAULT_MODEL]
    return catalog.map(id => ({
      provider,
      id,
      name: id,
      inputModalities: ['text' as const],
    }))
  }

  resolveModel(provider: string, model: string, _signal?: AbortSignal) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text' as const],
      // 本地小模型默认上下文（保守值；resolveModelInfo 会校验 >0）。
      context: { contextWindow: 8192 },
      defaultMaxTokens: 4096,
      // fork（corum）：暴露思考档位。Ollama 的 think 参数支持
      // true/false + low/medium/high/max（详见 docs.ollama.com/capabilities/thinking）。
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('off'), name: '关闭思考' },
          { id: ReasoningEffortId('low'), name: 'low · 轻量思考' },
          { id: ReasoningEffortId('medium'), name: 'medium · 标准思考' },
          { id: ReasoningEffortId('high'), name: 'high · 深度思考' },
          { id: ReasoningEffortId('max'), name: 'max · 最大思考' },
        ],
        defaultEffort: ReasoningEffortId('off'),
      },
    })
  }

  /** 流式调用：OpenAI 兼容 /v1/chat/completions（stream:true），SSE → StreamChunk。 */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const wireMessages = options.messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }))
    if (options.system !== undefined) {
      wireMessages.unshift({ role: 'system', content: options.system })
    }
    let response: Response
    try {
      response = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: wireMessages,
          stream: true,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          ...(options.stop !== undefined ? { stop: options.stop } : {}),
          // fork（corum）：思考档位。Ollama 的 think 参数支持
          // true/false + low/medium/high/max（详见 docs.ollama.com/capabilities/thinking）。
          ...(() => {
            const e = options.reasoningEffort
            if (e === undefined) return {}
            const val = e as unknown as string
            if (val === 'off' || val === '') return { think: false }
            if (val === 'low' || val === 'medium' || val === 'high' || val === 'max') return { think: val }
            return { think: true }
          })(),
        }),
        signal: options.signal ?? null,
      })
    } catch (e) {
      throw new LlmError(`Ollama 请求失败：${e instanceof Error ? e.message : String(e)}`, 'TRANSPORT', { cause: e })
    }
    if (!response.ok) {
      throw new LlmError(`Ollama API error (HTTP ${response.status})`, 'PROVIDER_ERROR', { status: response.status })
    }
    if (!response.body) throw new LlmError('Ollama returned no response body', 'EMPTY_RESPONSE')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let usage: { inputTokens: number; outputTokens: number } | undefined
    let finished = false
    const index = 0
    let textStarted = false
    let textAccum = ''

    while (!finished) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '' || !trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') { finished = true; break }
        let chunk: OllamaChatChunk
        try {
          chunk = JSON.parse(payload) as OllamaChatChunk
        } catch {
          continue
        }
        const choice = chunk.choices?.[0]
        const text = choice?.delta?.content
        if (text !== undefined && text !== '') {
          if (!textStarted) {
            textStarted = true
            yield { type: 'block-start', index, blockType: 'text' }
          }
          textAccum += text
          yield { type: 'text-delta', index, text }
        }
        if (chunk.usage !== undefined) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          }
        }
        if (choice?.finish_reason != null) finished = true
      }
    }

    if (textStarted) yield { type: 'block-end', index, block: { type: 'text', text: textAccum } }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * 在 `ctx.llm` 上注册 Ollama provider（插件启用后本地模型进入模型目录）。
 * 双注册：
 *   - registerAdapter：route 注册（listModels/Agent 驱动 LLM 可用）；
 *   - registerConfigurableProviders：进入「模型」设置页的供应商卡目录。
 * cordis fiber 随插件停用自动清理注册。
 */
export function registerOllamaProvider(ctx: Context): void {
  const llm = ctx.get('llm')
  if (llm === undefined) return
  // 本地模型无 credential：只注册 adapter（route 注册）——模型选择器 / Agent 默认
  // 模型 / 润色模型的下拉即可选 Ollama（routableProviders）。不注册
  // configurable provider：那条通道是给「需配 API key 的供应商」，会要求
  // settingsNs 有 settings section schema（Ollama 无 key 可配，注册会产出一张无
  // schema 的坏卡）。
  ctx.llm.registerAdapter([OLLAMA_PROVIDER], new OllamaAdapter())
  ctx.logger.info('corum-ollama: adapter registered for provider "ollama"')
}
