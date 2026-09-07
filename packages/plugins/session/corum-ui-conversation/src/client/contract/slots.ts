/** Target-neutral Conversation slot declarations and composed component props. */
import type { ReactNode, RefObject } from 'react'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  MaybeSnapshotSelectorHook, ObservableSnapshot, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-store'
import type {
  InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ComposerBlock } from './composer-blocks.ts'
import type {
  ComposerKeyboard, DraftAttachmentId, EditSelection, InputActions, InputNotice, InputState,
} from './input.ts'
import type { createConversationStore } from '../stores.ts'
import type { ComposerSubmitGesture, InputSubmitMode } from './composer-submission.ts'
import type { ConversationSnapshot } from './snapshot.ts'
import type { ViewTab } from './views.ts'

/** Browser-owned draft attachment that has not crossed the durable Host boundary. */
export type ComposerAttachment = ComposerImageAttachment | ComposerFileAttachment

/** Browser-owned image, base64-encoded into the prompt at send time. */
export interface ComposerImageAttachment {
  kind: 'image'
  id: DraftAttachmentId
  file: File
  previewUrl: string
  /** Intrinsic pixel width, filled asynchronously by the intake header probe. */
  width?: number
  /** Intrinsic pixel height, filled asynchronously by the intake header probe. */
  height?: number
}

/** Browser-owned generic file whose bytes upload to the Host as soon as it is picked. */
export interface ComposerFileAttachment {
  kind: 'file'
  id: DraftAttachmentId
  file: File
}

/** Upload lifecycle of one picked file draft (files upload on pick, not on send). */
export type DraftFileUpload =
  | { readonly status: 'uploading'; readonly loaded: number; readonly total?: number }
  | { readonly status: 'ready'; readonly receiptId: FileUploadReceiptId; readonly file: FileAttachmentRef }
  | { readonly status: 'error'; readonly message: string }

/** Per-draft upload states keyed by draft attachment id. */
export type DraftFileUploads = Readonly<Record<string, DraftFileUpload>>

/** Input state handed to the optional attachment presentation plugin. */
export interface ComposerAttachmentsOwnerProps {
  /** Browser-owned draft attachments in input order. */
  attachments: readonly ComposerAttachment[]
  /** Whether a document-level file drop may add attachments now. */
  canAcceptDrop: boolean
  /** Add one dropped batch through the composer's validation path. */
  onAddFiles: (files: readonly File[]) => void
  /** Remove one draft attachment through the Conversation service. */
  onRemoveAttachment: (id: DraftAttachmentId) => void
  /** Current per-draft upload states for file-kind attachments. */
  uploads: DraftFileUploads
  /** Restart one failed file upload. */
  onRetryFile: (id: DraftAttachmentId) => void
  /** Display-ready limits for the drop invitation. */
  dropLimits?: { readonly count: number; readonly size: string } | undefined
}

/**
 * One image inside a message record: a durable admitted reference, or the
 * local preview of a submission echo whose admission is still in flight.
 */
export type MessageImageSource =
  | { readonly attachment: ImageAttachmentRef }
  | {
    readonly preview: {
      /** Browser-owned preview URL (lifecycle stays with the submitter). */
      readonly url: string
      readonly name?: string
      /** Intrinsic pixel width, when the intake probe has resolved it. */
      readonly width?: number
      /** Intrinsic pixel height, when the intake probe has resolved it. */
      readonly height?: number
    }
  }

/** Durable image loader with an optional synchronous cache read. */
export type MessageImageLoader = ((attachment: ImageAttachmentRef) => Promise<string>) & {
  peek?: (attachment: ImageAttachmentRef) => string | undefined
}

/** Message image group handed to the optional attachment presentation plugin. */
export interface MessageImagesOwnerProps {
  /** Durable references or submission-echo previews in source order. */
  images: readonly MessageImageSource[]
  /** Session-authorized image URL loader for the durable arm. */
  loadImage: MessageImageLoader
  /** Horizontal placement inside the owning record. */
  align: 'start' | 'end'
  /** Force every image into the compact message-attachment tile size. */
  compact?: boolean
}

