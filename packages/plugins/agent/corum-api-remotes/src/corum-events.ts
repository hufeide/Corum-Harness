/**
 * corum 领域事件的 cordis `Events` 声明 + Remote 转发选择面（自包含）。
 *
 * fork（corum）：本文件从 `@corum/corum-agent/src/events.ts:212-238` **复制**
 * 12 个领域事件的 `declare module '@deepseek-ai/cordis'` 声明（外加本期新增的
 * 第 13 个 `corum/terminal/output`，见 UNIFIED-EVENT-BUS §3），**不
 * type-import corum-agent**——它是 host-only 包，其 events.ts 有 node-only 值
 * 导入（`./event-log.ts` 追加 jsonl），被拖进 client 编译面会炸。载荷类型在此
 * 自包含重声明（结构以 corum-agent/events.ts 为事实源，均为纯 JSON）。
 *
 * 同时照 `@deepseek-ai/dsh-api-session-controller/src/remote-events.ts:9-12`
 * 的写法，把 corum 事件并入 `TypertRemoteEventSelection`——renderer
 * `ctx.remote.$on('corum/...', cb)` 的 key 面与 listener 签名由此投影。
 *
 * @module @corum/corum-api-remotes/corum-events
 */

// ── 载荷类型（自包含重声明；事实源 = corum-agent/src/events.ts）──────────────

/** 队列条目实体类型（轻量指针，全文在 ctx.project 共享实体）。 */
export type TaskEntityType = 'task' | 'bug' | 'requirement' | 'discussion' | 'review'

/** 队列条目来源通道（谁提交的、经哪条路进入调度）。 */
export type TaskVia = 'transfer' | 'bug-report' | 'user-instruction' | 'dependency' | 'pm-decision'

/** 队列条目来源追溯（提交方组装谁填；支撑回溯与依赖追踪）。 */
export interface TaskSource {
  /** 提交方：角色 profileId、'user' 或 'runtime'。 */
  readonly submitter: string
  readonly via: TaskVia
  readonly at: number
  /** 因果链（阻塞派生/依赖解除/转交等）。 */
  readonly cause?: {
    readonly kind: 'blocked-by' | 'depends-on' | 'assigned' | 'reported'
    readonly byTaskId?: string
  }
}

/** 任务的领域引用（队列条目的 JSON-safe 快照）。 */
export interface TaskRef {
  readonly id: string
  /** 所属项目 id（调度隔离边界）。 */
  readonly projectId: string
  /** 目标角色 = AgentProfile id。 */
  readonly profileId: string
  /** 实体类型（轻量指针指向的共享实体类别；调度期临时任务也用 task）。 */
  readonly entityType: TaskEntityType
  /** 指向 ctx.project 共享实体的 id（未接实体时缺省，队列 id 即临时实体引用）。 */
  readonly entityId?: string
  /** 泳道路由标签：关联需求时为 `<requirementId>:<type>`，否则兼容退化为 `<type>`。 */
  readonly label: string
  /** 工作类型 slug（泳道语义仍保留；路由键是 label）。 */
  readonly type: string
  /** 关联需求 id（label 的需求段；未关联缺省）。 */
  readonly requirementId?: string
  /** 任务摘要。 */
  readonly summary: string
  /** 增量 context（提交方组装，可选）。 */
  readonly transferNote?: string
  /** 来源追溯（提交方/通道/时间/因果）。 */
  readonly source: TaskSource
  /** 优先级（0-3，可选；排序策略后续接）。 */
  readonly priority?: number
}

/** corum/task/assigned：任务入队。 */
export interface TaskAssignedEvent {
  readonly task: TaskRef
  /** 派发者：派活的角色 profileId、'user'（界面/RPC）或 'runtime'（调度器自派生）。 */
  readonly actor: string
  /** 入队后该「项目 × 角色」的队列长度（水位信号）。 */
  readonly queueLength: number
}

