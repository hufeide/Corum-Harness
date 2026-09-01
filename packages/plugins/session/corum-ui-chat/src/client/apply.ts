/** Register the Chat Conversation target, renderers, stats, and details surface. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { BoundActions, ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
// Type-only service and declaration merges used by the apply world.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@corum/corum-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  ChatNodeTurnDataInjected, ChatScrollPosition, ChatViewInjected, DetailsInjected,
  TurnTailOwnerProps,
} from './contract/slots.ts'
import type { ChatSnapshot } from './contract/snapshot.ts'
import { EMPTY_CHAT_SNAPSHOT } from './contract/snapshot.ts'
import { ApprovalCommand } from './chat/ApprovalCommand.tsx'
import { ChatView } from './chat/ChatView.tsx'
// fork（corum 重设计）：全局换肤——官方默认风 → corum 液态玻璃语言（见 corum-reskin.css）。
import './corum-reskin.css'
import { registerChatNodeRenderers } from './chat/register-node-renderers.ts'
import { registerConversationNodes } from './conversation-nodes/register.ts'
import { createReviewSource, type ReviewSource } from './chat/review-source.ts'
import { DetailsPanel } from './details/DetailsPanel.tsx'
import { en, NS, zh } from './locale.ts'
import { TranscriptViewRow, type TranscriptViewRowInjected } from './settings/TranscriptViewRow.tsx'
import { createChatStore } from './stores.ts'
import { TranscriptViewPolicy } from './transcript-view.ts'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../chat-settings.ts'

const CHAT_NODE_INJECT: ChatNodeTurnDataInjected = {
  hooks: {
    turnData: ({ useChat }, nodeKey) => function useTurnData(key) {
      return useChat((snapshot) => {
        const location = snapshot.nodes.get(nodeKey)?.location
        return location?.kind === 'turn' || location?.kind === 'step'
          ? location.turn.data.get(key)
          : undefined
      })
    },
  },
}

/**
 * fork（corum）：子 Agent 卡的跨 bundle 会话/RPC 句柄。
 *
 * `corum-ide-ui` 壳与 `corum-ui-chat` 渲染层是两个 bundle，模块级状态互不通
 * （tsdown noExternal 各自内联）——cordis 服务实例天然跨 bundle 单例（root
 * reflect.store），所以在 apply 时把「当前会话 id + connection」挂到 window
 * 单例，供 SubagentCard 轮询子会话进度时读取（与 __corumSidebarMode /
 * __corumSlotRegistry 同模式：write-once-per-mount，只读消费）。
 */
interface CorumChatRuntime {
  sessionId: string | undefined
  connection: ConnectionHandle | undefined
}
declare global {
  interface Window {
    __corumChatRuntime?: CorumChatRuntime
    /** 子 Agent 卡 act-goto 的跳子会话桥（apply.ts 挂载，官方 sessions.open 寻址）。 */
    __corumOpenSession?: (id: string) => void
  }
}

/** Services required by the Chat target and its presentation registrations. */
export const inject = [
  'slots', 'sessions', 'uiSession', 'uiConversation', 'layout', 'locale',
  'settingsScope', 'remote', 'remote.session',
]

