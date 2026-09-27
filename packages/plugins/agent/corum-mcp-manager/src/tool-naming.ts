/**
 * MCP 工具命名：与官方 `dsh-mcp-client` 的 `publicToolName` **逐字一致**。
 *
 * ## 为什么必须一致
 *
 * 工具名是**模型可见的契约**：提示词、技能、以及用户自己的 brief 里都写着
 * `mcp__chrome-devtools-9333__click` 这种名字（本仓 `docs/` 与 persona 里就有）。
 * 官方规则是「干净情形直接拼、超长/含非法字符时用 sha256 前 12 位截断」——
 * 我们自研池之后若不照抄，同一个 server 会因授权路径不同出现两种工具名，
 * 写死的名字就失效了。
 *
 * 官方实现（`@deepseek-ai/dsh-mcp-client` 的 `publicToolName`）：
 * ```js
 * const joined = `mcp__${serverName}__${rawName}`
 * const normalized = joined.replace(/[^A-Za-z0-9_-]/g, "_")
 * if (normalized === joined && normalized.length <= 64) return normalized
 * const hash = sha256(`${serverName}\0${rawName}`).slice(0, 12)
 * return `${normalized.slice(0, 64 - 12 - 1)}_${hash}`
 * ```
 *
 * @module @corum/corum-mcp-manager/tool-naming
 */

import { createHash } from 'node:crypto'

/** 官方常量：DeepSeek 函数名上限。 */
export const MAX_PUBLIC_NAME_LENGTH = 64
/** 官方常量：截断时追加的哈希长度。 */
export const HASH_LENGTH = 12
/** 官方常量：非法字符（保留字母/数字/下划线/连字符）。 */
export const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/**
 * 由 `(serverName, rawToolName)` 推出模型可见的工具名。
 * @param serverName - 授权里的服务名。
 * @param rawName - 服务端给出的原始工具名。
 * @returns 模型可见名（与官方逐字一致）。
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}