/** corum/task/started：任务已派进泳道会话。 */
export interface TaskStartedEvent {
  readonly task: TaskRef
  /** 承载该任务的泳道会话 id。 */
  readonly sessionId: string
  /** 任务占用该会话的起始 seq（团队日志 → Agent 工作现场的下钻起点）。 */
  readonly fromSeq: number
}

/** 指向泳道会话日志里一段工作成果的引用（TEAM-SCHEDULER-EVENT-LOG §6）。 */
export interface SessionResultRef {
  /** 泳道会话 id（官方 session 日志身份）。 */
  readonly sessionId: string
  /** 任务占用该会话的 seq 区间起点。 */
  readonly fromSeq: number
  /** 区间终点（completed 时补齐）。 */
  readonly toSeq: number
}

/** corum/task/completed：任务闭环。 */
export interface TaskCompletedEvent {
  readonly task: TaskRef
  /** 成果落点引用（下钻路径：resultRef → 官方 session 日志 readFrom(sessionId, fromSeq)）。 */
  readonly resultRef: SessionResultRef
  /** 执行侧的完成说明（complete_task 上报原文）。 */
  readonly result: string
}

/** corum/task/deferred：派发失败，任务放回队首重试（泳道会话未建立，无 sessionId）。 */
export interface TaskDeferredEvent {
  readonly task: TaskRef
  /** 失败原因（真实异常摘要）。 */
  readonly reason: string
}

/** corum/task/evicted：任务未执行即被逐出队列。 */
export interface TaskEvictedEvent {
  readonly task: TaskRef
  /** 逐出原因（如成员被移出项目组）。 */
  readonly reason: string
}

/** corum/task/blocked：任务遇阻塞即停，挂起（单阻塞链：同刻至多一个阻塞源）。 */
export interface TaskBlockedEvent {
  readonly task: TaskRef
  /** 阻塞原因（执行侧陈述缺什么前置信息）。 */
  readonly reason: string
  /** 派生的「解除阻塞」任务 id（阻塞源；它完成时本任务被反查唤醒）。 */
  readonly blockedByTaskId: string
}

/** corum/task/unblocked：依赖任务完成，挂起任务回队列（调度器反查推导，C 无需知道 B）。 */
export interface TaskUnblockedEvent {
  readonly task: TaskRef
  /** 解除阻塞的任务 id（刚 completed 的那个）。 */
  readonly unblockedByTaskId: string
}

/** corum/task/stalled：执行中任务超过阈值无活动（卡住感知；不改变任务状态）。 */
export interface TaskStalledEvent {
  readonly task: TaskRef
  /** 距最后活动的秒数。 */
  readonly idleSec: number
}

/** corum/task/steered：对执行中任务插入引导（下一步边界生效，不打断）。 */
export interface TaskSteeredEvent {
  readonly task: TaskRef
  /** 引导内容（收敛指令）。 */
  readonly note: string
  /** 操作者（'pm' | 'user'）。 */
  readonly by: string
}

/** corum/task/cancelled：中止执行中/挂起任务。 */
export interface TaskCancelledEvent {
  readonly task: TaskRef
  /** 中止原因。 */
  readonly reason: string
  /** 处置：requeue（回队重派）| evicted（废弃）| reassigned（改派他人，新 assigned 另发）。 */
  readonly fate: 'requeue' | 'evicted' | 'reassigned'
  /** 操作者（'pm' | 'user'）。 */
  readonly by: string
}

/** 项目组成员（引用式；与 corum-agent/project.ts 的 ProjectGroupMember 同构）。 */
export interface ProjectGroupMember {
  readonly profileId: string
  /** 调度角色：pm（会话统筹 + 人机交互入口）或 member（普通执行成员）。 */
  readonly role: 'pm' | 'member'
  /** 数据层专业角色（权限网关用，可选）。 */
  readonly profession?: 'pd' | 'techLead' | 'dev' | 'qa'
  /** 来源团队 id（可追溯「这个成员来自哪个团队」；独立 Agent 无此字段）。 */
  readonly fromTeam?: string
}