/** Slot-backed renderer used by Conversation targets without importing an attachment implementation. */
export type RenderMessageImages = (owner: Omit<MessageImagesOwnerProps, 'loadImage'>) => ReactNode

/** Selector hook over the current Session's assembled Conversation. */
export type UseConversation = SnapshotSelectorHook<ConversationSnapshot>
/** Selector hook over the registered Conversation View roster. */
export type UseConversationViews = SnapshotSelectorHook<readonly ViewTab[]>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Strict per-Session Conversation body. */
    'conversation.session': { kind: 'single'; scope: 'session' }
    /** Strict per-Session title, actions, and View navigation. */
    'conversation.session.header': { kind: 'single'; scope: 'session' }
    /** Optional replacement for one Session breadcrumb title. */
    'conversation.session.header.lineage': {
      kind: 'single'
      scope: 'session'
      owner: ConversationHeaderLineageOwnerProps
    }
    /** Title-adjacent Session actions in ascending order. */
    'conversation.session.header.actions': {
      kind: 'list'
      scope: 'session'
      owner: ConversationHeaderActionOwnerProps
    }
    /** Right-aligned Session utilities in ascending order. */
    'conversation.session.header.utilities': {
      kind: 'list'
      scope: 'session'
      owner: ConversationHeaderActionOwnerProps
    }
    /** Registered Conversation target Views, rendered one at a time. */
    'conversation.view': { kind: 'list'; scope: 'session'; owner: ConvViewOwnerProps }
    /** Selector-routed replacements for the current Session's resident composer. */
    'conversation.composer': { kind: 'chain'; scope: 'session'; owner: ComposerChainProps }
    /** Workspace picker shown by the blank-session Hero. */
    'conversation.hero.workspace': { kind: 'single'; scope: 'root'; owner: EmptyWorkspaceOwnerProps }
    /** Brand mark shown before the blank-session headline. */
    'conversation.hero.brand.mark': { kind: 'single'; scope: 'root'; owner: HeroBrandMarkOwnerProps }
    /** Agent-preset control staged for a New Session. */
    'conversation.hero.agentPreset': { kind: 'single'; scope: 'root'; owner: HeroAgentPresetOwnerProps }
    /** Full-width entries above the composer card. */
    'conversation.input.dock': { kind: 'list'; scope: 'session'; owner: InputZone }
    /** Floating entries rendered inside the resident composer card. */
    'conversation.input.overlay': { kind: 'list'; scope: 'session' }
    /** Ambient entries below the composer card. */
    'conversation.composer.dock': { kind: 'list'; scope: 'session' }
    /** Compact controls at the left of the composer tool row. */
    'conversation.input.left': { kind: 'list'; scope: 'session' }
    /** Compact controls before the composer submit action. */
    'conversation.input.right': { kind: 'list'; scope: 'session' }
    /** Resident composer body, including the no-Session inert state. */
    'conversation.composer.bar': { kind: 'single'; scope: 'session-maybe'; owner: ComposerBarOwnerProps }
    /** Optional draft-attachment rail and drop target. */
    'conversation.input.attachments': {
      kind: 'single'
      scope: 'session-maybe'
      owner: ComposerAttachmentsOwnerProps
    }
    /** Plan control inside the composer tool row. */
    'conversation.input.plan': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }
    /** Model selector inside the composer tool row. */
    'conversation.input.model': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }
  }

  interface GlobalStandardProps {
    /** Workspace selector supplied by the independently loaded Workspace UI. */
    useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
  }

  interface SessionStandardProps {
    /** Selector hook over target-neutral Conversation assembly. */
    useConversation: UseConversation
    /** Selector hook over the Session input machine. */
    useInput: SnapshotSelectorHook<InputState>
    /** Stable public input actions for this Session. */
    inputActions: InputActions
  }

  interface SessionMaybeStandardProps {
    /** Selector hook whose values are absent without a current Session. */
    useConversation: MaybeSnapshotSelectorHook<ConversationSnapshot>
    /** Input values are absent without a current Session. */
    useInput: MaybeSnapshotSelectorHook<InputState>
    /** Input actions are absent without a current Session. */
    inputActions: InputActions | undefined
  }
}

