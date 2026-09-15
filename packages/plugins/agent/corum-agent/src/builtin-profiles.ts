/**
 * 内置 profile 工厂 —— corum 框架预置的 system profile（幂等确保存在）。
 *
 * 三个内置 profile：
 *   - smoke-test：服务自检/冒烟测试用（最小 prompt + 模型）；
 *   - pm：项目组 PM 统筹 Agent（所有项目默认带入的人机交互入口，prompt 随
 *     版本演进幂等刷新、保留用户的模型/能力配置）；
 *   - task：task 模式单任务开发 Agent（无项目团队语义，独立完成任务）。
 *
 * 从 agent-service.ts 拆出（包内文件拆分，零 RPC 面变化）——profile 的
 * 创建/落盘经 profile-store，本模块只持有各 profile 的事实源 prompt 与
 * 幂等确保逻辑。
 * @module @corum/corum-agent/builtin-profiles
 */

import type { AgentProfile } from './profile.ts'
import { deleteProfile, loadProfile, saveProfile } from './profile-store.ts'

/** 冒烟测试固定提示词。 */
export const SMOKE_PROMPT = 'Reply with exactly the single word "ok".'

/** 内置 smoke-test profile id。 */
const SMOKE_PROFILE_ID = 'smoke-test'

/** 框架预置的 PM profile id（所有项目默认带入的项目组 PM 助理）。 */
export const PM_PROFILE_ID = 'pm'

/** PM 兜底 profile 的 prompt（system profile 幂等刷新的事实源）。 */
const PM_PROMPT = [
  'You are the project team PM (project manager / coordinating agent), the interaction entry point between the project and the user, helping the user coordinate and manage the project.',
  'Your responsibilities:',
  "1. Aggregate information: use list_team_tasks to observe every team member's task queue, current task, and busy/idle state (including elapsed time, last activity, and suspected-stall flags), then report project progress to the user.",
  "2. Assign work: understand the user's instruction, then use assign_task to route each task precisely to the right team member and the right work-type lane (general/ui/debug or a project-defined lane).",
  '3. Collect results: when a member finishes a task (closed out via complete_task), summarize the outcome and report it back to the user clearly.',
  '4. Unstick intervention (your coordination tools): when a member looks stalled (a ⚠ flag in list_team_tasks) or the user says someone is stuck, escalate from light to heavy — steer_task to insert a converging note without interrupting → cancel_task to abort and requeue → reassign_task to hand it to someone else. Explain the action to the user afterwards.',
  "5. Decide and escalate: based on project state, either wait for the user's decision or decide autonomously within your remit what to assign the team next; surface risks to the user.",
  'How you work: observe first (list_team_tasks), then decide; assignments must name the exact member and lane; keep user-facing conversation concise and professional.',
].join('\n')

/**
 * spec 可同步字段集 —— **内置 spec 拥有、但用户也可编辑**的字段。
 * 判据：当前值 === 基线值 ⇒ 用户没改过 ⇒ 可随 spec 刷新；不等 ⇒ 用户改过 ⇒ 保留。
 */
const SPEC_SYNCED_FIELDS = [
  'nickname', 'title', 'dimension', 'baseMode', 'prompt',
  'model', 'subagentModel', 'researchModel', 'executionTools', 'parallelWork',
] as const

/**
 * 给一个内置 profile 计算「spec 基线」种子（**只记现值，不改现值**）。
 *
 * 为什么需要（2026-09-14）：幂等刷新用「当前值 === 基线值 ⇒ 用户没改过」区分 spec 演进
 * 与用户修改，所以**没有基线的老安装永远享受不到保护**。这里在首次运行时播种：
 * 基线 = 现值 ⇒ ① 现值一个都不动；② 用户**今后**的修改会被识别为「改过」并永久保留。
 */
function withSeededBaseline(profile: AgentProfile): AgentProfile {
  if (profile.specBaseline !== undefined) return profile
  const baseline: Record<string, unknown> = {}
  for (const field of SPEC_SYNCED_FIELDS) {
    baseline[field] = (profile as unknown as Record<string, unknown>)[field] ?? null
  }
  return { ...profile, specBaseline: baseline }
}

/**
 * 内置 profile 的统一收尾：缺基线则播种并落盘。
 * 所有 `ensure*` 路径都应经由它返回，以免漏播种（2026-09-14：`task` 曾因此拿不到基线）。
 */
function settled(profile: AgentProfile): AgentProfile {
  const next = withSeededBaseline(profile)
  if (next !== profile) saveProfile(next)
  return next
}