/**
 * Mount all Chat-owned contributions.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const chatSources = new WeakMap<SessionBinding, ObservableSnapshot<ChatSnapshot>>()
  const chatSource = (binding: SessionBinding): ObservableSnapshot<ChatSnapshot> => {
    let source = chatSources.get(binding)
    if (source === undefined) {
      const target = ctx.uiConversation.binding(binding).target('chat')
      source = {
        getSnapshot: () => target.getSnapshot() ?? EMPTY_CHAT_SNAPSHOT,
        subscribe: listener => target.subscribe(listener),
      }
      chatSources.set(binding, source)
    }
    return source
  }
  registerConversationNodes(ctx)
  registerChatNodeRenderers(ctx)
  ctx.uiSession.provide({
    hooks: ['chat'],
    resolve: binding => ({ hooks: { chat: chatSource(binding) } }),
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chat: dictionaries')
  const t = ctx.locale.bind(NS)
  const chatStore = createChatStore()

  // fork（corum）：Review 卡的 per-session 数据源缓存（binding → ReviewSource）。
  const reviewSources = new WeakMap<SessionBinding, ReviewSource>()
  const reviewSource = (binding: SessionBinding): ReviewSource => {
    let source = reviewSources.get(binding)
    if (source === undefined) {
      source = createReviewSource(
        binding.eventSource,
        ctx.get('connection') as ConnectionHandle,
        // 泳道工作区绝对路径（撤销的路径根）：从会话 list 行取 cwd。
        ctx.sessions.list.getSnapshot().byId[binding.sessionId]?.cwd,
      )
      reviewSources.set(binding, source)
    }
    return source
  }
  const chatScrollPositions = new Map<SessionId, ChatScrollPosition>()
  const transcriptView = new TranscriptViewPolicy(
    ctx.settingsScope.bind<ChatSettings>({ namespace: CHAT_SETTINGS_NAMESPACE }),
  )

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'transcript-view',
    order: 12,
    locale: NS,
    inject: (): TranscriptViewRowInjected => ({
      hooks: { transcriptView: transcriptView.mode },
      setTranscriptView: (mode) => { transcriptView.setMode(mode) },
    }),
  }, TranscriptViewRow))

  ctx.slots.inject('conversation.view', () => {
    const disposeView = ctx.slots.register({
      name: 'conversation.view',
      id: 'chat',
      order: 0,
      label: () => t('view.chat'),
      locale: NS,
      children: {
        'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
        'conversation.message.images': { kind: 'single', scope: 'session' },
      },
      store: chatStore,
      inject: (sessionId: SessionId, actions: BoundActions<typeof chatStore>): ChatViewInjected => {
        const binding = ctx.sessions.binding(sessionId)
        const session = binding?.session
        if (binding === undefined || session === undefined) throw new Error(`ui-chat: unknown session "${sessionId}"`)
        // 子 Agent 卡轮询的当前会话/RPC 句柄（view 挂载即更新；cordis 服务跨 bundle 单例）。
        window.__corumChatRuntime = {
          sessionId: String(sessionId),
          connection: ctx.get('connection') as ConnectionHandle,
        }
        // 子 Agent 卡 act-goto 的跳子会话桥（官方 sessions.open 寻址，同步幂等）。
        window.__corumOpenSession = (id: string) => {
          try {
            ctx.sessions.open(SessionId(id))
          } catch {
            // 子会话不可寻址（origin=subagent 或被过滤）时静默——卡片仍可展示进度。
          }
        }
        return {
          review: reviewSource(binding),
          hooks: { transcriptView: transcriptView.mode },
          openDetails: (target) => {
            actions.select(target)
            ctx.layout.openDetails()
          },
          fileMentions: (owner: TurnTailOwnerProps) => ctx.get('chatFileMentions')?.forClosing(owner),
          openFile: async (path) => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
            const result = await ctx.remote.session.openWorkspacePath({
              path: resolveWorkspacePath(cwd, path),
            })
            if (!result.ok) throw new Error(`path open failed: ${result.error.message}`)
          },
          loadOlder: () => { void session.loadOlder() },
          loadImage: Object.assign(
            (attachment: ImageAttachmentRef) => ctx.uiConversation.imageUrl(sessionId, attachment),
            { peek: (attachment: ImageAttachmentRef) => ctx.uiConversation.peekImageUrl(sessionId, attachment) },
          ),
          chatScroll: {
            save: (position) => {
              if (position === null) chatScrollPositions.delete(sessionId)
              else chatScrollPositions.set(sessionId, position)
            },
            read: () => chatScrollPositions.get(sessionId) ?? null,
          },
          forkAt: (seq) => {
            ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
              .then((childId) => { ctx.sessions.open(childId) })
              .catch(() => {
                // Fork or child-title failure leaves the source view unchanged.
              })
          },
          // Agent 头昵称（2026-08-31 用户定调：对话区 Agent 头显示 nickname 而非
          // 通用「Corum Agent」）：task 泳道经 listTaskAgents 定位 profileId，普通
          // 会话用会话 agentPreset；再经 listProfiles 映射 nickname/title/id。
          getAgentName: async () => {
            try {
              // 官方 connection.rpc.call（同 makeCorumRpcCall 通道，不引 corum-rpc-client
              // 包依赖）：call('/api', '<ns>/<method>', { args }) → result.value。
              const connection = ctx.get('connection') as ConnectionHandle
              const rpc = async <T>(method: string): Promise<T> => {
                const result = await connection.rpc.call('/api', `corumAgent/${method}`, { args: {} })
                if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
                return result.value as T
              }
              const sid = String(sessionId)
              let profileId: string | undefined
              if (sid.startsWith('corum-task-')) {
                const tasks = await rpc<{ tasks: readonly { sessionId: string; profileId: string }[] }>('listTaskAgents')
                profileId = (tasks.tasks ?? []).find((x) => x.sessionId === sid)?.profileId
              }
              // 普通官方会话（非 task 泳道）的 profileId 暂无可直接读取的快照字段，
              // 回退「Corum Agent」。
              if (profileId === undefined) return undefined
              const profiles = await rpc<{ profiles: readonly { id: string; nickname?: string; title?: string }[] }>('listProfiles')
              const profile = (profiles.profiles ?? []).find((p) => p.id === profileId)
              return profile === undefined ? undefined : (profile.nickname ?? profile.title ?? profile.id)
            } catch {
              return undefined
            }
          },
        }
      },
    }, ChatView)
    return disposeView
  })

  // 底部状态行（conversation.composer.dock 的 StatsLine）已退役（2026-09-02 用户
  // 定调）：会话统计上移 Agent 标题栏状态胶囊 + 下拉详情卡（corum-ide-ui
  // AgentTitleBar + AgentStatusDetail），composer 下方不再重复展示。

  ctx.slots.inject('conversation.approval.detail', () =>
    ctx.slots.register({ name: 'conversation.approval.detail' }, ApprovalCommand))

  ctx.slots.inject('details', () => ctx.slots.register({
    name: 'details',
    locale: NS,
    children: { 'conversation.details.tool': { kind: 'single', scope: 'session' } },
    store: chatStore,
    inject: (): DetailsInjected => ({ closeDetails: () => { ctx.layout.closeDetails() } }),
  }, DetailsPanel))
}
