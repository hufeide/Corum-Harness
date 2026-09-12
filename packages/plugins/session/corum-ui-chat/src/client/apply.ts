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
import { registerReviewDock } from './chat/ReviewDock.tsx'
import { DetailsPanel } from './details/DetailsPanel.tsx'
import { en, NS, zh } from './locale.ts'
import { TranscriptViewRow, type TranscriptViewRowInjected } from './settings/TranscriptViewRow.tsx'
import { createChatStore } from './stores.ts'
import { TranscriptViewPolicy } from './transcript-view.ts'
import { createChatRuntime, primeSubagentChildCache, type ChatRuntimeService } from './chat-runtime.ts'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../chat-settings.ts'
import { useTurnDataValue } from './chat/use-turn-data.ts'

const CHAT_NODE_INJECT: ChatNodeTurnDataInjected = {
  hooks: {
    turnData: (_standard, data) => function useTurnData(key) {
      return useTurnDataValue(data, key)
    },
  },
}

/**
 * fork（corum）：子 Agent 卡的跨 bundle 会话/RPC 句柄 → cordis 服务（统一事件
 * 中心二期 window 全局迁移）。
 *
 * `corum-ide-ui` 壳与 `corum-ui-chat` 渲染层是两个 bundle，模块级状态互不通
 * （tsdown noExternal 各自内联）——cordis 服务实例天然跨 bundle 单例（root
 * reflect.store）。原实现把「当前会话 id + connection + 跳子会话桥」挂 window
 * 全局（`__corumChatRuntime` / `__corumOpenSession`），跨 bundle 共享可变状态
 * 违反红线 1。现收敛为 cordis 服务 `ctx.chatRuntime`（provide 于下方 apply）+
 * uSES 源；SubagentCard（同 bundle 纯组件）经 chat-runtime.ts 的模块级
 * `chatRuntimeRef` 消费同一实例。服务实现见 chat-runtime.ts。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 子 Agent 卡的当前会话 id + RPC connection + 跳子会话桥（cordis 服务）。 */
    chatRuntime: ChatRuntimeService
    /**
     * 「在编辑器打开」可编程入口的服务面镜像（统一事件中心三-2）：实现由
     * desktop client（@corum/corum-desktop，另一 bundle）provide——chat 不依赖
     * desktop 包（desktop 是壳装配根，反向依赖会成环），故 Context 合并在本地
     * 声明镜像 + 消费侧再用能力接口收窄（dev-conventions §2.4/§3.5：编译期
     * 保障、零运行时耦合；改面时两侧同步——注释锚定 corum-editor.ts 源）。
     */
    corumEditor: EditorOpenCapable
  }
}

/**
 * ctx.corumEditor 的能力接口收窄（dev-conventions §2.4 红线 2/3）：服务由
 * desktop client（@corum/corum-desktop，另一 bundle）provide，chat 只取
 * openFile 一个方法，可选链防御实现缺席。
 */
interface EditorOpenCapable {
  openFile?: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>
}

/** corumEditor 的「打开改动前后 diff」能力面（Review 卡点击文件行用）。 */
interface ContentDiffCapable {
  openContentDiff?: (input: {
    absolutePath: string
    originalContent: string
    note?: string | undefined
  }) => Promise<{ ok: boolean; error?: string }>
}

/** `__corumNotify` 一次写只读桥（规范 §1 例外：CorumNotification 面）。 */
interface CorumNotifyBridge {
  __corumNotify?: (n: { tone: 'error'; title: string; message?: string | undefined }) => void
}

/** 用户可见失败反馈（失败路径统一走这里，避免各处重复拼 window 断言）。 */
function notifyUser(title: string, message?: string | undefined): void {
  const notify = (window as unknown as CorumNotifyBridge).__corumNotify
  notify?.({ tone: 'error', title, ...message === undefined ? {} : { message } })
}