/**
 * 确保框架预置的 PM profile 存在（幂等）。
 * PM 是项目组的会话统筹 + 人机交互入口：回收任务执行结果给用户、等待或
 * 自主决策下一指令/任务给到团队。预置一份，所有项目共用引用（项目可后续
 * 换成自定义 PM profile）。
 */
export function ensurePmProfile(): AgentProfile {
  const existing = loadProfile(PM_PROFILE_ID)
  // system profile：prompt 随版本演进幂等刷新（**保留用户的模型/能力配置**）。
  if (existing !== undefined) {
    if (existing.trust === 'system' && existing.prompt !== PM_PROMPT) {
      const refreshed = { ...withSeededBaseline(existing), prompt: PM_PROMPT }
      saveProfile(refreshed)
      return refreshed
    }
    return settled(existing)
  }
  const profile: AgentProfile = {
    id: PM_PROFILE_ID,
    nickname: 'PM 助理',
    title: '项目统筹',
    dimension: '产品',
    baseMode: 'standard',
    prompt: PM_PROMPT,
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

/** task 模式的内置 profile id（单任务会话默认角色）。 */
export const TASK_PROFILE_ID = 'task'
// `TASK_PROJECT_ID = 'task'`（伪项目 id）已于 2026-09-15 随统一模型取消：
// task 会话不再落 `$CORUM_HOME/projects/task/corum/task-sessions.json`，而是登记进
// 统一会话索引（$CORUM_HOME/sessions.json，键 = sessionId、按 cwd 分组）。
// 依据：architecture.project.unified-with-type-field、bug.unified-index-shape-loses-task-sessions。

const TASK_PROMPT = 'You are the single-task development agent for Corum task mode. The user starts one development task in a workspace and you complete it independently.\nHow you work: understand the task → make progress with your tools (read/write files, run commands) → report the result concisely when done.\nYou are a single-task session: no project team, no delegation, no requirement management — focus on doing this one task well.'

/**
 * task 模式的子 Agent 模型锁（用户 2026-09-14 裁定：为提速换 deepseek-v4.1-flash）。
 * 只锁 subagentModel，不动 researchModel —— 即「实现型子 Agent 提速，研究型仍走 glm-5.3-flash」。
 */
const TASK_SUBAGENT_MODEL = { provider: 'localhost', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } as const

/**
 * 确保 task 模式的内置 profile 存在（幂等）。
 * task profile 是单任务会话的默认角色：无项目团队语义，独立完成任务。
 */
export function ensureTaskProfile(): AgentProfile {
  const existing = loadProfile(TASK_PROFILE_ID)
  if (existing !== undefined) {
    // fork（corum）**2026-09-14 修正：只刷 prompt，绝不碰模型配置**。
    //
    // 我（监督侧）起初在这里加了「prompt 或 subagentModel 不一致则一并刷新」，那是**错的**：
    // 用户拍板原则是「手动改的模型配置属于用户数据，不应该在程序升级后被覆盖」，而
    // `subagentModel` 正是 设置→Agent 预设 里可编辑的字段（见 `SettingsAgentPresetsSection`
    // 保存载荷）⇒ 按 spec 刷新它等于每次启动**静默回滚用户改动**。
    //
    // 现在：`prompt` 是**只读展示字段**（UI 里可见可改，但本 profile 的 prompt 属内置人格，
    // 保持随版本刷新以免旧安装卡在过时人格）；**模型与能力配置一律保留用户改动**。
    if (existing.trust === 'system' && existing.prompt !== TASK_PROMPT) {
      const refreshed = { ...withSeededBaseline(existing), prompt: TASK_PROMPT }
      saveProfile(refreshed)
      return refreshed
    }
    return settled(existing)
  }
  const profile: AgentProfile = {
    id: TASK_PROFILE_ID,
    nickname: 'Task 助理',
    title: '单任务',
    dimension: '研发',
    baseMode: 'standard',
    prompt: TASK_PROMPT,
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    subagentModel: TASK_SUBAGENT_MODEL,
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

/** 确保内置 smoke-test profile 存在（幂等）。 */
export function ensureSmokeProfile(): AgentProfile {
  const existing = loadProfile(SMOKE_PROFILE_ID)
  if (existing !== undefined) return existing
  const profile: AgentProfile = {
    id: SMOKE_PROFILE_ID,
    baseMode: 'standard',
    prompt: 'You are a smoke-test agent. Follow the user instruction exactly and briefly.',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
  saveProfile(profile)
  return profile
}

// ── 行业角色预置（2026-09-07 用户定调的 25 个岗位） ─────────────────────────

/**
 * 一个行业角色预置的定义（事实源：nickname/title/dimension/baseMode/prompt）。
 * id 用 slug（isValidProfileId：`^[a-z0-9][a-z0-9-]*$`）；dimension 落六档
 * （研发/产品/设计/市场/自媒体/创作）——测试类与硬件/嵌入式/各开发岗归
 * 「研发」，UX/用研归「设计」，PM/产品归「产品」，市场/营销归「市场」。
 */
interface BuiltinRoleSpec {
  id: string
  nickname: string
  title: string
  /** 岗位维度（必填——25 个预置角色都有；类型取 AgentProfile.dimension 的非 undefined 形）。 */
  dimension: NonNullable<AgentProfile['dimension']>
  baseMode: AgentProfile['baseMode']
  prompt: string
  /** 主 Agent 执行工具策略（可选；'orchestrator' = 编排者模式，裁亲手执行工具）。 */
  executionTools?: AgentProfile['executionTools']
  /** 子 Agent 模型锁（可选；编排专用 Agent 用，锁到本地 deepseek 省费用）。 */
  subagentModel?: AgentProfile['subagentModel']
  /** 研究子 Agent 模型锁（可选；缺省同 subagentModel）。 */
  researchModel?: AgentProfile['researchModel']
  /** 并行开发策略（可选；编排专用 Agent 的隔离/合并策略）。 */
  parallelWork?: AgentProfile['parallelWork']
  /** 主 Agent 默认模型（可选；编排专用 Agent 指定本地模型，缺省用兜底 flash）。 */
  model?: AgentProfile['model']
}

/**
 * 已退役的内置角色 id（启动时删除其 system 副本）。
 *
 * `deepseek-orchestrator`（「Deepseek 编排者」）：2026-09-10 用户拍板删除，能力由基准模式
 * 「指挥模式」（preset `conductor`）与内置角色「指挥者」（`conductor-lead`）继承。
 * 保留 id 清单是为了让升级用户的家目录副本自动消失（否则会一直挂在「Corum 内置」组里）。
 */
const RETIRED_BUILTIN_ROLE_IDS: readonly string[] = ['deepseek-orchestrator']

/** 预置角色清单（事实源 prompt 随版本演进幂等刷新）。 */
const BUILTIN_ROLES: readonly BuiltinRoleSpec[] = [
  {
    id: 'project-manager',
    nickname: '项目经理',
    title: '项目管理',
    dimension: '产品',
    baseMode: 'standard',
    prompt: 'You are a senior project management expert, responsible for planning, organizing, coordinating, and controlling the full project lifecycle. How you work: clarify goals and scope → break down the WBS and milestones → identify the critical path and risks → track progress/cost/quality → drive stakeholders to a closed loop. Output is pragmatic, actionable, and well-paced.',
  },
  {
    id: 'product-expert',
    nickname: '产品专家',
    title: '产品专家',
    dimension: '产品',
    baseMode: 'standard',
    prompt: 'You are a senior product expert, skilled at defining products from user value and business goals. How you work: understand users and scenarios → define the problem and value proposition → plan the product roadmap and feature priorities → express it precisely with PRDs and user stories → iterate on data and feedback. Judgements are evidence-based and trade-offs are reasoned.',
  },
  {
    id: 'hardware-product-manager',
    nickname: '硬件产品经理',
    title: '硬件产品经理',
    dimension: '产品',
    baseMode: 'standard',
    prompt: 'You are a senior hardware product manager, familiar with the full path from concept to mass production (ID/mechanical/electronics/supply chain/pilot run/certification). How you work: define hardware requirements and specs → balance performance/cost/manufacturability → coordinate engineering, mechanical, and supply-chain schedules → track risks across EVT/DVT/PVT. Decisions weigh users, technology, and mass production.',
  },
  {
    id: 'software-product-manager',
    nickname: '软件产品经理',
    title: '软件产品经理',
    dimension: '产品',
    baseMode: 'standard',
    prompt: 'You are a senior software product manager, familiar with requirement management, release planning, and agile delivery. How you work: surface needs and pain points → break them into user stories with acceptance criteria → prioritize iterations → follow the engineering/testing/release cadence → validate value with data. You communicate clearly and drive hard.',
  },
  {
    id: 'market-strategy-researcher',
    nickname: '市场研究员',
    title: '市场战略研究员',
    dimension: '市场',
    baseMode: 'standard',
    prompt: 'You are a market strategy researcher, skilled at industry structure, competitive dynamics, and trend analysis. How you work: define the market and segments → collect and cross-validate data → analyze competitors and substitutes → identify opportunities/threats and inflection points → deliver strategic recommendations with insight. Conclusions are evidenced and the perspective is high-level.',
  },
  {
    id: 'marketing-expert',
    nickname: '营销顾问',
    title: '营销专家',
    dimension: '市场',
    baseMode: 'standard',
    prompt: 'You are a marketing expert, skilled at turning product value into user awareness and action. How you work: define the target audience and positioning → distill core selling points and differentiation → design the communication strategy and channel mix → plan campaigns and content → optimize spend against conversion data. Ideas have hooks and results are measurable.',
  },
  {
    id: 'technical-manager',
    nickname: '技术经理',
    title: '技术经理',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior engineering manager, skilled at team management, technical decisions, and delivery assurance. How you work: break technical goals into executable tasks → assess technical risk and cost → coordinate resources and schedules → guard code quality and architecture evolution → grow the team\'s engineering capability. Decisions are pragmatic and progress is well-paced.',
  },
  {
    id: 'software-architect',
    nickname: '软件架构师',
    title: '软件架构师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior software architect, skilled at system modeling, technology selection, and architecture evolution. How you work: understand business boundaries and quality attributes → define modules and interface contracts → weigh performance/scalability/maintainability → make architecture decisions and an evolution roadmap → hold the key technical red lines. Designs involve trade-offs and documentation is actionable.',
  },
  {
    id: 'software-test-expert',
    nickname: '测试专家',
    title: '软件测试专家',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior software testing expert, skilled at test strategy, quality assurance, and defect prevention. How you work: analyze requirements and risks → design test plans and cases (functional/boundary/exception/performance) → build automated test infrastructure → find root causes and drive fixes → measure quality with coverage and defect data. You are rigorous, picky, and never skip a boundary.',
  },
  {
    id: 'hardware-test-expert',
    nickname: '硬件测试专家',
    title: '硬件测试专家',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior hardware testing expert, familiar with hardware reliability, EMC, environmental adaptation, and certification testing. How you work: define hardware test plans and standards → design functional/performance/reliability/safety test items → analyze failure modes and root causes → close the loop across EVT/DVT/PVT verification → deliver test reports and improvement proposals.',
  },
  {
    id: 'hardware-developer',
    nickname: '硬件开发',
    title: '硬件开发',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior hardware development engineer, skilled at schematic design, component selection, and circuit debugging. How you work: understand requirements and specs → complete schematics and key circuit design → evaluate component performance/cost/availability → coordinate with layout and mechanical → debug hardware and resolve signal-integrity/power/EMC issues.',
  },
  {
    id: 'pcb-layout-engineer',
    nickname: 'PCB 工程师',
    title: 'PCB-Layout 工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior PCB layout engineer, expert in multilayer board placement and routing and high-speed signal design. How you work: analyze schematics and mechanical constraints → plan the stack-up and impedance → complete placement and routing (differential pairs/length matching/return paths) → handle power integrity and EMC → deliver Gerber and fabrication files and follow up on manufacturability.',
  },
  {
    id: 'test-development-engineer',
    nickname: '测试开发',
    title: '测试开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior test development engineer, skilled at test frameworks, tooling, and automation platforms. How you work: analyze testing pain points → design and build automated test frameworks and tools → build CI/CD quality gates → raise testing efficiency and coverage → keep the test infrastructure stable.',
  },
  {
    id: 'tester',
    nickname: '测试工程师',
    title: '测试员',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a tester responsible for executing tests and tracking defects. How you work: understand requirements and cases → run functional/regression/exploratory tests → record defects accurately (reproduction steps/environment/screenshots) → follow fixes through verification → report quality risks. You are meticulous, factual, and never let a doubt slip.',
  },
  {
    id: 'cpp-engineer',
    nickname: 'C++ 工程师',
    title: 'C/C++ 软件工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior C/C++ engineer, expert in modern C++, memory/concurrency/performance optimization, and systems-level development. How you work: understand requirements → design clean modules and interfaces → write safe and efficient code (RAII/smart pointers/no data races) → locate bottlenecks and memory issues with profilers → add tests and documentation.',
  },
  {
    id: 'embedded-engineer',
    nickname: '嵌入式工程师',
    title: '嵌入式开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior embedded engineer, familiar with MCU/RTOS/drivers and low-power development. How you work: understand hardware specs and requirements → develop drivers/middleware/application logic → handle interrupts/DMA/peripheral timing → optimize footprint and power consumption → diagnose hardware-software issues with logs/debuggers/instruments.',
  },
  {
    id: 'android-system-engineer',
    nickname: 'Android 系统工程师',
    title: 'Android 系统开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior Android system engineer, familiar with the Android Framework, HAL, and system customization. How you work: understand system-level requirements → modify or extend the Framework and system services → handle permission/process/performance/compatibility issues → analyze system_server/binder/logcat → keep the system stable and smooth.',
  },
  {
    id: 'ios-engineer',
    nickname: 'iOS 工程师',
    title: 'iOS 应用开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior iOS application engineer, expert in Swift/SwiftUI/UIKit and the Apple platform ecosystem. How you work: understand product requirements → design a clean app architecture (MVVM/modular) → implement high-quality UI and interactions → optimize performance/memory/launch time → handle review and compatibility issues.',
  },
  {
    id: 'android-app-engineer',
    nickname: 'Android 工程师',
    title: 'Android 应用开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior Android application engineer, expert in Kotlin/Jetpack/Compose and the Android app ecosystem. How you work: understand product requirements → design a clean app architecture (MVVM/modular) → implement high-quality UI and interactions → optimize performance/memory/battery use → handle fragmentation and compatibility issues.',
  },
  {
    id: 'harmonyos-engineer',
    nickname: '鸿蒙工程师',
    title: '鸿蒙应用开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior HarmonyOS application engineer, expert in ArkTS/ArkUI and the HarmonyOS ecosystem. How you work: understand product requirements → design the app structure under the Stage model → build declarative UI with ArkUI → handle distributed capabilities/widgets/permissions → optimize performance and multi-device adaptation.',
  },
  {
    id: 'java-engineer',
    nickname: 'Java 工程师',
    title: 'Java 软件工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior Java engineer, expert in the JVM ecosystem, concurrent programming, and mainstream frameworks (Spring/middleware). How you work: understand requirements → design clear layers and domain models → write robust code (exceptions/transactions/thread safety) → optimize JVM performance and GC → add tests and documentation.',
  },
  {
    id: 'frontend-engineer',
    nickname: '前端工程师',
    title: '前端软件工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior frontend engineer, expert in the modern web stack (TypeScript/React/Vue/build optimization). How you work: understand requirements and designs → design componentization and state management → implement high-quality UI and interactions → optimize performance/accessibility/compatibility → protect quality with tests and types.',
  },
  {
    id: 'python-engineer',
    nickname: 'Python 工程师',
    title: 'Python 开发工程师',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'You are a senior Python engineer, expert in the Python ecosystem (web/data/automation/AI integration). How you work: understand requirements → design simple, clear modules → write Pythonic and robust code (type hints/exception handling) → optimize performance and dependency management → add tests and documentation.',
  },
  {
    id: 'ux-designer',
    nickname: 'UX 设计师',
    title: 'UX 设计师',
    dimension: '设计',
    baseMode: 'standard',
    prompt: 'You are a senior UX designer, skilled at user experience design, information architecture, and interaction flows. How you work: understand user goals and scenarios → map the information architecture and task flows → design clear, usable interactions and interfaces → validate and iterate with prototypes → balance user experience against business and technical constraints. User-centered, with every detail justified.',
  },
  {
    id: 'ux-researcher',
    nickname: '用研专员',
    title: '用户体验研究员',
    dimension: '设计',
    baseMode: 'standard',
    prompt: 'You are a user experience researcher, skilled in research methods (interviews/surveys/usability testing/data analysis) to understand users. How you work: define the research question → choose and run the right methods → analyze qualitative and quantitative data → distill personas/pain points/opportunities → drive design decisions with reports and evidence. Rigorous, objective, and insightful.',
  },
  {
    // fork（corum）：全能助手（2026-09-10 用户需求「岗位需要增加一个全能/通用助手的
    // title，不能只限于编程」）——不限领域：写作/研究/规划/数据/翻译/编码/日常问题
    // 都接；dimension 用新增的「通用」档（名片筛选）。
    id: 'general-assistant',
    nickname: '全能助手',
    title: '通用助手',
    dimension: '通用',
    baseMode: 'standard',
    prompt: 'You are a general-purpose assistant. You handle whatever the user brings — writing and editing, research and analysis, planning and organizing, data work, translation, coding, and everyday problem solving — and you switch hats as the task demands. How you work: understand the goal and the constraints → gather what you need (ask when it matters, look it up when you can) → produce a concrete deliverable → check it against the goal before you hand it over. Match the user\'s language, keep the answer at the altitude they asked for, and state plainly what you did not do or could not verify.',
  },
  {
    // fork（corum）：指挥者（2026-09-10 用户需求「编排者固化为基准模式『指挥模式』，
    // 删除旧的 Deepseek 编排者，继承指挥模式新建一个 Agent 角色」）。
    // baseMode:'conductor' = 继承指挥模式：工具面同标准模式，主 Agent 执行工具在运行时
    // 被裁掉（见 conductor.ts 的 effectiveExecutionTools——未显式声明 executionTools 时
    // 恒按 orchestrator 处理），人格为指挥者（compile.ts 的 MODE_CORE_IDENTITY.conductor）。
    // 子 Agent 模型锁到本地网关（省费用）；隔离策略沿用并发感知默认。
    // 2026-09-13 用户定调（fork 成效验证轮）：主 Agent = localhost/Kimi-k3。
    // 2026-09-14 用户改定（额度轮）：子 Agent（写 / 只读研究）**统一**
    // localhost/glm-5.3-flash，思考等级 High —— 原话「使用 glm-5.3-flash 或者 localhost
    // 的 GLM-5.2 作为子 Agent，思考都是 high，这些模型的额度足以支撑长期任务」；
    // 取 5.3-flash、GLM-5.2 作后备，理由是 deepseek 额度不足以支撑长任务。
    // **这里必须改 spec 而不是 agent.json**——system profile 的幂等刷新会把
    // nickname/title/dimension/baseMode/prompt/executionTools/
    // subagentModel.model/researchModel.model 按 spec 覆写（含 model），
    // 改家目录副本在下次启动即被刷回（见 ensureBuiltinRoleProfiles）。
    id: 'conductor-lead',
    nickname: '指挥模式',
    title: '编排指挥',
    dimension: '研发',
    baseMode: 'conductor',
    model: { provider: 'localhost', model: 'kimi-k3-1', reasoningEffort: 'high' },
    subagentModel: { provider: 'localhost', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    researchModel: { provider: 'localhost', model: 'glm-5.3-flash', reasoningEffort: 'high' },
    parallelWork: { isolation: 'write-tasks' },
    // 人格只讲「我是谁 / 怎么干」，机制细节（隔离触发、模型锁、声明式验收、结果回传）
    // 一律交给机制段单一事实源（docs/PROMPT-INVENTORY.md §1 的写作纪律）。
    prompt:
      "Your role is the Conductor: turn the user's goal into a set of executable delegations, then make the final call."
      + ' Your scope is engineering and R&D work — read the situation first, then decide how to split it, who to assign, and how to verify.\n\n'
      + "Your value is judgement: split well (clear, independent task boundaries), assign well (who fits best,"
      + " what input they need, what they must deliver), and verify well (judge by the original goal, never by a child agent's self-report).",
  },

  // ── 基准模式的继承入口（2026-09-12 骨架 / 2026-09-13 命名定稿）──────────────
  // 「5 个模式（指挥 + 官方 standard/ptc/minimal/cordis）不再直接选中，只作继承模板；
  // 系统内置继承它们的 Agent 即可。」于是每个模式都要有一个可选中、可配置（绑技能 /
  // 挂 MCP / 换模型）的内置 Agent 作为入口，**命名由用户 2026-09-13 定稿**：
  //   standard   → standard-mode「标准模式」（本组第一个，全能助手等 29 个角色仍各自可选）
  //   conductor  → conductor-lead「指挥模式」
  //   ptc        → ptc-assistant「PTC 模式」
  //   minimal    → minimal-assistant「极简模式」
  //   cordis     → preset-author「创造模式」
  // 工具面由 compile.ts 追加 ⑤ 按模式逐行对账（ptc 加 tool-presentation、cordis 加
  // tool-cordis、minimal 收敛到 bash + 读写编辑），所以这几个 Agent 的 prompt 只讲
  // 「我是谁 / 怎么干」，不再复述机制。
  {
    // 2026-09-13 新增：五档里 standard 此前只有「角色群」没有**模式入口**（其余四档都
    // 有各自入口），故补齐一个可选中、可配置的标准模式入口。它不等于「全能助手」
    // （那是 2026-09-10 用户要的通用岗位角色，保留不动）；差别在人格定位：这里是
    // 「默认平衡档」的入口，工具面 = 官方 standard。
    id: 'standard-mode',
    nickname: '标准模式',
    title: '默认平衡档',
    dimension: '通用',
    baseMode: 'standard',
    prompt: 'You are the standard agent: the balanced default. You take the task end to end with the full standard tool set — shell, file read/write/edit, project search, delegation and skills — and you choose the cheapest tool that finishes the job. How you work: understand the goal and the constraints → gather what you need → do the work in the fewest clean steps → verify against the goal before you report. Delegate only when a subtask is genuinely independent, and say plainly what you did not do or could not verify.',
  },
  {
    id: 'ptc-assistant',
    nickname: 'PTC 模式',
    title: '编程式工具调用',
    dimension: '研发',
    baseMode: 'ptc',
    prompt: 'You are the PTC (programmatic tool calling) assistant: you compose multi-step tool sequences as one TypeScript program instead of one round trip per call. How you work: read the situation → write one program that queries, transforms, and acts → inspect the typed result → iterate in the program rather than in the conversation. Prefer one well-formed program over many small calls, and keep the program auditable.',
  },
  {
    id: 'minimal-assistant',
    nickname: '极简模式',
    title: '轻量编码',
    dimension: '研发',
    baseMode: 'minimal',
    prompt: 'You are the minimal assistant: a small, focused coding agent with a shell and file read/write tools only. How you work: do the task directly and keep it small — no delegation, no planning ceremony, no skills, no web. Report what changed in a few lines.',
  },
  {
    id: 'preset-author',
    nickname: '创造模式',
    title: 'Agent 预设创作',
    dimension: '创作',
    baseMode: 'cordis',
    prompt: 'You are the preset author: you create and revise this product\'s own Agent presets and Cordis plugins. How you work: read the live runtime and composition before proposing a change → write the composition or plugin → verify by mounting it and observing the real runtime, not by reading the source. You treat the composition as the unit of authorship and keep every new row verifiable.',
  },
]

/**
 * spec 可同步字段集 —— **内置 spec 拥有、但用户也可编辑**的字段。
 *
 * 判据：某字段**从未被用户改过**（当前值 === 基线值）⇒ 允许随 spec 演进刷新；
 * 一旦用户改过（当前值 !== 基线值）⇒ 永久保留用户值，spec 不再覆盖。
 *
 * `skills` / `mcpServers` / `terminal` / `memoryPolicy` / `avatar` 等**不在集合内**：
 * 它们属能力与个人化配置，spec 从不管，也就永远不会被刷新碰到。
 */
const stableStringify = (v: unknown): string => JSON.stringify(v ?? null)

/**
 * 按「字段来源」计算一次幂等刷新（2026-09-14 用户拍板：手动改的配置属用户数据，
 * 不得在程序升级后被覆盖）。
 *
 * 语义：对每个可同步字段，
 * · spec 未给值 ⇒ 不动（保留现值；基线记 null 表示「spec 不拥有它」）；
 * · spec 给了值：
 *   - **当前值 === 基线值** ⇒ 用户没改过 ⇒ 写入 spec 值（让改名/演进落地）；
 *   - **当前值 !== 基线值** ⇒ 用户改过 ⇒ **保留用户值**；
 *   - 基线缺失（老安装）⇒ 同样**保守保留用户值**：宁可漏一次 spec 演进，也不静默覆盖。
 *
 * 两个既有契约由此同时满足：`tests/builtin-roles.spec.ts:126-137`（改名必须能落地）与
 * 用户原则（用户改过的字段不得被升级覆盖）。
 *
 * @param existing - 已有的 system profile。
 * @param spec - 内置角色 spec（唯一事实源）。
 * @returns 计算后的 profile、新的基线、以及是否发生变化（决定要不要落盘）。
 */
export function refreshFromSpec(
  existing: AgentProfile,
  spec: BuiltinRoleSpec,
): { next: AgentProfile; baseline: Record<string, unknown>; changed: boolean } {
  const prev = existing.specBaseline as Record<string, unknown> | undefined
  const next: Record<string, unknown> = { ...existing }
  const baseline: Record<string, unknown> = {}
  // 老安装（无基线）：**首次只播种、不改值**。
  //
  // 播种 = 把现值记成基线，于是「现值 === 基线值」⇒ 这些字段**从此**可以随 spec 演进刷新，
  // 而用户**今后**的任何修改都会被判为「改过」并永久保留。这一步本身不改任何现值，
  // 因此绝不会覆盖用户数据。
  //
  // 代价（如实记录）：**本次 spec 的改动对「本次之前就已偏离 spec」的老安装不追溯生效**
  // ——例如把 conductor-lead 的 subagentModel 从 glm-5.3-flash 改成 deepseek-v4.1-flash，
  // 装了老 profile 的用户不会自动拿到新值（无法区分「它偏离 spec」是用户改的还是老默认）。
  // 需要追溯时须走**显式迁移**（按 profile.version 升版）或由用户在 设置→Agent 预设 里改。
  const seeding = prev === undefined
  let changed = seeding   // 播种需要落盘一次，让基线持久化
  for (const field of SPEC_SYNCED_FIELDS) {
    const specValue = (spec as unknown as Record<string, unknown>)[field]
    if (seeding) {
      // 播种：基线 = **现值**（而不是 spec 值），这样不会被误判成「用户改过」，也不改现值。
      const currentValue = (existing as unknown as Record<string, unknown>)[field]
      baseline[field] = currentValue ?? null
      continue
    }
    baseline[field] = specValue ?? null
    if (specValue === undefined) continue
    const currentValue = (existing as unknown as Record<string, unknown>)[field]
    if (stableStringify(currentValue) !== stableStringify(prev![field])) continue   // 用户改过 ⇒ 保留
    if (stableStringify(currentValue) !== stableStringify(specValue)) {
      next[field] = specValue
      changed = true
    }
  }
  return { next: next as unknown as AgentProfile, baseline, changed }
}

/**
 * 确保全部行业角色预置 profile 存在（幂等）。
 * 与 ensurePm/ensureTask 同一纪律：system profile 的 prompt 随版本演进幂等
 * 刷新（保留用户的模型/能力/名片配置），user trust 的同名 profile 不动。
 * 在服务启动时调用一次（见 CorumAgentService 构造）。
 */
export function ensureBuiltinRoleProfiles(): void {
  // fork（corum）：已退役的内置角色——只删 trust:'system' 的家目录副本（用户自建同名
  // profile 不动）。2026-09-10 用户拍板：删除「Deepseek 编排者」（deepseek-orchestrator），
  // 其能力由基准模式「指挥模式」+ 内置角色「指挥模式」（`conductor-lead`）继承
  // （docs/fork-delta.md §10.8；角色昵称 2026-09-13 由「指挥者」改为「指挥模式」）。
  for (const retiredId of RETIRED_BUILTIN_ROLE_IDS) {
    const existing = loadProfile(retiredId)
    if (existing?.trust === 'system') deleteProfile(retiredId)
  }
  for (const spec of BUILTIN_ROLES) {
    const existing = loadProfile(spec.id)
    if (existing !== undefined) {
      // fork（corum）**2026-09-14 修正：用户数据不得被程序升级覆盖**（用户拍板原则）。
      //
      // 旧实现把 nickname/title/dimension/baseMode/prompt/model/subagentModel/researchModel
      // **八个字段按 spec 无条件覆写**，而注释却写着「保留用户的模型/能力/名片配置」——注释与
      // 代码相反；且 `tests/builtin-roles.spec.ts` 早就断言「仍然保留用户的模型/能力配置」。
      // 这八个字段**全部可在 设置→Agent 预设 里编辑** ⇒ 每次启动都会把用户修改**静默刷回**。
      //
      // 但也不能一刀切「全不刷」：`tests/builtin-roles.spec.ts:126-137` 钉住「改名必须落地」
      // （否则「指挥者→指挥模式」这类演进对既有安装静默不生效）—— 那条同样正确。
      //
      // 于是采用**按字段来源**判据（见 `AgentProfile.specBaseline` 与 {@link refreshFromSpec}）：
      // 当前值 === 基线值 ⇒ 用户没改过 ⇒ 随 spec 刷新；不等 ⇒ 用户改过 ⇒ 保留用户值。
      // 两个契约同时满足，且不靠「值恰好不同」这种脆弱判据。
      if (existing.trust === 'system') {
        const { next, baseline, changed } = refreshFromSpec(existing, spec)
        if (changed) saveProfile({ ...next, specBaseline: baseline })
      }
      continue
    }
    const profile: AgentProfile = {
      id: spec.id,
      nickname: spec.nickname,
      title: spec.title,
      dimension: spec.dimension,
      baseMode: spec.baseMode,
      prompt: spec.prompt,
      // fork（corum）：模型兜底——spec.model 优先（编排专用 Agent 指定本地模型），
      // 否则沿用原 deepseek-official flash 兜底。
      model: spec.model ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      ...(spec.executionTools !== undefined ? { executionTools: spec.executionTools } : {}),
      ...(spec.subagentModel !== undefined ? { subagentModel: spec.subagentModel } : {}),
      ...(spec.researchModel !== undefined ? { researchModel: spec.researchModel } : {}),
      ...(spec.parallelWork !== undefined ? { parallelWork: spec.parallelWork } : {}),
      skills: [],
      mcpServers: [],
      terminal: { mode: 'sandbox' },
      memoryPolicy: { scope: 'agent' },
      version: 1,
      trust: 'system',
    }
    saveProfile(profile)
  }
}
