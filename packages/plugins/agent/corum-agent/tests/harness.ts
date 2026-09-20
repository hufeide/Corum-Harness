/**
 * CorumAgentService 测试台（**唯一**知道「怎么造一个被测服务」的地方）。
 *
 * ## 为什么必须有这个文件（2026-09-21 架构轮 P0）
 *
 * 在它之前，「造一个服务」的知识**散在各自的 spec 里**，而且是**按状态表的名字硬编码**的：
 *
 * ```ts
 * const svc = Object.create(CorumAgentService.prototype) as CorumAgentService
 * Object.defineProperty(svc, 'taskAgents', { value: live })   // ← 名字写死在这里
 * Object.defineProperty(svc, 'typeAgents', { value: sessions })
 * ```
 *
 * 这个写法在当前实现下能跑（`Object.create` 绕过构造器 ⇒ 不触发 profile 播种与
 * prompt 段注册），但它有一个**静默失真**的致命形态：
 *
 * > 一旦把状态表搬进别的模块（本轮 P3 就要把 6 张表搬进 `AgentRegistry`），
 * > `Object.defineProperty(svc, 'taskAgents', …)` **照样成功**（只是挂了个没人读的属性），
 * > 被测代码会去用**它自己的空表** ⇒ 测试要么变成「未知会话」的假绿、要么以看不懂的
 * > TypeError 挂掉。**没有任何机制会提示「你的测试台已经失效了」。**
 *
 * 这正是本仓付过学费的那类失真（同 `docs/LESSONS.md` 的「画布态 ≠ 磁盘态」：
 * 你以为在看真实对象，其实在看一个已经脱钩的影子）。故本文件把这件事**收成一份**：
 *
 * - 状态注入一律经 {@link installState}，它**只认 {@link STATE_CONTAINER_KEY}** 这一个
 *   契约键 ⇒ 搬家时**只改这一个函数**，所有 spec 自动跟上；
 * - 契约键缺失时 **fail-loud**（见该函数注释）——宁可炸，也不要静默造出一个
 *   和真实对象脱钩的假服务。
 *
 * ## 用法
 *
 * ```ts
 * const h = makeHarness()                       // 自动建临时 home 并指向 CORUM_HOME
 * h.registerTaskAgent('sess-1', { profileId: 'p' })
 * await h.service.createTaskAgentRemote('/tmp/ws')
 * h.eventsOf('corum/subagent/progress')         // 断言推送帧
 * h.cleanup()                                   // 或 afterEach 里统一收拾
 * ```
 *
 * ⚠️ **不要**在 spec 里再出现 `Object.defineProperty(svc, 'taskAgents', …)`：
 * 那是把本文件要消灭的失真又种回去。
 *
 * @module @corum/corum-agent/tests/harness
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CorumAgentService } from '../src/agent-service.ts'
import type { AgentLaneDescriptor } from '../src/agent-service.ts'
import { ConductorRuntime } from '../src/conductor-runtime.ts'
import { SubagentProgressTracker } from '../src/subagent-progress.ts'
import type { AgentProfile } from '../src/profile.ts'
import type { ProgressState } from '../src/child-progress.ts'

/**
 * 状态容器的契约键。
 *
 * **含义**：被测服务从哪个属性上挂它的状态表。当前实现里状态表是类的自有字段，
 * 故值为 `undefined`（见 {@link installState}）；P3 把状态收进 `AgentRegistry`
 * 之后，这里改成 `'registry'`（或实现方选定的名字）**即可**——这是本文件与实现之间
 * 唯一需要同步的一个字面量。
 */
export const STATE_CONTAINER_KEY: string | undefined = undefined

/** 一张存活表对外的最小形状（harness 只做读写与遍历，不关心值类型）。 */
type StateMap = Map<string, unknown>

/**
 * 服务状态的可访问视图——spec 通过它读写存活表，而不是直接 `svc.taskAgents`。
 *
 * 这么绕一层的理由：搬家后 `svc.taskAgents` 这个属性会消失，而
 * `h.state.taskAgents` 这个名字由本文件担保、由 {@link installState} 兑现。
 */