/** corum/group/member-added：成员加入项目组。 */
export interface GroupMemberAddedEvent {
  readonly projectId: string
  /** 加入的成员（引用式：profileId + role + 可选 fromTeam）。 */
  readonly member: ProjectGroupMember
}

/** corum/group/member-removed：成员被移出项目组（调度器据此回收其运行时）。 */
export interface GroupMemberRemovedEvent {
  readonly projectId: string
  readonly profileId: string
}

/** corum/terminal/output：终端 pty 输出推送（统一事件中心一期真实迁移；host corumTerminal 在 proc.onData 里 emit）。 */
export interface TerminalOutputEvent {
  /** 终端会话 id（corumTerminal/create 返回）。 */
  readonly id: string
  /** 本帧 pty 输出（原始字节串，含 ANSI 控制序列）。 */
  readonly data: string
  /**
   * 帧序号（会话内单调递增；断链补帧用）。renderer 发现 `seq > lastSeq + 1`
   * 即判定断链窗口丢帧，经 `corumTerminal/snapshot(id, lastSeq)` 补拉。
   */
  readonly seq: number
}

/** corum/file/changed 单条变更（与 host corum-fs changeLog 条目同构）。 */
export interface FileChangeEntry {
  /** 相对项目根的路径（/ 开头）。 */
  readonly path: string
  /** fs watch 事件类型：rename（创建/删除/改名）或 change（内容变更）。 */
  readonly kind: 'rename' | 'change'
}

/** corum/file/changed：项目根递归 watch 的去抖批量变更推送（统一事件中心二期真实迁移；host corumFs 在 watcher 去抖回调里 emit——一个去抖窗口发一帧，载荷是该窗口累积的 changes 数组）。 */
export interface FileChangedEvent {
  /** 本去抖窗口累积的变更（批量；与 pollChanges 取走的 changeLog 同构）。 */
  readonly changes: FileChangeEntry[]
}

/**
 * corum/subagent/progress：子 Agent 会话进度增量推送（统一事件中心三期真实
 * 迁移；host corumAgent 在官方 `session/event` 追加点对 origin='subagent'
 * 会话维护 O(1) 折叠状态，仅在折叠快照变化时 emit——取代 SubagentCard 的
 * 2s 全量重读轮询，折叠口径与 corumAgent/getChildSessionProgress 一致）。
 */
/**
 * 子 Agent 终态推导的唯一口径家（corum fork 增量）。
 *
 * 根因：`done` 布尔只表达「最新 turn 已闭合（turn/end）」，中断同样闭合 turn，
 * 于是 done=true 被渲染成成功。这里用 `turn/end.reason.kind` 推导真正的终局
 * 原因，再映射成三态终态（completed / aborted / failed），供所有消费方统一走。
 *
 * 与 `corum-subagent/src/lifecycle.ts:236-261` 的 `epochStopReason` 同语义
 * （那份在字节锁定文件里，不可 import）。未知原因绝不能算成功 → 归为 error。
 */

/** 子 Agent 终局原因（自包含重声明；事实源 corum-subagent/src/types.ts:215-229）。 */
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/**
 * 宿主侧推导：`turn/end.reason.kind` → `SubagentStopReason`。
 * aborted|interrupted → 'aborted'；max-tokens → 'max-tokens'；
 * error → 'error'；blocked → 'refusal'；completed|undefined → 'completed'；
 * 其它未知 → 'error'（未知原因绝不能算成功）。
 */
export function stopReasonOfTurnEnd(kind: string | undefined): SubagentStopReason {
  switch (kind) {
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'max-tokens':
      return 'max-tokens'
    case 'error':
      return 'error'
    case 'blocked':
      return 'refusal'
    case 'completed':
    case undefined:
      return 'completed'
    default:
      return 'error'
  }
}

