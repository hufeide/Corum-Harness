/**
 * Same-session goal-round driver over public agent, session, and goal services.
 * @module @deepseek-ai/dsh-goal-round-driver
 */

import { isDeepStrictEqual } from 'node:util'
import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync } from 'node:fs'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GoalMessageSource, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { renderGoalRoundPrompt } from './prompt.ts'

export { renderGoalRoundPrompt } from './prompt.ts'

export const name = 'goal-round-driver'
export const inject = ['agents', 'goals', 'sessions']

/** Identity reserved before a goal continuation enters the agent inbox. */
interface RoundIdentity {
  readonly goalId: GoalRef['id']
  readonly revision: number
  readonly round: number
}

/** One queued, claimed, or admitted goal message retained until whole-agent quiescence. */
interface RoundAttempt extends RoundIdentity {
  readonly messageId: MessageId
  readonly content: ContentBlock[]
  phase: 'queued' | 'claimed' | 'admitted'
  cancelled: boolean
  stale: boolean
}

/** Serialized process-local scheduling state for one exact Agent lifecycle. */
interface DriverState {
  readonly agent: Agent
  attempt: RoundAttempt | undefined
  competingQueued: boolean
  needsCheckpoint: boolean
  requested: boolean
  run: Promise<void> | undefined
  stopping: boolean
}

/** Whether a source identifies an automatic, positive-numbered goal round. */
function isGoalRoundSource(source: MessageSource): source is GoalMessageSource {
  return source.kind === 'goal' && source.round > 0
}

/** Compare a source to one reserved identity. */
function sameRound(source: GoalMessageSource, round: RoundIdentity): boolean {
  return source.goalId === round.goalId
    && source.revision === round.revision
    && source.round === round.round
}

/** Compare the complete queued record to the driver's reservation. */
function sameQueued(content: readonly ContentBlock[], source: MessageSource, attempt: RoundAttempt): boolean {
  return isGoalRoundSource(source) && sameRound(source, attempt) && isDeepStrictEqual(content, attempt.content)
}

/** Exact current ref for a view. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * corum fork delta（fork #17，2026-09-27）：**在飞委派登记表**。
 *
 * 官方驱动的判据只有「`agent.status === 'idle'`」，于是**后台委派一交派出去、父 Agent 的回合结束
 * 变 idle**，驱动就认定「空闲了、该继续推进」⇒ 立刻生成新一轮提示词并 `followup`：用户实测到的
 * 「Agent 在指派子代理或等待结果时反复唤醒」就是这个（每等一次结果空转一轮）。
 *
 * 这里按官方公开事件 `subagent/start` / `subagent/end` 记账（`end` 必与 `start` 配对，官方
 * `invariant.ts` 就在校验这一点），闸门判据改为「该 Agent（含其派生的子/孙 Agent）名下**没有**
 * 在飞 run 才开新轮」；`subagent/end` 到达时对发起它的父 Agent 重新评估 ⇒ 结果回来就继续推进，
 * 既不再空转、也不会卡住。
 *
 * 为什么用事件而不是直接读子会话状态：事件是官方公开面（`lifecycle.ts` 的
 * `(name, info, parent)` 签名），不耦合 corum 私有的 activation 表；`parent` 就是发起方，
 * 恰好是需要的判据。
 */
export class PendingDelegations {
  private readonly runs = new Map<string, Agent>()

  /** 记一次 run 开始（`subagent/start`）。 */
  start(runId: string, parent: Agent): void {
    this.runs.set(runId, parent)
  }

  /** 记一次 run 结束（`subagent/end`）；未知 id 是空操作（配对由官方 invariant 保证）。 */
  end(runId: string): void {
    this.runs.delete(runId)
  }

  /** 在飞 run 数（测试/日志用）。 */
  get size(): number {
    return this.runs.size
  }

  /**
   * `agent` 名下（含其派生的子/孙 Agent）是否有在飞的 run。
   * @param agent - 待判定的 Agent（goal 轮的发起方）。
   * @param resolve - 会话 id → 存活 Agent（宿主 `ctx.agents.get`）。
   * @returns 有在飞委派为 true（此时**不得**开新轮）。
   */
  pendingUnder(agent: Agent, resolve: (sessionId: SessionId) => Agent | undefined): boolean {
    for (const parent of this.runs.values()) {
      if (isSelfOrDescendant(parent, agent, resolve)) return true
    }
    return false
  }
}

/**
 * `candidate` 是否就是 `ancestor` 或其后代（沿 `session.header.parentSession` 上溯，深度有界）。
 * @param candidate - 发起某个 run 的 Agent。
 * @param ancestor - 待判定的祖先。
 * @param resolve - 会话 id → 存活 Agent。
 * @returns 属于该子树为 true。
 */