export interface HarnessState {
  /** profileId → root Agent。 */
  agents: StateMap
  /** `(projectId)(profileId)(laneKey)` → 泳道会话。 */
  typeAgents: StateMap
  /** sessionId → task 模式会话。 */
  taskAgents: StateMap
  /** sessionId → 模型选择 ref。 */
  taskSelections: StateMap
  /** sessionId → 泳道归属索引。 */
  sessionLaneIndex: StateMap
  /**
   * 子会话进度折叠表 —— **注意它不再是一张可直接读写的 Map**。
   *
   * P1-b 把四张子会话记账表收进了 `SubagentProgressTracker`（它持有折叠表并独占
   * 容量淘汰 / LRU 置顶），故这里只给一个**窄视图**：
   *   · `size`   —— 条目数（容量守卫的可观测面）
   *   · `seed()` —— 种一条折叠态（测试需要「会话已有终态」的起点时用）
   *
   * 之所以不再交出 Map：直接把可变 Map 递给测试，会让「谁在写这张表」重新变含糊
   * ——那正是抽出 tracker 要解决的问题（见 `subagent-progress.ts` 的 `state` getter 注释）。
   * 角色 / 父会话 / 去重集仍是真的活视图（它们没有额外不变式）。
   */
  subagentProgress: {
    readonly size: number
    seed(sessionId: string, state: ProgressState): void
  }
  /** childSessionId → 委派角色。 */
  subagentRoles: StateMap
  /** childSessionId → 父会话 id。 */
  subagentParents: StateMap
  /** 已广播过中断的子会话（去重集）。 */
  notifiedInterrupted: Set<string>
  /** 待兑现的权限档位。 */
  pendingPermissions: StateMap
  /** profileId → 在飞创建 promise。 */
  agentCreationsInFlight: StateMap
  /** profileId → 最近创建时刻序列。 */
  agentCreationTimes: StateMap
}

/** 服务状态字段名 → 新值工厂（**本文件与实现之间的唯一契约**）。 */
const STATE_FIELDS: Record<string, () => unknown> = {
  agents: () => new Map<string, unknown>(),
  typeAgents: () => new Map<string, unknown>(),
  taskAgents: () => new Map<string, unknown>(),
  taskSelections: () => new Map<string, unknown>(),
  sessionLaneIndex: () => new Map<string, unknown>(),
  pendingPermissions: () => new Map<string, unknown>(),
  agentCreationsInFlight: () => new Map<string, unknown>(),
  agentCreationTimes: () => new Map<string, unknown>(),
}

/** 一条被 mock ctx 记下来的推送帧。 */
export interface RecordedEvent {
  readonly type: string
  readonly payload: unknown
}

