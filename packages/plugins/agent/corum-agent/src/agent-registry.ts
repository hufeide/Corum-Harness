/**
 * fork（corum）：**Agent 存活登记册**——从 `agent-service.ts` 按关注点抽出（2026-09-21）。
 *
 * ## 为什么独立成文件
 *
 * 用户 2026-09-20 定调：「整个 `agent-service` 混入了太多业务能力……各个模块**至少要在
 * 文件层面切分清晰**，方便维护。」
 *
 * 抽出的核心理由（与 `conductor-runtime.ts` 同源）：**状态的所有者必须显式**。此前有
 * 六张表散在 `CorumAgentService` 的字段里、被 25 处方法体直接读写，「谁在写这张表」只能
 * 靠全文搜索回答——而那正是上场只读护栏漏洞的结构性成因。
 *
 * ## 六张表
 *
 * | 表 | 键 → 值 | 语义 |
 * |---|---|---|
 * | `agents` | profileId → Agent | 按 profile 的 root Agent（`createAgent` 的缓存） |
 * | `typeAgents` | `projectId+profileId+laneKey` → {agent, sessionId, lane} | 「项目 × 角色 × 泳道」会话 |
 * | `sessionLaneIndex` | sessionId → 泳道归属 | 权限网关的**可信身份**来源 |
 * | `taskAgents` | sessionId → {agent, sessionId, cwd, profileId} | task 模式会话 |
 * | `taskSelections` | sessionId → ModelSelectionRef | 模型选择 ref（切模型靠改它的 `current`） |
 * | `agentCreationsInFlight` | profileId → Promise | 并发去重（一份 profile 只建一个 agent） |
 * | `agentCreationTimes` | profileId → 时刻序列 | 重建风暴护栏与取证 |
 *
 * ## 为什么用窄接口而不是把 Map 交出去
 *
 * 直接把 `Map` 暴露出去，等于把「谁都能改」制度化，抽出本模块就白做了。故这里给
 * **语义方法**（`register` / `find*` / `forget*` / `remove*`），调用方读起来是「登记一个
 * Agent」「忘掉它」，而不是「往这张表里塞一个键值对」。
 *
 * ⚠️ **本模块不碰**：不创建 Agent（那是 `ctx.agents.create` 的事，且需要 profile 编译、
 * preset 挂载、setup 钩子——属服务层编排）、不碰权限/指挥模式/沙箱、不读盘落盘。
 * 它只回答「谁还活着」。
 *
 * @module @corum/corum-agent/agent-registry
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'


/**
 * 泳道描述：路由标签（`key`）+ 工作类型语义（`type`）+ 可选需求段。
 *
 * ⚠️ 本类型原先定义在 `agent-service.ts` 里，由本模块 `import type` 引用 —— 那形成了
 * **registry → agent-service 的反向依赖**，被 `verify-refactor-guard.sh` 的 ④ 组拦下。
 * 它不是「白名单能放过」的那种：泳道表是本模块持有的六张表之一，泳道描述理应是本模块
 * 的词汇。故移到这里，服务侧改为 re-export（对外 import 面零变化）。
 */
export interface AgentLaneDescriptor {
  /** 泳道路由键：关联需求为 `<requirementId>:<type>`，兼容任务为 `<type>`。 */
  readonly key: string
  /** 工作类型 slug（泳道语义；路由键是 `key`）。 */
  readonly type: string
  /** 关联需求 id（标签泳道的需求段）。 */
  readonly requirementId?: string
}

/** task 模式会话的登记项。 */
export interface TaskAgentEntry {
  readonly agent: Agent
  readonly sessionId: SessionId
  /** 工作区目录（会话 cwd 创建后不可改）。 */
  readonly cwd: string
  readonly profileId: string
}

/** 泳道会话的登记项。 */
export interface TypeAgentEntry {
  readonly agent: Agent
  readonly sessionId: SessionId
  readonly lane: AgentLaneDescriptor
}

/** 泳道归属（sessionId → 「项目 × 角色 × 泳道」）。 */
export interface LaneIndexEntry {
  readonly projectId: string
  readonly profileId: string
  readonly type: string
  readonly laneKey: string
  readonly requirementId?: string
}

/**
 * 模型选择 ref 的**结构面**（只声明注册册需要搬运的字段）。
 *
 * 之所以在这里收窄而不是 import 官方类型：本模块对「选择」的内容一无所知——它只负责
 * 把调用方放进去的东西原样交还（`installTaskModelSelection` 每次请求实时读 `current`，
 * 故调用方拿到的是**同一个对象引用**，这正是「改 ref 即切模型」机制成立的前提）。
 */
export interface TaskSelectionRef {
  current: unknown
  assembled: unknown
}

/** 存活登记册。 */
export class AgentRegistry {
  /** profileId → root Agent（按 profile 的根 Agent 缓存）。 */
  private readonly byProfile = new Map<string, Agent>()

  /** `projectId+profileId+laneKey` → 泳道会话。 */
  private readonly lanes = new Map<string, TypeAgentEntry>()

  /** sessionId → 泳道归属（权限网关的可信身份来源）。 */
  private readonly laneIndex = new Map<string, LaneIndexEntry>()

  /** sessionId → task 模式会话。 */
  private readonly tasks = new Map<string, TaskAgentEntry>()

  /** sessionId → 模型选择 ref（**同一引用**，见 {@link TaskSelectionRef}）。 */
  private readonly taskSelections = new Map<string, TaskSelectionRef>()

