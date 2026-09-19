/**
 * fork（corum）2026-09-18：**问用户 + 按答案改变机制行为**的执行核（策略见 `model-ask.ts` 头注释）。
 *
 * 本文件只做「执行」：把 {@link CorumModelFailureFacts} 变成一个
 * `corum/model-ask/request` waterfall 调用，把回传的档位解析成
 * {@link CorumModelAskDecision}，再按决定去
 *   ① 改会话级临时覆盖、② 写预设（永久档）、③ 停用委派、④ 通知。
 * 判定（纯函数）与文案在 `model-ask.ts`，状态在 `corumOrchestration` 服务——三处分离，
 * 各自可单测。
 *
 * ## 通路
 *
 * 事件走 host 侧的**独立通路** `corum/model-ask/request`（`corum-api-remotes` 的转发
 * 白名单里是 `mode: 'waterfall'`），由 `@corum/corum-ui-model-ask` 这个 client 插件应答。
 * 与 `userQuestions`（LLM 主动提问）**完全隔离**：两条 waterfall 各自监听、互不截获。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  corumModelAskOptions,
  corumModelAskShortCause,
  corumResolveModelAskDecision,
  type CorumModelAskOption,
  type CorumModelAskDecision,
  type CorumModelFailureFacts,
} from './model-ask.ts'

/** 一次路由（provider/model/可选 reasoningEffort）。 */
export interface CorumRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * 会话级状态面（由 `corumOrchestration` 服务提供；窄接口而非 import 实现包，红线 3）。
 */
export interface CorumDelegationPolicyState {
  setModelOverride: (sessionId: string, route: CorumRoute) => void
  modelOverrideOf: (sessionId: string) => CorumRoute | undefined
  disableDelegation: (sessionId: string) => void
  delegationDisabledFor: (sessionId: string) => boolean
  clearModelOverride: (sessionId: string) => void
}

/** 可用的模型路由清单（供「永久改为指定模型」内嵌选择）。 */
export interface CorumModelCatalog {
  listRoutes: () => Promise<readonly {
    provider: string
    label: string
    models: readonly { model: string; label: string }[]
  }[]>
}

/**
 * `corum/model-ask/request` 的 host 侧调用面。
 *
 * 为什么用 `ctx.waterfall` 而不是 `ctx.emit`：需要**回传**用户的档位，`emit` 是单向的。
 * 为什么不是 `ctx.get('userQuestions')`：那是 LLM 提问的通路，机制级询问必须在自己的
 * 通路上（见 `model-ask.ts` 头注释）。
 */
export interface CorumModelAskChannel {
  call: (
    request: {
      readonly agent: Agent
      readonly label: string
      readonly configured: { provider: string; model: string }
      readonly fallback: { provider: string; model: string }
      readonly cause: string
      readonly role: 'worker' | 'research'
      readonly options: readonly CorumModelAskOption[]
      readonly catalog: readonly {
        provider: string
        label: string
        models: readonly { model: string; label: string }[]
      }[]
    },
    next: () => Promise<CorumModelAskOutcomeEvent>,
  ) => Promise<CorumModelAskOutcomeEvent>
}

/** client 回传的决定（协议键 `kind` + 可选的选定路由）。 */
export interface CorumModelAskOutcomeEvent {
  readonly kind: 'temporary' | 'permanent-follow' | 'permanent-route' | 'decline' | 'dismissed'
  readonly route?: { provider: string; model: string; reasoningEffort?: string }
}

/** 永久档的写入面（`corumAgent` 服务的窄面；缺失=无法永久写，降级为只报告）。 */
export interface CorumProfileWriteFace {
  applySubagentModelForSession: (
    sessionId: string,
    role: 'worker' | 'research',
    route: CorumRoute | undefined,
  ) => { presetId: string; applied: CorumRoute | undefined }
}

/** 提问结果（供调用方记录/测试断言）。 */
export interface CorumModelAskOutcome {
  readonly decision: CorumModelAskDecision
  /** 实际生效的会话级临时覆盖（未设置=undefined）。 */
  readonly override: CorumRoute | undefined
  /** 永久档是否真的写成功（无写入面/写失败=false）。 */
  readonly persisted: boolean
  /** 委派是否被停用。 */
  readonly delegationDisabled: boolean
  /** 给用户的可见结论（通知文本用）。 */
  readonly summary: string
}