/** 测试台。 */
export interface Harness {
  /** 被测服务（**不以**真实构造器创建；见本文件头注）。 */
  readonly service: CorumAgentService
  /** 本次测试独占的 home（已指向 `CORUM_HOME` / `DSH_HOME`）。 */
  readonly home: string
  /** 服务状态的可访问视图。 */
  readonly state: HarnessState
  /** mock ctx（补 `ctx.get(...)` 取不到的服务时用 {@link Harness.provide}）。 */
  readonly ctx: MockCtx
  /**
   * 提供一个**已 inject** 的服务：`ctx.<name>` 与 `ctx.get(name)` **都能**读到
   * （真 cordis 上 inject 过的服务正是如此）。用于 `agents` / `sessionPersistence` /
   * `gitCore` / `agentPresets` 这类 `static inject` 里的服务。
   */
  provide(name: string, value: unknown): void
  /**
   * 只提供 `ctx.get(name)`，**不**挂原始属性 —— 用于**无 inject 的可选服务**
   * （`corumReview` / `corumOrchestration` / `sessionProjections` / `settings`…）。
   *
   * ⚠️ 必须与 {@link Harness.provide} 分开：把可选服务也挂成属性，会让实现里
   * `agents?.list === undefined ? undefined : …` 这类**三态**判据失去「问不到」这一态，
   * 而实机上那一态是真实存在的（未 inject 的属性访问会抛）。实测踩过一次。
   */
  provideGet(name: string, value: unknown): void
  /** 所有被 `ctx.emit` 记下的帧（按顺序）。 */
  readonly events: RecordedEvent[]
  /** 取某类帧的全部 payload。 */
  eventsOf(type: string): unknown[]
  /** 清空帧记录（断言推送次数时先清）。 */
  clearEvents(): void
  /** 往 `agents` 表登记一个 root Agent（返回该 agent 便于继续断言）。 */
  registerAgent(profileId: string, agent: Agent): Agent
  /** 往 `taskAgents` 表登记一个 task 会话（最小 agent stub）。 */
  registerTaskAgent(sessionId: string, opts: {
    cwd?: string
    profileId?: string
    agent?: Agent
  }): Agent
  /** 往 `typeAgents` 表登记一个泳道会话。 */
  registerLaneAgent(instanceKey: string, opts: {
    sessionId: string
    lane: AgentLaneDescriptor
    agent?: Agent
  }): Agent
  /** 写一个 profile 到本次 home 的 `.agent-presets/<id>/agent.json`。 */
  writeProfile(profile: AgentProfile): void
  /**
   * 装一个假的 `sessionPersistence`（子会话进度/元信息两条 RPC 的数据源）。
   *
   * 只实现被真正用到的 seam：`open(id, 'read') → { read(fromSeq), header, close() }`
   * —— 与官方 0.1.3 的 handle seam 同形（顶层 `readFrom` 已删）。
   *
   * @param sessions - sessionId → { events, parentSession? }。
   */
  usePersistence(sessions: Record<string, FakeSessionRecord>): void
  /** 删掉本次 home（`afterEach` 用；幂等）。 */
  cleanup(): void
}

/** 一条假会话记录。 */
export interface FakeSessionRecord {
  /** 该会话持久化的事件（按 seq 升序）。 */
  events?: readonly SessionEvent[]
  /** `header.parentSession`（子会话的父；`childParentSession` 的持久化兜底源）。 */
  parentSession?: string
  /** `header.cwd`（`childWorktreeIsolation` 的持久化兜底源）。 */
  cwd?: string
}

/**
 * 测试用的 mock ctx。
 *
 * ⚠️ 两个必备形状（都是实机踩过的，不是洁癖）：
 *  ① **必须有 `get()`**——真 cordis ctx 上取服务走 `ctx.get(name)`；直接属性访问在
 *     未 inject 时抛 `cannot get property "…" without inject`（`vendor/cordis/src/reflect.ts`）。
 *     mock 少了 `get` 会把「实现错」和「mock 失真」混成同一个 TypeError。
 *  ② `logger` 四件套齐全——`noteAgentTeardown` 等路径会用 `info`。
 */
export interface MockCtx {
  logger: { info: (...a: unknown[]) => void, warn: (...a: unknown[]) => void, error: (...a: unknown[]) => void, debug: (...a: unknown[]) => void }
  /** 记录 `ctx.emit` 的帧（harness 断言用）。 */
  emit: (type: string, payload?: unknown) => void
  /** 事件订阅登记（harness 不主动触发；需要时用 {@link MockCtx.emitTo}）。 */
  on: (type: string, handler: (...a: unknown[]) => void) => () => void
  /** 手动把一条事件喂给订阅者（测事件接线用）。 */
  emitTo: (type: string, ...args: unknown[]) => void
  get: (name: string) => unknown
  [key: string]: unknown
}

/** {@link makeHarness} 的选项。 */
export interface HarnessOptions {
  /** 自定义 home（缺省新建临时目录）。 */
  home?: string
  /** 额外/覆盖的 ctx 字段。 */
  ctx?: Record<string, unknown>
  /** 初始 `ctx.get(name)` 解析表。 */
  provided?: Record<string, unknown>
}

/**
 * 建一个测试台。
 *
 * 不走真实构造器（`new CorumAgentService(ctx)`）的原因：构造器会做三件与单测无关、
 * 却要拉整棵官方组装链的事——`ensureBuiltinRoleProfiles/ensureTaskProfile/ensurePmProfile`
 * 播种、三段 `systemPrompt.section` 注册、`ctx.provide('corumConductor')`。
 * 那些属于 runtime-task 级联的装置，不是本层单测的对象。
 */
