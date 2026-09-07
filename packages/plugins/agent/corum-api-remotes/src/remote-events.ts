/**
 * The one home of this application's forwarded-Host-event allowlist. Both
 * compiler faces list this file, so the Host forwarding loop and the consumer
 * `ctx.remote.$on` key face read one declaration instead of two copies that
 * could drift; `./types.ts` derives the type projection from it and stays
 * type-only.
 */

import type {} from '@deepseek-ai/dsh-api-session-controller/remote-events'
import type { TypertForwardableEventEntry } from '@deepseek-ai/dsh-typert-protocol'
// fork（corum）：拉入 corum 领域事件的 cordis Events 声明（自包含，不 import
// host-only 的 corum-agent），让下方数组追加的 corum 条目过 `satisfies
// TypertForwardableEventEntry[]` 的编译期校验。
import type {} from './corum-events.ts'

/**
 * Host events this application forwards without renaming. The explicit mode is
 * both the Host dispatch strategy and the legal key set of `ctx.remote.$on`.
 */
export const API_REMOTE_FORWARDED_EVENTS = [
  { event: 'agent-preset/selected', mode: 'emit' },
  { event: 'approval/request', mode: 'waterfall' },
  { event: 'api-session/activity', mode: 'emit' },
  { event: 'api-session/added', mode: 'emit' },
  { event: 'api-session/error', mode: 'emit' },
  { event: 'api-session/removed', mode: 'emit' },
  { event: 'api-session/status', mode: 'emit' },
  { event: 'commands/change', mode: 'emit' },
  { event: 'credentials/reference-updated', mode: 'emit' },
  { event: 'cordis/request-run', mode: 'emit' },
  { event: 'cordis/request-run-resolved', mode: 'emit' },
  { event: 'cordis/dynamic-package', mode: 'emit' },
  { event: 'cordis/dynamic-retract', mode: 'emit' },
  { event: 'cordis/inspect-query', mode: 'emit' },
  { event: 'cordis/inspect-query-resolved', mode: 'emit' },
  { event: 'llm/adapters-updated', mode: 'emit' },
  { event: 'settings/document-updated', mode: 'emit' },
  { event: 'user-questions/request', mode: 'waterfall' },
  // ── fork（corum）：统一事件中心一期——corum 领域事件并入转发（官方 17 行零改动）──
  { event: 'corum/task/assigned', mode: 'emit' },
  { event: 'corum/task/started', mode: 'emit' },
  { event: 'corum/task/completed', mode: 'emit' },
  { event: 'corum/task/deferred', mode: 'emit' },
  { event: 'corum/task/evicted', mode: 'emit' },
  { event: 'corum/task/blocked', mode: 'emit' },
  { event: 'corum/task/unblocked', mode: 'emit' },
  { event: 'corum/task/stalled', mode: 'emit' },
  { event: 'corum/task/steered', mode: 'emit' },
  { event: 'corum/task/cancelled', mode: 'emit' },
  { event: 'corum/group/member-added', mode: 'emit' },
  { event: 'corum/group/member-removed', mode: 'emit' },
  { event: 'corum/terminal/output', mode: 'emit' },
  // ── fork（corum）：统一事件中心二期——文件 watch 变更推送并入转发 ──
  { event: 'corum/file/changed', mode: 'emit' },
] as const satisfies readonly TypertForwardableEventEntry[]
