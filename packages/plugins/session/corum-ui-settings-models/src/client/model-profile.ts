/**
 * 模型级（per-model）能力字段的读写：在 provider profile 的 `models[]` 数组里
 * 定位单个模型，读/写其 contextWindow / maxTokens / input(图片输入) / 思考模式。
 *
 * 数据形态（侦察报告 §4）：
 * - deepseek（ns `llm-deepseek`）：整节即 profile，模型目录在 profile.models
 *   （DeepSeekCatalogModel：contextWindow/maxTokens/inputModalities/thinking/reasoningEffort）。
 * - pi-ai（ns `llm-pi-ai`）：profile 在 providers.<route>，模型目录 profile.models
 *   （PiAiModelProfile：contextWindow/maxTokens/input/reasoningEfforts）。
 *
 * 写通路复用 settings/mutate 的 path ops（set/unset），与 ProviderEditor 同源。
 */

import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/** 费用配置（自建字段 `pricing`，每 M Token 单价；dsh 无此字段，纯记录）。 */
export interface ModelPricing {
  /** 输入 · 缓存命中（¥/M Token）。 */
  cacheHit?: number
  /** 输入 · 缓存未命中。 */
  cacheMiss?: number
  /** 输出。 */
  output?: number
}

/** 单个模型的可编辑能力草稿。 */
export interface ModelDraft {
  /** 模型 id（目录内唯一）。 */
  id: string
  /** 上下文窗口（token 数；undefined = 用 route 默认）。 */
  contextWindow?: number
  /** 最大输出 token 数。 */
  maxTokens?: number
  /** 是否支持图片输入（input modalities 含 image）。 */
  imageInput: boolean
  /** 思考模式档位（reasoningEffort 枚举值；undefined = 未配置/协议默认）。 */
  thinking?: string
  /** 费用配置（自建 pricing 字段）。 */
  pricing?: ModelPricing
}

/**
 * 读 provider profile 的模型目录数组。
 * @returns 模型对象数组（可能为空）。
 */
export function readModels(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  settingsPath: readonly string[],
): Record<string, unknown>[] {
  const list = schema.getPath(namespace.value, [...settingsPath, 'models'])
  if (!Array.isArray(list)) return []
  return list.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
}

/** 读单个模型的能力草稿。不存在则返回仅含 id 的空草稿。 */
export function readModel(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  settingsPath: readonly string[],
  modelId: string,
): ModelDraft {
  const models = readModels(schema, namespace, settingsPath)
  const raw = models.find(m => typeof m.id === 'string' && m.id === modelId)
  if (raw === undefined) return { id: modelId, imageInput: false }
  const input = raw.input ?? raw.inputModalities
  const imageInput = Array.isArray(input) && (input as unknown[]).includes('image')
  const thinking = typeof raw.reasoningEffort === 'string'
    ? raw.reasoningEffort
    : typeof raw.reasoning === 'string'
      ? raw.reasoning
      : undefined
  const pricingRaw = typeof raw.pricing === 'object' && raw.pricing !== null
    ? raw.pricing as Record<string, unknown>
    : undefined
  const pricing: ModelPricing | undefined = pricingRaw === undefined ? undefined : {
    ...(typeof pricingRaw.cacheHit === 'number' ? { cacheHit: pricingRaw.cacheHit } : {}),
    ...(typeof pricingRaw.cacheMiss === 'number' ? { cacheMiss: pricingRaw.cacheMiss } : {}),
    ...(typeof pricingRaw.output === 'number' ? { output: pricingRaw.output } : {}),
  }
  return {
    id: modelId,
    ...(typeof raw.contextWindow === 'number' ? { contextWindow: raw.contextWindow } : {}),
    ...(typeof raw.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {}),
    imageInput,
    ...(thinking === undefined ? {} : { thinking }),
    ...(pricing === undefined ? {} : { pricing }),
  }
}

/** 把 K/M 后缀的容量文本解析为 token 数（256K→256000，1M→1000000）。无法解析返回 undefined。 */
export function parseCapacity(text: string): number | undefined {
  const t = text.trim()
  if (t === '') return undefined
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(t)
  if (m === null) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return undefined
  const unit = (m[2] ?? '').toLowerCase()
  return Math.round(unit === 'k' ? n * 1000 : unit === 'm' ? n * 1000000 : n)
}

/** 把 token 数格式化为 K/M 文本（256000→256K）。 */
export function formatCapacity(value: number | undefined): string {
  if (value === undefined) return ''
  if (value >= 1000000 && value % 1000000 === 0) return `${value / 1000000}M`
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`
  return String(value)
}