export function makeHarness(options: HarnessOptions = {}): Harness {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'corum-agent-harness-'))
  mkdirSync(home, { recursive: true })
  process.env.CORUM_HOME = home
  // resolveDshHome 会先展开 ~ 再 resolve；home 已是绝对路径，直接生效。
  process.env.DSH_HOME = home

  const events: RecordedEvent[] = []
  const subscriptions = new Map<string, Array<(...a: unknown[]) => void>>()
  const provided: Record<string, unknown> = { ...options.provided }

  const ctx: MockCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    emit: (type: string, payload?: unknown) => { events.push({ type, payload }) },
    on: (type: string, handler: (...a: unknown[]) => void) => {
      const list = subscriptions.get(type) ?? []
      list.push(handler)
      subscriptions.set(type, list)
      return () => {
        const now = subscriptions.get(type) ?? []
        const i = now.indexOf(handler)
        if (i >= 0) now.splice(i, 1)
      }
    },
    emitTo: (type: string, ...args: unknown[]) => {
      for (const handler of subscriptions.get(type) ?? []) handler(...args)
    },
    get: (name: string): unknown => provided[name],
    ...options.ctx,
  }

  /**
   * 提供服务的**两条通道**（2026-09-21 实测踩到，必须分开）。
   *
   * 服务里两种取用方式同时存在，mock 必须按**各自真实的语义**提供，不能图省事合并：
   *
   * | 取用方式 | 例子 | 真 cordis 上的形态 | 对应方法 |
   * |---|---|---|---|
   * | `ctx.<name>`（属性） | `this.ctx.sessionPersistence`（`getSubagentSessionMetaRemote`） | 服务在 `static inject` 里 ⇒ 属性可读 | `provide()` |
   * | `ctx.get('<name>')` | `this.ctx.get('corumReview')`（**可选**服务，无 inject） | **属性访问会抛**，只有 `get` 能读 | `provideGet()` |
   *
   * ⚠️ 合并二者会踩两个**方向相反**的坑，都实测过：
   *
   * - 只写 `get` 侧：`getSubagentSessionMetaRemote` 在 `this.ctx.sessionPersistence` 上
   *   拿到 `undefined`，被它自己的 `try/catch` 吞掉 ⇒ **测试悄悄拿到 `{}`**，看起来像
   *   「实现没读到事件」，真因却是 mock 少了一条通道。
   * - 把 `get` 也一并提供（**本文件第一版就是这么写的，是错的**）：`agentRunning` 里
   *   `agents?.list === undefined ? undefined : …` 的**三态**判据被压成两态
   *   ⇒「问不到」（`undefined`）与「确认没在跑」（`false`）不再可分 ⇒ 中断判据的
   *   `not-running` / `pre-boot` 分支被静默换掉，而**实机上是 `undefined`**。
   *   于是测试断言的 `pre-boot` 变成了 `not-running` —— 测的是另一个世界。
   *
   * ⇒ 一句话：**`ctx.get` 必须保持「只认 get」**，那正是实现里用 `get` 而非属性访问的理由
   * （`applySubagentModelForSession` 的事故注释写得很清楚）。
   */
  const provideInjected = (name: string, value: unknown): void => {
    provided[name] = value
    ctx[name] = value
  }

  /** 只提供 `ctx.get(name)`，**不**挂原始属性（无 inject 的可选服务）。 */
  const provideGetOnly = (name: string, value: unknown): void => {
    provided[name] = value
  }

  const service = Object.create(CorumAgentService.prototype) as CorumAgentService
  // `ctx` 是类的 `protected readonly` 字段；Object.create 绕过构造器 ⇒ 这里补上。
  // 用 defineProperty 而非赋值：字段是 readonly，且要在不触发 setter 的前提下钉死。
  Object.defineProperty(service, 'ctx', { value: ctx, writable: true })

  const state = installState(service, ctx, events)

  const harness: Harness = {
    service,
    home,
    state,
    ctx,
    provide: provideInjected,
    provideGet: provideGetOnly,
    events,
    eventsOf: (type: string) => events.filter(e => e.type === type).map(e => e.payload),
    clearEvents: () => { events.length = 0 },
    registerAgent: (profileId: string, agent: Agent) => {
      state.agents.set(profileId, agent)
      return agent
    },
    registerTaskAgent: (sessionId, opts) => {
      const agent = opts.agent ?? makeAgent(sessionId)
      state.taskAgents.set(sessionId, {
        agent,
        sessionId: SessionId(sessionId),
        cwd: opts.cwd ?? '/tmp/ws',
        profileId: opts.profileId ?? 'task',
      })
      return agent
    },
    registerLaneAgent: (instanceKey, opts) => {
      const agent = opts.agent ?? makeAgent(opts.sessionId)
      state.typeAgents.set(instanceKey, { agent, sessionId: SessionId(opts.sessionId), lane: opts.lane })
      return agent
    },
    writeProfile: (profile: AgentProfile) => {
      const dir = join(home, '.agent-presets', profile.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'agent.json'), JSON.stringify(profile, null, 2))
    },
    usePersistence: (sessions: Record<string, FakeSessionRecord>) => {
      provideInjected('sessionPersistence', {
        open: async (id: SessionId) => {
          const record = sessions[String(id)]
          if (record === undefined) throw new Error(`harness: 无此会话 "${String(id)}"`)
          return {
            header: {
              ...(record.parentSession === undefined ? {} : { parentSession: record.parentSession }),
              ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
            },
            read: async (fromSeq: number) =>
              (record.events ?? []).filter(e => e.seq >= fromSeq),
            close: async () => {},
          }
        },
      })
    },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
  return harness
}