export function isSelfOrDescendant(
  candidate: Agent,
  ancestor: Agent,
  resolve: (sessionId: SessionId) => Agent | undefined,
): boolean {
  let current: Agent | undefined = candidate
  for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
    if (current === ancestor) return true
    const parentSession = current.session.header.parentSession
    if (parentSession === undefined) return false
    current = resolve(parentSession)
  }
  return false
}

/**
 * 委派事件载荷（本包只看 `runId`；其余字段由 subagent 包声明，本包的程序看不到那个
 * `Events` 合并 ⇒ 按 dev-conventions §2.4 收窄，不 import 实现包去拿类型）。
 */
interface SubagentRunInfo {
  readonly runId?: unknown
}

/**
 * 诊断追踪（**按环境变量开关**）：`CORUM_GOAL_TRACE=/path/to.log` 时把委派登记与闸门判定
 * 逐条追加到该文件。默认关闭、零开销；用于实机定位"闸门是否真的挡住/是否卡住"这类问题
 * （本轮就是靠它区分「事件没到」与「到了但没重评估」）。
 * @param message - 追踪行。
 */
function trace(message: string): void {
  const file = process.env.CORUM_GOAL_TRACE
  if (file === undefined || file === '') return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 追踪不得影响机制本身
  }
}

/** Install automatic same-session continuation and its race fences. */
export function apply(ctx: Context): void {
  const states = new Map<Agent, DriverState>()
  // corum fork delta：在飞委派登记表（整插件一份；`end` 会摘除条目）。
  const pending = new PendingDelegations()

  /** Create state for an exact currently live agent. */
  function stateFor(agent: Agent): DriverState {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: DriverState = {
      agent,
      attempt: undefined,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      run: undefined,
      stopping: false,
    }
    states.set(agent, state)
    return state
  }

  /** Read only when the exact Agent remains live. */
  function currentGoal(state: DriverState): GoalView | undefined {
    if (ctx.agents.get(state.agent.id) !== state.agent) return undefined
    return ctx.goals.get(state.agent)
  }

  /**
   * Whether this exact lifecycle is quiescent with no competing prompt.
   *
   * corum fork delta（fork #17）：额外要求**名下没有在飞的委派**。官方只看 `idle`，
   * 而后台委派后父 Agent 恰好就是 idle（回合已结束、子在跑）⇒ 会立刻空转开新轮。
   */
  function readyToDrive(state: DriverState): boolean {
    return ctx.fiber.state === FiberState.ACTIVE
      && !state.stopping
      && ctx.agents.get(state.agent.id) === state.agent
      && state.agent.status === 'idle'
      && !state.competingQueued
      && !(pending.pendingUnder(state.agent, sessionId => ctx.agents.get(sessionId))
        ? (trace(`gate  BLOCK ${state.agent.id} pending=${pending.size}`), true)
        : false)
  }

  /** Recheck every condition that an awaited checkpoint may have changed. */
  function readyAfterCheckpoint(state: DriverState): boolean {
    return readyToDrive(state) && !state.needsCheckpoint
  }

  /** Remove automatic authority while preserving the durable phase. */
  function disarm(state: DriverState): void {
    try {
      const goal = currentGoal(state)
      if (goal?.activation === 'armed') ctx.goals.disarm(state.agent)
    } catch (error: unknown) {
      ctx.logger.warn(`goal-round-driver: could not disarm agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /** Preserve claimed step context when this driver drops only its own round. */
  function restoreOtherClaimed(agent: Agent, messages: UserMessage[], messageId: MessageId): void {
    const retained = messages.filter(message => message.id !== messageId
      && !(message.source.kind === 'goal' && message.source.round === 0))
    for (const message of retained.toReversed()) {
      if (agent.inbox.nextStep.some(candidate => candidate.id === message.id)
        || agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) continue
      agent.inbox.prepend('next-step', message)
    }
  }

  /** Process admitted work at quiescence, then reserve at most one next round. */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state
    if (!readyToDrive(state)) return

    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
        return
      }
      // A mutation or ordinary prompt may have arrived while the checkpoint
      // was settling. Give it its own checkpoint / turn before reserving.
      if (!readyAfterCheckpoint(state)) return
    }

    const attempt = state.attempt
    if (attempt !== undefined) {
      state.attempt = undefined
      state.needsCheckpoint = true
      state.requested = true
      return
    }

    const goal = currentGoal(state)
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      ctx.goals.block(agent, goalRef(goal), {
        code: 'round-limit',
        message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
      })
      return
    }

    const round = goal.roundsStarted + 1
    const content = renderGoalRoundPrompt(goal, round)
    const message = createUserMessage({
      content,
      source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round },
    })
    const reservation: RoundAttempt = {
      goalId: goal.id,
      revision: goal.revision,
      round,
      messageId: message.id,
      content,
      phase: 'queued',
      cancelled: false,
      stale: false,
    }
    state.attempt = reservation
    try {
      agent.followup(message)
    } catch (error: unknown) {
      state.attempt = undefined
      ctx.logger.warn(`goal-round-driver: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`)
      const latest = currentGoal(state)
      if (latest !== undefined && latest.id === goal.id && latest.revision === goal.revision
        && latest.phase === 'active' && latest.activation === 'armed') {
        ctx.goals.block(agent, goalRef(latest), {
          code: 'queue-failed',
          message: `Could not queue goal round ${round}: ${renderThrown(error)}`,
        })
      }
    }
  }

  /** Coalesce triggers onto one agent-local serialized driver. */
  function requestDrive(state: DriverState): void {
    /* v8 ignore next -- teardown may race a final trigger after synchronously closing the step fence */
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error: unknown) {
            ctx.logger.warn(`goal-round-driver: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`)
            disarm(state)
          }
        }
      })
    } catch (error: unknown) {
      ctx.logger.warn(`goal-round-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, (error: unknown) => {
      ctx.logger.warn(`goal-round-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state)
      retire()
    })
  }

  // One composite effect keeps the step fence installed until this
  // plugin's own scheduling tasks settle.
  ctx.effect(function* () {
    ctx.on('agent/error', ({ agent }) => {
      const state = stateFor(agent)
      disarm(state)
    })

    // corum fork delta（fork #17）：登记/摘除在飞委派；`end` 到达即对发起方重新评估，
    // 于是"结果回来了"会继续推进（先前因为闸门被挡住，不会有人再唤醒父 Agent）。
    // ⚠️ 父 Agent 在 dispatch 的 **`this`（scope carrier）**里，**不是第二参数**：
    // fork #9 声明为 `'subagent/start'|'subagent/end'(this: Scoped<SubagentRuntime>, info)`，
    // 发射端只 `callback(info)`。**照抄 corum-tool-subagent 的既有教训**（那里曾写成
    // `(info, parentAgent)` ⇒ 恒 undefined ⇒ 抛错被 emitter 的 per-listener 容错吞掉 ⇒
    // 逻辑从未生效）：用普通函数取 `this`，经 `carrierKeyOf` 解出父 Agent；取不到就跳过
    // （宁可不登记，也不要抛错后被静默吞掉）。
    ctx.on('subagent/start' as never, (function (this: unknown, info: SubagentRunInfo) {
      const parent = carrierKeyOf(this) as unknown as Agent | undefined
      trace(`start run=${String(info.runId)} parent=${parent?.id ?? 'UNRESOLVED'}`)
      if (parent !== undefined) pending.start(String(info.runId), parent)
    }) as never)
    ctx.on('subagent/end' as never, (function (this: unknown, info: SubagentRunInfo) {
      const parent = carrierKeyOf(this) as unknown as Agent | undefined
      pending.end(String(info.runId))
      trace(`end   run=${String(info.runId)} parent=${parent?.id ?? 'UNRESOLVED'} pendingAfter=${pending.size}`)
      // 结果回来 ⇒ 重新评估（先前被闸门挡住的唤醒不会再有人补，不接这步会卡住）。
      if (parent !== undefined) {
        requestDrive(stateFor(parent))
        trace(`end   → requestDrive(${parent.id})`)
      }
    }) as never)

    ctx.on('agent/disposed', ({ agent }) => { states.delete(agent) })
    ctx.on('agent/created', ({ agent }) => {
      const state = stateFor(agent)
      state.attempt = undefined
      state.competingQueued = false
      state.needsCheckpoint = false
    })
    ctx.on('agent/status', ({ agent, status }) => {
      const state = stateFor(agent)
      if (status === 'idle') {
        state.competingQueued = false
        const attempt = state.attempt
        const goal = currentGoal(state)
        // Fence the pause to the exact dropped attempt's ref. A resume bumps
        // the revision, so a host pause followed by an immediate resume (before
        // the aborted turn converges to idle) must not re-pause the resumed goal.
        if (attempt !== undefined
          && (attempt.phase === 'queued' || attempt.phase === 'claimed' || attempt.cancelled)
          && goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'
          && attempt.goalId === goal.id && attempt.revision === goal.revision) {
          state.attempt = undefined
          try {
            ctx.goals.pause(agent, goalRef(goal))
          } catch (error: unknown) {
            ctx.logger.warn(`goal-round-driver: could not pause cancelled goal for agent "${agent.id}": ${renderThrown(error)}`)
            disarm(state)
          }
        }
        requestDrive(state)
      }
    })
    ctx.on('goal/changed', ({ agent, change }) => {
      const state = stateFor(agent)
      state.needsCheckpoint = true
      // A host-initiated pause stops goal execution: abort the live turn so the
      // model cannot keep acting or resume in the same turn. A model-initiated
      // pause (update_goal inside its own turn) finishes normally.
      if (change.operation === 'pause' && agent.status === 'running'
        && ctx.agents.currentInitiator() !== agent) {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      }
      requestDrive(state)
    })

    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) return
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) return
      state.competingQueued = true
      if (attempt?.phase === 'queued') attempt.stale = true
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.phase = 'claimed'
      }
    })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.cancelled = true
      }
    })

    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      const state = stateFor(agent)
      switch (event.type) {
        case 'user/message':
          if (state.attempt !== undefined && event.data.id === state.attempt.messageId) {
            state.attempt.phase = 'admitted'
          }
          return
        case 'turn/end':
          if (event.data.reason.kind === 'max-tokens') {
            disarm(state)
            return
          }
          if (event.data.reason.kind !== 'aborted') return
          if (state.attempt?.phase === 'claimed' || state.attempt?.phase === 'admitted') {
            state.attempt.cancelled = true
          }
          else disarm(state)
          return
        default:
          return
      }
    })

    /** Fail closed unless the queued prompt still owns the exact live revision. */
    function validReservation(
      state: DriverState,
      content: readonly ContentBlock[],
      source: GoalMessageSource,
    ): boolean {
      const attempt = state.attempt
      const goal = currentGoal(state)
      return ctx.fiber.state === FiberState.ACTIVE
        && !state.stopping && attempt !== undefined && attempt.phase === 'claimed'
      && !attempt.stale && sameQueued(content, source, attempt)
      && goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
      && goal.phase === 'active' && goal.activation === 'armed'
      && source.round === goal.roundsStarted + 1
    }

    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
      const submitted = messages.find((message): message is UserMessage & { source: GoalMessageSource } =>
        isGoalRoundSource(message.source))
      if (submitted === undefined) return next()
      const { content, source } = submitted
      const state = stateFor(agent)
      let valid = false
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
      }
      if (!valid) {
        const attempt = state.attempt
        if (attempt !== undefined && sameRound(source, attempt)) {
          attempt.stale = true
          state.attempt = undefined
        }
        restoreOtherClaimed(agent, messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      let decision: PreStepDecision
      try {
        decision = await next()
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // A throwing downstream hook drops the whole step proposal. Clear the
        // reservation before the balanced no-step turn returns to idle so the
        // next drive pass can reschedule the round.
        state.attempt = undefined
        requestDrive(state)
        throw error
      }
      if (signal.aborted) {
        if (decision.kind === 'enter') restoreOtherClaimed(agent, decision.messages, submitted.id)
        return decision
      }
      if (decision.kind === 'reject') {
        state.attempt = undefined
        const goal = currentGoal(state)
        if (goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
          && goal.phase === 'active' && goal.activation === 'armed') {
          ctx.goals.block(agent, goalRef(goal), {
            code: 'prompt-rejected',
            message: 'Goal round was rejected before entering its step.',
          })
        }
        return decision
      }
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
        valid = false
      }
      if (!valid) {
        state.attempt = undefined
        restoreOtherClaimed(agent, decision.messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      return { ...decision, startsRequestSeries: true }
    })

    // Loading a lifecycle driver over existing agents never inherits hidden
    // automatic authority from an earlier producer instance.
    for (const agent of ctx.agents.list()) {
      const state = stateFor(agent)
      disarm(state)
    }

    // Yielded after listener registration, so this close runs first and the
    // composite effect removes listeners only after its promise settles.
    yield async () => {
      const waits: Promise<void>[] = []
      for (const state of states.values()) {
        state.stopping = true
        disarm(state)
        const attempt = state.attempt
        if (attempt !== undefined) {
          attempt.stale = true
          /* v8 ignore next -- followup reserves the live agent before publishing a queued attempt */
          if (state.agent.status === 'running') {
            state.agent.cancel({ kind: 'parent' })
            waits.push(state.agent.whenIdle())
          }
        }
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'goal-round-driver lifecycle')
}
