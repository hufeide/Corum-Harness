/**
 * fork（corum）：@corum/corum-ui-trajectory —— 官方 `@deepseek-ai/dsh-client-ui-trajectory`
 * 的定制版（第 12 个 fork 包，台账 `docs/fork-delta.md` §14）。
 *
 * 与官方的唯一形态差异：**注册点从 `conversation.view` 迁到 corum 的 details 抽屉**。
 * 官方把轨迹注册成对话区的一个 view tab（「对话 / 轨迹」）；corum 的形态是
 * 「右上角轨迹按钮 → details 独立抽屉」（2026-09-07 用户定调，HANDOFF-0.1.3 §5）。
 * 因此本包：
 *   - **保留**官方全部 ctx 级注册（轨迹节点定义、request-header/assistant/tool/compaction
 *     定义、conversation view 构建器、locale 字典、`uiSession.provide` 的 trajectory hook）；
 *   - **不注册** `conversation.view` 条目（details 槽是 `kind:'single'`，其 occupant 由
 *     corum-ui-chat 的 DetailsPanel 持有——轨迹视图由它渲染）；
 *   - 组件面经 `exports["./view"] → src/client/view.ts` 供 `@corum/corum-ui-chat` 的
 *     DetailsPanel 内联消费（插件 bundle 自身不含组件，保持精简）。
 *
 * @module @corum/corum-ui-trajectory
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the SlotMap rows and Context merges declared by the corum
// conversation fork and the official renderer/session plugins.
import type {} from '@corum/corum-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { en, NS, zh } from './locales.ts'
import { registerTrajectoryAssistantDefinition } from './trajectory-assistant-definition.ts'
import { registerTrajectoryCompactionDefinitions } from './trajectory-compaction-definition.ts'
import { registerTrajectoryMessageDefinitions } from './trajectory-message-definitions.ts'
import { registerTrajectoryRequestHeaderDefinition } from './trajectory-request-header-definition.ts'
import {
  EMPTY_TRAJECTORY_SNAPSHOT, registerTrajectoryConversationView,
} from './trajectory-snapshot-builder.ts'
import type { TrajectorySnapshot } from './trajectory-contract.ts'
import { registerTrajectoryToolDefinition } from './trajectory-tool-definition.ts'

export type { TrajectoryKey } from './locales.ts'
export type {
  TrajectoryContribution,
  TrajectoryConversationViewNode,
  TrajectoryRequestHeaderState,
  TrajectorySnapshot,
  UseTrajectory,
} from './trajectory-contract.ts'

/** Required services: the trajectory registries, ordinary Session paging, and the locale service. */
export const inject = ['sessions', 'uiSession', 'uiConversation', 'locale']

/**
 * Client plugin body: register every trajectory ctx contribution (definitions,
 * dictionaries, the conversation view builder, and the session hook source).
 * The view itself is rendered by corum-ui-chat's details occupant — this fork
 * contributes no `conversation.view` tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const trajectorySources = new WeakMap<SessionBinding, ObservableSnapshot<TrajectorySnapshot>>()
  const trajectorySource = (binding: SessionBinding): ObservableSnapshot<TrajectorySnapshot> => {
    let source = trajectorySources.get(binding)
    if (source === undefined) {
      const target = ctx.uiConversation.binding(binding).target('trajectory')
      source = {
        getSnapshot: () => target.getSnapshot() ?? EMPTY_TRAJECTORY_SNAPSHOT,
        subscribe: listener => target.subscribe(listener),
      }
      trajectorySources.set(binding, source)
    }
    return source
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'corum-ui-trajectory: dictionaries')
  registerTrajectoryMessageDefinitions(ctx)
  registerTrajectoryRequestHeaderDefinition(ctx)
  registerTrajectoryAssistantDefinition(ctx)
  registerTrajectoryToolDefinition(ctx)
  registerTrajectoryCompactionDefinitions(ctx)
  registerTrajectoryConversationView(ctx)
  ctx.uiSession.provide({
    hooks: ['trajectory'],
    resolve: binding => ({ hooks: { trajectory: trajectorySource(binding) } }),
  })
  // fork（corum）：官方在此注册 conversation.view（id 'trajectory'）成为对话区 tab；
  // corum 形态是 details 抽屉，故不注册。轨迹视图由 corum-ui-chat 的 DetailsPanel
  // 渲染本包导出的 TrajectoryView（props 由 chat 侧装配）。
}