/**
 * 把状态表挂到被测服务上（**本文件与实现之间唯一的契约点**）。
 *
 * ## 契约
 *
 * 实现方有两条合法的表达方式，本函数**两种都认**：
 *
 * 1. **状态表是服务自有字段**（当前实现，`STATE_CONTAINER_KEY === undefined`）：
 *    直接挂在服务实例上，名字就是 {@link HarnessState} 的四个键。
 *    校验方式：`'taskAgents' in service`（原型上的字段声明也在 ⇒ 必须先有构造器
 *    侧的定义；`Object.create` 会带上字段声明的初始化吗？**不会**——故这里用
 *    `Object.getOwnPropertyNames` 之外的判据：直接无条件挂上，因为读它的一定是
 *    被测代码自己）。
 * 2. **状态表收在容器对象里**（P3 之后，`STATE_CONTAINER_KEY === 'registry'`）：
 *    造一个容器实例、把四张表塞进去、整体挂到服务上。
 *
 * ## fail-loud（本文件的重点）
 *
 * 若 `STATE_CONTAINER_KEY` 指名的容器**取不到**，**必须抛错**，不许退回「在服务上挂字段」
 * ——那正是本文件要消灭的静默失真：挂上去照样成功、被测代码却读自己的空表。
 */
function installState(service: CorumAgentService, ctx: Context, events: RecordedEvent[]): HarnessState {
  const container: Record<string, unknown> = STATE_CONTAINER_KEY === undefined
    ? service as unknown as Record<string, unknown>
    : (() => {
        const found = (service as unknown as Record<string, unknown>)[STATE_CONTAINER_KEY]
        if (found === undefined) {
          throw new Error(
            `corum-agent harness: 状态容器 "${STATE_CONTAINER_KEY}" 不在服务上 —— `
            + '实现改了状态归属而 harness 未同步（见 tests/harness.ts 的 STATE_CONTAINER_KEY）。'
            + '请更新该常量与 installState，而不是在本函数里退回「直接挂字段」。',
          )
        }
        return found as Record<string, unknown>
      })()

  // ⚠️ 为什么必须把**每一个**状态字段都造出来（2026-09-21 实测踩到）：
  //
  // `Object.create(CorumAgentService.prototype)` **不执行构造器**，而本仓的
  // `useDefineForClassFields` 未开 ⇒ **带初始值的字段（`= new Map()`）的初始化表达式
  // 也长在构造器里**，同样不执行。于是 `this.subagentProgress` 等字段全是 `undefined`，
  // 首个 `this.subagentProgress.get(...)` 就抛 `Cannot read properties of undefined`。
  //
  // 这个坑的表现极具误导性：报错指向实现的某一行，而真因是「测试台没造出那张表」——
  // 实测本轮就把它误读成「实现有 bug」。故这里按 {@link STATE_FIELDS} **穷举**造全，
  // 谁都不许少。
  for (const [name, make] of Object.entries(STATE_FIELDS)) {
    Object.defineProperty(container, name, { value: make(), writable: true, configurable: true })
  }
  // `laneSetupHooks` 是数组、语义上不是「状态表」，但同属构造器初始化 ⇒ 一并补上
  // （`registerLaneSetupHook` 会 push，缺了它会抛）。
  Object.defineProperty(container, 'laneSetupHooks', { value: [], writable: true, configurable: true })
  // `conductor` 与 `progress` 都是**有自己状态的对象**（已分别抽到
  // `conductor-runtime.ts` / `subagent-progress.ts`）。构造器不跑 ⇒ 这里必须造真实例，
  // 否则任何走到 `conductor.apply(...)` / `progress.fold(...)` 的路径都会抛。
  Object.defineProperty(container, 'conductor', {
    value: new ConductorRuntime(),
    writable: true,
    configurable: true,
  })
  // 跟踪器的两个 emit 回调接到本文件的帧记录器上（spec 因此能断言推送帧）。
  // ⚠️ 这里**不是**在复刻生产的接线：生产由 CorumAgentService 构造器接线，本文件只保证
  // 「tracker 发出来的帧」能被 spec 看到。事件**接线本身**（谁在什么事件上调 tracker）
  // 属服务构造器，由 characterization/spec 经 `ctx.emitTo` 触发来验。
  const tracker = new SubagentProgressTracker(ctx, {
    emitProgress: (frame) => { events.push({ type: 'corum/subagent/progress', payload: frame }) },
    emitInterrupted: (info) => { events.push({ type: 'corum/subagent/interrupted', payload: info }) },
  })
  Object.defineProperty(container, 'progress', { value: tracker, writable: true, configurable: true })

  // 视图**直接取自容器**（不是另造一份）：否则 spec 写进视图、服务读容器，两边各说各话
  // ——那正是本文件要消灭的失真形态。
  const pick = <T>(name: string): T => container[name] as T
  const trackerState = tracker.state
  return {
    agents: pick('agents'),
    typeAgents: pick('typeAgents'),
    taskAgents: pick('taskAgents'),
    taskSelections: pick('taskSelections'),
    sessionLaneIndex: pick('sessionLaneIndex'),
    subagentProgress: {
      get size(): number { return tracker.size },
      seed: (sessionId, state) => { pick<SubagentProgressTracker>('progress').seed(sessionId, state) },
    },
    subagentRoles: trackerState.roles as unknown as StateMap,
    subagentParents: trackerState.parents as unknown as StateMap,
    notifiedInterrupted: trackerState.notified,
    pendingPermissions: pick('pendingPermissions'),
    agentCreationsInFlight: pick('agentCreationsInFlight'),
    agentCreationTimes: pick('agentCreationTimes'),
  }
}

