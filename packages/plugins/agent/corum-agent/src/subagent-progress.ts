/**
 * fork（corum）：**子 Agent 进度跟踪器**——从 `agent-service.ts` 按关注点抽出（2026-09-21）。
 *
 * ## 为什么独立成文件
 *
 * 用户 2026-09-20 定调：「整个 `agent-service` 混入了太多业务能力……各个模块**至少要在
 * 文件层面切分清晰**，方便维护。」
 *
 * 本模块持有**四张状态表**（原先挂在 `CorumAgentService` 上，共 18 处 `this.` 直访）：
 *
 * | 表 | 用途 |
 * |---|---|
 * | `progressBySession` | 子会话进度折叠态（随 `session/event` 增量维护，兼 LRU 容量淘汰） |
 * | `roles` | 子会话 → 委派角色（worker / research / fork；花名册冷启动补标） |
 * | `parents` | 子会话 → 父会话 id（中断通知的跳转目标 / 归并键） |
 * | `notified` | 已广播过「半途失去运行」的子会话（进程内去重） |
 *
 * 抽出的直接理由（与 `conductor-runtime.ts` 同源）：**状态的所有者必须显式**。
 * 这四张表此前与「RPC 方法体」混在一个类里，于是「谁在读、谁在写、几处写」只能靠
 * 全文搜索回答——上场那个只读护栏漏洞就是这个形状的产物。
 *
 * ## 与 `child-progress.ts` 的分工
 *
 * - `child-progress.ts`：**纯**投影语义（折一条 / 折一窗 / 中断判定），无 I/O。
 * - 本模块：**持有状态 + 与宿主交互**（发帧、查 registry、读持久化 header 兜底）。
 *
 * 折叠一律经 `child-progress.ts` 的纯函数 ⇒ 增量与全量两条路径不可能漂移。
 *
 * ## 不碰什么
 *
 * 不碰沙箱、权限、指挥模式、profile 编译、泳道登记；也不直接依赖 `CorumAgentService`
 * （宿主能力经 {@link ProgressHost} 窄接口注入 —— 这也是它可被单测的前提）。
 *
 * @module @corum/corum-agent/subagent-progress
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentProgressEvent, SubagentStopReason } from '@corum/corum-api-remotes/corum-events'
import { foldProgressEvent, type ProgressState } from './child-progress.ts'

/** 委派角色（来自父侧 `tool/call` 的工具名，见 `corum/subagent/child` 帧）。 */
export type SubagentRole = 'worker' | 'research' | 'fork'

/**
 * 进度跟踪器需要的**宿主能力**（窄接口：不依赖 CorumAgentService）。
 *
 * 两个 emit 由宿主注入而不是自己去查 ctx：事件名与载荷的收窄声明面在宿主侧
 * （`corum/subagent/*` 的声明在 fork 包 `@corum/corum-api-remotes`，本插件不 import
 * 它的运行时声明面，避免「两份模块实例」红线）。
 *
 * ⚠️ **刻意不含「这个会话在跑吗」**：那是 **agents registry** 的知识（官方
 * `agent.status`，因为常驻子会话跑完不 dispose ⇒「在 registry 里」≠「在跑」），
 * 且其判据 `pre-boot` 还需要「本进程启动时刻」——两者都由宿主在
 * `getChildSessionProgressRemote` 里算好后经 {@link SubagentProgressTracker.broadcastInterrupted}
 * 传入。跟踪器不做 registry 查询、不看时钟，这是它能被纯单测的前提。
 */
export interface ProgressHost {
  /** 发一条进度帧。 */
  emitProgress(frame: SubagentProgressEvent): void
  /** 发一条「半途失去运行」通知。 */
  emitInterrupted(info: {
    readonly sessionId: string
    readonly parentSessionId?: string
    readonly reason: 'not-running' | 'pre-boot'
    readonly turn: number
    readonly step: number
    readonly lastActive: number
  }): void
}

/**
 * 进度折叠表容量上限（超出时淘汰最久未活动条目；`session/disposed` 已精确清理）。
 *
 * 为什么要上限：长驻宿主里委派次数会累积，而无上限的 Map 就是一条内存泄漏
 * （与 `ConductorRuntime` 的效果表同属「按 sessionId 索引的进程内表」）。
 */
export const SUBAGENT_PROGRESS_CAP = 200

/**
 * 跟踪器持有的状态表**视图**（供测试台注入/检视，**是本模块与 harness 的契约点**）。
 *
 * 为什么要有它：测试台（`tests/harness.ts`）需要把状态表换成自己可观测的实例。
 * 若它按属性名去 `Object.defineProperty` 猜内部结构，那么**任何状态搬家都会让测试台
 * 静默失真**（挂上了，但被测代码读自己的那份）—— 这正是本轮 P0 要消灭的形态。
 * 故这里把「四张表」收成一个**有名有姓的契约**，搬表只需改这一个 getter。
 */
