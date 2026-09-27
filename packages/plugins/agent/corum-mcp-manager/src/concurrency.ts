/**
 * 独占/复用策略的**自动推导**（2026-09-27 用户口径：「可复用的则不独占」）。
 *
 * ## 判据：目标是配置时定死，还是调用时传入
 *
 * | 情形 | 例 | 推导结果 | 理由 |
 * |---|---|---|---|
 * | 服务提供者，按参数寻址 | pencil（`execute{filePath}` 必填） | `per-resource(filePath)` | 每次调用自带资源 ⇒ 不同文档可并发 |
 * | 绑到**已存在**的实例 | CDP `--browser-url=…:9333` | `exclusive` | 就那一台浏览器，整机是一个资源（用户明确点名要独占）|
 * | server **自持**目标 | CDP 不传 `--browser-url`（自己拉起）/ `--isolated` | `per-resource(pageId)` | 官方文档：单实例共享给并发会话时默认开 `pageId` 路由 |
 * | 显式要"大家同时用、只限个数" | 用户口径 | `parallel` + `maxConcurrent` | 「可以设置一个访问上限」|
 * | 工具面共同的调用级资源参数 | 任意 server | `per-resource(该键)` | 工具自己就是这么寻址的 |
 * | 都推不出 | —— | `exclusive` | **保守默认**：宁可串行，也不要让两个 Agent 互相踩 |
 *
 * 顺序很重要：**显式配置 > 绑到已存在实例 > 自持目标 > 工具面共同参数 > 保守默认**。
 * 「绑到已存在实例」必须压过工具面规则：CDP 即便工具面带 `pageId`，只要连的是用户那台既有浏览器，
 * 就不该让两个 Agent 同时驱动它（用户 2026-09-27 明确要求独占）。
 *
 * @module @corum/corum-mcp-manager/concurrency
 */

import type { McpConcurrencyPolicy, McpServerConfig } from './types.ts'

/** 可作为「资源键」的候选参数名（按优先级）。 */
export const MCP_RESOURCE_ARG_CANDIDATES = ['filePath', 'pageId', 'document', 'docPath', 'path', 'file'] as const

/** 推导产物：策略 + 一句可读理由（进日志/设置页，便于用户理解为何独占）。 */
export interface McpConcurrencyDecision extends McpConcurrencyPolicy {
  /** 推导理由（英文短句，进日志；`explicit` 表示用户手写）。 */
  readonly reason: string
}

/** 只是工具面的最小投影（避免本模块依赖 MCP SDK 类型）。 */
export interface McpToolSchemaView {
  readonly name: string
  readonly inputSchema?: unknown
}

/** 该命令/参数是否指向 chrome-devtools-mcp（官方 CLI）。 */
function looksLikeChromeDevtoolsMcp(config: McpServerConfig): boolean {
  const haystack = config.transport === 'stdio'
    ? [config.command ?? '', ...(config.args ?? [])].join(' ')
    : config.url ?? ''
  return /chrome-devtools-mcp/i.test(haystack)
}

/** 是否**连到已存在**的浏览器实例（用户那台 ⇒ 整机独占）。 */
function attachesToExistingBrowser(config: McpServerConfig): boolean {
  if (config.transport !== 'stdio') return true // 远端 HTTP 端点本身就是既存实例 ⇒ 独占
  const args = config.args ?? []
  return args.some(arg => /^--(browser-url|browserUrl|autoConnect)\b|^--browser-url=/.test(arg))
}

/** 是否**自持**目标（自己拉起浏览器/独立 profile）⇒ 可并发。 */
function ownsItsTarget(config: McpServerConfig): boolean {
  // 远端 HTTP 端点本身就是既存实例 ⇒ 不拥有目标（首版漏了这个窄化，typecheck 直接拦下）。
  if (config.transport !== 'stdio') return false
  const args = config.args ?? []
  return args.some(arg => /^--(isolated|executablePath|headless)\b|^--(isolated|executablePath|headless)=/.test(arg))
    || !attachesToExistingBrowser(config)
}