/** 子 Agent 终态（三态；运行中 = undefined）。 */
export type SubagentOutcome = 'completed' | 'aborted' | 'failed'

/**
 * stopReason → 终态；undefined（还没结束）→ undefined。
 * completed → 'completed'；aborted → 'aborted'；
 * error|max-tokens|refusal → 'failed'；undefined → undefined。
 */
export function subagentOutcomeOf(stopReason: SubagentStopReason | undefined): SubagentOutcome | undefined {
  switch (stopReason) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'aborted'
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return 'failed'
    case undefined:
      return undefined
  }
}

/** 终态 → 通知色调（与 notifications.ts 的 NotificationTone 同词）。 */
export function subagentOutcomeTone(outcome: SubagentOutcome): 'success' | 'warn' | 'error' {
  switch (outcome) {
    case 'completed':
      return 'success'
    case 'aborted':
      return 'warn'
    case 'failed':
      return 'error'
  }
}

/** 终态 → 卡片/chip 色调词表（running/done/aborted/failed）。 */
export function subagentOutcomeChipTone(outcome: SubagentOutcome | undefined): 'running' | 'done' | 'aborted' | 'failed' {
  switch (outcome) {
    case 'completed':
      return 'done'
    case 'aborted':
      return 'aborted'
    case 'failed':
      return 'failed'
    case undefined:
      return 'running'
  }
}

/**
 * 子 Agent 终态时的改动摘要（corum fork 增量）。
 *
 * 数据源 = host `corumReview.snapshot(childSessionId)`（子会话轮次的影子 git
 * 快照）+ worktree 台账状态（隔离时按 slug 相关）。仅终态帧携带（terminal
 * backfill），运行中帧缺省——卡片在子 Agent 完成后才展示「改动」区。
 * 所有字段可选：host 不带 corumReview 或取不到时整段缺省，卡片降级为「无改动」。
 */
export interface SubagentChangeSummary {
  /** 改动文件数。 */
  readonly filesChanged: number
  /** 逐文件改动行数（±N）；可能缺省（host 取不到 diff 时只给 count）。 */
  readonly files?: readonly {
    /** 相对路径（子会话 cwd 下）。 */
    readonly path: string
    /** 新增行数。 */
    readonly added: number
    /** 删除行数。 */
    readonly removed: number
  }[]
  /** 隔离 worktree slug（隔离时携带，非隔离缺省）。 */
  readonly worktreeSlug?: string
  /** 隔离 worktree 分支名（隔离时携带）。 */
  readonly worktreeBranch?: string
  /** 隔离 worktree 完整路径（供 diff 打开时拼绝对路径；隔离时携带）。 */
  readonly worktreePath?: string
  /** 是否已在 worktree 分支内提交（committed）。 */
  readonly committed?: boolean
  /** 是否已集成回主工作区（台账 status='integrated'）。 */
  readonly integrated?: boolean
}

/**
 * ⚠️ UI 口径规矩（硬要求）：UI 里禁止用 `done` 布尔表达「结束了」。
 * `done` 只表示「最新 turn 已闭合」，中断同样闭合 turn。任何终态判定必须走
 * `subagentOutcomeOf(stopReason)`。
 */
/**
 * 子 Agent 的计划项（与 `@deepseek-ai/dsh-tool-todo` 的 `TodoItem` 结构同构）。
 * 结构镜像而非导入，避免给 corum-api-remotes 增加 dsh-tool-todo 依赖（该包
 * 只做事件声明/转发，不应耦合工具实现包）。
 */
export interface SubagentTodoItem {
  /** 任务内容（一句短祈使句）。 */
  readonly content: string
  /** 生命周期状态。 */
  readonly status: 'pending' | 'in_progress' | 'completed'
}

