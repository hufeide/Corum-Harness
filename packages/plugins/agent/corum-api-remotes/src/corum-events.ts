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
  }
}

// ── Remote 转发选择面（renderer $on 的 key 面）──────────────────────────────

/** 并入转发 allowlist 的 corum 事件名（12 个领域事件 + 终端输出 + 文件变更）。 */
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

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<CorumForwardedEvent, true> {}
}