/** 从工具 schema 里取属性名集合。 */
function propertiesOf(schema: unknown): string[] {
  if (schema === null || typeof schema !== 'object') return []
  const properties = (schema as { properties?: unknown }).properties
  if (properties === null || typeof properties !== 'object') return []
  return Object.keys(properties as Record<string, unknown>)
}

/**
 * 工具面是否**一致地**用某个参数寻址资源。
 *
 * 口径：**每一个带参数的工具有它**（不带参数的工具如 `get_app_state`/`list_pages` 不算违反）。
 * 只要有一个带参数的工具有属性却缺这个键，就不认为"按该资源寻址"（避免半套）。
 * @param tools - 工具面（含 schema）。
 * @returns 命中的候选键（按 {@link MCP_RESOURCE_ARG_CANDIDATES} 顺序），推不出为 undefined。
 */
export function sharedResourceArgOf(tools: readonly McpToolSchemaView[]): string | undefined {
  const withProps = tools.map(tool => propertiesOf(tool.inputSchema)).filter(names => names.length > 0)
  if (withProps.length === 0) return undefined
  for (const candidate of MCP_RESOURCE_ARG_CANDIDATES) {
    if (withProps.every(names => names.includes(candidate))) return candidate
  }
  return undefined
}

/**
 * 推导一个 server 的有效独占/复用策略。
 * @param input.config - 注册表里的服务定义。
 * @param input.tools - 已取到的工具面（可选；没有则只按配置推导）。
 * @returns 策略 + 理由（永远有值；推不出即 `exclusive`）。
 */
export function deriveConcurrencyPolicy(input: {
  readonly config: McpServerConfig | undefined
  readonly tools?: readonly McpToolSchemaView[]
}): McpConcurrencyDecision {
  const explicit = input.config?.concurrency
  if (explicit !== undefined) {
    return {
      mode: explicit.mode,
      ...(explicit.resourceArg !== undefined ? { resourceArg: explicit.resourceArg } : {}),
      ...(explicit.maxConcurrent !== undefined ? { maxConcurrent: explicit.maxConcurrent } : {}),
      reason: 'explicit',
    }
  }
  const config = input.config
  if (config !== undefined && looksLikeChromeDevtoolsMcp(config)) {
    if (attachesToExistingBrowser(config) && !ownsItsTarget(config)) {
      return { mode: 'exclusive', reason: 'attached to an existing browser instance' }
    }
    return { mode: 'per-resource', resourceArg: 'pageId', reason: 'owns its browser; pageId routing' }
  }
  const shared = input.tools !== undefined ? sharedResourceArgOf(input.tools) : undefined
  if (shared !== undefined) {
    return { mode: 'per-resource', resourceArg: shared, reason: `every tool addresses "${shared}"` }
  }
  return { mode: 'exclusive', reason: 'no per-call resource argument found' }
}

/**
 * 由策略算出租约**桶容量**（信号量上限）。
 *
 * 用户 2026-09-27 口径：非独占那侧「大家都可以同时访问，只是可以设置一个访问上限」⇒ 这里给出容量：
 * `exclusive`=1；`per-resource` 缺省 1/桶；`parallel` 缺省不限（`0` 也当不限）；`shared` 不限。
 * @param decision - 有效策略。
 * @returns 上限（`Number.POSITIVE_INFINITY` = 不限）。
 */
export function concurrencyLimitOf(decision: McpConcurrencyPolicy): number {
  if (decision.mode === 'exclusive') return 1
  if (decision.mode === 'shared') return Number.POSITIVE_INFINITY
  const configured = decision.maxConcurrent
  if (configured !== undefined) return configured > 0 ? Math.floor(configured) : Number.POSITIVE_INFINITY
  return decision.mode === 'per-resource' ? 1 : Number.POSITIVE_INFINITY
}

/**
 * 从一次调用的参数里取资源值（用于租约键）。
 * @param args - 调用参数（模型给的原始对象）。
 * @param resourceArg - 资源键名。
 * @returns 字符串化的资源值；缺省/非标量 ⇒ undefined（= 该调用按"整机"键）。
 */
export function resourceValueOf(args: unknown, resourceArg: string | undefined): string | undefined {
  if (resourceArg === undefined) return undefined
  if (args === null || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[resourceArg]
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}