  /** profileId → 在飞创建（并发去重）。 */
  private readonly inFlight = new Map<string, Promise<unknown>>()

  /** profileId → 最近创建时刻（重建风暴护栏与取证）。 */
  private readonly creationTimes = new Map<string, readonly number[]>()

  /* ───────────── 按 profile 的 root Agent ───────────── */

  /** 该 profile 的活 Agent（未创建 → `undefined`）。 */
  profileAgent(profileId: string): Agent | undefined {
    return this.byProfile.get(profileId)
  }

  /** 登记一个 root Agent。 */
  registerProfileAgent(profileId: string, agent: Agent): void {
    this.byProfile.set(profileId, agent)
  }

  /** 忘掉一个 root Agent（保存/删除 profile、重启自检都会调；下次使用会重建）。 */
  forgetProfileAgent(profileId: string): void {
    this.byProfile.delete(profileId)
  }

  /** 全部已登记的 profile id（`listAgents` 的数据源）。 */
  profileIds(): string[] {
    return [...this.byProfile.keys()]
  }

  /* ───────────── 泳道会话 ───────────── */

  /** 泳道路由键（`projectId` + `profileId` + `laneKey` 直接拼接——**无分隔符**，与旧实现逐字一致）。 */
  private static laneKeyOf(projectId: string, profileId: string, laneKey: string): string {
    return `${projectId}${profileId}${laneKey}`
  }

  /** 按「项目 × 角色 × 泳道」取活 Agent。 */
  laneAgent(projectId: string, profileId: string, laneKey: string): Agent | undefined {
    return this.lanes.get(AgentRegistry.laneKeyOf(projectId, profileId, laneKey))?.agent
  }

  /**
   * 登记一条泳道会话（同时写 `lanes` 与 `laneIndex` —— 两张表必须同步，
   * 故合成一个方法而不是暴露两次写入）。
   */
  registerLane(projectId: string, profileId: string, lane: AgentLaneDescriptor, agent: Agent, sessionId: SessionId): void {
    this.lanes.set(AgentRegistry.laneKeyOf(projectId, profileId, lane.key), { agent, sessionId, lane })
    this.laneIndex.set(String(sessionId), {
      projectId,
      profileId,
      type: lane.type,
      laneKey: lane.key,
      ...lane.requirementId === undefined ? {} : { requirementId: lane.requirementId },
    })
  }

  /** 按 sessionId 反查泳道归属（只识别本进程存活、且登记过的泳道）。 */
  laneOf(sessionId: string): LaneIndexEntry | undefined {
    return this.laneIndex.get(sessionId)
  }

  /**
   * 按 sessionId 在泳道表里找到那条会话（不是归属索引，是**会话本体**）。
   *
   * ⚠️ 返回 `| undefined`：两张表都没命中时必须返回 `undefined`（不是「什么都不返回」）
   * —— 上场真实发生过：这句 `return undefined` 被机械重构切掉后**编译通过、测试全绿**
   * （falling off the end 语义相同），只有 `git diff` 才发现。
   * `scripts/verify-refactor-guard.sh` 的 ② 组现在把这条钉成机器断言。
   */
  findLaneBySession(sessionId: string): { agent: Agent, sessionId: SessionId } | undefined {
    for (const entry of this.lanes.values()) {
      if (String(entry.sessionId) === sessionId) return entry
    }
    return undefined
  }

  /* ───────────── task 模式会话 ───────────── */

  /** 取 task 会话登记项。 */
  task(sessionId: string): TaskAgentEntry | undefined {
    return this.tasks.get(sessionId)
  }

  /** 登记/更新一条 task 会话。 */
  registerTask(entry: TaskAgentEntry): void {
    this.tasks.set(String(entry.sessionId), entry)
  }

  /**
   * 取该会话的模型选择 ref（**同一引用**——切模型靠改它的 `current`）。
   * 未登记时 `undefined`（进程重启后内存态丢失，调用方要退化为重装一层）。
   */
  taskSelection(sessionId: string): TaskSelectionRef | undefined {
    return this.taskSelections.get(sessionId)
  }

  /** 记下该会话的模型选择 ref。 */
  setTaskSelection(sessionId: string, ref: TaskSelectionRef): void {
    this.taskSelections.set(sessionId, ref)
  }

  /** 存活 task 会话数（诊断/测试可观测面）。 */
  get taskCount(): number {
    return this.tasks.size
  }

  /* ───────────── 并发去重与重建风暴记账 ───────────── */

  /** 该 profile 正在飞的创建（并发去重：同一 profile 复用同一个 promise）。 */
  inFlightOf<T>(profileId: string): Promise<T> | undefined {
    return this.inFlight.get(profileId) as Promise<T> | undefined
  }

  /** 记下在飞创建。 */
  setInFlight(profileId: string, task: Promise<unknown>): void {
    this.inFlight.set(profileId, task)
  }

  /** 清除在飞创建（无论成败——`finally` 语义，否则失败的创建会把键永久占住）。 */
  clearInFlight(profileId: string): void {
    this.inFlight.delete(profileId)
  }

  /** 该 profile 最近的创建时刻序列（重建风暴护栏的输入）。 */
  creationTimesOf(profileId: string): readonly number[] {
    return this.creationTimes.get(profileId) ?? []
  }

  /** 覆盖该 profile 的创建时刻序列（护栏判定后写回）。 */
  setCreationTimes(profileId: string, times: readonly number[]): void {
    this.creationTimes.set(profileId, times)
  }
}
