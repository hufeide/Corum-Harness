/**
 * Continuable-subagent orchestration behind `ctx.subagents`: stable child ids,
 * descriptor persistence, provider preparation, cold resume, authorization,
 * and message routing. {@link ContinuableActivationRegistry} owns the mutable
 * process-local Activation graph and its settlement and disposal lifecycle.
 *
 * A continuable child has one durable Session and at most one process-local
 * Activation. The Agent inbox is the only turn queue, so this manager owns
 * durable orchestration while the Agent loop owns all turn ordering and
 * execution. No continuable path creates a Task or an intermediate
 * result-bearing wrapper.
 *
 * @module @corum/corum-subagent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import {
  childSessionMeta,
  captureDelegatedPolicyOverrides,
  resolveChildAgentOptions,
  resolveChildDepth,
} from './child-agent.ts'
import {
  ContinuableActivationRegistry,
} from './continuation-activation.ts'
import type { Activation } from './continuation-activation.ts'
import {
  createAgentMessage,
  withContinuableReturnGuidance,
} from './continuation-messages.ts'
export type {
  AgentMessageSource,
  SubagentSettledMessageSource,
} from './continuation-messages.ts'
import { assertChildCwd, assertSubagentMaxDepth } from './depth.ts'
import { foldSubagentDescriptor, snapshotSubagentDescriptor } from './descriptor.ts'
import { SubagentError } from './error.ts'
import { isAdjacentAgentSendMessageTool } from './internal.ts'
import type { ActivationObserver } from './lifecycle.ts'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  SubagentStartRequest,
} from './types.ts'

/** What a caller asks for when starting a continuable background child. */
export interface ContinuableStartSpec {
  /** The `ctx.subagents` provider whose continuable-creation capability establishes the child. */
  readonly provider: string
  /** The initial delegation's short `description`, persisted as the child's creation label. */
  readonly label: string
  /**
   * Optional caller-reserved child identity. Omission preserves the manager's
   * UUID allocation; supplying one lets a durable parent record provisioning
   * before child materialization without a second identity handshake.
   */
  readonly childId?: SessionId
  /**
   * The delegation request. The manager reserves the stable child id, resolves
   * the durable descriptor, and composes the child itself.
   */
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}

/** Identities returned once a continuable child accepted its initial prompt. */
export interface ContinuableStart {
  /** The durable child session id, stable across activations. */
  readonly childId: SessionId
  /** The accepted initial prompt's inbox message id. */
  readonly messageId: MessageId
}

/**
 * Authority under which one interrupt request is admitted. `user` carries the
 * durable direct-parent address a human client presented; `ancestor` carries
 * the exact live Agent object whose recorded lineage must contain the caller.
 */
export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent }

/** Options for one model-authored message between adjacent Agents. */
export interface SubagentSendMessageOptions {
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
  /**
   * corum（fork #9 增量）：本次投递的 LLM 路线覆盖（provider/model[/reasoningEffort]）。
   *
   * 动机：可续接子 Agent 以 `stopReason: 'error'` 终结（如其模型不可用）后被 DISPOSED，
   * 父机制要带着既有上下文在同一条子会话上换路线续跑。该覆盖**只按次生效、不落盘**：
   * 它仅参与 `coldResume` 对恢复 Agent 的物化，永不写回 descriptor（descriptor 仍在
   * 创建时一次性追加，保持权威）；之后的无覆盖投递/恢复自动回落到描述符路线。
   *
   * **已驻留（resident）的子 Agent 不应用此覆盖**：为换路线拆掉一个正在（或可以）
   * 干活的 Activation 是错的，覆盖只 honoring 在冷恢复路径上；需要换路线时先让/等
   * 子 Agent 结算，再在下一次投递上携带覆盖（届时走 coldResume）。
   */
  readonly agentOptions?: AgentOptions
}

/** Inputs shared by model steering and the human Queue adapter. */
type ChildDeliveryOptions =
  | {
    readonly delivery: 'steer'
    /**
     * A provided host source is preserved on the user message; omission attributes
     * an adjacent-Agent message to the parent.
     */
    readonly source?: MessageSource
    readonly signal: AbortSignal
    /**
     * corum（fork #9 增量）：本次投递的路线覆盖；仅冷恢复路径 honoring，驻留子 Agent
     * 忽略（见 {@link SubagentSendMessageOptions.agentOptions} 的注释）。
     */
    readonly agentOptions?: AgentOptions
  }
  | {
    readonly delivery: 'queue'
    readonly source: MessageSource
    readonly signal: AbortSignal
    /** 同上：仅冷恢复路径 honoring 的按次路线覆盖。 */
    readonly agentOptions?: AgentOptions
  }

