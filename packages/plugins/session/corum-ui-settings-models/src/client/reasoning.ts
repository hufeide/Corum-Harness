/**
 * 思考模式（推理强度）档位：按**单个模型**读取，不翻译——模型返回什么档位 id
 * 就用什么 id（每个模型的档位叫法/数量都不同：deepseek 的 low/high/max、kimi
 * 的自有档、pi-ai 的 minimal/low/medium/high/xhigh/max…）。
 *
 * 数据源（侦察 §2）：
 * - profile 已配置 `reasoningEfforts: false | Partial<Record<档位id, wire拼写>>`：
 *   读它的 key 集合 = 该模型实际支持的档位（用户/之前存过的真实档）。
 * - profile 当前默认档：`reasoningEffort`（deepseek）/ `reasoning`（pi-ai）。
 * - catalog 的 per-model 档位 Remote 读不到（host-only），所以「侦测不到」时
 *   给自定义输入入口（方案 C）：下拉(侦测到) + 「自定义…」手填 wire 值。
 */

import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { SelectOption } from './controls.tsx'
import THINKING_CATALOG from './thinking-catalog.ts'

export type ThinkingFamily = 'deepseek' | 'pi-ai' | undefined

/** 侦测不到时的固定档 valuelist（用户定：off/low/medium/high/xhigh/max）。 */
const FALLBACK_LEVELS: readonly string[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/** 未配置时的默认选中档（用户定：所有模型默认 high）。 */
export const DEFAULT_THINKING = 'high'

/**
 * 单模型档位 catalog 表（内联自 @earendil-works/pi-ai@0.84.3 的
 * dist/providers/data/*.json，经 getSupportedThinkingLevels 换算，429 个模型）。
 * key = `<providerRouteId>/<modelId>`，value = 该模型支持的档位 id 列表（不翻译）。
 */
const CATALOG = THINKING_CATALOG as Readonly<Record<string, readonly string[]>>

/** 按 provider route id + 模型 id 查 catalog 档位。命中返回档位列表，未命中 undefined。 */
/** provider route id → catalog 文件名（不一致的归一；catalog 文件见 thinking-catalog.ts）。 */
const ROUTE_TO_CATALOG: Readonly<Record<string, string>> = {
  'deepseek-official': 'deepseek',
  'deepseek': 'deepseek',
  'moonshotai-cn': 'moonshotai-cn',
  'moonshotai': 'moonshotai',
  'kimi-coding': 'kimi-coding',
  'zai-coding-cn': 'zai-coding-cn',
  'zai': 'zai',
}

function catalogLevels(provider: string, modelId: string): readonly string[] | undefined {
  const route = ROUTE_TO_CATALOG[provider] ?? provider
  const key = `${route}/${modelId}`
  if (CATALOG[key] !== undefined) return CATALOG[key]
  // 兜底：同模型 id 在任一 catalog 文件命中（自定义 route 复用 catalog 模型时）。
  for (const [k, v] of Object.entries(CATALOG)) {
    if (k.endsWith(`/${modelId}`)) return v
  }
  return undefined
}

/** 从 provider 的 settings namespace 推协议族（仅用于决定读哪个默认档字段）。 */
export function familyOfNamespace(settingsNs: string): ThinkingFamily {
  if (settingsNs.includes('deepseek')) return 'deepseek'
  if (settingsNs.includes('pi-ai')) return 'pi-ai'
  return undefined
}

/** 单个模型的思考档位事实。 */
export interface ModelThinking {
  /** 该模型支持的档位 id 列表（不翻译，原始 id）。空 = 侦测不到。 */
  levels: readonly string[]
  /** 当前默认档（profile 配置值；'off' = 关闭）。 */
  current: string
  /** 是否侦测到了档位（false → 给自定义输入入口）。 */
  detected: boolean
}

/**
 * 读单个模型的思考档位。
 * @param schema - settings schema 操作。
 * @param namespace - provider 所在 namespace view。
 * @param settingsPath - provider profile 路径。
 * @param modelId - 模型 id。
 * @param family - 协议族（决定默认档字段名）。
 */
export function readModelThinking(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  settingsPath: readonly string[],
  modelId: string,
  family: ThinkingFamily,
  provider: string,
): ModelThinking {
  const list = schema.getPath(namespace.value, [...settingsPath, 'models'])
  const raw = Array.isArray(list)
    ? list.find((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && m.id === modelId)
    : undefined
  // 当前默认档：deepseek 用 reasoningEffort，pi-ai 用 reasoning；未配置时默认 high（用户定）。
  const thinkKey = family === 'deepseek' ? 'reasoningEffort' : 'reasoning'
  const configured = raw !== undefined && typeof raw[thinkKey] === 'string' ? raw[thinkKey] as string : undefined
  const current = configured ?? DEFAULT_THINKING
  // ① 优先：profile 显式配置的 reasoningEfforts（用户/覆盖声明的档位）。
  const efforts = raw !== undefined ? raw.reasoningEfforts : undefined
  if (efforts === false) {
    // 显式剥离思考能力：只有 off（不受默认 high 影响）。
    return { levels: ['off'], current: 'off', detected: true }
  }
  if (typeof efforts === 'object' && efforts !== null && !Array.isArray(efforts)) {
    const keys = Object.keys(efforts as Record<string, unknown>)
    if (keys.length > 0) {
      const levels = ['off', ...keys.filter(k => k !== 'off')]
      return { levels: mergeCurrent(levels, current), current, detected: true }
    }
  }
  // ② 其次：catalog 表（单模型真实档位，与 host resolveModel 同源）。
  const fromCatalog = catalogLevels(provider, modelId)
  if (fromCatalog !== undefined && fromCatalog.length > 0) {
    return { levels: mergeCurrent([...fromCatalog], current), current, detected: true }
  }
  // ③ 兜底：侦测不到 → 固定档 valuelist（off/low/medium/high/xhigh/max）+ 自定义入口。
  return {
    levels: mergeCurrent([...FALLBACK_LEVELS], current),
    current,
    detected: false,
  }
}

/** 当前档位若不在档位集合里（手写覆盖的自定义档），并入以保证可选中。 */
function mergeCurrent(levels: readonly string[], current: string): readonly string[] {
  if (current === 'off' || levels.includes(current)) return levels
  return [...levels, current]
}

/** 把档位 id 列表转下拉选项（不翻译，label = id）。 */
export function thinkingOptionsOf(levels: readonly string[]): SelectOption[] {
  return levels.map(id => ({ id, label: id }))
}

/** pi-ai schema 的 reasoningEfforts dict 形态（off 可 null，其余必须非空 wire 值）。 */
export type ReasoningEfforts = Record<string, string | null>

/**
 * 由侦测到的档位集合推 `reasoningEfforts` dict（方案 A：能力集合落盘）。
 * 映射（用户定）：off → null，其余 → 档位 id 本身；用户已配置的 wire 值保留。
 * 返回 undefined = 不该写（无档位）；调用方决定写/删。
 */
export function reasoningEffortsOf(
  levels: readonly (string | boolean | undefined)[],
  existing: unknown,
): ReasoningEfforts | undefined {
  if (levels.length === 0) return undefined
  const prev: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {}
  const dict: ReasoningEfforts = {}
  for (const rawLevel of levels) {
    // 运行时防御（2026-09-15 真实事故）：档位 id 类型上声明为 string，但**布尔 false 会被
    // JS 悄悄当成字典键 `"false"`** ⇒ 落盘成 YAML 的 `false:`（**布尔键**）⇒ pi-ai 段校验
    // 失败 ⇒ 整个 settings 段注册不上，UI 只报「namespace not registered」（不指向该键）。
    // 语义上布尔 false 就是「关闭推理」= `off`，故**归一化**而不是丢弃。
    const level = typeof rawLevel === 'string' ? rawLevel : rawLevel === false ? 'off' : undefined
    if (level === undefined || level === '') continue
    if (level === 'off') { dict.off = null; continue }
    const wire = prev[level]
    dict[level] = typeof wire === 'string' && wire !== '' ? wire : level
  }
  // pi-ai 校验：dict 必须至少有一个非 off 档（否则应写 false / 省略字段）。
  return Object.keys(dict).some(k => k !== 'off') ? dict : undefined
}

/**
 * 按 provider route id 列出 catalog 表里的全部模型 id（官方目录路由的「可用模型」，
 * discoverModels 不注册网络发现时由此提供）。
 */
export function catalogModelIdsOf(provider: string): readonly string[] {
  const route = ROUTE_TO_CATALOG[provider] ?? provider
  const prefix = `${route}/`
  const ids: string[] = []
  for (const key of Object.keys(CATALOG)) {
    if (key.startsWith(prefix)) ids.push(key.slice(prefix.length))
  }
  return ids
}