/**
 * 造一个最小 Agent stub。
 *
 * `session` 是真 `Session`（官方构造），因为投影读取路径（`stateOf(session, key)`）
 * 与 `snapshotEvents()` 都期待真会话；其余能力面按需补——**不要**在这里堆没被用到的
 * 方法（会掩盖「实现其实读了别的东西」这类失真）。
 *
 * ⚠️ **投影来源是 `ctx.get('sessionProjections')`，不是 agent 自己的属性**
 * （`applySubagentModelForSession` 走 `projections.stateOf(agent.session, 'agentPreset')`，
 * 2026-09-18 实机事故的修法）。故这里**不**往 agent 上挂 `projections`——
 * 挂了只会让人误以为投影来自 agent。要用投影的测试请走
 * `h.provide('sessionProjections', { stateOf })`。
 *
 * @param sessionId - 会话 id。
 */
export function makeAgent(sessionId: string): Agent {
  const session = Session.create(SessionId(sessionId))
  const stub = {
    session,
    ctx: {} as Context,
    status: 'idle',
  }
  return stub as unknown as Agent
}

/** mock 投影服务：按 sessionId 给 `agentPreset`（其余 key 返回 undefined，与官方一致）。 */
export function projectionsOf(bySession: Record<string, string>): { stateOf: (s: Session, key: string) => unknown } {
  return {
    stateOf: (s: Session, key: string): unknown =>
      key === 'agentPreset' ? bySession[String(s.id)] : undefined,
  }
}

