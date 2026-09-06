/**
 * @corum/corum-ollama — corum 本地 LLM 插件（基于 Ollama 推理引擎）。
 *
 * 纯 host 侧插件。LocalLlmService 继承 TypertRemoteService，通过 @Remote
 * 装饰器暴露 /api/localLlm/* 端点供浏览器半（corum-ide-ui 设置页 + corum-agent
 * polishPrompt 引擎路由）调用。
 *
 * 能力：探测/管理本机 Ollama（Apple Silicon 统一内存友好），为 AI 润色等
 * 轻量改写任务提供本地模型推理；内存 ≥16 GB 时推荐本地部署，否则回落线上。
 * 插件启用后，本地模型自动注册进 dsh 模型目录，可作 Agent 驱动 LLM。
 * @module @corum/corum-ollama
 */

import type { Context } from '@deepseek-ai/cordis'
import { LocalLlmService } from './local-llm-service.ts'
import { registerOllamaProvider } from './ollama-adapter.ts'

export type { GpuInfo, LocalEngineStatus, LocalChatArgs, LocalChatResult, RecommendedModel, PulledModel, OnlineModelTag } from './types.ts'
export { LocalLlmService, DEFAULT_LOCAL_MODEL, MIN_MEMORY_GB } from './local-llm-service.ts'
export { OllamaAdapter, OLLAMA_PROVIDER, OLLAMA_DEFAULT_MODEL, registerOllamaProvider } from './ollama-adapter.ts'

/** Cordis 插件名。 */
export const name = 'ollama'

/** 运行时依赖的服务（llm：注册本地 provider 到模型目录）。 */
export const inject: string[] = ['llm']

/** 挂载 LocalLlmService 单例服务 + 注册 Ollama provider 进模型目录（幂等：重复 apply 不再注册）。 */
export function apply(ctx: Context): void {
  // 幂等：本插件的 host apply 可能被多个 loader 行（cordis.patch.yml 的 corum-ollama
  // 行 + 历史 combo 行）触发。localLlm 已在根 ctx 注册过则跳过，避免 cordis
  // 「service has been registered」硬错。
  if (ctx.get('localLlm') === undefined) {
    new LocalLlmService(ctx)
    // 插件启用后，本地模型自动出现在「模型」配置目录，可作 Agent 驱动 LLM。
    registerOllamaProvider(ctx)
  }
}