export interface SubagentProgressEvent {
  /** 子会话 id（origin='subagent' 的 UUID id）。 */
  readonly sessionId: string
  /** 最新已开启 turn（0 = 尚未开 turn）。 */
  readonly turn: number
  /** 当前 turn 已闭合 step 数。 */
  readonly step: number
  /** 当前动作（最新工具调用名）；无进行中动作时缺省。 */
  readonly currentAction?: string
  /**
   * 最新 turn 已闭合（turn/end）。
   * ⚠️ 不代表终态，只表示 turn 闭合；中断同样闭合 turn。终态看 `stopReason`。
   */
  readonly done: boolean
  /** 终局原因；仅在该 turn 闭合时给出（undefined = 运行中/未结束）。 */
  readonly stopReason?: SubagentStopReason
  /** 触发本帧的源事件时间（ms epoch）。 */
  readonly lastActive: number
  /**
   /**
    * 子 Agent 的当前计划列表（`todo/write` 折叠；`turn/start` 时重置为空）。
    * 缺省表示无计划（子 Agent 未用 todo 工具）——消费者应隐藏计划区。
    */
  readonly todos?: readonly SubagentTodoItem[]
  /**
    * 终态改动摘要（corum fork 增量）。
    *
    * 仅在终态帧（`done=true`）的 terminal backfill 路径填充——host 从
    * `corumReview.snapshot(childSessionId)` 取改动文件列表 ±N，从 worktree
    * 台账取 committed/integrated 状态。运行中帧缺省；卡片据此决定是否渲染
    * 「改动」区。所有子字段可选：取不到时卡片降级。
    */
  readonly changeSummary?: SubagentChangeSummary
}

/**
 * corum/subagent/child：宿主 spawn 子 Agent 时发出的**精确父子映射**
 * （2026-09-09 用户反馈「子 Agent 处理时无法进入子会话实时查看」）。
 *
 * 背景：SubagentCard 过去只能靠「会话列表里 origin='subagent' 且时间最近的
 * 一行」猜 childSessionId——父会话在等工具结果时不再产生事件、卡片不重算，
 * 于是整个运行期拿不到 id（goto 按钮 disabled、进度帧也过滤不了），只有子会话
 * 结束、父会话追加工具结果后才匹配上。宿主在 `subagents.start()` 返回的同一刻
 * 就知道 `run.id`（= 子会话 id），按父侧 tool/call id 精确广播即可让卡片在
 * 第一帧就能跳转与订阅进度。
 */
export interface SubagentChildEvent {
  /** 父会话 id（卡片按当前会话过滤）。 */
  readonly parentSessionId: string
  /** 父侧 tool/call id（卡片按它精确匹配本次委托）。 */
  readonly callId: string
  /** 子会话 id（origin='subagent'）。 */
  readonly childSessionId: string
  /** 委托标签（工具 description / 任务 label）。 */
  readonly label: string
  /** 是否隔离到独立 worktree（false = 直接在主工作区）。 */
  readonly isolated: boolean
  /** 前台一次性（父等结果）还是后台 agent（父继续干活、可续接）。 */
  readonly mode: 'foreground' | 'background'
  /** 隔离时的 worktree 三件套（台账 chip 与卡片提示用）。 */
  readonly worktree?: { readonly slug: string; readonly branch: string; readonly path: string }
  /**
   * 本次 spawn 的真实生效模型路由（UI 侧花名册行 / 工作区行的模型 chip 用）。
   *
   * 取值 = `request.agentOptions` 的 provider/model/reasoningEffort（锁定路径 =
   * 角色锁模型；非锁定/fork 路径 = 从父合并来的父真实路由）；若缺失则退回
   * `corumEffectiveModel`；两者都无则不写该字段（不伪造空对象）。reasoningEffort
   * 缺失时省略该键。
   */
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  /** 广播时间（ms epoch）。 */
  readonly time: number
}