/** Services required by the Chat target and its presentation registrations. */
export const inject = [
  'slots', 'sessions', 'uiSession', 'uiConversation', 'layout', 'locale',
  'settingsScope', 'remote', 'remote.session',
  // 统一事件中心三-2：corum:open-in-editor 跨 bundle CustomEvent → corumEditor
  // cordis 服务（desktop client provide；红线 4 必须 inject 声明）。
  'corumEditor',
  // P2-3（2026-09-09 复核补齐）：本包 3 处 ctx.get('connection')（reviewSource /
  // chatRuntime.setSession / getAgentName RPC）此前未声明 inject——红线 4 违规。
  // connection 是官方 client 平台服务（ui-conversation/desktop 同款注入），
  // 声明后 cordis 保证激活时序、ctx.get 不再依赖「碰巧已装配」。
  'connection',
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
  // fork（corum）：chatRuntime cordis 服务（替代 __corumChatRuntime/__corumOpenSession
  // window 全局）。provide 后任何 bundle 可 inject；同 bundle 的 SubagentCard 经
  // chat-runtime.ts 模块级 chatRuntimeRef 拿同一实例。服务在 conversation.view 的
  // inject 回调里随会话切换更新（见下方 setSession/setOpenSession）。
  const chatRuntime = createChatRuntime()
  // 统一事件中心三-3：'corum/subagent/progress' 推送订阅入口（SubagentCard
  // 经 chatRuntimeRef 模块级引用消费，无 inject 面；remote 面在此注入服务）。
  // 本插件 inject 数组已含 'remote'（红线 4 声明消费）。
  chatRuntime.setRemote(ctx.remote)
  ctx.provide('chatRuntime', chatRuntime)
  // 2026-09-09：spawn 精确父子映射的订阅在激活期就建好——卡片挂载晚于广播时，
  // 仍能从进程内缓存拿到 childSessionId（运行中即可跳子会话）。
  ctx.effect(() => primeSubagentChildCache(), 'ui-chat:subagent-child-prime')
  ctx.uiSession.provide({
    hooks: ['chat'],
    resolve: binding => ({ hooks: { chat: chatSource(binding) } }),
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chat: dictionaries')
  const t = ctx.locale.bind(NS)
  const chatStore = createChatStore()

  // fork（corum）：Review 卡的 per-session 数据源缓存（binding → ReviewSource）。
  // 2026-09-11 起数据源是 host 的影子 git 仓库（corumReview）：客户端不再从事件流
  // 反推改动、也不再自算行数/水位，只把 sessionId 交给 host。
  const reviewSources = new WeakMap<SessionBinding, ReviewSource>()
  const reviewSource = (binding: SessionBinding): ReviewSource => {
    let source = reviewSources.get(binding)
    if (source === undefined) {
      source = createReviewSource(
        String(binding.sessionId),
        ctx.get('connection') as ConnectionHandle,
        binding.eventSource,
      )
      reviewSources.set(binding, source)
    }
    return source
  }

  /**
   * 在内置编辑器打开一个（可能相对 cwd 的）文件路径。
   *
   * 抽成公共闭包是因为 Review 卡的**两个**渲染面都要用它：ChatView 的文件提及
   * 链接（`openFile` prop）与 ReviewDock 的展开态文件行（`onOpenFile`）。早先
   * 这段逻辑内联在 view 的 inject 里，Review 卡搬去 dock 后就够不着了。
   *
   * 统一事件中心三-2：原 corum:open-in-editor 跨 bundle CustomEvent（fire-and-
   * forget 无失败反馈）→ corumEditor cordis 服务直调（desktop client provide，
   * 内部转相对路径 + 点亮编辑器 + pending 挂载认领）。{ ok, error } 结构化反馈：
   * error 时 console.warn + 框架通知（用户可见）。
   */
  const openFileAt = async (sessionId: SessionId, path: string): Promise<void> => {
    const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
    const absolute = resolveWorkspacePath(cwd, path)
    const editor = ctx.corumEditor as unknown as EditorOpenCapable
    if (typeof editor.openFile !== 'function') {
      console.warn('[ui-chat] openFile: corumEditor service missing openFile face')
      return
    }
    try {
      const result = await editor.openFile(absolute)
      if (!result.ok) {
        console.warn('[ui-chat] openFile failed:', result.error, { path: absolute })
        notifyUser('无法在编辑器打开文件', result.error)
      }
    } catch (err) {
      console.warn('[ui-chat] openFile threw:', err, { path: absolute })
    }
  }
  const chatScrollPositions = new Map<SessionId, ChatScrollPosition>()
  const transcriptView = new TranscriptViewPolicy(
    ctx.settingsScope.bind<ChatSettings>({ namespace: CHAT_SETTINGS_NAMESPACE }),
  )

  /**
   * fork（corum）：把「改动审查保留天数」推给 host 的影子 git 仓库服务。
   *
   * 设置值存在 settings.yaml（namespace `corum-review`），而**读取方在 host**——
   * host 侧没有 settings 读取面（与 corum-git 当年只注册不退推同款约束），所以由
   * 客户端在启动时与每次变更后推一次 `corumReview/setRetention`。
   * 推送失败不阻断：host 会停在默认值（1 天），功能照常。
   */
  const reviewRetention = ctx.settingsScope.bind<{ retentionDays?: number }>({ namespace: 'corum-review' })
  const pushRetention = (): void => {
    const days = reviewRetention.getSnapshot().value?.retentionDays ?? 1
    void (ctx.get('connection') as ConnectionHandle)
      .rpc.call('/api', 'corumReview/setRetention', { args: { days } })
      .catch((error: unknown) => {
        console.warn('[ui-chat] push review retention failed:', error)
      })
  }
  pushRetention()
  reviewRetention.subscribe(() => { pushRetention() })

  // fork（corum）：Review 卡注册进 `conversation.input.dock`（与 TodoPanel 同槽），
  // 由 ConversationRoot 的 sticky composerSeat 统一吸附 —— 不再依赖 DOM 选择器
  // 捞 composerStack 做 portal（见 Chat/ReviewDock.tsx 顶部注释）。
  registerReviewDock(ctx, (sessionId) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ui-chat: unknown session "${sessionId}"`)
    const source = reviewSource(binding)
    return {
      review: source,
      cwd: ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd,
      // 点击文件行 → 「本轮改动前 ↔ 当前」diff tab。两步：
      //   ① source.fileBefore(path) 从影子 git 仓库取**精确**的改动前内容；
      //   ② corumEditor.openContentDiff 把原文交给编辑器开 diff tab。
      // 用户可见失败反馈走 __corumNotify（一次性只读桥，规范 §1 例外）。
      openDiff: (path: string) => {
        void (async () => {
          const result = await source.fileBefore(path)
          if (!result.ok) {
            console.warn('[ui-chat] openDiff: fileBefore failed:', result.message, { path })
            notifyUser('取不到该文件的改动前内容', result.message)
            return
          }
          const editor = ctx.corumEditor as unknown as ContentDiffCapable
          if (typeof editor.openContentDiff !== 'function') {
            console.warn('[ui-chat] openDiff: corumEditor service missing openContentDiff face')
            notifyUser('无法打开改动对比', '当前编辑器不支持 diff 视图')
            return
          }
          const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
          const absolute = resolveWorkspacePath(cwd, path)
          const opened = await editor.openContentDiff({
            absolutePath: absolute,
            originalContent: result.content,
            ...result.complete ? {} : { note: result.note ?? '左侧为尽力重建的内容，可能不等于本轮改动前的完整原文' },
          })
          if (!opened.ok) {
            console.warn('[ui-chat] openDiff failed:', opened.error, { path: absolute })
            notifyUser('无法打开改动对比', opened.error)
          }
        })()
      },
    }
  })

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
        if (binding === undefined) throw new Error(`ui-chat: unknown session "${sessionId}"`)
        const session = binding.session
        const chat = chatSource(binding)
        // 子 Agent 卡轮询的当前会话/RPC 句柄（view 挂载即更新；cordis 服务跨 bundle 单例）。
        chatRuntime.setSession(String(sessionId), ctx.get('connection') as ConnectionHandle)
        // 子 Agent 卡 act-goto 的跳子会话桥（官方 sessions.open 寻址，同步幂等）。
        chatRuntime.setOpenSession((id: string) => {
          try {
            ctx.sessions.open(SessionId(id))
          } catch {
            // 子会话不可寻址（origin=subagent 或被过滤）时静默——卡片仍可展示进度。
          }
        })
        // fork（corum）：子 Agent 改动区（SubagentChanges）打开 diff 的桥——
        // 经 corumEditor cordis 服务直调（与 ReviewDock 的 openDiff 同款收窄）。
        chatRuntime.setOpenContentDiff(async (input) => {
          const editor = ctx.corumEditor as unknown as ContentDiffCapable
          if (typeof editor.openContentDiff !== 'function') {
            notifyUser('无法打开改动对比', '当前编辑器不支持 diff 视图')
            return { ok: false, error: 'corumEditor service missing openContentDiff face' }
          }
          const opened = await editor.openContentDiff(input)
          if (!opened.ok) notifyUser('无法打开改动对比', opened.error)
          return opened
        })
        return {
          hooks: { transcriptView: transcriptView.mode },
          keyedHooks: {
            chatNode: key => chat.getSnapshot().nodes.source(key),
            chatNodeProcess: key => chat.getSnapshot().nodes.processSource(key),
          },
          openDetails: (target) => {
            actions.select(target)
            ctx.layout.openDetails()
          },
          fileMentions: (owner: TurnTailOwnerProps) => ctx.get('chatFileMentions')?.forClosing(owner),
          openFile: async (path) => { await openFileAt(sessionId, path) },
          loadOlder: () => { void session.loadOlder() },
          loadThrough: seq => session.loadThrough(seq),
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
