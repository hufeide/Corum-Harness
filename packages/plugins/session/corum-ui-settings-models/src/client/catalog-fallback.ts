/**
 * 目录型 provider 的「可用模型」兜底。
 *
 * 官方 `llm/discoverModels` 只对**注册了 model discovery 的 namespace** 生效：
 * `llm-pi-ai` 注册了网络发现，而官方 DeepSeek 适配器没有注册——它的模型目录来自
 * 配置段自身的 `models`（schema 默认层已解析出官方三档 V4），文档里也写明
 * 「a route whose adapter already knows its models answers from that knowledge」。
 * 于是对 `llm-deepseek` 调 discoverModels 必然抛
 * `no model discovery is registered for "llm-deepseek"`（code `NO_DISCOVERY`）。
 *
 * 本模块把这个错误转成「内置目录」结果（不是失败）：优先读该 provider profile 的
 * **已解析** `models`（含 schema 默认，带真实 contextWindow/maxTokens），读不到再退
 * 到内置 catalog id 表（thinking-catalog.ts，与官方默认目录同 id）。两条路径都不发
 * 网络请求，也不写配置。
 */

import type { LlmDiscoveredModel, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { catalogModelIdsOf } from './reasoning.ts'

/** 该错误 = 这个 namespace 没有注册网络发现（目录型 provider），不是连不通。 */
export function isNoDiscoveryError(message: string): boolean {
  return /no model discovery is registered/i.test(message)
}

/** 一行 profile 模型 → 候选模型（只取发现流程用得到的三个字段）。 */
function discoveredOfRows(raw: unknown): LlmDiscoveredModel[] {
  if (!Array.isArray(raw)) return []
  const out: LlmDiscoveredModel[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      ...(typeof row.contextWindow === 'number' ? { contextWindow: row.contextWindow } : {}),
      ...(typeof row.maxTokens === 'number' ? { maxTokens: row.maxTokens } : {}),
    })
  }
  return out
}

/** 一组 profile 模型行 → 候选模型（供已持有 rows 的调用方复用）。 */
export function discoveredModelsOf(rows: unknown): LlmDiscoveredModel[] {
  return discoveredOfRows(rows)
}

/** 内置 catalog id 表 → 候选模型（无 profile 目录可读时的最后兜底）。 */
export function catalogIdsAsModels(provider: string): LlmDiscoveredModel[] {
  return catalogModelIdsOf(provider).map(id => ({ id }))
}

/**
 * 目录型 provider 的兜底候选：profile 已解析 `models` → 内置 catalog id 表。
 * @param schema - settings schema 操作（下钻 profile 路径）。
 * @param namespace - 该 provider 所在 namespace 视图（可能未加载）。
 * @param settingsPath - namespace 根到该 provider profile 的路径（整节 provider 为 `[]`）。
 * @param provider - provider route id（查内置 catalog 表用）。
 * @returns 候选模型；空数组 = 该路由既无 profile 目录也不在内置表里。
 */
export function catalogFallbackModels(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView | undefined,
  settingsPath: readonly string[],
  provider: string,
): LlmDiscoveredModel[] {
  const fromProfile = namespace === undefined
    ? []
    : discoveredOfRows(schema.getPath(namespace.value, [...settingsPath, 'models']))
  if (fromProfile.length > 0) return fromProfile
  return catalogIdsAsModels(provider)
}

/**
 * 配置向导里的 profile 地址推导：整节 provider（`llm-deepseek`，route 由适配器
 * 固定）的 profile 就是节根，pi-ai 的自定义/内置路由在 `providers.<route>`。
 */
export function wizardProfilePath(settingsNs: string, provider: string): readonly string[] {
  return settingsNs === 'llm-deepseek' ? [] : ['providers', provider]
}