/**
 * 机制级提问 + 应用答案。
 *
 * **所有失败都必须被吞掉并降级**（返回一个决定而不是抛错）：本函数的调用点是子 Agent 失败
 * 之后的收尾路径，此时再抛错会把「一次委派失败」放大成「父会话这一步崩掉」，
 * 而用户的诉求恰恰是「确保任务完成」。
 *
 * @param deps - 机制依赖（状态面 + 提问通路 + 可选写入面/目录）。
 * @param parent - 委派方 Agent（waterfall 的 scope 载体）。
 * @param facts - 失败事实（label/configured/fallback/cause/role）。
 * @param channel - 独立通路的调用面（缺失=该部署没有 corum-ui-model-ask）。
 * @param signal - 取消信号（父会话取消时提问随之作废）。
 * @param logger - 告警出口。
 * @returns 决定与生效结果；任何异常都被降级为「dismissed + 无改动」。
 */
export async function corumAskAboutModelFailure(
  deps: {
    state: CorumDelegationPolicyState
    channel: CorumModelAskChannel | undefined
    profile?: CorumProfileWriteFace | undefined
    catalog?: CorumModelCatalog | undefined
  },
  parent: Agent,
  facts: CorumModelFailureFacts,
  signal: AbortSignal,
  logger: { warn: (message: string) => void },
): Promise<CorumModelAskOutcome> {
  const fail = (reason: string, decision: CorumModelAskDecision = { kind: 'dismissed' }): CorumModelAskOutcome => ({
    decision,
    override: undefined,
    persisted: false,
    delegationDisabled: false,
    summary: reason,
  })

  const channel = deps.channel
  if (channel === undefined) {
    // 没有作答通道（headless / sdk-minimal 等组合，或 UI 插件未挂）：**保守降级**——
    // 不停用委派、不改配置，明确告诉用户「机制无法询问」，把决定权交回人。绝不替用户选。
    logger.warn(`corum model-ask: no corum/model-ask channel; cannot ask about ${facts.label}`)
    return fail(
      `Subagent model unavailable (${facts.label}) and this deployment has no way to ask you: `
      + `configured ${facts.configured.provider}/${facts.configured.model} failed (${facts.cause}). `
      + `Nothing was changed. Fix the child-Agent model in Settings → Agents to keep delegating.`,
    )
  }

  // 可用模型清单（供展开面板的「永久改指定模型」内嵌选择）。列举失败不阻断提问——
  // 前三个档位不依赖它。
  let catalog: readonly {
    provider: string
    label: string
    models: readonly { model: string; label: string }[]
  }[] = []
  if (deps.catalog !== undefined) {
    try {
      catalog = await deps.catalog.listRoutes()
    } catch (error: unknown) {
      logger.warn(`corum model-ask: listing models failed: ${String(error)}`)
    }
  }

  // ── 一次询问：四个档位 + 内嵌模型选择（方案 C：一轮完成，无第二轮问答）──
  let answer: CorumModelAskOutcomeEvent
  try {
    answer = await channel.call(
      {
        agent: parent,
        label: facts.label,
        configured: { ...facts.configured },
        fallback: { ...facts.fallback },
        cause: corumModelAskShortCause(facts.cause),
        role: facts.role,
        options: corumModelAskOptions(),
        catalog,
      },
      // 下游没人应答 ⇒ 视为「没作答」（等价于用户挂起）。绝不抛错——提问失败不该
      // 把一次委派失败放大成父会话崩溃。
      async () => ({ kind: 'dismissed' as const }),
    )
  } catch (error: unknown) {
    // 父会话取消、通路断开、client 抛错都在这里。一律降级为「不改变现状」，
    // 并把原因记进日志——绝不因为问不到就去改用户的配置。
    const detail = error instanceof Error ? error.message : String(error)
    logger.warn(`corum model-ask: could not ask about ${facts.label}: ${detail}`)
    return fail(
      `Subagent model unavailable (${facts.label}): configured ${facts.configured.provider}/${facts.configured.model} `
      + `failed (${facts.cause}). The mechanism could not ask you (${detail}), so nothing was changed.`,
    )
  }

  const decision = corumResolveModelAskDecision(answer.kind, facts.fallback, answer.route)

  // ── 应用决定 ────────────────────────────────────────────────────────────
  return applyCorumModelDecision(deps, parent, facts, decision, logger)
}

/**
 * 把机制决定落到状态/配置上（纯副作用；与「问」分离以便单测直接驱动）。
 *
 * @param deps - 同 {@link corumAskAboutModelFailure}。
 * @param parent - 委派方 Agent。
 * @param facts - 失败事实。
 * @param decision - 已解析的决定。
 * @param logger - 告警出口。
 * @returns 生效结果。
 */