/**
 * corum/artgen/download-progress：文生图引擎/模型下载进度推送（P2-7；
 * host corumArtGen 的 downloadSlots 每次写入即 emit——取代设置页 500ms 轮询
 * `corumArtGen/getDownloadProgress`）。
 */
export interface ArtgenDownloadProgressEvent {
  /** 槽位：engine（sd-cli 二进制）或 model（SD 模型）。 */
  readonly key: 'engine' | 'model'
  readonly percent: number
  readonly downloadedBytes: number
  readonly totalBytes: number
  /** 下载状态（'downloading' | 'done' | 'error' | 'idle'）。 */
  readonly status: string
  /** 失败原因（status='error' 时）。 */
  readonly error?: string
  /** 下载目标文件名（模型 = 文件名；引擎 = sd-cli-download.zip）。2026-09-09 新增。 */
  readonly target?: string
  /** 瞬时下载速度（字节/秒；滑动窗口）。2026-09-09 新增。 */
  readonly bytesPerSecond?: number
  /** 预计剩余秒数。2026-09-09 新增。 */
  readonly etaSeconds?: number
}

/**
 * corum/artgen/job-progress：文生图任务进度推送（P2-7；host corumArtGen 的
 * txt2imgJobs 每次 percent/phase/终态变更即 emit——取代设置页 400ms 轮询
 * `corumArtGen/getTxt2ImgJob`）。
 */
export interface ArtgenJobProgressEvent {
  readonly jobId: string
  readonly status: 'running' | 'done' | 'error'
  readonly percent: number
  /** 阶段（queued / starting / generating / sampling / decoding / done）。 */
  readonly phase: string
  /** 失败原因（status='error' 时）。 */
  readonly error?: string
}

/**
 * corum/ollama/download-progress：本地 LLM 引擎（ollama 二进制）下载进度推送
 * （P2-7；host localLlm 的 downloadProgress 每次写入即 emit——取代设置页
 * 500ms 轮询 `localLlm/getDownloadProgress`）。模型拉取本身走 Ollama HTTP
 * 流式接口（client 直读 ReadableStream），不经本事件。
 */
export interface OllamaDownloadProgressEvent {
  readonly percent: number
  readonly downloadedBytes: number
  readonly totalBytes: number
  /** 下载状态（'idle' | 'downloading' | 'done' | 'error'）。 */
  readonly status: string
  /** 失败原因（status='error' 时）。 */
  readonly error?: string
  /** 瞬时下载速度（字节/秒；滑动窗口，仅 downloading 时有）。2026-09-09 新增。 */
  readonly bytesPerSecond?: number
  /** 预计剩余秒数（有总大小且速度 > 0 时）。2026-09-09 新增。 */
  readonly etaSeconds?: number
}