export interface SubagentProgressState {
  /** childSessionId → 委派角色。 */
  readonly roles: Map<string, SubagentRole>
  /** childSessionId → 父会话 id。 */
  readonly parents: Map<string, string>
  /** 已广播过中断的子会话。 */
  readonly notified: Set<string>
}

/**
 * 子 Agent 进度跟踪器（每个 `CorumAgentService` 持有一个实例）。
 */
export class SubagentProgressTracker {
  /** sessionId → 折叠态（插入序 = 最近活动序，LRU 淘汰的依据）。 */
  private readonly progressBySession = new Map<string, ProgressState>()

  /** childSessionId → 委派角色。⚠️ 内存态：推送帧不重放，故冷启动另有 durable 兜底。 */
  private readonly roles = new Map<string, SubagentRole>()

  /** childSessionId → 父会话 id。 */
  private readonly parents = new Map<string, string>()

  /**
   * 已广播过「半途失去运行」的子会话（进程内去重）。
   *
   * 判定发生在**读取**路径上，同一子会话会被反复拉取（花名册种子 + 卡片），
   * 不去重就会每拉一次刷一条通知。
   */
  private readonly notified = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly host: ProgressHost,
  ) {}

  /**
   * 三张「按会话索引的记账表」的**活视图**（不是快照拷贝——改它就改了跟踪器）。
   *
   * 折叠表 `progressBySession` 刻意**不在**这里：它的读写必须经本类的
   * {@link read} / {@link fold}（容量淘汰与 LRU 置顶都在里面），直接把 Map 交出去
   * 会让「谁在写这张表」重新变含糊 —— 那正是抽出本模块要解决的问题。
   */
  get state(): SubagentProgressState {
    return { roles: this.roles, parents: this.parents, notified: this.notified }
  }

  /** 当前折叠表条目数（容量守卫的可观测面；测试与诊断用）。 */
  get size(): number {
    return this.progressBySession.size
  }

  /**
   * 种一条折叠态（**仅供测试台**：造出「该会话已有终态/进度」的起点）。
   *
   * 为什么需要：`emitTerminalFrame` 与 `markTerminal` 都依赖「表里已有该会话」，
   * 而正常路径要靠一连串 `session/event` 才能把它喂出来。生产代码**不调用**本方法——
   * 表的所有权仍在 `fold` / `markTerminal` / `clear` 手里，本方法只是给测试一个
   * 显式入口，避免测试去反射内部 Map（那正是 harness 要消灭的失真形态）。
   */
  seed(sessionId: string, state: ProgressState): void {
    this.progressBySession.set(sessionId, state)
  }

  /** 读某会话的折叠态（`undefined` = 本进程没记过它）。 */
  read(sessionId: string): ProgressState | undefined {
    return this.progressBySession.get(sessionId)
  }

  /** 该会话的委派角色（本进程没记过 → `undefined`，花名册据此缺省）。 */
  roleOf(sessionId: string): SubagentRole | undefined {
    return this.roles.get(sessionId)
  }

  /**
   * 记一条 `corum/subagent/child` 帧（父会话归属与角色**分开记**）。
   *
   * 角色可能缺省（取不到工具名的路径），但父会话 id 一直有——中断广播要靠它给出
   * 通知的跳转目标（2026-09-13）。
   */
  noteChild(info: {
    readonly childSessionId?: string
    readonly parentSessionId?: string
    readonly role?: SubagentRole
  }): void {
    if (info.childSessionId !== undefined && info.parentSessionId !== undefined) {
      this.parents.set(info.childSessionId, info.parentSessionId)
    }
    if (info.childSessionId === undefined || info.role === undefined) return
    this.roles.set(info.childSessionId, info.role)
  }

  /**
   * 把一条子会话事件增量折进进度态；**快照有变化时返回推送帧**，否则 `undefined`。
   *
   * 折叠本体是 `child-progress.ts` 的纯函数（与全量读取路径共用，见模块头注）；
   * 本方法另外做两件**有状态**的事：容量淘汰与「置顶为最近活动」。
   */
  fold(sessionId: string, event: SessionEvent): SubagentProgressEvent | undefined {
    const prev = this.progressBySession.get(sessionId) ?? { turn: 0, step: 0, done: false }
    const next = foldProgressEvent(prev, event)
    if (next === undefined) return undefined // 非进度事件 / 无变化 ⇒ 不广播
    this.evictIfNeeded(sessionId)
    // 置顶为最近活动（容量淘汰的 LRU 依据）。
    this.progressBySession.delete(sessionId)
    this.progressBySession.set(sessionId, next)
    return {
      sessionId,
      turn: next.turn,
      step: next.step,
      ...next.currentAction === undefined ? {} : { currentAction: next.currentAction },
      done: next.done,
      ...next.stopReason === undefined ? {} : { stopReason: next.stopReason },
      lastActive: event.time,
      ...next.todos === undefined ? {} : { todos: next.todos },
    }
  }

  /**
   * `subagent/end` 终态兜底：子会话在首个 turn 打开前被取消时，`session/event` 不产生
   * `turn/start` / `turn/end`，{@link fold} 一帧不发；此处用宿主权威终态事件补发一帧。
   *
   * 已有终态帧（`stopReason` 已写入）时**不覆盖**，返回 `false` 让调用方走「补发改动摘要」
   * 那条路（幂等兜底）。
   *
   * @returns 是否新发了终态帧。
   */
  markTerminal(sessionId: string, stopReason: SubagentStopReason): boolean {
    const state = this.progressBySession.get(sessionId)
    if (state?.stopReason !== undefined) return false
    const next: ProgressState = {
      turn: state?.turn ?? 0,
      step: state?.step ?? 0,
      done: true,
      stopReason,
      ...state?.todos === undefined ? {} : { todos: state.todos },
    }
    this.evictIfNeeded(sessionId)
    this.progressBySession.delete(sessionId)
    this.progressBySession.set(sessionId, next)
    this.host.emitProgress({
      sessionId,
      turn: next.turn,
      step: next.step,
      done: true,
      stopReason,
      lastActive: Date.now(),
      ...next.todos === undefined ? {} : { todos: next.todos },
    })
    return true
  }

  /**
   * 发一帧带 `changeSummary` 的终态帧（P2 的改动摘要补发用）。
   *
   * `changeSummary` 缺省时**不带该键**（`exactOptionalPropertyTypes` 下
   * `changeSummary: undefined` 与「键不存在」在类型上就是两回事，UI 也按前者判降级）。
   */
  emitTerminalFrame(sessionId: string, changeSummary?: SubagentProgressEvent['changeSummary']): boolean {
    if (changeSummary === undefined) return false // 无改动摘要 ⇒ 调用方本就不该发这一帧
    const state = this.progressBySession.get(sessionId)
    if (state === undefined) return false // 会话已 dispose，进度表已清
    this.host.emitProgress({
      sessionId,
      turn: state.turn,
      step: state.step,
      ...state.currentAction === undefined ? {} : { currentAction: state.currentAction },
      done: true,
      ...state.stopReason === undefined ? {} : { stopReason: state.stopReason },
      lastActive: Date.now(),
      changeSummary,
    })
    return true
  }

  /** 会话 dispose → 清表（`session/disposed`）。 */
  clear(sessionId: string): void {
    this.progressBySession.delete(sessionId)
  }

  /**
   * 判定「半途失去运行」，并在**发现点**补一次中断广播（进程内去重）。
   *
   * 为什么在读取路径上发：这条事实**不是事件**——它是宿主对「上一个进程生命周期留下的
   * 未闭合 turn」的判定，只能在读持久化事件时得出。通知桥只订阅推送帧，所以此前这种
   * 子 Agent 完全静默（2026-09-12 实测：8 张卡里 1 张「已中断」，通知栏一条都没有）。
   *
   * ⚠️ 判据（`done` / `stopReason` / registry / `lastActive` vs 启动时刻）由调用方算好传入：
   * 本模块不做时钟与 registry 决策，只管「广播一次」这件事。
   *
   * @returns 是否本次真的广播了。
   */
  async broadcastInterrupted(
    sessionId: string,
    info: { readonly reason: 'not-running' | 'pre-boot', readonly turn: number, readonly step: number, readonly lastActive: number },
  ): Promise<boolean> {
    if (this.notified.has(sessionId)) return false
    // 先占位再 await：并发两次拉同一条进度时也只广播一次。
    this.notified.add(sessionId)
    const parentSessionId = await this.parentOf(sessionId)
    this.host.emitInterrupted({
      sessionId,
      ...parentSessionId === undefined ? {} : { parentSessionId },
      ...info,
    })
    return true
  }

  /**
   * 子会话的父会话 id（通知的跳转目标，也是「同一批合并成一条」的键）。
   *
   * 先查本进程记的 `corum/subagent/child` 帧；**帧不重放**（重启后一条都没有），
   * 于是退回**持久化 header** 的 `parentSession` —— 那是会话自身 durable 的事实，
   * 重启/刷新后依然在（2026-09-13 实测：只靠帧的话 9 个被中断的子 Agent 会各成一条
   * 通知，因为它们都没有父会话可归并）。
   */
  async parentOf(sessionId: string): Promise<string | undefined> {
    const known = this.parents.get(sessionId)
    if (known !== undefined) return known
    try {
      const handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), 'read')
      try {
        const parent = handle.header.parentSession
        if (parent === undefined) return undefined
        const id = String(parent)
        this.parents.set(sessionId, id)
        return id
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  /** 容量护栏：超出上限时淘汰最久未活动条目（Map 迭代序 = 插入序 = 最近活动序）。 */
  private evictIfNeeded(incoming: string): void {
    if (this.progressBySession.has(incoming)) return
    if (this.progressBySession.size < SUBAGENT_PROGRESS_CAP) return
    const oldest = this.progressBySession.keys().next().value
    if (oldest !== undefined) this.progressBySession.delete(oldest)
  }
}