/** Owner share of the Hero agent-preset control. */
export interface HeroAgentPresetOwnerProps {
  /** Marker field: the occupant owns its roster and staged selection. */
  children?: never
}

/** Header actions derive their state from standard Session props. */
export interface ConversationHeaderActionOwnerProps {
  /** Marker field: entries receive no owner-specific values. */
  children?: never
}

/** Plain breadcrumb data handed to the optional lineage renderer. */
export interface ConversationHeaderLineageOwnerProps {
  /** Session represented by this breadcrumb title. */
  lineageSessionId: SessionId
  /** Display title available to a combined title/control renderer. */
  displayTitle: string
  /** Navigate to an ancestor title when present. */
  openTitle?: () => void
}

/** Point-in-time owner values for composer extension entries. */
export interface InputZone {
  readonly session: SessionSnapshot
  readonly input: InputState
}

/** Conversation View entries obtain their data from registered standard hooks. */
export interface ConvViewOwnerProps {
  /** Focus request addressed to the selected View. */
  viewRequest: import('./views.ts').ConversationViewRequest | null
  /** Select a View and address one opaque focus identity to it. */
  openView: (view: string, focus: string) => void
  /** Acknowledge the current one-shot focus request. */
  completeViewRequest: () => void
}

/** Base props of one target-owned Conversation View entry. */
export type ConvViewProps = PropsRuntime<'conversation.view'>

/** Business callbacks injected into the resident Conversation shell. */
export interface ConversationInjected {
  /** Connect and open a blank Session in the selected Workspace. */
  selectWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /** Session-addressed composer block source, or the stable absent source. */
  hooks: { composerBlock: ObservableSnapshot<ComposerBlock | undefined> }
  emptyActions: {
    /** 最近项目列表（corumProject.listProjects）。 */
    listProjects: () => Promise<readonly { id: string; name: string; memberCount?: number; updatedAt?: number }[]>
    /** 进入某个项目（切项目模式 + 打开项目实体，ProjectPane 接管详情）。 */
    openProject: (projectId: string) => Promise<void>
    /** 新建项目（切项目模式 + 目录选择器分流，ProjectPane 接管向导）。 */
    newProject: () => Promise<void>
    /** 进入某个任务泳道（切任务模式 + sessions.open）。 */
    openTask: (sessionId: string) => Promise<void>
    /** 新建任务（切任务模式 + 起 task 泳道）。不传 cwd 时取当前/最近工作区，
     *  无则先弹目录选择器；profileId 缺省用内置 task profile；permission 缺省
     *  沿用全局默认档位。 */
    newTask: (options?: NewTaskOptions) => Promise<void>
    /** 可选的 Agent profile 列表（corumAgent.listProfiles，含各 Agent 默认模型）。 */
    listAgents: () => Promise<readonly AgentOption[]>
    /** 可选模型目录（corumAgent.listModels，provider→models）。新建任务表单模型
     *  下拉的数据源：选定 Agent 后默认取该 Agent 的默认模型，用户仍可改。 */
    listModels: () => Promise<readonly ModelProviderOption[]>
    /** 含推理元数据的模型目录（session/modelCatalog，与 composer 模型选择器同源）。
     *  新建任务表单的「模型 + 推理等级」两级面板数据源：每个模型带 reasoning
     *  （efforts + defaultEffort）；无 reasoning 的模型（如部分第三方路由）不显示
     *  推理等级入口。 */
    listModelCatalog: () => Promise<readonly ModelProviderGroup[]>
    /** 可选的访问权限档位（corumAgent.listPermissionPresets，官方 preset 表）。
     *  返回含 `defaultPreset` 的整体值——默认档位取官方 defaultPreset（组合默认
     *  workspace-write），不能取列表首项（表首项恰是 read-only，最严档）。 */
    listPermissions: () => Promise<PermissionSelect>
    /** 选择工作目录（host directoryPicker Remote）；取消返回 null。 */
    pickDirectory: () => Promise<string | null>
    /** task 泳道会话的 Agent 显示名（设计稿副标语「由 X 执行」）；非 task 会话/查询失败返回 undefined。 */
    getTaskAgentName: (sessionId: string) => Promise<string | undefined>
    /** task 泳道会话的 Agent 名片信息（显示名 + 岗位 + 岗位维度）——对话起始页
     *  按专业方向定制推荐命令的数据源；非 task 会话/查询失败返回 undefined。 */
    getTaskAgentInfo: (sessionId: string) => Promise<TaskAgentInfo | undefined>
    /** task 泳道会话当前绑定的 Agent profileId（composer 可选 Agent chip 的选中值）；非 task 会话/查询失败返回 undefined。 */
    getTaskAgentProfileId: (sessionId: string) => Promise<string | undefined>
    /** 切换 task 泳道的 Agent（新会话界面 composer 可选 Agent chip）。blank 限定：
     *  泳道已开始（有 turn）时 host 拒绝（agent-preset/locked），调用方应 catch 呈现。 */
    selectTaskAgent: (sessionId: string, profileId: string) => Promise<void>
    /** 已注册的工作区列表（官方 ctx.workspaces 快照）——新建任务在**已有列表里选**。 */
    listWorkspaces: () => Promise<readonly WorkspaceOption[]>
  }
  /**
   * 会话内提示词润色（corumAgent/polishConversation）：结合当前 session 最近
   * 若干条「user 提问 + AI 最终输出」（不含 reasoning/tool），把草稿改写成
   * Agent 能充分理解意图、良好衔接任务的输入。意图自动判断（推进/新问题/BUG）。
   */
  polishDraft: (sessionId: string, text: string) => Promise<string>
  /**
   * 「新建任务表单」打开信号面（侧栏顶部「新会话」按钮 → 空态联动）。
   * 实现桥到 ctx.layout 的 grid actions（AppFrame 持有监听者集与 pending
   * 标记）：已挂载时 onOpen 监听者被直推；未挂载（在会话视图）时
   * consumePending 在挂载时认领标记。原 OPEN_NEW_TASK_FORM_EVENT +
   * sessionStorage 桥已退役。
   */
  newTaskForm: {
    /** 订阅「打开新建任务表单」信号（EmptyStateHero 挂载期）。返回退订函数。 */
    onOpen: (listener: () => void) => () => void
    /** 认领 pending 的打开标记（EmptyStateHero 挂载时调一次）。 */
    consumePending: () => boolean
  }
}