/** Package-private hooks supplied by the owning service. */
interface ContinuationHost {
  /** Resolve one provider's detached continuable-creation contribution. */
  prepareContinuable(name: string, request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
  /** Build the lifecycle observer for one Activation residency epoch. */
  observeActivation(provider: string, childId: SessionId, parent: Agent): ActivationObserver
}

/**
 * The continuable-subagent orchestration service behind `ctx.subagents`. Tool
 * schema and host adapters are consumers of this one contract; foreground
 * one-shot delegation keeps calling `ctx.subagents.start()` and never enters
 * this lifecycle.
 */
export class SubagentContinuationManager {
  private readonly activations: ContinuableActivationRegistry

  constructor(
    private readonly ctx: Context,
    private readonly host: ContinuationHost,
  ) {
    this.activations = new ContinuableActivationRegistry(
      ctx,
      (provider, childId, parent) => host.observeActivation(provider, childId, parent),
    )
  }

  /**
   * Start one continuable background child and resolve at initial inbox acceptance.
   * Every earlier failure disposes any created handle and rolls back Activation
   * and parent ownership without returning either id.
   * @param spec - provider, delegation request, and caller cancellation.
   * @returns the durable child id and accepted initial prompt message id.
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    const request = spec.request
    const parent = request.parent
    this.activations.assertAdmitting(parent)
    const persistence = this.requirePersistence()
    assertSubagentMaxDepth(request.maxDepth)
    assertChildCwd(request.cwd)
    const childId = spec.childId ?? brandString<SessionId>(randomUUID())
    this.activations.assertChildIdAvailable(childId)
    const childDepth = resolveChildDepth(parent, request.maxDepth)
    // Snapshot before any await: invalid descriptor JSON rejects the call
    // before a child exists, and the detached value is what reaches the log.
    const agentOptions = resolveChildAgentOptions(parent, request.agentOptions, childDepth)
    const agentProvider = agentOptions.provider
    const agentModel = agentOptions.model
    const agentReasoningEffort = agentOptions.reasoningEffort
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: spec.provider,
      label: spec.label,
      ...agentProvider !== undefined ? { agentProvider } : {},
      ...agentModel !== undefined ? { agentModel } : {},
      ...agentReasoningEffort !== undefined ? { agentReasoningEffort } : {},
      ...request.persona !== undefined ? { persona: request.persona } : {},
      // fork（corum）2026-09-20：种类与注入层落盘（resume 时据此重放同一套角色契约）。
      ...request.kind !== undefined ? { kind: request.kind } : {},
      ...request.personaHint !== undefined ? { personaHint: request.personaHint } : {},
      // fork（corum）2026-09-22：隔离写边界标记落盘（resume 时据此重装门禁）。
      ...request.confinedSandbox === true ? { confined: true } : {},
      ...request.toolFilter !== undefined ? { toolFilter: request.toolFilter } : {},
    })
    // Capture before the first await: a later parent switch belongs to the
    // parent's future, not to this child.
    //
    // fork（corum）2026-09-22：隔离后台子会话同样钉沙箱（正交轴，修法 1）——`confinedSandbox`
    // 由工具层/isolated provider 在**隔离建成后**置位；这里与 one-shot 路径共享同一判定，
    // 否则「默认后台」的 continuable 委派会漏掉隔离边界（正是本次要修的一类漏项）。
    const delegatedPolicies = captureDelegatedPolicyOverrides(parent, {
      pinReadOnly: request.readonlySandbox === true,
      confineToWorktree: request.confinedSandbox === true,
    })

    // An idle continuation-managed parent must not settle while a caller is
    // still creating its child. A turn-scoped delegation does not need this,
    // but the service is also callable outside a turn.
    const releaseHold = this.activations.holdOwnership(parent, childId)
    try {
      const prepared = await this.host.prepareContinuable(spec.provider, {
        sessionId: childId,
        parent,
        signal: spec.signal,
      })
      spec.signal.throwIfAborted()
      this.activations.assertAdmitting(parent)

      const inheritedEventCount = SessionLogOffset(prepared.seed?.length ?? 0)
      const seed = prepared.seed
      const messageId = await this.activations.locks.run(childId, async () => {
        spec.signal.throwIfAborted()
        this.activations.assertAdmitting(parent)
        this.activations.assertChildIdAvailable(childId)
        if (spec.childId !== undefined) {
          const persisted = await persistence.stat(childId, { signal: spec.signal })
          spec.signal.throwIfAborted()
          this.activations.assertAdmitting(parent)
          this.activations.assertChildIdAvailable(childId)
          if (persisted !== undefined) {
            throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD')
          }
        }
        const activation = await this.activations.materialize({
          childId,
          provider: spec.provider,
          parent,
          create: {
            seed,
            meta: childSessionMeta(parent, childDepth, prepared.seed !== undefined, request.cwd),
            inheritedEventCount,
            delegatedPolicies,
            descriptor,
          },
          agentOptions,
          composition: {
            ...request.kind === undefined ? {} : { kind: request.kind },
            ...request.personaHint === undefined ? {} : { personaHint: request.personaHint },
            persona: request.persona,
            toolFilter: request.toolFilter,
            // fork（corum）2026-09-22：隔离写边界门禁（纵深防御；边界取子会话 cwd）。
            ...request.confinedSandbox === true ? { confined: true } : {},
          },
          signal: spec.signal,
        })
        const childHeader = activation.handle.agent.session.header
        return await this.submitMaterialized(
          activation,
          isAdjacentAgentSendMessageTool(this.ctx.get('tools')?.get('send_message', activation.handle.agent))
            ? withContinuableReturnGuidance(parent.id, request.prompt)
            : request.prompt,
          { source: { kind: 'user' }, signal: spec.signal, delivery: 'queue' },
          parent,
        )
      })
      return { childId, messageId }
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /**
   * Deliver one model-authored message to a direct continuable child or to the
   * sender's direct parent. A missing direct child cold-resumes through the
   * ordinary continuation lifecycle.
   * @param sender - exact live Agent authorizing and originating the message.
   * @param targetId - durable direct-parent or direct-child session id.
   * @param content - model-authored content to deliver.
   * @param options - caller cancellation before acceptance.
   * @returns the accepted message's inbox id.
   */
  async sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: SubagentSendMessageOptions,
  ): Promise<MessageId> {
    if (this.ctx.agents.get(sender.id) !== sender) {
      throw new SubagentError(
        'message delivery requires the exact live sender agent',
        'UNAUTHORIZED',
      )
    }
    this.activations.assertAdmitting(sender)
    const senderActivation = this.activations.get(sender.id)
    if (senderActivation !== undefined
      && senderActivation.handle.agent === sender
      && senderActivation.parentSession === targetId) {
      options.signal.throwIfAborted()
      return this.sendToParent(senderActivation, sender, content)
    }
    if (sender.session.header.parentSession === targetId) {
      throw new SubagentError(
        `agent "${sender.id}" is not a resident continuable child and cannot send to parent "${targetId}"`,
        'UNAUTHORIZED',
      )
    }
    return this.deliverToChild(sender, targetId, content, {
      signal: options.signal,
      delivery: 'steer',
      // corum（fork #9 增量）：随投递透传按次路线覆盖（undefined 时不产生覆盖）。
      ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
    })
  }