// ── cordis Events 声明（host emit 与 renderer $on 共享的事实签名）────────────

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** corum/task/assigned：任务入队到「项目 × 角色」队列。 */
    'corum/task/assigned'(data: TaskAssignedEvent): void
    /** corum/task/started：任务派进泳道会话（followup 已发出）。 */
    'corum/task/started'(data: TaskStartedEvent): void
    /** corum/task/completed：任务闭环（complete_task 上报）。 */
    'corum/task/completed'(data: TaskCompletedEvent): void
    /** corum/task/deferred：派发失败，任务放回队首重试。 */
    'corum/task/deferred'(data: TaskDeferredEvent): void
    /** corum/task/evicted：任务未执行即被逐出队列。 */
    'corum/task/evicted'(data: TaskEvictedEvent): void
    /** corum/task/blocked：任务遇阻塞挂起（单阻塞链）。 */
    'corum/task/blocked'(data: TaskBlockedEvent): void
    /** corum/task/unblocked：依赖解除，挂起任务回队列。 */
    'corum/task/unblocked'(data: TaskUnblockedEvent): void
    /** corum/task/stalled：执行中任务超时无活动（卡住感知）。 */
    'corum/task/stalled'(data: TaskStalledEvent): void
    /** corum/task/steered：对执行中任务插入引导。 */
    'corum/task/steered'(data: TaskSteeredEvent): void
    /** corum/task/cancelled：中止任务（fate=requeue/evicted/reassigned）。 */
    'corum/task/cancelled'(data: TaskCancelledEvent): void
    /** corum/group/member-added：项目组成员加入。 */
    'corum/group/member-added'(data: GroupMemberAddedEvent): void
    /** corum/group/member-removed：项目组成员移除（调度器回收其运行时）。 */
    'corum/group/member-removed'(data: GroupMemberRemovedEvent): void
    /** corum/terminal/output：终端 pty 输出推送（统一事件中心一期；终端轮询迁移的承载事件）。 */
    'corum/terminal/output'(data: TerminalOutputEvent): void
    /** corum/file/changed：项目根递归 watch 去抖批量变更推送（统一事件中心二期；文件 watch 轮询迁移的承载事件）。 */
    'corum/file/changed'(data: FileChangedEvent): void
    /** corum/subagent/progress：子 Agent 会话进度增量推送（统一事件中心三期；SubagentCard 进度轮询迁移的承载事件）。 */
    'corum/subagent/progress'(data: SubagentProgressEvent): void
    /** corum/subagent/child：宿主 spawn 子 Agent 的精确父子映射（卡片运行中即可跳子会话）。 */
    'corum/subagent/child'(data: SubagentChildEvent): void
    /** corum/worktree-ledger：子 Agent 隔离台账快照（fork #10 发射；「并行工作区」chip 订阅源）。 */
    'corum/worktree-ledger'(data: CorumWorktreeLedgerFrameEvent): void
    /** corum/artgen/download-progress：文生图引擎/模型下载进度（P2-7）。 */
    'corum/artgen/download-progress'(data: ArtgenDownloadProgressEvent): void
    /** corum/ollama/download-progress：本地 LLM 引擎下载进度（P2-7）。 */
    'corum/ollama/download-progress'(data: OllamaDownloadProgressEvent): void
    /** corum/artgen/job-progress：文生图任务进度（P2-7）。 */
    'corum/artgen/job-progress'(data: ArtgenJobProgressEvent): void
  }
}

/** corum/worktree-ledger 帧（与 fork #10 CorumWorktreeLedgerFrame 同构，自包含声明）。 */
export interface CorumWorktreeLedgerFrameEvent {
  readonly sessionId: string
  readonly entries: readonly {
    readonly slug: string
    readonly branch: string
    readonly path: string
    readonly status: 'active' | 'settled' | 'integrated' | 'discarded'
    readonly runId?: string
    readonly childSessionId?: string
  }[]
  readonly pending: number
}

// ── Remote 转发选择面（renderer $on 的 key 面）──────────────────────────────

/** 并入转发 allowlist 的 corum 事件名（12 个领域事件 + 终端输出 + 文件变更 + 子 Agent 进度 + 台账 + 两个下载进度）。 */
export type CorumForwardedEvent =
  | 'corum/task/assigned'
  | 'corum/task/started'
  | 'corum/task/completed'
  | 'corum/task/deferred'
  | 'corum/task/evicted'
  | 'corum/task/blocked'
  | 'corum/task/unblocked'
  | 'corum/task/stalled'
  | 'corum/task/steered'
  | 'corum/task/cancelled'
  | 'corum/group/member-added'
  | 'corum/group/member-removed'
  | 'corum/terminal/output'
  | 'corum/file/changed'
  | 'corum/subagent/progress'
  | 'corum/subagent/child'
  | 'corum/worktree-ledger'
  | 'corum/artgen/download-progress'
  | 'corum/ollama/download-progress'
  | 'corum/artgen/job-progress'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<CorumForwardedEvent, true> {}
}
