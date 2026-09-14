/**
 * fork（corum）vendor：官方 agent.ts 两个守卫 helper 的逐字拷贝（官方
 * `@deepseek-ai/dsh-api-session-controller` 0.1.3-alpha.1，源文件
 * packages/api/session-controller/src/agent.ts:80-103；npm 产物不带 src
 * 且这两个函数不在公共导出面，故拷贝而非引用）。升级官方基线时按
 * docs/fork-delta.md runbook 重拷并比对。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** 官方 hasApiSessionSubagentOwner（agent.ts:80-90），仅类型面收窄。 */
export function hasApiSessionSubagentOwnerLocal(
  ctx: Context,
  session: { readonly header: { readonly origin?: string; readonly parentSession?: unknown } },
  agent: { readonly id: SessionId } | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId as SessionId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/** 官方 apiSessionSubagentOwnershipError（agent.ts:97-103），返回 RemoteError。 */
export function apiSessionSubagentOwnershipErrorLocal(sessionId: SessionId): RemoteError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}
