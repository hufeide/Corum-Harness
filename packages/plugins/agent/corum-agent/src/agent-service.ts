/**
 * CorumAgentService — corum Agent 实例创建服务。
 *
 * 把 AgentProfile 编译成 preset，落盘后经官方
 * `ctx.agentPresets.mount` 走完整组装链路，创建一个真正绑定
 * 模型 / persona / 工具 / skill / MCP / 终端的 root Agent。
 *
 * 继承 TypertRemoteService，通过 @Remote 装饰器把 listProfiles / createAgent /
 * runPrompt / verify 暴露为 /api/corumAgent/* 端点，供浏览器半（dev-agent-shell）
 * 经桌面 IPC 桥调用。
 *
 * 这是「路径 A：每角色（每 profile）一个 preset」的落地点，也是第一刀
 * 要补全的「真正的 Agent 实例」。
 * @module @corum/corum-agent/agent-service
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
// fork（corum）：官方 installModelSelection 会用安装时的选择覆盖用户显式换的模型，
// 见 task-model-selection.ts 文件头（2026-09-09 用户实测：换模型后仍打旧模型）。
import { installTaskModelSelection } from './task-model-selection.ts'
import { childRunInterruptOf } from './child-progress.ts'
import { CHILD_WORKER_ROLE, TOOL_POLICY_SECTION, TOOL_POLICY_TEXT } from './tool-policy.ts'
import { HOST_IDENTITY_SECTION, hostIdentityText } from './host-identity.ts'
import {
  LOCALE_SETTINGS_NAMESPACE,
  OUTPUT_LANGUAGE_SECTION,
  OUTPUT_LANGUAGE_VARIABLE,
  localeIdFromSection,
  outputLanguageSectionText,
  outputLanguageVariableValue,
} from './output-language.ts'
// 空类型 import：让 ctx.agentDefaultModel / ctx.agentPresets 的 Context 合并生效。
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { ReasoningEffortId, createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
// 空类型 import：让 ctx.llm 的 Context 合并生效。
import type {} from '@deepseek-ai/dsh-llm'
// 空类型 import：让 ctx.localLlm（可选本地引擎面）的 Context 合并生效。
import type {} from './local-llm-face.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// 空类型 import：让 ctx.sessionPersistence 的 Context 合并生效（resume 用）。
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { compilePreset, workStyleTextOf } from './compile.ts'
import type { AgentProfile, ProfileModel, SkillBinding } from './profile.ts'
import { isValidProfileId, isValidAgentDimension, isValidPersonaPreset } from './profile.ts'
import { GENERAL_WORK_TYPE, canonicalWorkspaceKey, isValidProjectId, isValidWorkTypeSlug, isGroupMember, projectTypeOf } from './project.ts'
import { loadProject, findProjectByCwd } from './project-store.ts'
// 统一会话索引（两模式共用；键 = sessionId，按 cwd 分组）——
// 见 session-index.ts 的文件头（两套旧索引键空间不同构，不可机械合并）。
import { findSessionByLane, readSessionIndex, registerSession } from './session-index.ts'
import { loadProfile, listProfiles, saveProfile, deleteProfile, agentDirPath, loadPolishConfig, savePolishConfig } from './profile-store.ts'
import type { PolishConfig } from './profile-store.ts'
import { SMOKE_PROMPT, ensureBuiltinRoleProfiles, ensurePmProfile, ensureSmokeProfile, ensureTaskProfile, TASK_PROFILE_ID } from './builtin-profiles.ts'
import { extractHeader, summarizeText, taskTitleOf, simplifyEventData } from './event-projection.ts'
// fork（corum）：指挥模式（基准模式 `conductor`）——主 Agent 运行时裁剪 + 人格段。
import {
  CONDUCTOR_PERSONA,
  CONDUCTOR_PRESET_ID,
  CONDUCTOR_SECTION,
  CONDUCTOR_STALE_SECTIONS,
  conductorExecutionDeny,
  conductorModeOf,
  effectiveExecutionTools,
} from './conductor.ts'
import type { ConductorMode } from './conductor.ts'
// fork（corum）：机制 deny 的收敛口径与 scope 可见工具名——与 fork #10 同源
// （docs/LESSONS.md §6.18：机制生成的名字必须按运行时注册面收敛）。
import { corumNarrowDenyFilter, corumVisibleToolNames } from '@corum/corum-orchestration'

/**
 * fork（corum）：官方 0.1.3 session-persistence 改 handle seam —— 顶层
 * `readFrom(id, fromSeq)` 已删，读取须先 `open(id, 'read')` 拿 SessionHandle，
 * `handle.read(offset)` 读区间，用完 `close()` 释放。本 helper 收敛这一固定三步，
 * 替代旧 readFrom 的「读全历史/读 fromSeq 起」语义（length 缺省 = 读到日志尾）。
 */
async function readPersistedEvents(
  persistence: Context['sessionPersistence'],
  sessionId: SessionId,
  fromSeq: number,
): Promise<readonly SessionEvent[]> {
  const handle = await persistence.open(sessionId, 'read')
  try {
    return await handle.read(fromSeq)
  } finally {
    await handle.close()
  }
}
import { scanSkills } from './skill-catalog.ts'
import { corumHome } from './home.ts'
import { stallAutoRecoverMsValue } from './runtime-state.ts'
import type { SkillEntry } from './skill-entry.ts'
// 统一事件中心三-3：'corum/subagent/progress' 的 cordis Events 声明 + 终态推导口径
// （自包含在 fork 包 corum-api-remotes；type-only import 只拉编译面，不进运行时依赖图）。
import type {} from '@corum/corum-api-remotes/corum-events'
// 值导入 stopReasonOfTurnEnd：turn/end.reason.kind → SubagentStopReason（同口径，同包依赖已存在）。
import { stopReasonOfTurnEnd, type SubagentStopReason, type SubagentTodoItem, type SubagentChangeSummary } from '@corum/corum-api-remotes/corum-events'
// 模块增强：加载 dsh-tool-todo 的 'todo/write' SessionEventMap 扩展声明
// （corum-agent 在 compile.ts 里把 dsh-tool-todo 编进工具表，但 TS 不会自动
// 拉取其类型增强——这里显式 import 只触发 declare module 合并，无运行时开销）。
import type {} from '@deepseek-ai/dsh-tool-todo'
// 模块增强：加载 @corum/corum-git-core 的 `gitCore` Context 合并声明
// （不变式①的创建前置门禁——本服务在 createAgentForTask/openProject 等入口调
// this.ctx.gitCore.assertGitWorkspace；显式 import 只触发 declare module 合并）。
import type {} from '@corum/corum-git-core'

// 再导出：保持既有消费方（index.ts / project-service.ts / runtime.ts /
// contract/agent.ts）的 import 面不变——包内拆分对外的稳定锚。
export { ensurePmProfile, ensureTaskProfile, PM_PROFILE_ID } from './builtin-profiles.ts'
export { simplifyEventData } from './event-projection.ts'
export type { SkillEntry } from './skill-entry.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum Agent 实例服务（AgentProfile → preset → root Agent）。 */
    corumAgent: CorumAgentService
    /**
     * 指挥模式查询面（本服务 provide；`@corum/corum-subagent` 按**可选**服务消费）。
     * 见 {@link CorumConductorFace}。
     */
    corumConductor?: CorumConductorFace
  }
}

/**
 * `corumConductor` 服务的面：把「这个会话是不是指挥模式」交给子 Agent 组装方。
 *
 * 消费方（`@corum/corum-subagent` 的 `applyChildComposition`）按可选服务取用：
 * - `isConductor` 为真 → 子 Agent 换掉继承来的**角色人格**（只保留工作风格），
 *   并在子 scope deny 掉全部委派工具（指挥模式下不再召唤孙 Agent）；
 * - `childPersonaFor` 给出替代人格文本（中性工作型角色行 + 父的工作风格段）。
 *
 * 缺席（精简装配里没挂 corumAgent）时消费方退化为原有行为——不报错、不阻断。
 */
export interface CorumConductorFace {
  /** 该会话此刻是否处于指挥模式。 */
  isConductor: (sessionId: string) => boolean
  /** 指挥模式下子 Agent 的替代人格文本；非指挥模式返回 undefined。 */
  childPersonaFor: (sessionId: string) => string | undefined
}

/** 创建结果。 */
export interface CreateAgentResult {
  /** 创建的 root Agent。 */
  agent: Agent
  /** 编译落盘的 preset id（= profile id）。 */
  presetId: string
}

/** UI 投影的 profile 摘要（不含敏感字段）。 */
export interface ProfileSummary {
  id: string
  nickname?: string
  title?: string
  /** 岗位维度（名片筛选，可选）。 */
  dimension?: string
  /** 名片履历（可选）。 */
  experience?: string
  /** 人格设置（可选，不超过 500 字符；personaPreset==='custom' 时使用）。 */
  persona?: string
  /** 人格预设（工作场景人格原型；编辑回填用）。 */
  personaPreset?: string
  /** 头像（dataURL 或 URL，可选）。 */
  avatar?: string
  /** 基础模式（编辑回填用）。 */
  baseMode?: string
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  /** 子 Agent 模型配置（可选，缺省同主 Agent）。 */
  subagentModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 研究子 Agent 模型配置（可选，缺省同 subagentModel）。 */
  researchModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 并行开发策略（可选；fork #10 双实例行 config 的 profile 级覆盖）。 */
  parallelWork?: import('./profile.ts').ParallelWorkPolicy
  skills: SkillBinding[]
  mcpServers: string[]
  terminal: { mode: string }
  /** 记忆功能开关（UI 投影；sourceOfTruth 在 memoryPolicy.scope，'agent'=开启）。 */
  memoryEnabled?: boolean
  version: number
  trust: string
  /** 目录来源（2026-09-02 合并官方 preset 后区分）：'corum' = corum profile
   *  （.agent-presets）；'official' = 官方 preset（cordis/minimal/ptc/standard）。
   *  消费者按需过滤（团队段成员/Agent 测试面板只关心 corum；新建任务表单并列）。 */
  source: 'corum' | 'official'
}

/** Agent 运行状态。 */
export interface AgentStatus {
  profileId: string
  created: boolean
}

/** UI 投影的 LLM provider + 模型目录。 */
export interface ProviderCatalog {
  id: string
  name: string
  models: Array<{
    id: string
    name: string
    input?: string[]
  }>
}

/* ── AI 润色的 wire 类型（2026-09-09 宿主端重建；contract/agent.ts 从此 re-export）── */

/** getPolishConfig 返回：润色配置（未配置为 null）。 */
export interface GetPolishConfigResult {
  config: {
    provider: string
    model: string
    /** 引擎：auto（本地可用走本地，否则线上）/ local / online。 */
    engine?: 'auto' | 'local' | 'online'
    /** 本地模型名（engine=local/auto 的本地分支）。 */
    localModel?: string
    reasoningEffort?: string
  } | null
}

/** setPolishConfig 入参（provider/model 必填；engine/localModel/reasoningEffort 可选）。 */
export interface SetPolishConfigArgs {
  engine?: 'auto' | 'local' | 'online'
  provider: string
  model: string
  localModel?: string
  reasoningEffort?: string
}

/** polishPrompt 入参（kind 给模型一点体裁提示，如 prompt / text）。 */
export interface PolishPromptArgs {
  text: string
  kind?: string
}

/** polishPrompt 返回：润色后文本。 */
export interface PolishPromptResult {
  polished: string
}

/** polishConversation 入参（text + 最近若干条 user/AI 最终输出）。 */
export interface PolishConversationArgs {
  text: string
  history: Array<{ role: 'user' | 'assistant'; text: string }>
}

/** polishConversation 返回：润色后文本 + 意图（continue/new-topic/bug-report/other/unknown）。 */
export interface PolishConversationResult {
  polished: string
  intent: string
}

/** translatePrompt 入参。 */
export interface TranslatePromptArgs {
  text: string
}

/** translatePrompt 返回：译文。 */
export interface TranslatePromptResult {
  translated: string
}

/** `sessionProjections` 的最小能力面（与 task-model-selection.ts 同款，避免耦合官方类型增强）。 */
interface ModelSelectionProjections {
  stateOf: (session: Session, key: 'modelSelection') => unknown
}

/** `modelSelection` 投影里的选择形状（只读 provider/model）。 */
interface ProjectedSelection {
  provider: string
  model: string
}

/**
 * 会话历史里是否出现过图片内容块。
 *
 * 与官方 `session-controller/commands.ts` 的 `imageInEvent` 同判据（content /
 * message.content / assistant 流式块），但**不看 attachment 匹配、只看有无**：
 * 换模型预警只关心「历史里有没有图」，不关心是哪一张。
 * 形态不认就返回 false（宁可不提示，不可误报阻塞用户切换）。
 */
function eventHasImage(event: SessionEvent): boolean {  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
  }
  if (contentHasImage(data.content)) return true
  if (contentHasImage(data.message?.content)) return true
  return false
}

/** 内容块数组里是否存在 image 块（不做 attachment 字段校验，容忍历史形态差异）。 */
function contentHasImage(content: unknown): boolean {  if (!Array.isArray(content)) return false
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly content?: unknown }
    if (block.type === 'image') return true
    if (block.type === 'tool-result' && contentHasImage(block.content)) return true
  }
  return false
}

/**
 * 解析润色模型的 JSON 信封（polishConversation）。
 * 模型常把 JSON 包在 ```json 代码块或前后加解释文字里，故先抓第一个平衡的 `{...}`。
 * 解析失败返回 null（调用方回落「整段即润色结果」）。
 */
function parsePolishEnvelope(raw: string): PolishConversationResult | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { polished?: unknown; intent?: unknown }
    if (typeof parsed.polished !== 'string' || parsed.polished.trim() === '') return null
    return {
      polished: parsed.polished.trim(),
      intent: typeof parsed.intent === 'string' && parsed.intent.trim() !== '' ? parsed.intent.trim() : 'unknown',
    }
  } catch {
    return null
  }
}

/** 单条会话事件的 UI 投影（只取 UI 需要的简化结构）。 */
export interface SessionEventDto {
  seq: number
  type: string
  /** 简化数据（UI 按 type 自行解析）。 */
  data: unknown
  time: number
}

/** runPrompt 的返回：assistant 回复文本 + 过程事件快照 + 装配的 system prompt。 */
export interface RunPromptResult {
  reply: string
  events: SessionEventDto[]
  /** 最终装配的 system prompt（从 request/header 事件提取）。 */
  systemPrompt?: string
  /** 装配的工具 schema 列表（从 request/header 事件提取）。 */
  tools?: Array<{ name: string; description?: string }>
}

/** task 模式会话摘要（侧栏列表行）。 */
export interface TaskAgentSummary {
  sessionId: string
  cwd: string
  profileId: string
  /** 是否本进程存活（可立即对话；否则需 resume）。 */
  alive: boolean
  /** 标题（首条 user 消息摘要；无消息为空）。 */
  title: string
  /** 最后活动时间（Unix ms；无事件为 0）。 */
  lastActive: number
}

/** saveProfile 的 RPC 入参（AgentProfile 子集，UI 可编辑的字段）。 */
export interface SaveProfileInput {
  id: string
  nickname?: string
  title?: string
  /** 岗位维度（名片筛选）。 */
  dimension?: string
  /** 名片履历。 */
  experience?: string
  /** 人格设置（不超过 500 字符；personaPreset==='custom' 时使用）。 */
  persona?: string
  /** 人格预设（工作场景人格原型：内置预设 id 或 'custom'）。 */
  personaPreset?: string
  avatar?: string
  baseMode: AgentProfile['baseMode']
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  subagentModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 研究子 Agent 模型配置（可选，缺省同 subagentModel）。 */
  researchModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 并行开发策略（可选；fork #10 双实例行 config 的 profile 级覆盖）。 */
  parallelWork?: import('./profile.ts').ParallelWorkPolicy
  /** 绑定的 skill 列表（引用绑定 + 版本 pin）。 */
  skills: SkillBinding[]
  /** MCP 服务授权列表（引用全局注册表中的服务名）。 */
  mcpServers: string[]
  terminal: { mode: 'sandbox' | 'host' }
  memoryPolicy: { scope: 'agent' | 'none'; dir?: string }
  trust: 'system' | 'user'
}

/**
 * CorumAgentService — corum Agent 实例服务。
 *
 * 单例（注册在 host 根 ctx），负责：
 *   1. 把 AgentProfile 编译成 preset 目录并落盘到 user root；
 *   2. 用 `ctx.agents.create({ setup })` 创建 root Agent，setup 里 mount preset；
 *   3. 返回真正的、绑定完整能力的 Agent。
 *
 * 同时继承 TypertRemoteService，暴露 /api/corumAgent/* RPC 端点供 UI 调用。
 */