/**
 * 校验「harness 挂上的状态表**就是**被测服务在读的那一份」。
 *
 * 为什么需要：`installState` 成功挂上字段**不等于**被测代码会用它。若状态搬了家
 * （例如收进 registry）而 harness 仍往服务实例上挂字段，两边会**都成功、却互不相干**
 * ——测试随后以「未知会话」这类假绿或莫名的 TypeError 呈现，指不到真因。
 *
 * 判据（不依赖实现细节，只看行为）：往 harness 的表里塞一个**可识别的**条目，
 * 再看被测服务能否通过它自己的读取路径看到。用 `listAgentsRemote`——
 * 它是 `[...this.agents.keys()]`，纯读、无副作用、无 ctx 依赖。
 *
 * @param harness - 测试台。
 * @throws 当服务读不到 harness 的 `agents` 表时（= 契约已断）。
 */
export function assertStateContract(harness: Harness): void {
  const probe = '__harness_contract_probe__'
  harness.state.agents.set(probe, makeAgent(`probe-${probe}`))
  try {
    const seen = harness.service.listAgentsRemote().agents.map(a => a.profileId)
    if (!seen.includes(probe)) {
      throw new Error(
        'corum-agent harness: 状态契约已断 —— harness 的 agents 表不是服务在读的那一份。'
        + '实现改了状态归属（见 tests/harness.ts 的 STATE_CONTAINER_KEY / installState），'
        + '请同步 harness 而不是改断言。',
      )
    }
  } finally {
    harness.state.agents.delete(probe)
  }
}

/** 造一个最小 AgentProfile（与既有 spec 同口径）。 */
export function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'harness-agent',
    baseMode: 'standard',
    prompt: '测试 Agent',
    model: { provider: 'local', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
    ...overrides,
  }
}

/**
 * 本进程的启动时刻（`getChildSessionProgressRemote` 里 `bootAt` 的同款算法）。
 *
 * ## 为什么测试要拿它来造事件时间（2026-09-21 实测踩到）
 *
 * 「半途失去运行」的判据②是 **`lastActive < bootAt` ⇒ pre-boot**（最后一条事件发生在
 * 本进程启动之前 ⇒ 那个未闭合的 turn 不可能还在跑）。
 *
 * 这个判据在**测试进程里会失真**：`process.uptime()` 返回运行测试的 worker 的存活时长
 * （实测 ~0.2s），而实现用的是 `Date.now() - process.uptime() * 1000` —— 于是
 * `bootAt ≈ now`，**任何 200ms 前发生的事件都被算成「启动之前」** ⇒ 一个明明还活着的
 * 子会话被判成 `interrupted`。实机宿主是长驻进程，不存在这个失真。
 *
 * ⇒ **凡是要表达「这条事件发生在本进程运行期间」，时间就用 `now(相对 BOOT_AT)` 造**，
 * 不要裸用 `Date.now() - 几百毫秒`。反例（故意要 pre-boot）用 {@link LONG_AGO}。
 */
export const BOOT_AT = Date.now() - process.uptime() * 1000

/** 「上个进程遗留」的时间戳（必然早于 {@link BOOT_AT}）。 */
export const LONG_AGO = 1_000

/** 造一条会话事件（折叠测试用；`time` 可显式给，便于断言 `lastActive`）。 */
export function sessionEvent(
  type: string,
  data: Record<string, unknown>,
  time = 1_700_000_000_000,
  seq = 1,
): SessionEvent {
  return { seq, type, data, time } as unknown as SessionEvent
}