export function applyCorumModelDecision(
  deps: {
    state: CorumDelegationPolicyState
    profile?: CorumProfileWriteFace | undefined
  },
  parent: Agent,
  facts: CorumModelFailureFacts,
  decision: CorumModelAskDecision,
  logger: { warn: (message: string) => void },
): CorumModelAskOutcome {
  const sessionId = String(parent.session.id)
  const base = { decision, persisted: false, delegationDisabled: false, override: undefined }

  switch (decision.kind) {
    case 'temporary': {
      // 用户原话：临时生效、不覆盖设置 ⇒ 只写会话级内存（不落 settings.yaml / 预设）。
      deps.state.setModelOverride(sessionId, decision.route)
      return {
        ...base,
        override: decision.route,
        summary:
          `You chose to switch this session's child-Agent model to ${decision.route.provider}/${decision.route.model} `
          + `(temporary — your saved configuration is untouched, so a new session will still use ${facts.configured.provider}/${facts.configured.model}). `
          + `Re-issuing the same delegation will now run on that model.`,
      }
    }
    case 'permanent-follow': {
      const result = persistCorumModelChoice(deps.profile, sessionId, facts, undefined, logger)
      // 永久改成「跟随主 Agent」= 该角色不再有锁定路由 ⇒ 当前会话的临时覆盖已无意义，清掉。
      deps.state.clearModelOverride(sessionId)
      return {
        ...base,
        persisted: result.ok,
        summary: result.ok
          ? `Your Agent preset was updated permanently: its ${facts.role} child-Agent model now follows the main Agent (this overrides the unavailable ${facts.configured.provider}/${facts.configured.model}). Re-issuing the delegation will run on your own route; new sessions keep this.`
          : `You chose to make the child Agent follow the main Agent, but the mechanism could NOT save it — reason: ${result.reason}. Change it manually in Settings → Agents.`,
      }
    }
    case 'permanent-route': {
      const result = persistCorumModelChoice(deps.profile, sessionId, facts, decision.route, logger)
      deps.state.clearModelOverride(sessionId)
      return {
        ...base,
        persisted: result.ok,
        summary: result.ok
          ? `Your Agent preset was updated permanently: its ${facts.role} child-Agent model is now ${decision.route.provider}/${decision.route.model} (replacing the unavailable ${facts.configured.provider}/${facts.configured.model}). Re-issuing the delegation will run on that model; new sessions keep it.`
          : `You chose ${decision.route.provider}/${decision.route.model} permanently, but the mechanism could NOT save it — reason: ${result.reason}. Change it manually in Settings → Agents.`,
      }
    }
    case 'decline': {
      // 用户原话：「后续主 Agent 不再派遣子 Agent，所有工作由主 Agent 继续」。
      // 停用是**机制级**的（消费方同时注册 tools.guard），不是靠提示词劝模型别派。
      deps.state.disableDelegation(sessionId)
      return {
        ...base,
        delegationDisabled: true,
        summary:
          `You declined to keep delegating: the configured child-Agent model ${facts.configured.provider}/${facts.configured.model} `
          + `is unavailable. Delegation is now DISABLED for this session — any further subagent/orchestrate call is refused by the mechanism. `
          + `Do all of the remaining work yourself until the task is complete.`,
      }
    }
    case 'dismissed':
    default: {
      return {
        ...base,
        summary:
          `Subagent model unavailable (${facts.label}): configured ${facts.configured.provider}/${facts.configured.model} failed (${facts.cause}). `
          + `No choice was made, so nothing changed — delegation still uses your configured model. If it keeps failing, change the child-Agent model in Settings → Agents.`,
      }
    }
  }
}

/**
 * 写预设（永久档）。返回**失败原因**而不是裸 boolean。
 *
 * 为什么要带原因（2026-09-18 实机教训）：第一版只返回 `false`，于是把「服务取不到」
 * 与「服务取到了但写盘抛错」渲染成同一句 "could not save it (no writable profile)"——
 * 实机那次真因是**服务查找方式写错**（`ctx.root.get` 取不到），却被文案误导成
 * "没有可写的 profile"，排查方向直接跑偏。错误信息必须说真话。
 */
function persistCorumModelChoice(
  profile: CorumProfileWriteFace | undefined,
  sessionId: string,
  facts: CorumModelFailureFacts,
  route: CorumRoute | undefined,
  logger: { warn: (message: string) => void },
): { ok: true } | { ok: false; reason: string } {
  if (profile === undefined) {
    logger.warn('corum model-ask: the corumAgent service is unreachable; cannot persist the permanent choice')
    return { ok: false, reason: 'the profile-write capability (corumAgent) was unreachable from the delegation mechanism' }
  }
  try {
    profile.applySubagentModelForSession(sessionId, facts.role, route)
    return { ok: true }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.warn(`corum model-ask: persisting the permanent choice failed: ${detail}`)
    return { ok: false, reason: detail }
  }
}