/** 泳道描述：路由标签（key）+ 工作类型语义（type）+ 可选需求段。 */
export interface AgentLaneDescriptor {
  /** 泳道路由键：关联需求为 `<requirementId>:<type>`，兼容任务为 `<type>`。 */
  readonly key: string
  /** 工作类型 slug（泳道语义；路由键是 key）。 */
  readonly type: string
  /** 关联需求 id（标签泳道的需求段）。 */
  readonly requirementId?: string
}

export class CorumAgentService extends TypertRemoteService {
  static inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'sessionPersistence', 'systemPrompt', 'gitCore']

  /** 已创建的角色 root Agent（按 profile id）。 */
  private readonly agents = new Map<string, Agent>()

  /**
   * 已存活的「项目 × 角色 × 工作类型」会话 Agent（instanceKey =
   * `${projectId}${profileId}${type}`）。调度层模拟单实例多会话的活跃实例表。
   */
  private readonly typeAgents = new Map<string, { agent: Agent; sessionId: SessionId; lane: AgentLaneDescriptor }>()

  /** sessionId → 「项目 × 角色 × 泳道标签」反查索引（权限网关用；仅本进程存活会话）。 */
  private readonly sessionLaneIndex = new Map<string, { projectId: string; profileId: string; type: string; laneKey: string; requirementId?: string }>()

  /** 已存活的 task 模式会话（keyed by sessionId；一个工作区可多个）。 */
  private readonly taskAgents = new Map<string, { agent: Agent; sessionId: SessionId; cwd: string; profileId: string }>()

  /**
   * 待定的访问权限档位（sessionId → preset 名），**只存内存、不落盘**。
   * 用户建任务时选的档位先记在这里，等发第一条消息时才写进会话事件
   * （见 {@link rememberPendingPermission}）——这样未发消息的会话不留磁盘记录。
   */
  private readonly pendingPermissions = new Map<string, string>()

  /**
   * 指挥模式在**主 Agent scope** 注册的效应撤销器（sessionId → dispose）。
   * 只在内存：限制/人格段都是 scope 内的运行时注册，进程重启后由 setup 重新注册。
   * blank 泳道切换 Agent 时先撤销旧注册再按新 preset 决定是否重注册
   * （见 {@link applyConductorMode}）。
   */
  private readonly conductorEffects = new Map<string, () => void>()

  /**
   * 每个会话**当前**的指挥模式形态（sessionId → ConductorMode）。
   *
   * 为什么要有这张表：子 Agent 组装发生在 `@corum/corum-subagent`，而「父是不是指挥模式」
   * 只有本服务知道（preset id 只是其中一半口径，corum profile 走
   * `executionTools: 'orchestrator'`）。经 `corumConductor` 服务暴露给子 Agent 组装方，
   * 用它决定两件事：① 子 Agent 是否继承父的**角色人格**（指挥模式不继承，换成
   * {@link CHILD_WORKER_ROLE} + 工作风格段）；② 子 Agent 是否还能召唤孙 Agent
   * （指挥模式下不能，见 2026-09-11 用户定调）。
   */
  private readonly conductorModes = new Map<string, ConductorMode>()

  /** 该会话此刻是否处于指挥模式（供 `corumConductor` 服务消费）。 */
  private isConductorSession(sessionId: string): boolean {
    return (this.conductorModes.get(sessionId) ?? 'off') !== 'off'
  }

  /**
   * 指挥模式下给子 Agent 的替代人格 = **中性工作型角色行 + 父的「工作风格人格」**。
   *
   * 角色人格（title/domain/persona/prompt）在此**故意丢弃**——用户定调（2026-09-11）：
   * 子 Agent 只继承「工作风格」（如专业干练），不继承「你是谁」。
   * @param sessionId - 父会话 id。
   * @returns 替代 persona 文本；非指挥模式或查不到 profile 时 undefined（= 维持原样继承）。
   */
  private childPersonaFor(sessionId: string): string | undefined {
    if (!this.isConductorSession(sessionId)) return undefined
    const profileId = this.taskAgents.get(sessionId)?.profileId
    if (profileId === undefined) return undefined
    const profile = profileId === TASK_PROFILE_ID ? ensureTaskProfile() : loadProfile(profileId)
    const style = profile === undefined ? undefined : workStyleTextOf(profile)
    return style === undefined ? CHILD_WORKER_ROLE : `${CHILD_WORKER_ROLE}\n\n${style}`
  }

  /**
   * 泳道会话能力钩子：所有「项目×角色×类型」会话（含用户直聊的 PM 会话、
   * 调度派活的执行会话）在 create/resume 的 setup 里统一经过这些钩子装配。
   * AgentRuntime 借此给每个会话装调度工具（assign_task/list_team_tasks/
   * complete_task）——PM 统筹会话与被调度会话能力一致是「PM 派活」闭环的前提。
   */
  private readonly laneSetupHooks: Array<(agentCtx: Context, projectId: string, profileId: string) => void> = []

  /** 注册泳道会话能力钩子（在 create/resume 的 setup 阶段同步调用；插件 apply 期注册）。 */
  registerLaneSetupHook(hook: (agentCtx: Context, projectId: string, profileId: string) => void): void {
    this.laneSetupHooks.push(hook)
  }

  constructor(ctx: Context) {
    super(ctx, 'corumAgent')
    // 行业角色预置（25 个岗位）：幂等确保存在——system profile 的 prompt 随
    // 版本演进刷新，用户自建/已改的 user profile 不动。服务启动时一次性注册，
    // 让新建任务表单的 Agent 下拉与名片页立即可见全量预置角色。
    ensureBuiltinRoleProfiles()
    // fork（corum）2026-09-14：**task / pm 也要在启动时播种 spec 基线**。
    //
    // 这两个 profile 的 `ensure*` 是**懒加载**的（只在真正用到该 profile 时调用：
    // `:463/:1487/:1792/:1850` 的 `profileId === TASK_PROFILE_ID ? ensureTaskProfile() : …`），
    // 于是它们的 `specBaseline` 要等被用到才播种 ⇒ 在此之前「用户数据不被升级覆盖」的保护
    // **不生效**（2026-09-14 实测：`task` 的基线一直缺失）。这里把两者提前到启动时幂等执行。
    ensureTaskProfile()
    ensurePmProfile()
    /**
     * 工具使用策略段（root scope，所有 corum 会话继承）。
     *
     * 用户实测：模型改代码一律走 bash（heredoc / sed -i / python -）。官方
     * `tool:read`/`tool:write`/`tool:edit` 段只讲各自怎么用，没有任何一段讲
     * 「别用 bash 干这个」；`tool:bash` 段只有一句 exit-code 提示。本段补这一层
     * （Claude Code 同款做法），并说明代价：走 bash 的改动绕过改动审查捕获。
     * 指挥模式下由 applyConductorMode 用空文本覆盖（内层覆盖外层）。
     */
    ctx.systemPrompt.section({
      name: TOOL_POLICY_SECTION,
      order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') - 50,
      text: TOOL_POLICY_TEXT,
    })
    /**
     * 宿主身份段（root scope，所有 corum 会话继承）：把「本会话跑在哪个实例 / home /
     * CDP 端口上」作为**事实**写进提示词。
     *
     * 2026-09-12 实测事故：子 Agent 需要判断「哪个实例在跑、我能不能重启它」，而会话从
     * 内部无法知道自己的宿主（它的 bash 里 `echo $CORUM_HOME` 是空的）→ 它用 ps/lsof
     * 拼凑，`cdp.mjs` 又因默认端口 9222 而驱动了**用户主实例**，读到用户真实会话后误判
     * 「:9333 的宿主就是我」，差一步重启用户正在用的应用。结论：补事实，不靠猜。
     * 配套：`home.ts` 把 CORUM_HOME 写进进程环境，让脚本也拿得到。
     * 顺序放在最前（order 5）——它是后续所有工具/验证判断的前提。
     */
    ctx.systemPrompt.section({
      name: HOST_IDENTITY_SECTION,
      order: 5,
      text: hostIdentityText(corumHome(), process.env.CORUM_DEBUG_PORT),
    })
    /**
     * 输出语言段（root scope，所有 corum 会话继承）：把「用户的母语是什么」作为**事实**
     * 注入提示词（2026-09-15 用户需求）。
     *
     * **只约束对外可见输出**（最终回复 + 思考摘要），**不约束内部推理**——用户明确
     * 「对于提示词/思考过程不做要求，某些模型确实英文语料训练的比较多。仅在关键结论、
     * 输出做要求」。措辞细节与理由见 `output-language.ts` 的文件头。
     *
     * 语言值走**占位符 `{{output_language}}`**（用户要求）：与 `{{model}}`/`{{cwd}}`
     * 同一套 `systemPrompt.variable` 机制（`dsh-agent-loop/src/index.ts:421-423` 注册那两个）。
     * provider **每次组装时求值** ⇒ 用户在设置里改语言后**下一次组装即生效**，
     * 不缓存、不重启会话。
     *
     * ⚠️ provider **绝不返回 `undefined`**：严格插值下 `undefined` 会让整个组装抛错
     * （`dsh-system-prompt/src/index.ts:334-339` 实测）。未设偏好时返回一句可读的
     * 「未指定」+ 回退指示，段文本依然自洽。
     */
    ctx.systemPrompt.variable(OUTPUT_LANGUAGE_VARIABLE, () => {
      // settings 服务在 boot 早期可能尚未挂载（与上面 registerSettings 同款情形）；
      // 读不到就当作「无偏好」——可选偏好绝不阻断会话组装。
      const settings = ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
      const localeId = localeIdFromSection(settings?.get?.(LOCALE_SETTINGS_NAMESPACE))
      return outputLanguageVariableValue(localeId)
    })
    // 段文本**静态**（含 `{{output_language}}` 占位符），由上面的变量在组装时插值。
    ctx.systemPrompt.section({
      name: OUTPUT_LANGUAGE_SECTION,
      order: 6,
      text: outputLanguageSectionText(),
    })
    /**
     * `corumConductor` 服务：把「这个会话是不是指挥模式」暴露给子 Agent 组装方。
     *
     * 为什么必须经服务：子 Agent 的组装点在 `@corum/corum-subagent`（跨包），而指挥模式的
     * 权威判定在本服务（preset id + `executionTools: 'orchestrator'` 两个口径，见
     * `conductor.ts` 的 conductorModeOf）。消费方按**可选服务**取用（`ctx.get`），
     * 缺席时退化为「没有指挥模式语义」，不影响其它装配。
     */
    ctx.provide('corumConductor', {
      isConductor: (sessionId: string): boolean => this.isConductorSession(sessionId),
      childPersonaFor: (sessionId: string): string | undefined => this.childPersonaFor(sessionId),
    } satisfies CorumConductorFace)
    /**
     * 用户发出第一条真实消息时，兑现待定的访问权限档位。
     *
     * 用官方 `session/event` 事件而不是自家 `runPromptForTask` RPC：UI 走的是官方
     * 客户端 `session.prompt()` → host session-controller 的 prompt，**不经过**本服务
     * 的 RPC。判定条件与官方 `api-session/activity` 同源（官方在
     * `dsh-api-session-controller/lib/index.js:2692-2694` 用的正是
     * `user/message` + `source.kind === 'user'`），覆盖所有发送通道。
     */
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const sid = String(session.id)
      const entry = this.taskAgents.get(sid)
      if (entry === undefined) return
      this.flushPendingPermission(entry.agent.session, sid)
    })
    /**
     * 统一事件中心三-3：子 Agent 会话进度增量推送（SubagentCard 2s 全量重读
     * 轮询的迁移承载）。
     *
     * 机制：官方 `session/event` 每追加一条事件就是子会话一次状态推进。本
     * 监听器对 origin='subagent' 的会话维护每会话 O(1) 折叠状态（与
     * getChildSessionProgress 的全量折叠同口径，但随事件流增量更新，不再
     * 每 2s `readFrom(sessionId, 0)` 重读整段历史），折叠快照变化即
     * `ctx.emit('corum/subagent/progress', frame)`，经 fork 包
     * corum-api-remotes 的转发 allowlist 推给所有 renderer。
     *
     * 容量护栏：会话 dispose（`session/disposed`）时清表；再按上限淘汰最久
     * 未活动条目（防长进程多 delegation 累积）。
     */
    ctx.on('session/event', (session, event) => {
      if (session.header.origin !== 'subagent') return
      const sid = String(session.id)
      const frame = this.foldSubagentProgress(sid, event)
      if (frame !== undefined) this.ctx.emit('corum/subagent/progress', frame)
      // 终态帧（turn/end → stopReason 写入）发出后 → 异步补发改动摘要。
      if (frame !== undefined && frame.stopReason !== undefined) this.emitChangeSummary(sid)
    })
    ctx.on('session/disposed', (session) => {
      this.subagentProgress.delete(String(session.id))
    })
    /**
     * 委派角色记账（`corum/subagent/child` 帧 → childSessionId → 角色）。
     *
     * 帧里带的是父侧工具名派生的角色（见 `SubagentChildEvent.role`）。这里留存一份，
     * 供会话条花名册经 `getChildSessionProgress` 冷启动补标——推送帧不重放，不记就
     * 只剩「本页加载之后新建的子 Agent」才显示角色（与 mode/isolated 的老缺口同源）。
     */
    ctx.on('corum/subagent/child' as never, ((info: {
      readonly childSessionId?: string
      readonly parentSessionId?: string
      readonly role?: 'worker' | 'research' | 'fork'
    }) => {
      // 父会话归属与角色分开记：角色可能缺省（取不到工具名的路径），但父会话 id 一直有——
      // 中断广播要靠它给出通知的跳转目标（2026-09-13）。
      if (info.childSessionId !== undefined && info.parentSessionId !== undefined) {
        this.subagentParents.set(info.childSessionId, info.parentSessionId)
      }
      if (info.childSessionId === undefined || info.role === undefined) return
      this.subagentRoles.set(info.childSessionId, info.role)
    }) as never, { global: true })

    /**
     * subagent/end 终态兜底：子会话在首个 turn 打开前被取消时，
     * session/event 不产生 turn/start / turn/end，foldSubagentProgress
     * 一帧不发。此处用宿主权威终态事件补发进度帧，让 UI 卡片拿到终态。
     *
     * as never + { global: true } 收窄口径与 corum-tool-subagent/src/index.ts
     * 同款（cordis Events 合并声明在 @corum/corum-subagent，跨包类型面不共享）。
     */
    ctx.on('subagent/end' as never, ((info: { readonly id: unknown; readonly stopReason: string }) => {
      const sid = String(info.id)
      const state = this.subagentProgress.get(sid)
      // 已有终态帧（turn/end 已写入 stopReason）→ 不覆盖。
      if (state?.stopReason !== undefined) {
        // 已有终态帧：补发改动摘要（turn/end 路径里也补发，此处兜底重复幂等）。
        this.emitChangeSummary(sid)
        return
      }
      const reason = info.stopReason as SubagentStopReason
      const turn = state?.turn ?? 0
      const step = state?.step ?? 0
      const todos = state?.todos
      this.subagentProgress.delete(sid)
      this.subagentProgress.set(sid, { turn, step, done: true, stopReason: reason, ...todos === undefined ? {} : { todos } })
      this.ctx.emit('corum/subagent/progress', {
        sessionId: sid,
        turn,
        step,
        done: true,
        stopReason: reason,
        lastActive: Date.now(),
        ...todos === undefined ? {} : { todos },
      })
      // 终态帧已发出 → 异步补发改动摘要（corumReview.snapshot + 台账状态）。
      this.emitChangeSummary(sid)
    }) as never, { global: true })
  }

  /** 子 Agent 进度折叠的每会话 O(1) 状态（session/event 增量维护）。 */
  /**
   * fork（corum）：子会话 → 委派角色（调研/执行/分叉）。
   *
   * 为什么要有这张表：角色来自父侧 `tool/call` 的工具名，随 `corum/subagent/child`
   * 帧推送；而推送帧**不重放**（刷新/重启/切走后丢失）——会话条花名册的 mode/isolated
   * 今天就有同样的缺口。卡片走父会话日志（durable）不受影响；花名册由本表经
   * `getChildSessionProgress` 的冷启动补标拿到（与 stopReason 的种子同一条路）。
   */
  private readonly subagentRoles = new Map<string, 'worker' | 'research' | 'fork'>()
  /** childSessionId → 父会话 id（中断广播的通知跳转目标；来自 `corum/subagent/child` 帧）。 */
  private readonly subagentParents = new Map<string, string>()
  /**
   * 已广播过「半途失去运行」的子会话（进程内去重）。
   * 判定发生在**读取**路径上，同一子会话会被反复拉取（花名册种子 + 卡片），
   * 不去重就会每拉一次刷一条通知。
   */
  private readonly notifiedInterrupted = new Set<string>()

  private readonly subagentProgress = new Map<string, {
    turn: number
    step: number
    currentAction?: string
    done: boolean
    stopReason?: SubagentStopReason
    /** 子 Agent 的当前计划列表（todo/write 折叠；turn/start 重置为 undefined）。 */
    todos?: readonly SubagentTodoItem[]
  }>()

  /** 进度折叠表容量上限（超出时淘汰最久未活动条目；dispose 已精确清理）。 */
  private static readonly SUBAGENT_PROGRESS_CAP = 200

  /**
   * 把一条子会话事件增量折叠进进度状态；快照变化时返回推送帧，否则 undefined。
   * 折叠口径与 getChildSessionProgressRemote 的全量扫描一致（同一份事件语义）。
   */
  private foldSubagentProgress(sessionId: string, event: SessionEvent): {
    sessionId: string
    turn: number
    step: number
    currentAction?: string
    done: boolean
    stopReason?: SubagentStopReason
    lastActive: number
    todos?: readonly SubagentTodoItem[]
  } | undefined {
    let state = this.subagentProgress.get(sessionId)
    if (state === undefined) {
      if (this.subagentProgress.size >= CorumAgentService.SUBAGENT_PROGRESS_CAP) {
        // Map 迭代序 = 插入序，首项即最久未活动（每次变更都 delete+set 置顶）。
        const oldest = this.subagentProgress.keys().next().value
        if (oldest !== undefined) this.subagentProgress.delete(oldest)
      }
      state = { turn: 0, step: 0, done: false }
    }
    const prev = state
    let turn = prev.turn
    let step = prev.step
    let currentAction = prev.currentAction
    let done = prev.done
    let stopReason = prev.stopReason
    let todos = prev.todos
    switch (event.type) {
      case 'turn/start': {
        const t = (event.data as { turn?: number }).turn ?? 0
        if (t > turn) { turn = t; step = 0 }
        done = false
        stopReason = undefined // 新一轮开始＝不再有终态
        todos = undefined // 投影语义：turn/start 重置 todos 为 null（空列表）
        break
      }
      case 'step/end': {
        const t = (event.data as { turn?: number }).turn ?? 0
        const s = (event.data as { step?: number }).step ?? 0
        if (t === turn && s >= step) step = s
        break
      }
      case 'tool/call': {
        const name = (event.data as { name?: string }).name
        if (name !== undefined && name !== '') currentAction = name
        break
      }
      case 'assistant/message': {
        // 一条 assistant 正文闭合 = 当前 step 的生成结束，清掉工具动作避免滞留。
        const content = (event.data as { message?: { content?: Array<{ type: string }> } }).message?.content ?? []
        if (content.some(b => b.type === 'text' || b.type === 'reasoning')) currentAction = undefined
        break
      }
      case 'turn/end': {
        done = true
        stopReason = stopReasonOfTurnEnd((event.data as { reason?: { kind?: string } }).reason?.kind)
        currentAction = undefined
        break
      }
      case 'todo/write': {
        // 与 dsh-tool-todo 投影同口径：last-write-wins，turn/start 重置。
        todos = (event.data as { todos?: SubagentTodoItem[] }).todos ?? undefined
        break
      }
      default:
        return undefined // 非进度事件（user/message、step/start 等）不产生帧。
    }
    if (turn === prev.turn && step === prev.step && currentAction === prev.currentAction && done === prev.done && stopReason === prev.stopReason && todos === prev.todos) {
      return undefined // 折叠无变化（如乱序/重复事件），不广播。
    }
    // 置顶为最近活动（容量淘汰的 LRU 依据）。
    this.subagentProgress.delete(sessionId)
    this.subagentProgress.set(sessionId, { turn, step, ...currentAction === undefined ? {} : { currentAction }, done, ...stopReason === undefined ? {} : { stopReason }, ...todos === undefined ? {} : { todos } })
    return {
      sessionId,
      turn,
      step,
      ...currentAction === undefined ? {} : { currentAction },
      done,
      ...stopReason === undefined ? {} : { stopReason },
      lastActive: event.time,
      ...todos === undefined ? {} : { todos },
    }
  }

  /**
   * 终态改动摘要：从 host corumReview.snapshot(childSessionId) 取改动文件列表
   * ±N，从 worktree 台账取 committed/integrated 状态（隔离时按 slug 相关）。
   *
   * 数据源（host source of truth）：
   *   - `corumReview.snapshot(childSessionId)`：子会话轮次的影子 git 快照，
   *     返回 `{ files: ReviewFileEntry[] }`，每条带 path/added/removed/hash。
   *   - worktree 台账（`corumOrchestration.entriesOf(parentSessionId)`）：按
   *     slug 匹配子会话的 worktree 条目，取 status 判断 integrated。
   *
   * ⚠️ 台账按 slug 相关（SubagentChildEvent.worktree.slug → 台账 entry.slug）；
   * 并发任务正在给台账条目加 childSessionId 字段——届时可改成精确匹配，
   * 此处留 worktreeSlug 作为过渡相关键（见本方法末尾注释）。
   *
   * 全部可选 + 防御：取不到 corumReview 或台账 → 返回 undefined（卡片降级）。
   */
  private async buildChangeSummary(childSessionId: string): Promise<SubagentChangeSummary | undefined> {
    type ReviewSnapshotValue = { files: Array<{ path: string; added: number; removed: number; status?: 'content' | 'absent' | 'unavailable' | 'missing' }> }
    type OrchestrationFace = {
      entriesOf(id: string): Array<{ slug: string; branch: string; path: string; status: string; runId?: string }>
    }
    // ① corumReview.snapshot(childSessionId) —— 子会话轮次的改动快照。
    let filesChanged = 0
    let files: SubagentChangeSummary['files'] | undefined
    let worktreeSlug: string | undefined
    let worktreeBranch: string | undefined
    let worktreePath: string | undefined
    let committed: boolean | undefined
    try {
      const review = this.ctx.get('corumReview') as
        | { snapshot: (sid: string) => Promise<ReviewSnapshotValue> }
        | undefined
      if (review !== undefined) {
        const snap = await review.snapshot(childSessionId)
        filesChanged = snap.files.length
        // 问题 1-④⑤ 收口：透传每文件改前状态（unavailable 的行 UI 置灰并标注
        // 「无可撤销内容」——常见于轮末并集兜底误算进来的非本 Agent 所写文件）。
        files = snap.files.map(f => ({
          path: f.path,
          added: f.added,
          removed: f.removed,
          ...f.status === undefined ? {} : { status: f.status },
        }))
      }
    } catch {
      // corumReview 缺席或取不到 → 改动摘要降级为只给 count（已知 0 或缺省）。
    }
    // ② worktree 台账 —— 隔离状态 + integrated 判定。
    //
    // 台账条目按 slug 相关（SubagentChildEvent.worktree.slug → entry.slug）。
    // 并发任务正在给台账加 childSessionId 字段——届时可改成按 childSessionId 精确匹配，
    // 此处暂用 slug 过渡（见开头注释）。
    let integrated: boolean | undefined
    try {
      const orchestration = this.ctx.get('corumOrchestration') as OrchestrationFace | undefined
      if (orchestration !== undefined) {
        // 台账按父会话 id 查；子会话的父由 session.header.parentSession 给出。
        // 此处用 agents 服务反查父会话（与 settleFromEnd 的兜底同路）。
        // ⚠️ 同 childWorktreeIsolation：`agents.list` 是**方法**，按属性迭代会抛
        // `function is not iterable`（此处被外层 try/catch 吞掉 → integrated 标记长期静默失效）。
        type ParentAgentLike = { session: { id: string; header?: { parentSession?: string } } }
        const agents = this.ctx.get('agents') as
          | { list?: Iterable<ParentAgentLike> | (() => Iterable<ParentAgentLike>) }
          | undefined
        let parentSessionId: string | undefined
        const rawList = agents?.list
        const parentCandidates: Iterable<ParentAgentLike> = typeof rawList === 'function' ? rawList() : rawList ?? []
        for (const agent of parentCandidates) {
          if (String(agent.session.id) === childSessionId) {
            parentSessionId = agent.session.header?.parentSession
            break
          }
        }
        if (parentSessionId !== undefined) {
          const entries = orchestration.entriesOf(parentSessionId)
          // 并发任务加 childSessionId 后可改成精确匹配；当前按 slug 过渡。
          for (const entry of entries) {
            // integrated 状态：一旦台账说 integrated，就标记。
            if (entry.status === 'integrated') {
              integrated = true
            }
            // 记录 slug/branch/path 供卡片展示 + diff 打开（首次遇到的隔离条目）。
            if (worktreeSlug === undefined) {
              worktreeSlug = entry.slug
              worktreeBranch = entry.branch
              worktreePath = entry.path
            }
          }
        }
      }
    } catch {
      // 台账取不到 → 隔离状态降级（不阻断改动列表）。
    }
    if (filesChanged === 0 && worktreeSlug === undefined && integrated === undefined) return undefined
    return {
      filesChanged,
      ...files === undefined ? {} : { files },
      ...worktreeSlug === undefined ? {} : { worktreeSlug },
      ...worktreeBranch === undefined ? {} : { worktreeBranch },
      ...worktreePath === undefined ? {} : { worktreePath },
      ...committed === undefined ? {} : { committed },
      ...integrated === undefined ? {} : { integrated },
    }
  }

  /**
   * 终态改动摘要的异步补发：终态帧已同步发出（含 stopReason），此处 fire-and-
   * forget 追加一帧带 changeSummary 的进度帧——卡片收到后渲染「改动」区。
   *
   * 不阻塞终态帧本身（corumReview.snapshot 是 async 的，子 Agent 已完工，
   * 延几十 ms 追发不影响体验）。失败静默（卡片降级为不显示改动区）。
   */
  private emitChangeSummary(childSessionId: string): void {
    void (async () => {
      const summary = await this.buildChangeSummary(childSessionId)
      if (summary === undefined) return
      const state = this.subagentProgress.get(childSessionId)
      if (state === undefined) return // 会话已 dispose，进度表已清。
      this.ctx.emit('corum/subagent/progress', {
        sessionId: childSessionId,
        turn: state.turn,
        step: state.step,
        ...state.currentAction === undefined ? {} : { currentAction: state.currentAction },
        done: true,
        ...state.stopReason === undefined ? {} : { stopReason: state.stopReason },
        lastActive: Date.now(),
        changeSummary: summary,
      })
    })()
  }

  /**
   * 从 AgentProfile id 创建（或复用）一个 root Agent。
   * @param profileId - AgentProfile id。
   * @param extraSetup - 可选：在 mount preset 之后、模型选择之前注入的额外
   *   能力（如 AgentRuntime 的 complete_task 工具）。仅在首次创建时执行。
   * @returns 创建的 root Agent 及其 preset id。
   */
  async createAgent(
    profileId: string,
    extraSetup?: (agentCtx: Context) => void,
  ): Promise<CreateAgentResult> {
    const existing = this.agents.get(profileId)
    if (existing !== undefined) return { agent: existing, presetId: profileId }

    const profile = loadProfile(profileId)
    if (profile === undefined) {
      throw new Error(`dev-agent: profile "${profileId}" not found`)
    }
    if (!isValidProfileId(profile.id)) {
      throw new Error(`dev-agent: invalid profile id "${profile.id}"`)
    }

    // 1. 把绑定的 skill checkout 到 pinned commit（版本 pinning）。
    this.checkoutPinnedSkills(profile)

    // 2. 编译 + 落盘 preset 目录（含 agent.cordis.yml + preset.yml）。
    const dir = agentDirPath(profile.id)
    this.writeAgentDir(profile, dir)

    // 2. 创建 root Agent，setup 里 mount preset（官方组装链路）。
    const sessionId = SessionId(`corum-dev-${profile.id}-${randomUUID()}`)

    // 模型选择走官方 ModelSelection 通道：`agentOptions` 只有 provider/model/
    // maxTokens，reasoningEffort 由 installModelSelection 在 setup 里安装（官方
    // headless / api-proxy 同款做法）。塞进 agentOptions 会被 buildRequest 忽略。
    const selection: ModelSelectionRef = {
      current: {
        provider: profile.model.provider,
        model: profile.model.model,
        ...(profile.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(profile.model.reasoningEffort) }),
      },
      assembled: undefined,
    }

    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd(), agentPreset: profile.id },
      agentOptions: {
        provider: profile.model.provider,
        model: profile.model.model,
      },
      setup: async (agentCtx) => {
        // 官方组装链路：mount preset，把 persona / 工具 / skill / MCP 全挂上。
        await this.ctx.agentPresets.mount(agentCtx, profile.id)
        // 额外能力注入（如 complete_task 工具），在 mount preset 之后。
        extraSetup?.(agentCtx)
        // 官方模型选择安装：把 provider/model/reasoningEffort 绑定到该 Agent 作用域。
        installTaskModelSelection(agentCtx, selection)
      },
    })

    this.agents.set(profileId, handle.agent)
    this.ctx.logger.info(`corum-agent: root agent created for profile "${profileId}" — ${sessionId}`)
    return { agent: handle.agent, presetId: profile.id }
  }

  /** 兼容入口：按工作类型建/恢复泳道（label 退化为 type）。 */
  async createAgentForType(
    projectId: string,
    profileId: string,
    type: string = GENERAL_WORK_TYPE,
    extraSetup?: (agentCtx: Context) => void,
  ): Promise<CreateAgentResult & { sessionId: SessionId }> {
    return this.createAgentForLane(projectId, profileId, { key: type, type }, extraSetup)
  }

  /**
   * 按「项目 × 角色 × 泳道标签」创建或恢复一个 root Agent（= 一个泳道会话）。
   *
   * 这是团队成员多会话模型的落地（见 project.md「单 Agent 多会话」已知待解
   * 问题 + docs/agent-foundation/TEAM-SCHEDULER-EVENT-LOG.md §6.1）：
   * 同一 profile 按 (projectId, laneKey) 各持一个独立 root Agent（官方 Agent:Session
   * =1:1 硬绑定，N 个 type 会话即 N 个实例，各挂同一份 preset、会话各自独立）。
   *
   * sessionId 稳定可路由：corum-proj<p>-agent<a>-lane<label>-<rand>。进程内已存活
   * 直接复用；否则查 sessionPersistence——已持久化则 resume（冷恢复历史），
   * 未持久化则 create（并登记 sessionId 进项目目录，供下次 resume 找回）。
   *
   * @param projectId - 项目 id（团队属项目，会话隔离边界）。
   * @param profileId - 角色 profile id。
   * @param lane - 泳道描述（key=路由标签，type=工作类型语义，requirementId 可选）。
   * @param extraSetup - 可选额外能力注入（如 complete_task 工具）。
   * @returns 创建/恢复结果 + 该会话的 sessionId。
   */
  async createAgentForLane(
    projectId: string,
    profileId: string,
    lane: AgentLaneDescriptor,
    extraSetup?: (agentCtx: Context) => void,
  ): Promise<CreateAgentResult & { sessionId: SessionId }> {
    if (!isValidProjectId(projectId)) throw new Error(`dev-agent: invalid project id "${projectId}"`)
    if (!isValidWorkTypeSlug(lane.type)) throw new Error(`dev-agent: invalid work type slug "${lane.type}"`)
    const instanceKey = `${projectId}${profileId}${lane.key}`
    const existing = this.typeAgents.get(instanceKey)
    if (existing !== undefined) return { agent: existing.agent, presetId: profileId, sessionId: existing.sessionId }

    const profile = loadProfile(profileId)
    if (profile === undefined) throw new Error(`dev-agent: profile "${profileId}" not found`)
    if (!isValidProfileId(profile.id)) throw new Error(`dev-agent: invalid profile id "${profile.id}"`)

    // 项目工作目录：Agent 的工作现场（session cwd 创建后不可改）。
    // 必须用项目自己的 cwd（干净目录），而非 process.cwd()——否则 Agent 会在
    // corum 源码仓里跑，测试时污染源码。项目未设 cwd 时退回 process.cwd()。
    const project = loadProject(projectId)
    if (project === undefined) throw new Error(`dev-agent: project "${projectId}" not found`)

    // 成员边界：只有项目组成员才能在该项目里建会话/被调度（非成员不参与工作）。
    if (!isGroupMember(project, profileId)) {
      throw new Error(`dev-agent: profile "${profileId}" 不是项目 "${projectId}" 的项目组成员，不参与该项目工作`)
    }
    const workCwd = project.cwd !== undefined && project.cwd !== '' ? project.cwd : process.cwd()

    // 查本项目该 type 会话是否已持久化（登记在项目目录的 session 索引里）。
    const persisted = this.lookupPersistedSessionId(projectId, profileId, lane.key)
    const sessionId = persisted ?? SessionId(`corum-proj${projectId}-agent${profileId}-lane${slugLaneKey(lane.key)}-${randomBytes(4).toString('hex')}`)

    // resume 与 create 共用同一份 setup（preset 挂载 + 能力注入 + 模型选择）。
    // resume 时 session 历史由 persistence 加载，能力仍经 setup 重新组装。
    const selection: ModelSelectionRef = {
      current: {
        provider: profile.model.provider,
        model: profile.model.model,
        ...(profile.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(profile.model.reasoningEffort) }),
      },
      assembled: undefined,
    }
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, profile.id)
      for (const hook of this.laneSetupHooks) hook(agentCtx, projectId, profileId)
      extraSetup?.(agentCtx)
      installTaskModelSelection(agentCtx, selection)
    }
    const agentOptions = { provider: profile.model.provider, model: profile.model.model }

    let handle: { agent: Agent }
    if (persisted !== undefined) {
      // 已持久化：冷恢复（preset 在 create 时已落盘，无需重复 checkout/write）。
      handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      this.ctx.logger.info(`corum-agent: resumed agent — ${sessionId}`)
    } else {
      // 首次：checkout skill + 编译落盘 preset，再 create。
      this.checkoutPinnedSkills(profile)
      this.writeAgentDir(profile, agentDirPath(profile.id))
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: workCwd, agentPreset: profile.id },
        agentOptions,
        setup,
      })
      this.registerSessionId(projectId, profileId, lane.key, sessionId)
      this.ctx.logger.info(`corum-agent: created agent — ${sessionId}`)
    }

    this.typeAgents.set(instanceKey, { agent: handle.agent, sessionId, lane })
    this.sessionLaneIndex.set(String(sessionId), {
      projectId,
      profileId,
      type: lane.type,
      laneKey: lane.key,
      ...(lane.requirementId !== undefined ? { requirementId: lane.requirementId } : {}),
    })
    return { agent: handle.agent, presetId: profileId, sessionId }
  }

  /**
   * 按 sessionId 反查泳道归属（权限网关的可信身份来源）。
   * 只识别本服务创建/恢复、且当前仍登记在存活表里的泳道会话。
   */
  resolveLaneBySessionId(sessionId: string): { projectId: string; profileId: string; type: string; laneKey: string; requirementId?: string } | undefined {
    return this.sessionLaneIndex.get(sessionId)
  }

  /** 获取一个已存活的 (project, profile, type) 会话 Agent。 */
  getAgentForType(projectId: string, profileId: string, type: string = GENERAL_WORK_TYPE): Agent | undefined {
    return this.typeAgents.get(`${projectId}${profileId}${type}`)?.agent
  }

  /** 获取一个已存活的泳道会话 Agent（按路由标签）。 */
  getAgentForLane(projectId: string, profileId: string, laneKey: string): Agent | undefined {
    return this.typeAgents.get(`${projectId}${profileId}${laneKey}`)?.agent
  }

  /**
   * 查统一会话索引：某 (工作区, profile, 泳道) 会话是否已持久化。
   * 返回其 sessionId（供 resume），未登记返回 undefined。
   *
   * 「按工作区判」是修 `bug.task-lane-reuse-misses-project-sessions` 的关键：
   * 旧实现 `lookupPersistedSessionId(projectId, …)` 用 **projectId** 作账本边界，
   * 而 task 模式用的是伪 projectId——同一工作区在两种模式下各有一本账，互不可见。
   * 改为按 **cwd** 查统一索引后，两模式共享同一本账。
   */
  private lookupPersistedSessionId(projectId: string, profileId: string, type: string): SessionId | undefined {
    // projectId → cwd：索引与工作区同一套账本（会话索引按 cwd 分组）。
    const project = loadProject(projectId)
    const cwd = project?.cwd
    if (cwd === undefined || cwd === '') return undefined
    const found = findSessionByLane(profileId, type, cwd)
    return found === undefined ? undefined : SessionId(found)
  }

  /** 把一个 (工作区, profile, 泳道) → sessionId 登记进统一会话索引。 */
  private registerSessionId(projectId: string, profileId: string, type: string, sessionId: SessionId): void {
    const project = loadProject(projectId)
    const cwd = project?.cwd
    if (cwd === undefined || cwd === '') {
      // 无工作区的项目（cwd 缺省）无法按工作区建账——统一模型的身份由 cwd 决定。
      this.ctx.logger.warn(`corum-agent: project "${projectId}" 无 cwd，跳过会话索引登记（${String(sessionId)}）`)
      return
    }
    registerSession(String(sessionId), {
      cwd,
      profileId,
      type: projectTypeOf(project),
      laneKey: type,
    })
  }

  // ── task 会话（统一索引：sessionId 作键，一个工作区多会话）──────────────

  /**
   * 读 task 会话索引（统一索引里 `type='task'` 的那些）。
   *
   * **键 = sessionId**（不再是 `<profileId><type>`）：task 模式一个工作区可以有多
   * 个会话，用复合键会把它们压成一条（实测 217 条会丢 180 条，见台账
   * `bug.unified-index-shape-loses-task-sessions`）。
   */
  private readTaskSessionIndex(): Record<string, { cwd: string; profileId: string }> {
    const out: Record<string, { cwd: string; profileId: string }> = {}
    for (const [sessionId, entry] of Object.entries(readSessionIndex())) {
      if (entry.type !== 'task') continue
      out[sessionId] = { cwd: entry.cwd, profileId: entry.profileId }
    }
    return out
  }

  /** 登记一条 task 会话（sessionId → cwd/profileId）进统一索引（type='task'）。 */
  private registerTaskSession(sessionId: SessionId, cwd: string, profileId: string): void {
    registerSession(String(sessionId), { cwd, profileId, type: 'task' })
  }

  /** 获取已创建的 Agent（未创建返回 undefined）。 */
  getAgent(profileId: string): Agent | undefined {
    return this.agents.get(profileId)
  }

  /**
   * 把一个提示词驱动给 profile 对应的 root Agent，等它跑到 quiescence 后
   * 汇总最终回复文本。
   * @param profileId - AgentProfile id。
   * @param prompt - 用户提示词文本。
   * @returns 最终 assistant 文本（多段 text 拼接）。
   */
  async runProfile(profileId: string, prompt: string): Promise<string> {
    const { agent } = await this.createAgent(profileId)
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)
    return summarizeText(agent.session.snapshotEvents(), firstSeq)
  }

  // ── TypertRemoteService @Remote 端点（/api/corumAgent/*） ──────────

  /**
   * 列出所有 AgentProfile 摘要（新建任务表单 Agent 下拉数据源）。
   * 合并两个目录（2026-09-02 用户定调「并列展示」）：
   * - **corum profile**（$CORUM_HOME/.agent-presets：研发/PM 助理/测试/Task 助理，
   *   继承 standard 全量 + 各自 persona/模型差异）；
   * - **官方 preset**（cordis/minimal/ptc/standard，agentPresets 服务目录）——
   *   架构调整后与 corum 同构可直接 mount；模型跟随部署默认
   *   （`agentDefaultModel.currentSelection()`），`trust` 保留。
   * 官方 preset 与 corum profile id 冲突时 corum 优先（corum 是官方拓展）。
   */
  @Remote('listProfiles')
  async listProfilesRemote(): Promise<{ profiles: ProfileSummary[] }> {
    const corumProfiles = listProfiles().map(p => ({
      id: p.id,
      ...(p.nickname !== undefined ? { nickname: p.nickname } : {}),
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.dimension !== undefined ? { dimension: p.dimension } : {}),
      ...(p.experience !== undefined ? { experience: p.experience } : {}),
      ...(p.persona !== undefined ? { persona: p.persona } : {}),
      ...(p.personaPreset !== undefined ? { personaPreset: p.personaPreset } : {}),
      ...(p.avatar !== undefined ? { avatar: p.avatar } : {}),
      baseMode: p.baseMode,
      prompt: p.prompt,
      model: p.model,
      ...(p.subagentModel !== undefined ? { subagentModel: p.subagentModel } : {}),
      ...(p.researchModel !== undefined ? { researchModel: p.researchModel } : {}),
      ...(p.parallelWork !== undefined ? { parallelWork: p.parallelWork } : {}),
      skills: p.skills,
      mcpServers: p.mcpServers,
      terminal: { mode: p.terminal.mode },
      memoryEnabled: p.memoryPolicy.scope !== 'none',
      version: p.version,
      trust: p.trust,
      source: 'corum' as const,
    }))
    const corumIds = new Set(corumProfiles.map(p => p.id))
    // 官方 preset 目录——只保留用户点名的四种模式（cordis/minimal/ptc/standard）；
    // shipped-presets 的 `code`（PTC 的桌面发货变体）与 corum 重名项/broken 过滤。
    const OFFICIAL_MODE_IDS = new Set([CONDUCTOR_PRESET_ID, 'cordis', 'minimal', 'ptc', 'standard'])
    const officialPresets = (await this.ctx.agentPresets.list())
      .filter(p => OFFICIAL_MODE_IDS.has(p.id) && p.broken === undefined && !corumIds.has(p.id))
    const defaultModel = this.ctx.agentDefaultModel.currentSelection()
    const officialProfiles = officialPresets.map(p => ({
      id: p.id,
      // 官方 preset 的显示名（name 如「标准模式」），回落 id。
      ...(p.name !== undefined ? { nickname: p.name } : {}),
      // prompt 不回填（preset 的 persona 在组合里，不在 roster 元数据）——
      // 表单只显示 nickname + 模型，prompt 不进 UI 投影。
      prompt: p.description ?? '',
      model: {
        provider: defaultModel.provider,
        model: defaultModel.model,
        ...(defaultModel.reasoningEffort === undefined ? {} : { reasoningEffort: defaultModel.reasoningEffort }),
      },
      skills: [],
      mcpServers: [],
      terminal: { mode: 'sandbox' },
      version: 1,
      trust: p.trust,
      source: 'official' as const,
    }))
    return { profiles: [...corumProfiles, ...officialProfiles] }
  }

  /** 创建（或复用）一个 root Agent，返回状态。 */
  @Remote('createAgent')
  async createAgentRemote(profileId: string): Promise<{ status: AgentStatus }> {
    await this.createAgent(profileId)
    return { status: { profileId, created: true } }
  }

  /** 用指定 profile 的 Agent 跑一个 prompt，返回回复文本 + 过程事件。 */
  @Remote('runPrompt')
  async runPromptRemote(profileId: string, prompt: string): Promise<RunPromptResult> {
    const { agent } = await this.createAgent(profileId)
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)
    const reply = summarizeText(agent.session.snapshotEvents(), firstSeq)
    const events: SessionEventDto[] = []
    for (const event of agent.session.snapshotEvents()) {
      if (event.seq < firstSeq) continue
      events.push({
        seq: event.seq,
        type: event.type,
        data: simplifyEventData(event),
        time: event.time,
      })
    }
    // 从 request/header 事件提取最终装配的 system prompt + 工具列表
    const { systemPrompt, tools } = extractHeader(agent.session.snapshotEvents(), firstSeq)
    return { reply, events, ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(tools !== undefined ? { tools } : {}) }
  }

  /**
   * 保存（创建或更新）一个 AgentProfile，并编译落盘整个 Agent 目录。
   *
   * Skill 采用引用绑定 + 版本 pinning：
   *   agent.json 的 skills 字段记录 SkillBinding[] {name, commitHash}。
   *   Agent mount 前把 skill checkout 到 pinned commit。
   *   Skill 全局统一管理在 <CORUM_HOME>/skills/（由 dev-skill-manager 管理导入）。
   */
  @Remote('saveProfile')
  saveProfileRemote(input: SaveProfileInput): { profile: ProfileSummary } {
    if (!isValidProfileId(input.id)) {
      throw new Error(`corum-agent: invalid profile id "${input.id}"`)
    }
    const profile: AgentProfile = {
      id: input.id,
      ...(input.nickname !== undefined && input.nickname.trim() !== '' ? { nickname: input.nickname.trim() } : {}),
      ...(input.title !== undefined && input.title.trim() !== '' ? { title: input.title.trim() } : {}),
      ...(input.dimension !== undefined && isValidAgentDimension(input.dimension) ? { dimension: input.dimension } : {}),
      ...(input.experience !== undefined && input.experience.trim() !== '' ? { experience: input.experience.trim() } : {}),
      ...(input.persona !== undefined && input.persona.trim() !== '' ? { persona: input.persona.trim().slice(0, 500) } : {}),
      ...(input.personaPreset !== undefined && isValidPersonaPreset(input.personaPreset) ? { personaPreset: input.personaPreset } : {}),
      ...(input.avatar !== undefined && input.avatar.trim() !== '' ? { avatar: input.avatar.trim() } : {}),
      baseMode: input.baseMode,
      prompt: input.prompt,
      model: input.model,
      ...(input.subagentModel !== undefined ? { subagentModel: input.subagentModel } : {}),
      ...(input.researchModel !== undefined ? { researchModel: input.researchModel } : {}),
      ...(input.parallelWork !== undefined ? { parallelWork: input.parallelWork } : {}),
      skills: input.skills,
      mcpServers: input.mcpServers,
      terminal: input.terminal,
      memoryPolicy: input.memoryPolicy,
      version: 0,
      trust: input.trust,
    }
    saveProfile(profile)

    // 编译并落盘 agent.cordis.yml + preset.yml
    const dir = agentDirPath(input.id)
    this.writeAgentDir(loadProfile(input.id)!, dir)

    // 清掉旧 Agent 使下次重建
    this.agents.delete(input.id)
    const saved = loadProfile(input.id)!
    return {
      profile: {
        id: saved.id,
        ...(saved.nickname !== undefined ? { nickname: saved.nickname } : {}),
        ...(saved.title !== undefined ? { title: saved.title } : {}),
        ...(saved.dimension !== undefined ? { dimension: saved.dimension } : {}),
        ...(saved.experience !== undefined ? { experience: saved.experience } : {}),
        ...(saved.persona !== undefined ? { persona: saved.persona } : {}),
        ...(saved.personaPreset !== undefined ? { personaPreset: saved.personaPreset } : {}),
        ...(saved.avatar !== undefined ? { avatar: saved.avatar } : {}),
        baseMode: saved.baseMode,
        prompt: saved.prompt,
        model: saved.model,
        ...(saved.subagentModel !== undefined ? { subagentModel: saved.subagentModel } : {}),
        ...(saved.researchModel !== undefined ? { researchModel: saved.researchModel } : {}),
        ...(saved.parallelWork !== undefined ? { parallelWork: saved.parallelWork } : {}),
        skills: saved.skills,
        mcpServers: saved.mcpServers,
        terminal: { mode: saved.terminal.mode },
        memoryEnabled: saved.memoryPolicy.scope !== 'none',
        version: saved.version,
        trust: saved.trust,
        source: 'corum' as const,
      },
    }
  }

  /** 删除一个 AgentProfile。 */
  @Remote('deleteProfile')
  deleteProfileRemote(id: string): { ok: boolean } {
    if (!isValidProfileId(id)) throw new Error(`corum-agent: invalid profile id "${id}"`)
    // 系统级预置 Agent（trust:'system'，开发者模式编排固化）不可删除。
    const existing = loadProfile(id)
    if (existing?.trust === 'system') {
      throw new Error(`corum-agent: profile "${id}" 是系统级预置 Agent，不可删除`)
    }
    this.agents.delete(id)
    deleteProfile(id)
    return { ok: true }
  }

  /** 获取已创建 Agent 的会话事件快照（从指定 seq 开始）。 */
  @Remote('getEvents')
  getEventsRemote(profileId: string, fromSeq: number): { events: SessionEventDto[] } {
    const agent = this.agents.get(profileId)
    if (agent === undefined) return { events: [] }
    const events: SessionEventDto[] = []
    for (const event of agent.session.snapshotEvents()) {
      if (event.seq < fromSeq) continue
      events.push({
        seq: event.seq,
        type: event.type,
        data: simplifyEventData(event),
        time: event.time,
      })
    }
    return { events }
  }

  /** 按「项目×角色×类型」创建（或 resume）一个会话 Agent。 */
  @Remote('createAgentForType')
  async createAgentForTypeRemote(
    projectId: string,
    profileId: string,
    type?: string,
  ): Promise<{ sessionId: string; created: boolean }> {
    const result = await this.createAgentForType(projectId, profileId, type)
    return { sessionId: String(result.sessionId), created: true }
  }

  /** 在「项目×角色×类型」会话里发一个 prompt，等回复。 */
  @Remote('runPromptForType')
  async runPromptForTypeRemote(
    projectId: string,
    profileId: string,
    type: string,
    prompt: string,
  ): Promise<RunPromptResult> {
    const { agent } = await this.createAgentForType(projectId, profileId, type)
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await this.ctx.sessions.flush(agent.session)
    const reply = summarizeText(agent.session.snapshotEvents(), firstSeq)
    const events: SessionEventDto[] = []
    for (const event of agent.session.snapshotEvents()) {
      if (event.seq < firstSeq) continue
      events.push({ seq: event.seq, type: event.type, data: simplifyEventData(event), time: event.time })
    }
    const { systemPrompt, tools } = extractHeader(agent.session.snapshotEvents(), firstSeq)
    return { reply, events, ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(tools !== undefined ? { tools } : {}) }
  }

  /**
   * 读「项目×角色×类型」会话的历史事件（从 fromSeq 开始，只读不发消息）。
   * 用于切换泳道时回填该会话的对话历史。会话未存活返回空。
   */
  @Remote('getSessionEventsForType')
  async getSessionEventsForTypeRemote(
    projectId: string,
    profileId: string,
    type: string,
    fromSeq: number,
  ): Promise<{ events: SessionEventDto[] }> {
    const agent = this.getAgentForType(projectId, profileId, type)
    if (agent === undefined) return { events: [] }
    const events: SessionEventDto[] = []
    for (const event of agent.session.snapshotEvents()) {
      if (event.seq < fromSeq) continue
      events.push({ seq: event.seq, type: event.type, data: simplifyEventData(event), time: event.time })
    }
    return { events }
  }

  // ── task 模式泳道（单任务会话，corum-task-* session id，与 project 泳道隔离） ──

  /**
   * 创建（或按 cwd+profile 恢复）一个 task 模式单任务会话 Agent。
   *
   * task 模式与 project 模式的差异：task 会话是「用户在某工作区直接发起的单任务
   * 对话」，无项目/团队/需求概念——不强绑 projectId、不校验项目组成员、lane 无
   * requirementId。复用与 project 泳道同一套内核（preset 编译落盘 + mount 组装 +
   * resume 冷恢复 + simplifyEventData 投影），但 sessionId 用 corum-task-* 形态、
   * cwd 取用户工作区路径，与 project 泳道（corum-proj 系 / corum-dev 系）互相不可见。
   *
   * 创建（或复用）一个 task 模式单任务会话 Agent，并**归属到官方 workspace**。
   *
   * 2026-08-30 修正「新建任务落在未分组」：原实现直接 `ctx.agents.create`，
   * 绕过了官方 `session.create` 的 `workspace.attachSession()`——侧栏分组按
   * `WorkspaceView.sessionIds`（不是 cwd 匹配），没 attach 就落「未分组」桶。
   * attach 硬要求 `realpath(session.cwd) === workspace.path`，故入参目录必须先
   * realpath 归一（macOS /tmp→/private/tmp 一类 symlink 会直接拒接）。
   *
   * **复用语义（官方 connectWorkspace 同款）**：目标工作区里已有 **blank（未发
   * 过消息）** 的 task 泳道时直接复用它，不新建——用户连点「新建任务」不会堆
   * 出一串空会话（官方：「A created session is blank by definition」+ 侧栏
   * 「blank 仅当前选中时可见」）。
   *
   * @param cwd - 工作区目录（task 会话的工作现场，创建后不可改）。
   * @param profileId - Agent profile id（缺省用内置 task profile）。
   * @param permission - 访问权限档位（`read-only`/`workspace-write`/
   *   `danger-full-access`，缺省沿用全局默认）。经官方 `permissionPresets.set`
   *   写入：先落 `permission/preset` 事件，再由 `setSandboxMode`/`setApprovalPolicy`
   *   写两个旋钮——与官方「新建会话固定权限」语义一致，只是用调用方指定的档位
   *   覆盖全局默认值。
   * @returns 创建/恢复结果 + 该会话的 sessionId（corum-task-<rand>）。
   */
  async createAgentForTask(cwd: string, profileId: string = TASK_PROFILE_ID, permission?: string, model?: ProfileModel): Promise<CreateAgentResult & { sessionId: SessionId }> {
    // 判定表门禁（不变式 C：互斥）——**本方法是「task 模式」入口**，故按 task 口径校验。
    // 用户 2026-09-14 裁定：「如果是 task 模式打开一个 project 项目，则提示用户是项目
    // 模式，是否按照项目模式开启。**拒绝按照 task 模式开启**。」
    // 缺此校验时本入口会绕开门禁直接在 project 工作区里建 task 会话，破坏不变式 C。
    // ⚠️ 用 realpath 归一查（同 openProjectByPath 的一工作区一条目口径）。
    const owner = findProjectByCwd(cwd)
    if (owner !== undefined) {
      const stored = projectTypeOf(owner.project)
      if (stored === 'project') {
        throw new Error(
          `dev-agent: 工作区 "${cwd}" 已是项目模式（project ${owner.project.id}）——无法以任务模式开启。`
          + '请按项目模式打开该工作区（同一工作区只能有一个类型）。',
        )
      }
    }
    // profileId 双源（2026-09-02 并列展示）：corum profile（研发/PM 助理/测试/Task
    // 助理，loadProfile 加载）或**官方 preset**（cordis/minimal/ptc/standard，
    // agentPresets 目录——直接 mount preset id，无 corum profile 实体）。
    const isOfficialPreset = profileId !== TASK_PROFILE_ID && loadProfile(profileId) === undefined
    let profile: AgentProfile
    if (isOfficialPreset) {
      // 官方 preset：persona 在组合里（profile.prompt 只用于 UI 显示/校验占位）；
      // 模型跟随部署默认（official preset 不绑定固定模型）。
      const dm = this.ctx.agentDefaultModel.currentSelection()
      profile = {
        id: profileId,
        baseMode: 'standard',
        prompt: '',
        model: model ?? {
          provider: dm.provider,
          model: dm.model,
          ...(dm.reasoningEffort === undefined ? {} : { reasoningEffort: dm.reasoningEffort }),
        },
        skills: [],
        mcpServers: [],
        terminal: { mode: 'sandbox' },
        memoryPolicy: { scope: 'agent' },
        version: 1,
        trust: 'system',
      }
    } else {
      const loaded = profileId === TASK_PROFILE_ID ? ensureTaskProfile() : loadProfile(profileId)
      if (loaded === undefined) throw new Error(`dev-agent: profile "${profileId}" not found`)
      profile = loaded
    }
    if (!isValidProfileId(profile.id)) throw new Error(`dev-agent: invalid profile id "${profile.id}"`)
    // 设计稿「新建任务表单可选模型」：默认用 profile.model，调用方可覆盖
    // （「选好工作区和 Agent 后自动加载默认模型，用户仍可改」）。
    const effectiveModel = model ?? profile.model

    // 目录 realpath 归一：workspace.attachSession 硬要求 realpath(cwd) === ws.path，
    // 否则抛错 → 会话落「未分组」（macOS /tmp→/private/tmp 一类 symlink 会踩）。
    const root = realpathSync(cwd)

    // 不变式①（invariant.workspace-git-required）的机制门禁：创建任务泳道**之前**
    // 强制「探测，没有就初始化」——不再依赖 UI 层自觉调 ensureRepo（旧缺口的根因：
    // 新目录建任务可经 RPC/直调绕过 UI 直命中本入口）。git-core 是 corum 核心插件
    // （不可卸载）；此处同进程直调 assertGitWorkspace，失败（目录不可写/git 缺失）
    // fail-loud 阻断创建，不静默降级。
    await this.ctx.gitCore.assertGitWorkspace(root)

    // 复用目标工作区里已有的 blank task 泳道（官方 connectWorkspace 语义）：
    // 连点「新建任务」不该堆一串空会话。
    const reuse = this.findBlankTaskLane(root)
    if (reuse !== undefined) {
      this.ctx.logger.info(`corum-agent(task): reuse blank lane — ${reuse} (cwd=${root})`)
      const resolved = await this.resolveTaskAgent(reuse)
      if (resolved !== undefined) {
        // fork（corum）：复用的 blank 泳道必须兑现本次新建表单的 Agent/模型选择——
        // 此前实现静默沿用泳道创建时的 profile/model，用户在「新建任务」表单里
        // 改选 Agent 或模型后开始的对话仍是旧配置（2026-09-07 用户实测反馈）。
        // 泳道是 blank（未发消息），官方 agentPresets.select 的 blank 限定成立，
        // 可安全换绑：select 重组 scoped 工具链并记 agent-preset/selected，
        // installModelSelection 重装模型绑定；task 索引/存活表/落盘目录同步。
        if (resolved.profileId !== profile.id) {
          // 先编译落盘再 select（docs/fork-delta.md §8 note 3）：select/mount 要读
          // .agent-presets/<id>/agent.cordis.yml——从未编译的 corum profile（有
          // agent.json 但产物缺失）若先 select 会报 composition missing、writeAgentDir
          // 永远到不了。官方 preset 无 corum profile 实体——跳过编译落盘
          // （同 selectTaskAgentProfile）。
          if (!isOfficialPreset) this.writeAgentDir(profile, agentDirPath(profile.id))
          await this.ctx.agentPresets.select(resolved.agent, profile.id)
          this.registerTaskSession(resolved.sessionId, resolved.cwd, profile.id)
          this.taskAgents.set(String(resolved.sessionId), { ...resolved, profileId: profile.id })
          // fork（corum）：换绑后指挥模式口径必须跟随新 preset（旧限制先撤销）。
          this.applyConductorMode(
            String(resolved.sessionId),
            resolved.agent.ctx,
            conductorModeOf(profile.id, isOfficialPreset, effectiveExecutionTools(profile)),
          )
          this.ctx.logger.info(`corum-agent(task): reused lane preset switched — ${reuse} → ${profile.id}`)
        }
        const reuseSelection: ModelSelectionRef = {
          current: {
            provider: effectiveModel.provider,
            model: effectiveModel.model,
            ...(effectiveModel.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effectiveModel.reasoningEffort) }),
          },
          assembled: undefined,
        }
        installTaskModelSelection(resolved.agent.ctx, reuseSelection)
        // 复用的是 blank 泳道（还没发过消息），同样只记内存、不写盘。
        this.rememberPendingPermission(String(resolved.sessionId), permission)
        return { agent: resolved.agent, presetId: profile.id, sessionId: resolved.sessionId }
      }
    }

    // 一个工作区多个会话：每次新建独立 sessionId（corum-task-<rand>），不按 cwd 复用。
    const sessionId = SessionId(`corum-task-${randomBytes(4).toString('hex')}`)

    const selection: ModelSelectionRef = {
      current: {
        provider: effectiveModel.provider,
        model: effectiveModel.model,
        ...(effectiveModel.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effectiveModel.reasoningEffort) }),
      },
      assembled: undefined,
    }
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, profile.id)
      installTaskModelSelection(agentCtx, selection)
      // fork（corum）：指挥模式 / orchestrator profile——主 Agent 只思考规划、子 Agent
      // 全权执行。实现与边界见 {@link applyConductorMode}。
      this.applyConductorMode(
        String(sessionId),
        agentCtx,
        conductorModeOf(profile.id, isOfficialPreset, effectiveExecutionTools(profile)),
      )
    }
    // BUG-25（2026-09-11）：`agentOptions` 必须带上 reasoningEffort——此前只传
    // provider/model，Agent 自身的模型配置就丢了档位（表单填 High、会话里却是默认档）。
    // 与会话选择（installTaskModelSelection）口径一致：所选即所得。
    const agentOptions = {
      provider: effectiveModel.provider,
      model: effectiveModel.model,
      ...(effectiveModel.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(effectiveModel.reasoningEffort) }),
    }

    // 官方 preset 无 corum profile 实体——跳过编译落盘与 skill checkout（preset
    // 目录已在 agentPresets 服务管理的根里，mount 直接按 id 解析）。
    if (!isOfficialPreset) {
      this.checkoutPinnedSkills(profile)
      this.writeAgentDir(profile, agentDirPath(profile.id))
    }
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: root, agentPreset: profile.id },
      agentOptions,
      setup,
    })
    this.registerTaskSession(sessionId, root, profile.id)
    await this.attachTaskWorkspace(sessionId, root)
    // 权限档位只记内存、不写事件——写事件会 append 落盘，而用户还没发消息。
    this.rememberPendingPermission(String(sessionId), permission)
    this.ctx.logger.info(`corum-agent(task): created — ${sessionId} (cwd=${root})`)

    this.taskAgents.set(String(sessionId), { agent: handle.agent, sessionId, cwd: root, profileId: profile.id })
    return { agent: handle.agent, presetId: profile.id, sessionId }
  }

  /**
   * 找出目标工作区里**尚未发过消息**的泳道会话（复用候选）。
   *
   * 判定（对齐官方 blank 语义）：官方 `applySessionListMetadata` 里
   * `blank = state.blank && event.type !== 'turn/start'`——**日志里出现第一个
   * `turn/start` 就不再是 blank**。host 侧 `ctx.sessions.list()` 返回的是
   * `Session`（无 blank 字段，blank 在客户端摘要层），故此处直接按官方同源
   * 规则判定：同一工作区 + 事件流里没有 `turn/start`。
   *
   * **查全库、不只查 task 索引**（修 `bug.task-lane-reuse-misses-project-sessions`）：
   * 旧实现只遍历 `readTaskSessionIndex()`（仅 `type='task'`），于是同一工作区里
   * **项目模式的 blank 会话不会被复用** ⇒ 同一工作区出现两条并行泳道（一条 task、
   * 一条 project）。这与统一模型（工作区即项目）直接冲突，也违背它自己的原始意图
   * （源码注释：「连点『新建任务』不该堆一串空会话」）。
   *
   * 统一模型下的正确判据：**按工作区判**——`type` 只决定「显示哪些会话」，
   * 不参与「能不能复用」。故这里遍历**统一索引**（两模式的会话都在里面）。
   *
   * 工作区比较走 `canonicalWorkspaceKey`（realpath 归一）：存量实测
   * `"/a/b/"` 与 `"/a/b"` 同指一个目录，直接比字符串会把一个工作区判成两个。
   */
  private findBlankTaskLane(cwd: string): string | undefined {
    const want = canonicalWorkspaceKey(cwd)
    if (want === undefined) return undefined
    for (const [sid, entry] of Object.entries(readSessionIndex())) {
      if (canonicalWorkspaceKey(entry.cwd) !== want) continue
      const session = this.ctx.sessions.list().find((s) => String(s.id) === sid)
      // 会话不在对象层时保守不复用（宁可新建一个，也不要复用一个可能有历史的会话）。
      if (session === undefined) continue
      if (!session.snapshotEvents().some((e) => e.type === 'turn/start')) return sid
    }
    return undefined
  }

  /**
   * 把泳道会话挂到官方 workspace（侧栏按 `WorkspaceView.sessionIds` 分组，
   * 不 attach 就落「未分组」桶）。
   *
   * 官方 `session.create({workspaceId})` 会自动 attach，但泳道是自己起的
   * `agents.create`，必须补这一步。attach 失败**不阻断**会话创建（会话可用，
   * 只是归到未分组），但要打日志——静默失败会让「未分组」问题无法定位。
   */
  private async attachTaskWorkspace(sessionId: SessionId, cwd: string): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      this.ctx.logger.warn('corum-agent(task): workspaceRegistry unavailable — lane stays ungrouped')
      return
    }
    try {
      // create 幂等：已注册的目录直接返回既有实体（不重复建节点）；未注册则新建
      // 并 prepend 到侧栏列表（用户要的「工作区先出现这个目录名的父节点」）。
      const target = await registry.create(cwd)
      await target.attachSession(sessionId)
      this.ctx.logger.info(`corum-agent(task): attached — ${String(sessionId)} → workspace ${String(target.id)}`)
    } catch (error) {
      // 不阻断：会话已可用，只是归到未分组。打日志避免「未分组」问题无法定位。
      this.ctx.logger.warn(`corum-agent(task): attach failed — ${String(error)}`)
    }
  }

  /**
   * 给新建的 task 会话固定访问权限档位。
   *
   * 时机很关键：官方 `permissionPresets` 在 `session/created` 事件里给会话钉
   * **全局默认档位**（`pinInitialPermission`），此时会话已有 `permission/preset` +
   * `sandbox/mode` + `approval/policy` 三件套。要按用户选的档位覆盖，必须在
   * `agents.create` **之后**调用 `permissionPresets.set(session, name)`——它的
   * `apply()` 只在档位与当前值不同时追加事件，因此此处切换会追加
   * `permission/preset` + 变化的旋钮事件，后写的旋钮覆盖先写的（官方读取语义是
   * 「最后一个事件生效」）。
   *
   * 服务未挂载（无 ctx.permissionPresets）或档位名不在预设表里时**静默沿用默认**，
   * 不阻断会话创建——权限是增强项，不是创建的前置条件。
   */
  private applyTaskPermission(session: Session, permission?: string): void {
    if (permission === undefined || permission === '') return
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined) {
      this.ctx.logger.warn(`corum-agent(task): permissionPresets unavailable — skip preset "${permission}"`)
      return
    }
    if (!presets.names.includes(permission)) {
      this.ctx.logger.warn(`corum-agent(task): unknown permission preset "${permission}" — skip`)
      return
    }
    try {
      presets.set(session as never, permission)
      this.ctx.logger.info(`corum-agent(task): permission preset pinned — ${permission}`)
    } catch (error) {
      this.ctx.logger.warn(`corum-agent(task): failed to pin preset "${permission}" — ${String(error)}`)
    }
  }

  /**
   * 记下用户在「新建任务」表单里选的访问权限档位，**暂不写入会话**。
   *
   * **为什么延迟（2026-08-30 用户要求：未发第一条消息就不落盘）**：
   * 官方 `SessionPersistence` 的 `create(meta)` 只登记元数据（`materialized:
   * false`，`dsh-session-persistence/lib/index.js:872`），**首次 `append` 才真正
   * 落盘**（同文件 :905）。而 `permissionPresets.set()` 会 append
   * `permission/preset` + `sandbox/mode` + `approval/policy` 三条事件——建会话时
   * 立刻调它，就等于立刻落盘，磁盘上留下一条从未对话的 session 记录。
   *
   * 故改为：建会话时只把档位记在内存表里，等用户真正发第一条消息
   * （`runPromptForTask` / 会话首次 engage）前再调 {@link applyTaskPermission}
   * 写盘。未发消息的会话 leave nothing behind。
   */
  private rememberPendingPermission(sessionId: string, permission?: string): void {
    if (permission === undefined || permission === '') return
    this.pendingPermissions.set(sessionId, permission)
  }

  /** 落盘前兑现待定的权限档位（有则写入并清除，无则跳过）。 */
  private flushPendingPermission(session: Session, sessionId: string): void {
    const pending = this.pendingPermissions.get(sessionId)
    if (pending === undefined) return
    this.pendingPermissions.delete(sessionId)
    this.applyTaskPermission(session, pending)
  }

  /**
   * fork（corum）：指挥模式的运行时生效/撤销（2026-09-10 用户需求「把编排者固化为
   * 与标准模式同级的基准模式」）。
   *
   * 为什么在**运行时**而不是 preset 里裁：preset 的 standing mount 是所有 join 它的
   * Agent（含子 Agent）的父 scope，scope 链上的 restriction 会把子 Agent 一起裁掉
   * （实机证实 preset 裁行 → 子 Agent 没工具，见 PLAN-deepseek-orchestrator-agent §3.2
   * 路线 B）。因此这里只在**主 Agent 自己的 scope** 注册三件事：
   *   ① `tools.restrict({deny})` 裁掉亲手执行工具（写/编辑/命令）——只读调查 + 编排全家
   *      保留；子 Agent join 全量 preset + 自己的 toolFilter，不受影响；
   *   ② 同名空段覆盖 preset 常驻层的 `tool:write` / `tool:edit` 指引（工具已裁掉，
   *      提示词不能还教模型去用）；
   *   ③ 指挥者角色段（`preset` 形态用独立段名 `corum:conductor` 追加在部署人格之后；
   *      `profile` 形态的人格来自它自己的 preset）——**只给主 Agent**（子 Agent 若也被
   *      告知「你绝不亲手执行」，会在没有编排工具的情况下空转；角色段留在 agent scope
   *      正是为了不污染子 Agent）。
   *
   * deny 名单必须按该 scope **真实可见**的工具名收敛（`corumNarrowDenyFilter` +
   * `corumVisibleToolNames`）——`tools.restrict()` 对未知名 fail-loud，而
   * `str_replace_editor` 只在挂 str-replace-editor 行的 preset 里存在（官方标准模式
   * 没有；2026-09-10 官方三模式全崩的根因，见 docs/LESSONS.md §6.18）。
   *
   * 幂等：同一 sessionId 再次调用先撤销上一次注册（blank 泳道切换 Agent 时口径必须
   * 跟随新 preset，不能残留旧限制）。撤销器按 sessionId 存内存表，不落盘。
   * @param sessionId - 泳道 id（撤销键）。
   * @param agentCtx - 主 Agent 的 scoped 创建/存活上下文。
   * @param mode - 生效形态（`off` / `profile` / `preset`，见 {@link conductorModeOf}）。
   */
  private applyConductorMode(sessionId: string, agentCtx: Context, mode: ConductorMode): void {
    const previous = this.conductorEffects.get(sessionId)
    if (previous !== undefined) {
      this.conductorEffects.delete(sessionId)
      previous()
    }
    this.conductorModes.set(sessionId, mode)
    if (mode === 'off') return
    const disposers: Array<() => void> = []
    // 指挥者没有 write/edit/bash：工具策略段（「用专用工具而不是 bash」）对它只会误导，
    // 用空文本覆盖（与 CONDUCTOR_STALE_SECTIONS 清 tool:write/tool:edit 同一手法）。
    disposers.push(agentCtx.systemPrompt.section({
      name: TOOL_POLICY_SECTION,
      order: agentCtx.systemPrompt.getSectionOrder('TOOL_BASH') - 50,
      text: '',
    }))
    const deny = corumNarrowDenyFilter(
      { deny: conductorExecutionDeny() },
      corumVisibleToolNames(agentCtx),
    )
    if (deny?.deny !== undefined && deny.deny.length > 0) disposers.push(agentCtx.tools.restrict({ deny: deny.deny }))
    for (const staleToolSection of CONDUCTOR_STALE_SECTIONS) {
      disposers.push(agentCtx.systemPrompt.section({
        name: staleToolSection,
        order: agentCtx.systemPrompt.getSectionOrder('TOOL_WRITE'),
        text: '',
      }))
    }
    // 基准模式（preset）追加指挥者角色段——部署人格（`deployment:persona`）保留；
    // orchestrator profile 的人格来自它自己的 preset（persona 行），不再追加（否则重复）。
    if (mode === 'preset') {
      disposers.push(agentCtx.systemPrompt.section({
        name: CONDUCTOR_SECTION,
        order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA') + 1,
        text: CONDUCTOR_PERSONA,
      }))
    }
    this.conductorEffects.set(sessionId, () => { for (const dispose of disposers) dispose() })
  }

  /**
   * 按 sessionId 解析（或冷恢复）一个 task 会话的 Agent。
   * 已存活直接返回；未存活但已持久化则 resume（官方 session-persistence 冷恢复历史）。
   */
  private async resolveTaskAgent(sessionId: string): Promise<{ agent: Agent; sessionId: SessionId; cwd: string; profileId: string } | undefined> {
    const live = this.taskAgents.get(sessionId)
    if (live !== undefined) return live
    const index = this.readTaskSessionIndex()
    const meta = index[sessionId]
    if (meta === undefined) return undefined
    // 泳道经官方对象层可能已被激活（侧栏选中/官方 sessions 收录）——此时 ctx.agents
    // 已有活 agent，直接复用，**不能再 resume**（官方 agents.resume 拒绝 live 会话：
    // 「cannot prepare session while it is live」）。
    // profileId 双源：corum profile 或官方 preset id（冷恢复官方模式泳道——
    // 官方 preset 不绑定固定模型，跟随部署默认）。
    const isOfficialPreset = meta.profileId !== TASK_PROFILE_ID && loadProfile(meta.profileId) === undefined
    const profile = meta.profileId === TASK_PROFILE_ID ? ensureTaskProfile() : loadProfile(meta.profileId)
    // fork（corum）：指挥模式口径（conductor preset 或 executionTools:'orchestrator'）——
    // 下面三条恢复路径（复用活 agent / resume / 由官方层激活）都要按它决定是否
    // 在主 Agent scope 注册裁剪+人格。
    const conductor = conductorModeOf(meta.profileId, isOfficialPreset, profile === undefined ? undefined : effectiveExecutionTools(profile))
    const sid0 = SessionId(sessionId)
    const activated = this.ctx.agents.get(sid0)
    if (activated !== undefined) {
      const entry = { agent: activated, sessionId: sid0, cwd: meta.cwd, profileId: meta.profileId }
      this.taskAgents.set(sessionId, entry)
      this.applyConductorMode(sessionId, activated.ctx, conductor)
      return entry
    }
    if (!isOfficialPreset && profile === undefined) return undefined
    const resumeModel = profile !== undefined && profile !== null
      ? profile.model
      : (() => { const dm = this.ctx.agentDefaultModel.currentSelection(); return { provider: dm.provider, model: dm.model, ...(dm.reasoningEffort === undefined ? {} : { reasoningEffort: dm.reasoningEffort }) } })()
    const selection: ModelSelectionRef = {
      current: {
        provider: resumeModel.provider,
        model: resumeModel.model,
        ...(resumeModel.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(resumeModel.reasoningEffort) }),
      },
      assembled: undefined,
    }
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, meta.profileId)
      installTaskModelSelection(agentCtx, selection)
      this.applyConductorMode(sessionId, agentCtx, conductor)
    }
    const agentOptions = { provider: resumeModel.provider, model: resumeModel.model }
    const sid = SessionId(sessionId)
    const handle = await this.ctx.agents.resume({ resumeSessionId: sid, agentOptions, setup })
    this.ctx.logger.info(`corum-agent(task): resumed — ${sessionId}`)
    const entry = { agent: handle.agent, sessionId: sid, cwd: meta.cwd, profileId: meta.profileId }
    this.taskAgents.set(sessionId, entry)
    return entry
  }

  /** 创建/恢复一个 task 会话并返回其 sessionId。 */
  @Remote('createTaskAgent')
  async createTaskAgentRemote(cwd: string, profileId?: string, permission?: string, model?: ProfileModel): Promise<{ sessionId: string }> {
    const result = await this.createAgentForTask(cwd, profileId, permission, model)
    return { sessionId: String(result.sessionId) }
  }

  /**
   * 切换 task 泳道的 Agent（新会话界面 composer 的可选 Agent chip）。
   * 官方 `agentPresets.select` 是 blank 限定——泳道已开始（有 turn）即
   * `agent-preset/locked` 拒绝；blank 泳道切换时重组 scoped 工具链并记
   * `agent-preset/selected`。本端点只补充 task 索引/存活表同步与 profile 校验。
   */
  @Remote('selectTaskAgentProfile')
  async selectTaskAgentProfileRemote(sessionId: string, profileId: string): Promise<{ ok: true }> {
    const resolved = await this.resolveTaskAgent(sessionId)
    if (resolved === undefined) throw new Error(`dev-agent: task session "${sessionId}" not found`)
    // profileId 双源（同 createAgentForTask）：corum profile 或官方 preset id。
    const isOfficialPreset = profileId !== TASK_PROFILE_ID && loadProfile(profileId) === undefined
    const profile = profileId === TASK_PROFILE_ID ? ensureTaskProfile() : loadProfile(profileId)
    if (!isOfficialPreset && profile === undefined) throw new Error(`dev-agent: profile "${profileId}" not found`)
    // 先编译落盘再 select（docs/fork-delta.md §8 note 3）：agentPresets.select 要读
    // .agent-presets/<id>/agent.cordis.yml——从未编译的 corum profile（有 agent.json
    // 但产物缺失）若先 select 会抛 agent-preset/invalid（composition missing）、
    // writeAgentDir 永远到不了。官方 preset 无 corum profile 实体——跳过编译落盘。
    if (!isOfficialPreset && profile !== undefined) this.writeAgentDir(profile, agentDirPath(profile.id))
    // select 自己判 blank（turnBoundary 投影）——非 blank 泳道抛 locked，原样上抛给 UI。
    await this.ctx.agentPresets.select(resolved.agent, profileId)
    this.registerTaskSession(resolved.sessionId, resolved.cwd, profileId)
    this.taskAgents.set(String(sessionId), { ...resolved, profileId })
    // fork（corum）：指挥模式口径随切换重算（切出指挥模式即撤销裁剪与人格段）。
    this.applyConductorMode(
      String(sessionId),
      resolved.agent.ctx,
      conductorModeOf(profileId, isOfficialPreset, profile === undefined ? undefined : effectiveExecutionTools(profile)),
    )
    this.ctx.logger.info(`corum-agent(task): preset switched — ${sessionId} → ${profileId}`)
    return { ok: true }
  }

  /** 列出可选的访问权限档位（新建任务表单三档数据源）。 */
  @Remote('listPermissionPresets')
  listPermissionPresetsRemote(): { presets: { id: string; name: string; description?: string }[]; defaultPreset: string } {
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined) return { presets: [], defaultPreset: '' }
    return {
      presets: presets.names.map((id) => {
        const option = presets.optionOf(id)
        return { id, name: option.name, ...(option.description === undefined ? {} : { description: option.description }) }
      }),
      defaultPreset: presets.defaultPreset,
    }
  }

  /** 在 task 会话里发一个 prompt，等回复（返回回复文本 + 过程事件投影）。 */
  @Remote('runPromptForTask')
  async runPromptForTaskRemote(sessionId: string, prompt: string): Promise<RunPromptResult> {
    const resolved = await this.resolveTaskAgent(sessionId)
    if (resolved === undefined) throw new Error(`dev-agent: task session "${sessionId}" not found`)
    const { agent } = resolved
    await agent.whenIdle()
    // 用户真的要发消息了——此刻才兑现「新建任务」时选的权限档位并落盘。
    // 此前会话一直在内存里（官方 lazy materialization），磁盘无记录。
    this.flushPendingPermission(agent.session, sessionId)
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    // BUG-5（2026-09-11）：task 模式 turn 级超时兜底——不能依赖 corumRuntime 的
    // stalled 扫描（它只扫 this.profiles 项目×角色，taskAgents 不其中）。
    // 当 bash 工具 300s 超时但 model turn 未收到 tool_result 时，agent.whenIdle()
    // 会永久 pending（实测 13min、18min 未恢复）。超时后主动 cancel + 注入
    // tool_result 让模型继续（与「停止生成」同款恢复路径，但自动化）。
    await this.whenIdleWithTimeout(agent, sessionId)
    await this.ctx.sessions.flush(agent.session)
    const reply = summarizeText(agent.session.snapshotEvents(), firstSeq)
    const events: SessionEventDto[] = []
    for (const event of agent.session.snapshotEvents()) {
      if (event.seq < firstSeq) continue
      events.push({ seq: event.seq, type: event.type, data: simplifyEventData(event), time: event.time })
    }
    const { systemPrompt, tools } = extractHeader(agent.session.snapshotEvents(), firstSeq)
    return { reply, events, ...(systemPrompt !== undefined ? { systemPrompt } : {}), ...(tools !== undefined ? { tools } : {}) }
  }

  /**
   * BUG-5（2026-09-11）：task 模式 turn 级超时兜底——当 `agent.whenIdle()` 阻塞
   * 超时（bash 工具 300s 超时但 model turn 未收到 tool_result，实测 13min/18min
   * 未恢复），主动 cancel + 注入 tool_result 让模型继续，避免只能手动「停止生成」。
   *
   * 不能依赖 corumRuntime 的 stalled 扫描（它只扫 this.profiles 项目×角色，
   * taskAgents 不在其中——补丁对 task 模式完全无效）。此处是 task 泳道自己的
   * turn 级恢复机制，与项目制调度层的 stalled 自动恢复互补。
   *
   * 恢复路径与「停止生成」同款：cancel({kind:'hook', reason}) 中止当前 turn，
   * 模型 turn 以 aborted 结束；后续的 followup 会从 aborted 状态恢复。
   * @param agent - task 泳道的活 Agent。
   * @param sessionId - task 会话 id（日志用）。
   */
  private async whenIdleWithTimeout(agent: Agent, sessionId: string): Promise<void> {
    // 与项目制 stalled 恢复**共用同一个可配置阈值**（C4）：此前这里另写了一份
    // 硬编码 10min，两处容易漂移。现在统一读 runtime-state 的 holder。
    const TIMEOUT_MS = stallAutoRecoverMsValue()
    return new Promise<void>((resolve) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        this.ctx.logger.warn(
          `corumAgent(task): whenIdle 超 ${TIMEOUT_MS / 1000}s 未返回 — session "${sessionId}"，主动 cancel 恢复（tool 超时或状态不同步）`,
        )
        agent.cancel({ kind: 'hook', reason: `task 会话 turn 超 ${TIMEOUT_MS / 1000}s 无活动，自动恢复` })
        resolve()
      }, TIMEOUT_MS)
      void agent.whenIdle().then(() => {
        clearTimeout(timer)
        if (!timedOut) resolve()
        // timedOut 时 timer 已 resolve——cancel 后的 whenIdle 很快返回（aborted 收敛）。
      })
    })
  }

  /**
   * 读 task 会话的历史事件（从 fromSeq 开始，只读不发消息；切会话回填用）。
   *
   * 数据源：**持久化**（`ctx.sessionPersistence.readFrom`，全历史）而非
   * `agent.session.snapshotEvents()` 窗口——后者冷 resume 后只含会话种子事件（permission/
   * sandbox/approval/end-seed），历史消息不在窗口（2026-08-28 实测：冷泳道 resume
   * 仅 4 条种子、无 user/message）。持久化读全历史，冷/活泳道一致。
   */
  @Remote('getTaskSessionEvents')
  async getTaskSessionEventsRemote(sessionId: string, fromSeq: number): Promise<{ events: SessionEventDto[] }> {
    const index = this.readTaskSessionIndex()
    if (index[sessionId] === undefined) return { events: [] }
    const stored = await readPersistedEvents(this.ctx.sessionPersistence, SessionId(sessionId), fromSeq)
    const events: SessionEventDto[] = []
    for (const event of stored) {
      events.push({ seq: event.seq, type: event.type, data: simplifyEventData(event), time: event.time })
    }
    return { events }
  }

  /**
   * 会话图片态 + 模型视觉能力（composer 换模型提示的数据源）。
   *
   * 官方只在 **prompt 准入**时校验图片-模型匹配（`session-controller/commands.ts`
   * 的 `hasImage` 分支抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`），`selectModel` 本身
   * 不读历史。corum 需要在**切换那一刻**就给出预警，故补此读端点：
   *
   * - `hasImage`：扫会话历史，任一条 user/assistant 消息含 image 内容块即为真
   *   （与官方 `imageInEvent` 同判据：content / message.content / assistant 流块）。
   * - `supportsImage`：`ctx.llm.resolveModelInfo` 的 `inputModalities`。**语义与
   *   官方一致——`undefined` 表示未知（不当作「不支持」）**，仅显式声明且不含
   *   `image` 才算不支持（否则本地模型未声明模态会被误判）。
   *
   * 读失败一律降级为「未知」（`hasImage:false` / `supportsImage:null`），绝不阻断切换。
   * @param sessionId - 泳道 id。
   * @param provider - 目标供应商（缺省用会话当前选择）。
   * @param model - 目标模型。
   */
  @Remote('getImageCompatibility')
  async getImageCompatibilityRemote(
    sessionId: string,
    provider?: string,
    model?: string,
  ): Promise<{ hasImage: boolean; supportsImage: boolean | null }> {
    let hasImage = false
    try {
      const stored = await readPersistedEvents(this.ctx.sessionPersistence, SessionId(sessionId), 0)
      hasImage = stored.some(event => eventHasImage(event))
    } catch {
      hasImage = false
    }

    let supportsImage: boolean | null = null
    try {
      // 目标模型：显式入参优先；否则读会话的 `modelSelection` 投影（next 优先于
      // lastUsed），再退到部署默认。不用 `agents.selectionFor`——那是官方
      // session-controller 内部注册表，不是本服务可依赖的公开面。
      const target = provider !== undefined && model !== undefined
        ? { provider, model }
        : (() => {
            const live = this.taskAgents.get(sessionId)
            const projections = (this.ctx as unknown as { sessionProjections?: ModelSelectionProjections }).sessionProjections
            const state = live === undefined || projections === undefined
              ? undefined
              : projections.stateOf(live.agent.session, 'modelSelection')
            const projected = state !== undefined && state !== null && typeof state === 'object'
              ? (state as { next?: ProjectedSelection | null; lastUsed?: ProjectedSelection | null })
              : undefined
            const picked = projected?.next ?? projected?.lastUsed ?? this.ctx.agentDefaultModel.currentSelection()
            return { provider: picked.provider, model: picked.model }
          })()
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model)
      supportsImage = info.inputModalities === undefined
        ? null
        : info.inputModalities.includes('image')
    } catch {
      supportsImage = null
    }
    return { hasImage, supportsImage }
  }

  /**
   * 按子会话 id 折叠子 Agent 精确进度（子 Agent 进度卡数据源）。
   *
   * 与 getTaskSessionEvents 的差异：本端点不限 task 泳道索引——子 Agent 会话
   * （origin='subagent'，UUID id）不进 task 索引，但同样持久化在 sessionPersistence。
   * 从子会话事件窗算：turn（最新 turn/start）、step（当前 turn 已闭合 step 数）、
   * currentAction（最新工具调用名 / 生成中）、done（turn/end 闭合）。
   */
  /**
   * 读某会话的隔离 worktree 台账（「并行工作区」区的**冷启动基线**）。
   *
   * 为什么需要：台账推送（`corum/worktree-ledger`）只在**变更时** emit，
   * 页面刷新/应用重启后不重放——纯推送订阅的历史会话永远看到空台账，而
   * 「N 个隔离工作区 · 待集成」恰恰是刷新后最需要看的信息（未集成的分支可能
   * 被后续 cleanup 清掉，用户要能发现）。故补一个读端点：前端挂载时拉一次做基线，
   * 之后由推送帧增量更新（与 SubagentCard 的「推送为主 + RPC 冷启动基线」同范式）。
   */
  @Remote('getWorktreeLedger')
  async getWorktreeLedgerRemote(sessionId: string): Promise<{
    entries: Array<{ slug: string; branch: string; path: string; status: string; childSessionId?: string }>
    pending: number
  }> {
    const orchestration = this.ctx.get('corumOrchestration') as
      | { entriesOf(id: string): Array<{ slug: string; branch: string; path: string; status: string; childSessionId?: string }> }
      | undefined
    if (orchestration === undefined) return { entries: [], pending: 0 }
    try {
      const entries = orchestration.entriesOf(sessionId)
      return {
        entries: entries.map(entry => ({ ...entry })),
        pending: entries.filter(entry => entry.status === 'active' || entry.status === 'settled').length,
      }
    } catch {
      // 取不到按空台账处理（可见性增强，绝不影响会话本身）。
      return { entries: [], pending: 0 }
    }
  }

  /**
   * fork（corum）：该会话此刻**是否正在跑一个 turn**（用于识别「被杀掉/半途失去运行」）。
   *
   * 用途：判断「被进程退出杀掉的子会话」——它的 log 里只有 `turn/start`、没有
   * `turn/end`，事件投影永远推不出终态（卡片会一直 Running，2026-09-12 实测）。
   * 判据用官方 `agent.status`（running/idle）而非「在不在 registry 里」：常驻
   * （continuable）子会话跑完不 dispose，仍在 registry 里但 status=idle。
   * @param sessionId - 会话 id。
   * @returns 是否活着；取不到 agents 服务时 undefined（不猜）。
   */
  private agentRunning(sessionId: string): boolean | undefined {
    // `agent.status` 是官方终值：'running'（正在跑一个 turn）/ 'idle'（空闲，可续接）。
    // 关键差别（2026-09-12 实测）：**continuable/resident 子会话跑完不会被 dispose**，
    // 所以「在 registry 里」不等于「在跑」——研究子 Agent 就是常驻的，被杀掉之后
    // 仍留在 registry 里、status 为 idle。用它才能把「空闲的常驻子会话」与
    // 「真的在跑」分开。
    type AgentLike = { session: { id: string }; status?: string }
    try {
      const agents = this.ctx.get('agents') as
        | { list?: Iterable<AgentLike> | (() => Iterable<AgentLike>) }
        | undefined
      const raw = agents?.list
      if (raw === undefined) return undefined
      const list: Iterable<AgentLike> = typeof raw === 'function' ? raw() : raw
      for (const agent of list) {
        if (String(agent.session.id) !== sessionId) continue
        return agent.status === 'running'
      }
      // 不在 registry 里（一次性子会话跑完已 dispose）→ 没在跑。
      return false
    } catch {
      return undefined
    }
  }

  /**
   * fork（corum）：该子会话是否跑在隔离 worktree 里（durable 判据）。
   *
   * 为什么不用推送帧：`corum/subagent/child` 带 `isolated`，但**帧不重放**——刷新/重启
   * 后花名册的「隔离」徽标整体消失（2026-09-12 用户实测）。子会话自己的 `header.cwd`
   * 就是 durable 事实：隔离时它是 `<repo>/.corum-worktrees/<slug>`（台账/机制建的 worktree
   * 根名固定为 `.corum-worktrees`，见 CorumWorktreeChildOptions.worktreeRoot 默认值）。
   *
   * @param sessionId - 子会话 id。
   * @returns true/false；取不到会话时 undefined（不猜）。
   */
  private async childWorktreeIsolation(sessionId: string): Promise<boolean | undefined> {
    /** 隔离子会话的工作目录就是 worktree 根下的 `<repo>/.corum-worktrees/<slug>`。 */
    const ofCwd = (cwd: string | undefined): boolean | undefined =>
      cwd === undefined ? undefined : /(^|[\\/])\.corum-worktrees([\\/]|$)/.test(cwd)
    // ① 已加载的 agent（内存 header，最快）。
    //
    // ⚠️ `agents.list` 是**方法**（`list(): Agent[]`，dsh 的 agent registry），不是可迭代
    // 属性——按属性 `for...of` 会抛 `function is not iterable`。2026-09-12 实测教训：
    // 这个 throw 直接把 `getChildSessionProgress` 整个打挂，而 renderer 的
    // `useChildProgress` 正是靠它补冷启动进度 → **所有子 Agent 卡片永远停在 Running**。
    // 故这里 (a) 兼容「方法 / 可迭代属性」两种形态，(b) 整段 try/catch 兜住——
    // 可见性增强的辅助信息绝不能把主 RPC 打挂。
    try {
      type AgentLike = { session: { id: string; header?: { cwd?: string } } }
      const agents = this.ctx.get('agents') as
        | { list?: Iterable<AgentLike> | (() => Iterable<AgentLike>) }
        | undefined
      const raw = agents?.list
      const list: Iterable<AgentLike> = typeof raw === 'function' ? raw() : raw ?? []
      for (const agent of list) {
        if (String(agent.session.id) !== sessionId) continue
        const memory = ofCwd(agent.session.header?.cwd)
        if (memory !== undefined) return memory
        break
      }
    } catch {
      // 取不到就落到 ②（持久化 header）；两者都取不到 → undefined（不猜）。
    }
    // ② 持久化 header——**一次性子会话跑完就被 dispose，不在 agents.list 里**，这时只能读盘。
    //    `SessionHandle.header` 是不变元数据（含 cwd），读它不需要把会话载回来。
    try {
      const handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), 'read')
      try {
        return ofCwd(handle.header.cwd)
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  @Remote('getChildSessionProgress')
  async getChildSessionProgressRemote(sessionId: string): Promise<{
    /**
     * 委派角色：**独立于 progress 返回**（progress 只从子会话事件窗口折出来，而角色
     * 来自父侧工具名）。花名册冷启动时用它补角色小标；本进程没记过该子会话则缺省。
     */
    role?: 'worker' | 'research' | 'fork'
    /**
     * 是否隔离到 worktree。**由子会话自己的 cwd 判定**（隔离子会话的工作目录就是
     * `<repo>/.corum-worktrees/<slug>`），而不是靠 `corum/subagent/child` 推送帧——
     * 推送帧不重放，刷新/重启后花名册的「隔离」徽标会整体消失（2026-09-12 用户实测：
     * 「下拉的悬浮窗中无法看到隔离任务的分类了」）。cwd 是会话自身的 durable 事实。
     */
    isolated?: boolean
    progress?: {
      turn: number
      step: number
      currentAction?: string
      done: boolean
      stopReason?: SubagentStopReason
      /** 运行中途失去运行（进程退出/被丢弃）——没有权威 stopReason 时的诚实补标。 */
      interrupted?: boolean
      lastActive: number
      todos?: readonly SubagentTodoItem[]
    }
  }> {
    // role/isolated 与「子会话事件窗口」无关（角色来自父侧工具名、隔离来自子会话 cwd），
    // 故先算好、所有返回路径都带上——否则事件读不到时（返回 {}）花名册的角色/隔离徽标会
    // 一起消失（2026-09-12 用户实测：「下拉的悬浮窗中无法看到隔离任务的分类了」）。
    const role = this.subagentRoles.get(sessionId)
    const isolated = await this.childWorktreeIsolation(sessionId)
    const identity: { role?: 'worker' | 'research' | 'fork'; isolated?: boolean } = {
      ...role === undefined ? {} : { role },
      ...isolated === undefined ? {} : { isolated },
    }
    let stored: readonly SessionEvent[]
    try {
      const events = await readPersistedEvents(this.ctx.sessionPersistence, SessionId(sessionId), 0)
      stored = events
    } catch {
      return identity
    }
    if (stored.length === 0) return identity
    let turn = 0
    let step = 0
    let done = false
    let currentAction: string | undefined
    let stopReason: SubagentStopReason | undefined
    let todos: readonly SubagentTodoItem[] | undefined
    for (const event of stored) {
      switch (event.type) {
        case 'turn/start': {
          const t = (event.data as { turn?: number }).turn ?? 0
          if (t > turn) { turn = t; step = 0 }
          done = false
          stopReason = undefined // 新一轮开始＝不再有终态
          todos = undefined // 投影语义：turn/start 重置 todos
          break
        }
        case 'step/end': {
          const t = (event.data as { turn?: number }).turn ?? 0
          const s = (event.data as { step?: number }).step ?? 0
          if (t === turn && s >= step) step = s
          break
        }
        case 'tool/call': {
          const name = (event.data as { name?: string }).name
          if (name !== undefined && name !== '') currentAction = name
          break
        }
        case 'assistant/message': {
          // 一条 assistant 正文闭合 = 当前 step 的生成结束，清掉工具动作避免滞留。
          const content = (event.data as { message?: { content?: Array<{ type: string }> } }).message?.content ?? []
          if (content.some(b => b.type === 'text' || b.type === 'reasoning')) currentAction = undefined
          break
        }
        case 'turn/end': {
          done = true
          stopReason = stopReasonOfTurnEnd((event.data as { reason?: { kind?: string } }).reason?.kind)
          currentAction = undefined
          break
        }
        case 'todo/write': {
          todos = (event.data as { todos?: SubagentTodoItem[] }).todos ?? undefined
          break
        }
      }
    }
    const lastActive = stored[stored.length - 1].time
    /**
     * 被进程退出杀掉 / 中途失去运行的子会话：log 里有 `turn/start` 却没有 `turn/end`，
     * 事件投影推不出终态 → 卡片永远停在 Running（2026-09-12 用户实测「search agent
     * 结束后卡片仍是 running」的一类残余）。宿主能判「它已经不在跑」→ 补一个**诚实**
     * 的终态：`done: true` + `interrupted: true`。
     * 判据本体在 `child-progress.ts`（纯函数 + 单测）；这里只负责查 registry 与时钟。
     */
    const bootAt = Date.now() - process.uptime() * 1000
    const interruptReason = childRunInterruptOf({
      done,
      stopReason,
      agentRunning: () => this.agentRunning(sessionId),
      lastActive,
      bootAt,
    })
    const interrupted = interruptReason !== undefined
    // 「中断」不是事件（它是读取时的判定），而通知桥只消费推送帧 → 在**发现点**补一次
    // 广播（进程内按子会话去重）。用户 2026-09-13 定调：这种情况要有通知，不能静默。
    if (interruptReason !== undefined) {
      await this.broadcastInterrupted(sessionId, { reason: interruptReason, turn, step, lastActive })
    }
    return {
      ...identity,
      progress: {
        turn,
        step,
        ...currentAction === undefined ? {} : { currentAction },
        done: done || interrupted,
        ...stopReason === undefined ? {} : { stopReason },
        ...interrupted ? { interrupted: true } : {},
        lastActive,
        ...todos === undefined ? {} : { todos },
      },
    }
  }

  /**
   * 「半途失去运行」的一次性广播（进程内按子会话去重）。
   *
   * 为什么在读取路径上发：这条事实**不是事件**——它是宿主对「上一个进程生命周期留下的
   * 未闭合 turn」的判定，只能在读持久化事件时得出。通知桥只订阅推送帧，所以此前这种
   * 子 Agent 完全静默（2026-09-12 实测：8 张卡里 1 张「已中断」，通知栏一条都没有）。
   * 广播失败绝不影响进度读取——辅助信息不得打挂主 RPC（2026-09-12 的教训）。
   */
  /**
   * 子会话的父会话 id（通知的跳转目标，也是「同一批合并成一条」的键）。
   *
   * 先查本进程记的 `corum/subagent/child` 帧；**帧不重放**（重启后一条都没有），
   * 于是退回**持久化 header** 的 `parentSession` —— 那是会话自身 durable 的事实，
   * 重启/刷新后依然在（2026-09-13 实测：只靠帧的话 9 个被中断的子 Agent 会各成一条
   * 通知，因为它们都没有父会话可归并）。
   */
  private async childParentSession(sessionId: string): Promise<string | undefined> {
    const known = this.subagentParents.get(sessionId)
    if (known !== undefined) return known
    try {
      const handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), 'read')
      try {
        const parent = handle.header.parentSession
        if (parent === undefined) return undefined
        const id = String(parent)
        this.subagentParents.set(sessionId, id)
        return id
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  private async broadcastInterrupted(
    sessionId: string,
    info: { readonly reason: 'not-running' | 'pre-boot'; readonly turn: number; readonly step: number; readonly lastActive: number },
  ): Promise<void> {
    if (this.notifiedInterrupted.has(sessionId)) return
    // 先占位再 await：并发两次拉同一条进度时也只广播一次。
    this.notifiedInterrupted.add(sessionId)
    const parentSessionId = await this.childParentSession(sessionId)
    try {
      this.ctx.emit('corum/subagent/interrupted', {
        sessionId,
        ...parentSessionId === undefined ? {} : { parentSessionId },
        ...info,
      })
    } catch {
      // 广播失败不影响读取（同上）。
    }
  }

  /**
   * 按子会话 id 提取父 Agent 注入的提示词（子 Agent 卡「任务详情」展开区数据源）。
   *
   * prompt = 子会话首条 user/message 全文（子 Agent 由父 Agent 发起，首条 user
   * 消息必是父注入的任务指令；后续 user 消息是子会话自己的 followup，不取）。
   * 模型（modelSelection）与父会话 id（parentSessionId）由 client 侧 `session/list`
   * 行投影直接提供，host 不重复读。
   */
  @Remote('getSubagentSessionMeta')
  async getSubagentSessionMetaRemote(sessionId: string): Promise<{
    meta?: { prompt?: string }
  }> {
    let stored: readonly SessionEvent[]
    try {
      const events = await readPersistedEvents(this.ctx.sessionPersistence, SessionId(sessionId), 0)
      stored = events
    } catch {
      return {}
    }
    for (const event of stored) {
      if (event.type !== 'user/message') continue
      const data = event.data as {
        content?: Array<{ type: string; text?: string }>
        message?: { content?: Array<{ type: string; text?: string }> }
      }
      const content = data.content ?? data.message?.content ?? []
      const text = content
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('')
        .trim()
      if (text !== '') return { meta: { prompt: text } }
    }
    return {}
  }

  /**
   * 列出 task 模式会话（侧栏 task 列表数据源；可按 cwd 过滤）。
   * 合并存活表与持久化索引：附标题（首条 user 消息摘要）、cwd、sessionId、
   * 最后活动时间、是否存活。一个工作区可多个会话。
   */
  @Remote('listTaskAgents')
  async listTaskAgentsRemote(cwd?: string): Promise<{ tasks: TaskAgentSummary[] }> {
    const index = this.readTaskSessionIndex()
    const out: TaskAgentSummary[] = []
    // cwd 过滤走身份归一（realpath）而非字符串直比：存量实测 "/a/b/" 与 "/a/b"
    // 同指一个目录，直比会把同一工作区的会话漏掉一半（同 findBlankTaskLane）。
    const wantCwd = cwd === undefined ? undefined : canonicalWorkspaceKey(cwd)
    for (const [sessionId, meta] of Object.entries(index)) {
      if (wantCwd !== undefined && canonicalWorkspaceKey(meta.cwd) !== wantCwd) continue
      const live = this.taskAgents.get(sessionId)
      // 标题/最后活动从持久化读（冷泳道也有；存活表仅标 alive）。读全历史取首条
      // user 消息 + 末条时间，失败回退空（会话损坏不阻塞列表）。
      let title = ''
      let lastActive = 0
      try {
        const events = await readPersistedEvents(this.ctx.sessionPersistence, SessionId(sessionId), 0)
        title = taskTitleOf(events)
        if (events.length > 0) lastActive = events[events.length - 1].time
      } catch { /* 单个会话读取失败不阻塞列表 */ }
      out.push({
        sessionId,
        cwd: meta.cwd,
        profileId: meta.profileId,
        alive: live !== undefined,
        title,
        lastActive,
      })
    }
    return { tasks: out }
  }

  /* ── AI 润色（prompt polish）────────────────────────────────────────────
   * fork（corum）：宿主端实现（2026-09-09 重建）。
   * 历史：契约（contract/agent.ts 的 5 个方法）+ 配置存储（profile-store 的
   * load/savePolishConfig）+ 客户端按钮一直都在，但宿主端方法在基座升级重置
   * **未提交工作树**时丢失（点 sparkle → /api/corumAgent/polishConversation 404；
   * 见 docs/ide-formal/PROGRESS.md 第 50 轮）。本轮按契约重建。
   * 引擎路由（PolishConfig.engine）：online → ctx.llm.stream；local →
   * ctx.localLlm.chat（窄能力接口，不耦合 @corum/corum-ollama）；auto →
   * 本地引擎可用（installed && running && meetsMinMem && 有模型）走本地，否则线上。
   * ────────────────────────────────────────────────────────────────────── */

  /** 读取润色配置（未配置返回 null）。 */
  @Remote('getPolishConfig')
  getPolishConfigRemote(): GetPolishConfigResult {
    const config = loadPolishConfig()
    if (config === undefined) return { config: null }
    return {
      config: {
        provider: config.provider,
        model: config.model,
        ...(config.engine === undefined ? {} : { engine: config.engine }),
        ...(config.localModel === undefined ? {} : { localModel: config.localModel }),
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      },
    }
  }

  /**
   * 保存润色配置（provider/model 必填——engine=local 时仍作为 auto 的线上回落）。
   * ⚠️ 形参名必须与 contract 的 args 字段同名：typert 网关按**方法形参名**做
   * 命名绑定（SRC 描述符），形参写成单个 `args` 会报
   * `gateway/arguments-invalid: unexpected "text"...`（2026-09-09 首次重建时踩到）。
   */
  @Remote('setPolishConfig')
  setPolishConfigRemote(
    engine: 'auto' | 'local' | 'online' | undefined,
    provider: string,
    model: string,
    localModel?: string,
    reasoningEffort?: string,
  ): { ok: boolean } {
    const providerText = typeof provider === 'string' ? provider.trim() : ''
    const modelText = typeof model === 'string' ? model.trim() : ''
    if (providerText === '' || modelText === '') return { ok: false }
    const engineValue = engine === 'local' || engine === 'online' || engine === 'auto' ? engine : undefined
    const localModelValue = typeof localModel === 'string' && localModel.trim() !== '' ? localModel.trim() : undefined
    const reasoningEffortValue = typeof reasoningEffort === 'string' && reasoningEffort.trim() !== ''
      ? reasoningEffort.trim()
      : undefined
    savePolishConfig({
      ...(engineValue === undefined ? {} : { engine: engineValue }),
      ...(localModelValue === undefined ? {} : { localModel: localModelValue }),
      provider: providerText,
      model: modelText,
      ...(reasoningEffortValue === undefined ? {} : { reasoningEffort: reasoningEffortValue }),
    })
    return { ok: true }
  }

  /** 润色一段提示词（无对话上下文；kind 用于给模型一点体裁提示）。 */
  @Remote('polishPrompt')
  async polishPromptRemote(text: string, kind?: string): Promise<PolishPromptResult> {
    const source = typeof text === 'string' ? text.trim() : ''
    if (source === '') return { polished: '' }
    const config = this.requirePolishConfig()
    const kindText = typeof kind === 'string' && kind.trim() !== '' ? kind.trim() : 'prompt'
    const system = [
      'You are a prompt-polishing assistant. Rewrite the text the user gives you so it is clearer, more specific, and easier for an AI to execute,',
      'Preserve the original meaning and language (Chinese in, Chinese out; English in, English out). Do not answer the question, do not explain, and do not add any prefix or suffix.',
      `Text kind: ${kindText}. Output only the polished text itself.`,
    ].join(' ')
    const polished = await this.runPolishEngine(config, system, source)
    return { polished: polished.trim() }
  }

  /**
   * 会话内提示词润色：结合最近若干条「user 提问 + AI 最终输出」，把草稿改写成
   * 意图明确、衔接顺畅的输入，并给出意图分类（continue/new-topic/bug-report/other）。
   * 模型按 JSON 返回；解析失败时回落「整段即润色结果 + intent=unknown」。
   */
  @Remote('polishConversation')
  async polishConversationRemote(
    text: string,
    history: Array<{ role: 'user' | 'assistant'; text: string }>,
  ): Promise<PolishConversationResult> {
    const source = typeof text === 'string' ? text.trim() : ''
    if (source === '') return { polished: '', intent: 'unknown' }
    const config = this.requirePolishConfig()
    const recent = Array.isArray(history) ? history.slice(-6) : []
    const context = recent.length === 0
      ? '(no conversation history)'
      : recent.map(h => `${h.role === 'user' ? 'User' : 'AI'}: ${h.text}`).join('\n')
    const system = [
      'You are a prompt-polishing assistant. You are given the recent conversation context and the draft the user just typed.',
      'Rewrite the draft into input that states its intent clearly, flows with the context, and can be executed by an AI directly:',
      'Fill in omitted references and make vague requests concrete, but do **not** make decisions for the user and do not add requirements the user did not state.',
      "Keep the user's language.",
      'Output exactly one JSON object, with no markdown code fence and no extra text, shaped like:',
      '{"polished":"the polished text","intent":"continue|new-topic|bug-report|other"}',
    ].join(' ')
    const prompt = `Conversation context:\n${context}\n\nDraft:\n${source}`
    const raw = await this.runPolishEngine(config, system, prompt)
    const parsed = parsePolishEnvelope(raw)
    return parsed ?? { polished: raw.trim(), intent: 'unknown' }
  }

  /** 中英文互译（中文→英文、英文→中文；其它语言→中文）。 */
  @Remote('translatePrompt')
  async translatePromptRemote(text: string): Promise<TranslatePromptResult> {
    const source = typeof text === 'string' ? text.trim() : ''
    if (source === '') return { translated: '' }
    const config = this.requirePolishConfig()
    const system = [
      'You are a translation assistant. Translate Chinese into English, English into Chinese, and any other language into Chinese.',
      'Output only the translation itself: no explanation and no quotation marks.',
    ].join(' ')
    const translated = await this.runPolishEngine(config, system, source)
    return { translated: translated.trim() }
  }

  /** 取润色配置；未配置时抛错（客户端把错误显示成「请先配置润色模型」）。 */
  private requirePolishConfig(): PolishConfig {
    const config = loadPolishConfig()
    if (config === undefined) {
      throw new Error('未配置 AI 润色模型：请在「设置 → 扩展 → AI 润色」选择引擎与模型')
    }
    return config
  }

  /**
   * 一次润色调用（引擎路由 + 单次补全）。本地失败时：
   * engine=local 明确指定 → 抛错；engine=auto → 回落线上（本地只是加速项）。
   */
  private async runPolishEngine(config: PolishConfig, system: string, prompt: string): Promise<string> {
    const engine = config.engine ?? 'auto'
    if (engine !== 'online') {
      const local = this.ctx.get('localLlm')
      if (local === undefined) {
        if (engine === 'local') throw new Error('本地引擎不可用：请先在「设置 → 扩展 → Ollama」安装并下载模型')
      } else {
        try {
          const status = await local.status()
          // 严格已激活（用户定调 2026-09-09）：只有加载到内存的模型才用于润色——
          // 未激活模型首次调用要冷加载，可用性没保证，auto 档也不该挑它。
          const activated = status.models.filter(m => m.active === true)
          const usable = status.installed && status.running && status.meetsMinMem && activated.length > 0
          if (engine === 'local' || usable) {
            const ensured = status.running ? { ok: true } : await local.ensureServer()
            if (!ensured.ok) {
              throw new Error(ensured.error ?? '本地引擎启动失败')
            }
            // 模型选择：配置值必须在**已激活**集合里（可能已被停止/卸载），否则回落
            // 第一个已激活模型——与设置页下拉的语义一致（不手填模型 id）。
            const configured = config.localModel === undefined
              ? undefined
              : activated.find(m => m.name === config.localModel)
            const model = (configured ?? activated[0])?.name ?? ''
            if (model === '') {
              throw new Error('本地引擎没有已激活的模型：请在「设置 → 扩展 → Ollama」激活一个模型（未激活的模型不进润色候选）')
            }
            const out = await local.chat({ model, prompt: `${system}\n\n${prompt}`, temperature: 0.2, numPredict: 1024 })
            if (out.text.trim() !== '') return out.text
            throw new Error('本地模型返回空结果')
          }
        } catch (error) {
          if (engine === 'local') throw error
          // auto：本地不可用时静默回落线上。
        }
      }
    }
    return await this.generateOnline(config, system, prompt)
  }

  /** 线上一次性补全（ctx.llm.stream + BlockAssembler，与官方 compaction 同法）。 */
  private async generateOnline(config: PolishConfig, system: string, prompt: string): Promise<string> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('llm 服务不可用（无法调用线上模型）')
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }),
      system,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'corum-agent' } })],
      temperature: 0.2,
      maxTokens: 1024,
    })) {
      assembler.push(chunk)
    }
    const text = assembler.blocks()
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text.trim() === '') throw new Error('润色模型返回空结果')
    return text
  }

  /** 冒烟测试。 */
  @Remote('verify')
  async verifyRemote(): Promise<{ ok: boolean; reply?: string; error?: string }> {
    try {
      const profile = ensureSmokeProfile()
      const reply = await this.runProfile(profile.id, SMOKE_PROMPT)
      return { ok: true, reply }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 列出已创建的 Agent 的 profile id。 */
  @Remote('listAgents')
  listAgentsRemote(): { agents: AgentStatus[] } {
    return { agents: [...this.agents.keys()].map(id => ({ profileId: id, created: true })) }
  }

  /**
   * 扫描全局 skill 目录（<CORUM_HOME>/skills/）发现可用 skills。
   *
   * Skill 全局统一管理在 <CORUM_HOME>/skills/，每个 skill 是一个含 SKILL.md
   * 的子目录。Agent 只引用 name 不复制文件——skill 更新即时生效。
   *
   * 返回的列表包含 git 版本信息（commit hash + 是否有未提交修改），
   * 用于 UI 展示版本和回溯。
   */
  @Remote('listSkills')
  listSkillsRemote(): { skills: SkillEntry[] } {
    return { skills: scanSkills() }
  }

  /**
   * 列出所有已注册的 LLM provider 及其模型。
   * 通过 ctx.llm.listProviders() + ctx.llm.listModels() 动态获取，
   * 包含 deepseek-official 和 pi-ai 等第三方适配器注册的 provider。
   */
  @Remote('listModels')
  async listModelsRemote(): Promise<{ providers: ProviderCatalog[] }> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return { providers: [] }
    const providers = llm.listProviders()
    const catalog: ProviderCatalog[] = []
    for (const p of providers) {
      try {
        const models = await llm.listModels(p.id)
        catalog.push({
          id: p.id,
          name: p.name ?? p.id,
          models: models.map(m => ({
            id: m.id,
            name: m.name ?? m.id,
            ...(m.inputModalities !== undefined ? { input: [...m.inputModalities] } : {}),
          })),
        })
      } catch {
        // 跳过 listModels 失败的 provider
      }
    }
    return { providers: catalog }
  }

  /**
   * 日志验证（冒烟测试）：用内置 smoke-test profile 跑一个固定提示词，把
   * 「创建 Agent → 驱动 → 汇总」的完整闭环打到 stderr 日志。
   */
  async verify(): Promise<void> {
    const log = (line: string): void => { process.stderr.write(`[corum-agent] ${line}\n`) }
    try {
      const profile = ensureSmokeProfile()
      log(`verify start — profile "${profile.id}" (${profile.model.provider}/${profile.model.model})`)
      const reply = await this.runProfile(profile.id, SMOKE_PROMPT)
      log(`verify done — agent replied ${JSON.stringify(reply)}`)
    } catch (error) {
      log(`verify failed — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  }

  /**
   * 编译 AgentProfile 并落盘到 Agent 目录。
   * 写入 agent.cordis.yml + preset.yml。
   */
  private writeAgentDir(profile: AgentProfile, dir: string): void {
    mkdirSync(dir, { recursive: true })
    const compiled = compilePreset(profile)
    writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
    writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)
  }

  /**
   * 把绑定的 skill 切换到 pinned 版本。
   * 把 .versions/<versionId>/SKILL.md 复制为当前 SKILL.md。
   * versionId 为空 = 用当前 SKILL.md（未锁定）。
   */
  private checkoutPinnedSkills(profile: AgentProfile): void {
    const skillsRoot = join(corumHome(), 'skills')
    for (const binding of profile.skills) {
      const skillDir = join(skillsRoot, binding.name)
      if (!existsSync(skillDir)) {
        this.ctx.logger.warn(`corum-agent: skill "${binding.name}" not found in ${skillsRoot}`)
        continue
      }
      // 未锁定版本（versionId 空）→ 直接用当前 SKILL.md，跳过切换。
      if (binding.versionId === undefined || binding.versionId === '') continue
      // 从版本目录复制 SKILL.md
      const versionSkillMd = join(skillDir, '.versions', binding.versionId, 'SKILL.md')
      const currentSkillMd = join(skillDir, 'SKILL.md')
      if (!existsSync(versionSkillMd)) {
        // 没有版本目录，说明 skill 是手动放进去的，直接用当前 SKILL.md
        continue
      }
      try {
        const content = readFileSync(versionSkillMd, 'utf8')
        writeFileSync(currentSkillMd, content, 'utf8')
      } catch (error) {
        this.ctx.logger.warn(`corum-agent: failed to switch skill "${binding.name}" to version ${binding.versionId}`, error)
      }
    }
  }
}

/** 泳道标签转 sessionId 安全段（标签可含 `:`，sessionId/路径只用 lower-kebab）。 */
function slugLaneKey(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? GENERAL_WORK_TYPE : slug
}

export default CorumAgentService