export interface AgentOption {
  id: string
  /** 显示名（nickname 优先，其次 title/id）。 */
  name: string
  /** 该 Agent 的默认模型（profile.model）——选定 Agent 后模型下拉默认选中它。 */
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 目录来源（2026-09-02 并列展示）：'corum' = corum Agent；'official' = 官方
   *  四模式（cordis/minimal/ptc/standard，模型跟随部署默认）。下拉按此分组标注。 */
  source?: 'corum' | 'official'
  /** 信任级（corum profile.trust）：'system' = Corum 内置（25 个行业预置 +
   *  PM/Task 兜底）；'user' = 用户自定义。official preset 恒为 system 但其分组
   *  由 source 决定（「通用」组），分组判断先看 source、corum 内再看 trust。 */
  trust?: 'system' | 'user'
  /** 岗位 / 职位（corum profile.title；official preset 无）。 */
  title?: string
  /** 岗位维度（corum profile.dimension：研发/产品/设计/市场/自媒体/创作；official 无）。 */
  dimension?: string
}

/** task 泳道 Agent 的名片信息（对话起始页按专业方向定制推荐命令）。 */
export interface TaskAgentInfo {
  /** 显示名（nickname 优先，其次 title/id）。 */
  name: string
  /** 岗位 / 职位（corum profile.title；official preset 无）。 */
  title?: string
  /** 岗位维度（corum profile.dimension；official preset 无 → 推荐命令回退通用集）。 */
  dimension?: string
}

/** 模型目录里的一个 provider（corumAgent.listModels 投影）。 */
export interface ModelProviderOption {
  id: string
  name: string
  models: readonly { id: string; name: string }[]
}