  /**
   * Queue one human-authored prompt as a distinct direct-child turn.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution for the human prompt.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted durable message id.
   */
  async queuePrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
    agentOptions?: AgentOptions,
  ): Promise<MessageId> {
    return this.deliverToChild(parent, childId, content, {
      source,
      signal,
      delivery: 'queue',
      ...(agentOptions === undefined ? {} : { agentOptions }),
    })
  }

  /**
   * Steer one host-authored prompt to a direct continuable child.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution for the host prompt.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted durable message id.
   */
  async steerPrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
    agentOptions?: AgentOptions,
  ): Promise<MessageId> {
    return this.deliverToChild(parent, childId, content, {
      source,
      signal,
      delivery: 'steer',
      ...(agentOptions === undefined ? {} : { agentOptions }),
    })
  }

  /** Route one parent-originated delivery through residency and cold resume. */
  private async deliverToChild(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    this.activations.assertAdmitting(parent)
    const releaseHold = this.activations.holdOwnership(parent, childId)
    try {
      return await this.deliverFollowup(parent, childId, content, options)
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /** The delivery loop behind {@link deliverToChild}, run under the parent hold. */
  private async deliverFollowup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    while (true) {
      const live = await this.activations.locks.run(childId, async () => {
        const activation = this.activations.get(childId)
        if (activation === undefined) return this.coldResume(parent, childId, content, options)
        const disposal = activation.inbox.closing
        /* v8 ignore next 3 -- the send-versus-dispose cutoff needs a delivery to
         * observe the transaction inside the same critical section that opened it. */
        if (disposal !== undefined) {
          return disposal.then(() => undefined, () => undefined)
        }
        if (contentHasImage(content)) {
          await this.assertImageCapable(activation.handle.agent, options.signal)
          if (activation.inbox.closing !== undefined) {
            await Promise.allSettled([activation.inbox.closing])
            return undefined
          }
        }
        const messageId = this.submitAdmitted(activation, content, options, parent)
        activation.announced = true
        return messageId
      })
      /* v8 ignore start -- only a delivery that lost the disposal cutoff retries. */
      if (live !== undefined) return live
      this.activations.assertAdmitting(parent)
      options.signal.throwIfAborted()
      /* v8 ignore stop */
    }
  }

  /**
   * Interrupt one live continuable child's current turn. Admission is
   * synchronous and the cancellation effect is asynchronous. An absent or
   * already-closing target is an accepted no-op after authority checks.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live ancestor Agent.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.activations.interrupt(targetSessionId, authority)
  }

  /**
   * corum（fork #9 增量）：用户停止一个会话 = 立即停止该会话子树里所有在跑的
   * 可续接子 Agent，并抑制它们结算时的「唤醒父会话」。委托给
   * {@link ContinuableActivationRegistry.stopConversation}。
   * @param sessionId - 被用户停止的会话 id（停止标记的根）。
   * @returns 实际被取消的活跃子 Agent 数（供日志与测试断言）。
   */
  stopConversation(sessionId: SessionId): number {
    return this.activations.stopConversation(sessionId)
  }

  /**
   * corum（fork #9 增量）：解除该会话的用户停止标记——用户重新发消息（或会话
   * 释放）后，结算通知恢复默认的「唤醒父会话」语义。幂等。
   * @param sessionId - 会话 id。
   */
  resumeConversation(sessionId: SessionId): void {
    this.activations.resumeConversation(sessionId)
  }

  /** Deliver one resident continuable child's message to its live direct parent. */
  private sendToParent(
    activation: Activation,
    sender: Agent,
    content: ContentBlock[],
  ): MessageId {
    /* v8 ignore next 6 -- only synchronous re-entrant teardown can open this
     * transaction between exact-agent authorization and this no-await span. */
    if (activation.inbox.closing !== undefined) {
      throw new SubagentError(
        `subagent "${sender.id}" activation is being disposed; the message was not delivered`,
        'ACTIVATION_CLOSING',
      )
    }
    const parent = this.ctx.agents.get(activation.parentSession)
    if (parent === undefined) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
      )
    }
    const message = createAgentMessage(sender, content)
    this.sendAgentMessage(parent, message)
    // 投递成功后记账（抛错时不记）：结算通知据此不再重复 closing message。
    activation.deliveredToParent = true
    return message.id
  }

  /** Send one Agent message while translating only the target's own rejection. */
  private sendAgentMessage(
    parent: Agent,
    message: ReturnType<typeof createUserMessage>,
  ): void {
    try {
      this.activations.sendWaking(parent, message, 'steer')
    } catch (error: unknown) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
        { cause: error },
      )
    }
  }

  /** Close manager-wide admission and release every live Activation. */
  async drain(): Promise<void> {
    await this.activations.drain()
  }

  /**
   * Stop only the continuable descendants of exact live host-owned parents.
   * @param parents - exact live roots whose continuable descendants must stop.
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    await this.activations.drainDescendants(parents)
  }

  /**
   * Release selected resident direct children of one exact live parent.
   * @param parent - exact live direct parent authorizing the selected release.
   * @param childIds - durable direct-child ids to release when resident.
   */
  async drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    await this.activations.drainChildren(parent, childIds)
  }

  /**
   * Cold-resume a persisted child and submit the waiting turn. The descriptor
   * supplies every reconstruction input; no subagent provider is dispatched.
   */
  private async coldResume(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    const query = this.requireSessionQuery()
    let observation: SessionObservation
    try {
      observation = await query.observeSession(childId, {
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    using source = observation
    this.activations.assertAdmitting(parent)
    this.activations.authorizeLineage(parent, childId, source.header.parentSession)
    const descriptor = foldSubagentDescriptor(
      source.events.slice(source.inheritedEventCount),
    )
    if (descriptor === undefined || descriptor.mode !== 'continuable') {
      throw new SubagentError(
        `subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`,
        'NOT_RESUMABLE',
      )
    }
    let activation: Activation
    try {
      // corum（fork #9 增量）：按次路线覆盖合入冷恢复的物化 options（覆盖赢）。
      // ① **只在冷恢复路径 honoring**：驻留子 Agent 不拆不换（见 SubagentSendMessageOptions 注释）；
      // ② **非持久**：合入结果只物化本次 Activation，永不写回 descriptor——之后无覆盖的
      //    投递仍按 descriptor 路线恢复，descriptor 保持创建时一次追加的权威语义；
      // ③ **effort 清除规则**与 resolveChildAgentOptions 一致：覆盖换掉了 provider/model
      //    却没给 effort 时，descriptor 的 agentReasoningEffort 属于旧路线，静默携带会让
      //    新模型拒绝一个它不支持的 effort（UNSUPPORTED_REASONING_EFFORT），故清除。
      const override = options.agentOptions
      const resumedRoute: AgentOptions = {
        ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
        ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
        ...descriptor.agentReasoningEffort !== undefined
          ? { reasoningEffort: ReasoningEffortId(descriptor.agentReasoningEffort) }
          : {},
        ...override,
      }
      if (
        override !== undefined
        && (resumedRoute.provider !== descriptor.agentProvider || resumedRoute.model !== descriptor.agentModel)
        && override.reasoningEffort === undefined
      ) {
        delete resumedRoute.reasoningEffort
      }
      activation = await this.activations.materialize({
        childId,
        provider: descriptor.provider,
        parent,
        agentOptions: resumedRoute,
        composition: {
          ...descriptor.kind === undefined ? {} : { kind: descriptor.kind },
          ...descriptor.personaHint === undefined ? {} : { personaHint: descriptor.personaHint },
          persona: descriptor.persona,
          toolFilter: descriptor.toolFilter,
          // fork（corum）2026-09-22：冷恢复重装隔离写边界门禁（不落盘则会丢这一层）。
          ...descriptor.confined === true ? { confined: true } : {},
        },
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      if (error instanceof SubagentError) throw error
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    return await this.submitMaterialized(activation, content, options, parent)
  }

  /** Admit a materialized child, commit its creation fact, and release it on failure. */
  private async submitMaterialized(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
  ): Promise<MessageId> {
    try {
      if (contentHasImage(content)) {
        await this.assertImageCapable(activation.handle.agent, options.signal)
        if (activation.inbox.closing !== undefined) {
          throw new SubagentError(`subagent "${activation.childId}" is closing`, 'ACTIVATION_CLOSING')
        }
      }
      const messageId = this.submitAdmitted(activation, content, options, parent)
      activation.announced = true
      return messageId
    } catch (error: unknown) {
      try {
        await this.activations.dispose(activation)
      } catch (cleanupError: unknown) {
        this.ctx.logger.warn(
          `subagent continuation: disposal after admission failure also failed: ${String(cleanupError)}`,
        )
      }
      throw error
    }
  }

  /** Build and submit one message across the final synchronous admission cutoff. */
  private submitAdmitted(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
  ): MessageId {
    const message = options.source === undefined
      ? createAgentMessage(parent, content)
      : createUserMessage({ content, source: options.source })
    return this.activations.submitAdmitted(
      activation,
      message,
      options.delivery,
      parent,
      options.signal,
    )
  }

  /** Refuse image content for a child whose fixed model accepts text only. */
  private async assertImageCapable(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<void> {
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return
    const llm = this.ctx.get('llm')
    /* v8 ignore next -- without an LLM registry, delivery defers to projection. */
    if (llm === undefined) return
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      throw new SubagentError(
        `Model "${model}" does not support image input.`,
        'MODEL_DOES_NOT_SUPPORT_IMAGES',
      )
    }
  }

  /** Resolve the persistence service continuable children require, or fail loud. */
  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new SubagentError(
        'continuable subagents require session persistence (load a dsh-session-persistence backend)',
        'PERSISTENCE_UNAVAILABLE',
      )
    }
    return persistence
  }

  /** Resolve the Session query service used for cold child observations. */
  private requireSessionQuery(): SessionQueryEngine {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      throw new SubagentError(
        'continuable subagents require session query (load @deepseek-ai/dsh-session-query)',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return query
  }
}

export type { SubagentDescriptorData } from './descriptor.ts'
export default SubagentContinuationManager
