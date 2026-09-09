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
 *   - **不注册** `conversation.view` 条目；
 *   - **注册右侧「轨迹」区域 occupant**（壳声明的 `corum.trajectory` 网格叶子）：
 *     2026-09-09 用户定调——抽屉形态不好用，改为与编辑器/终端同构的独立区域，
 *     右上角轨迹按钮点亮（`layout.showRegion`）。
 *
 * @module @corum/corum-ui-trajectory
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
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
import { createTrajectoryDurationStore } from './duration-store.ts'
import { TrajectoryRegion, type TrajectoryRegionInjected } from './TrajectoryRegion.tsx'

export type { TrajectoryKey } from './locales.ts'
export type {
  TrajectoryContribution,
  TrajectoryConversationViewNode,
  TrajectoryRequestHeaderState,
  TrajectorySnapshot,
  UseTrajectory,
} from './trajectory-contract.ts'

/** Required services: the trajectory registries, slots, Session paging, and the locale service. */
export const inject = ['slots', 'sessions', 'uiSession', 'uiConversation', 'locale']

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
  // corum 形态是**右侧独立区域**（用户 2026-09-09 定调），故不注册 tab，改为注册
  // 壳声明的 corum.trajectory 区域 occupant（session-maybe：无会话时空态）。
  const duration = createTrajectoryDurationStore()
  const emptySource = {
    getSnapshot: (): TrajectorySnapshot => EMPTY_TRAJECTORY_SNAPSHOT,
    subscribe: (_listener: () => void): (() => void) => () => {},
  }
  ctx.slots.inject('corum.trajectory', () => ctx.slots.register({
    name: 'corum.trajectory',
    locale: NS,
    children: { 'conversation.trajectory.images': { kind: 'single', scope: 'session' } },
    inject: (sessionId?: SessionId): TrajectoryRegionInjected => {
      const trajectory = sessionId === undefined
        ? undefined
        : ctx.uiConversation.binding(sessionId).target('trajectory')
      return {
        hooks: {
          trajectory: trajectory === undefined
            ? emptySource
            : {
                getSnapshot: () => trajectory.getSnapshot() ?? EMPTY_TRAJECTORY_SNAPSHOT,
                subscribe: listener => trajectory.subscribe(listener),
              },
          duration,
        },
        loadOlder: async () => {
          if (sessionId === undefined) return false
          const session = ctx.sessions.binding(sessionId)?.session
          if (session === undefined) return false
          const before = trajectory?.getSnapshot()
          await session.loadOlder()
          return trajectory?.getSnapshot() !== before
        },
        loadImage: Object.assign(
          (attachment: ImageAttachmentRef) => ctx.uiConversation.imageUrl(sessionId as SessionId, attachment),
          {
            peek: (attachment: ImageAttachmentRef) =>
              ctx.uiConversation.peekImageUrl(sessionId as SessionId, attachment),
          },
        ),
        setActualDuration: (actualDuration: boolean) => { duration.set(actualDuration) },
      }
    },
  }, TrajectoryRegion))
}