/** 一个推理档位（session/modelCatalog 投影的 adapter-owned effort）。 */
export interface ModelEffortOption {
  id: string
  name: string
  description?: string
}
/** 一个模型的推理元数据（可选档位 + provider 默认档）。 */
export interface ModelReasoningInfo {
  efforts: readonly ModelEffortOption[]
  defaultEffort?: string
}
/** 含推理元数据的一个模型（session/modelCatalog 投影）。 */
export interface ModelCatalogModelOption {
  id: string
  name: string
  reasoning?: ModelReasoningInfo
}
/** 含推理元数据的模型 provider 分组（session/modelCatalog 投影）。 */
export interface ModelProviderGroup {
  id: string
  name: string
  models: readonly ModelCatalogModelOption[]
}

/** 新建任务表单的一个访问权限档位（官方 permissionPresets 预设表投影）。 */
export interface PermissionOption {
  /** 档位 id（= 官方 preset key：read-only / workspace-write / danger-full-access）。 */
  id: string
  /** 官方配置的显示名（未配置时回落到 preset key）。 */
  name: string
  /** 官方配置的一句话说明。 */
  description?: string
}

/** 权限档位选择器的整体值：可选档位 + 官方默认档位。 */
export interface PermissionSelect {
  presets: readonly PermissionOption[]
  /** 官方 defaultPreset（组合默认 = workspace-write）。 */
  defaultPreset: string
}

/** 新建任务表单的提交参数。 */
/** 新建任务表单的一个工作区选项（官方 ctx.workspaces 快照投影）。 */
export interface WorkspaceOption {
  id: string
  /** 显示名（官方 title）。 */
  title: string
  /** 绝对目录路径。 */
  path: string
}

export interface NewTaskOptions {
  /** 工作目录（必填，无默认）。 */
  cwd: string
  /** Agent profile id（缺省用内置 task profile）。 */
  profileId?: string
  /** 访问权限档位 id（缺省沿用全局默认）。 */
  permission?: string
  /** 覆盖模型（缺省用 Agent profile 的默认模型）。 */
  model?: { provider: string; model: string; reasoningEffort?: string }
}

/** Business callbacks injected into the strict Session body. */
export interface ConversationSessionInjected {
  /** Package-owned View roster source bound only for the Conversation body. */
  readonly hooks: { readonly conversationViews: ObservableSnapshot<readonly ViewTab[]> }
  /** Bind input draft persistence to the Session-owned store instance. */
  bindDraftMirror: (write: (text: string) => void) => () => void
  /** Select and activate one View while addressing an opaque focus request to it. */
  openView: (view: string, focus: string) => void
}

/** Business callbacks injected into the strict Session header. */
export interface ConversationSessionHeaderInjected {
  /** Package-owned View roster source bound only for the Conversation header. */
  readonly hooks: { readonly conversationViews: ObservableSnapshot<readonly ViewTab[]> }
  /** Select a Session through the Session Controller. */
  open: (sessionId: SessionId) => void
  /** Select and activate one registered Conversation View. */
  selectView: (view: string) => void
}

/** Owner share of the resident composer bar. */
export interface ComposerBarOwnerProps {
  /** Hero uses centered placement; composer uses the active bottom placement. */
  variant: 'hero' | 'composer'
  /** A feature-owned reason that makes message input inert while leaving model selection live. */
  blocked?: { readonly reason: string }
  /** Lock all message actions while preserving the resident composer surface. */
  disabled?: boolean
  /** Whether the shared Workspace picker is expanded. */
  workspacePickerOpen?: boolean
  /** Open the Workspace picker from the inert composer surface. */
  onRequestWorkspace?: () => void
  placeholder?: string
  /** Optional content rendered above the composer surface. */
  accessory?: ReactNode
  /** fork（corum）：工具栏左侧前导内容（Agent 选择下拉 + AI 润色按钮），渲染在
   * 访问模式选择器之后、`conversation.input.left` 槽之前。官方 0.1.3 删除了
   * leftItems owner prop，corum 以此增量字段保留工具栏内定制（不改官方字段）。 */
  toolbarLeading?: ReactNode
}

/** Package-private operations injected into the resident composer bar. */
export interface ComposerBarInjected {
  keyboard: ComposerKeyboard | undefined
  addFiles: ((files: readonly File[]) => string | null) | undefined
  removeAttachment: ((id: DraftAttachmentId) => void) | undefined
  resolveDraftAttachments: ((ids: readonly DraftAttachmentId[]) => readonly ComposerAttachment[]) | undefined
  /** Restart one failed file upload; absent without a session. */
  retryFileUpload: ((id: DraftAttachmentId) => void) | undefined
  resolveSubmitMode: (
    running: boolean,
    gesture: ComposerSubmitGesture,
    steeringAvailable: boolean,
  ) => InputSubmitMode
  toggleCommandMenu: ((selection: EditSelection) => void) | undefined
  stop: (() => void) | undefined
  command: ((line: string) => Promise<boolean>) | undefined
  hooks: {
    /** Live per-draft upload states for file-kind drafts. */
    fileUploads: ObservableSnapshot<DraftFileUploads>
    notices: ObservableSnapshot<InputNotice | null>
    lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>>
    menuLauncher: ObservableSnapshot<string | null>
  }
}

/** Owner share of the named plan and model controls. */
export interface InputControlOwnerProps {
  /** Whether the composer currently refuses interaction. */
  locked: boolean
}

/** Full props of the resident composer bar. */
export type ComposerBarProps =
  PropsRuntime<'conversation.composer.bar'>
  & PropsRenderSlots<
    | 'conversation.input.attachments' | 'conversation.input.overlay'
    | 'conversation.input.left' | 'conversation.input.plan'
    | 'conversation.input.right' | 'conversation.input.model'
    | 'conversation.composer.dock'
  >
  & InjectFace<ComposerBarInjected>
  & PropsLocale<'conversation'>

/** Owner values used to elect a composer takeover. */
export interface ComposerChainProps {
  /** Current Session identity used by temporary business-owned entries. */
  sessionId: SessionId | undefined
  /** Current Session lifecycle state, absent without a selected Session. */
  session: SessionSnapshot | undefined
  /** Effective business-owned interaction awaiting the user in this Session. */
  pendingInteraction: SessionPendingInteraction | undefined
}

/** Presentation props supplied to the blank-session brand mark. */
export interface HeroBrandMarkOwnerProps {
  /** Requested square edge in pixels. */
  size: number
  /** Host class preserving the surrounding mark geometry. */
  className?: string | undefined
}

/** Full props of the resident optional-Session Conversation shell. */
export type ConversationSlotProps =
  PropsRuntime<'conversation'>
  & PropsRenderSlots<
    | 'conversation.session' | 'conversation.session.header'
    | 'conversation.composer' | 'conversation.composer.bar'
    | 'conversation.input.dock'
    | 'conversation.hero.brand.mark'
    | 'conversation.hero.workspace'
    | 'conversation.hero.agentPreset'
  >
  & InjectFace<ConversationInjected>
  & PropsLocale<'conversation'>

/** Shared target-neutral Conversation store handle. */
export type ConversationStore = ReturnType<typeof createConversationStore>

/** Full props of the strict Session body. */
export type ConversationSessionSlotProps =
  PropsRuntime<'conversation.session'>
  & PropsRenderSlots<'conversation.view'>
  & PropsStore<ConversationStore>
  & InjectFace<ConversationSessionInjected>

/** Full props of the strict Session header. */
export type ConversationSessionHeaderSlotProps =
  PropsRuntime<'conversation.session.header'>
  & PropsRenderSlots<
    'conversation.session.header.lineage'
    | 'conversation.session.header.actions'
    | 'conversation.session.header.utilities'
  >
  & PropsStore<ConversationStore>
  & InjectFace<ConversationSessionHeaderInjected>
  & PropsLocale<'conversation'>

/** Full props of the draft-attachment renderer. */
export type ComposerAttachmentsProps =
  PropsRuntime<'conversation.input.attachments'> & PropsLocale<'conversation'>

/** Owner share common to blank-session Workspace pickers. */
export interface EmptyWorkspaceOwnerProps {
  open: boolean
  anchorRef?: RefObject<HTMLElement>
  /** Currently selected Workspace, when available. */
  selectedId?: WorkspaceId | undefined
  onPick: (workspaceId: WorkspaceId) => void
  onClose: () => void
}
