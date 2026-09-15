/**
 * Project 数据模型：corum「Agent 驱动项目管理平台」的项目单元。
 *
 * 团队属项目（见 docs/agent-foundation/TEAM-SCHEDULER-EVENT-LOG.md §1）：
 * 一个团队（一组角色 Agent / profile）可同时服务多个项目，但每个项目
 * 独立实例化一套 Agent 实例 + 一份调度事件日志 + 一套调度状态，彼此隔离。
 *
 * 本模型是「轻量版」——只承载 projectId 的生成与项目元信息（name/path），
 * 打通「创建项目 → 拿 projectId」链路。PRD §3 的完整项目实体（计划/阶段/
 * 需求/任务/BUG 等）的项目数据层在本包内演进（project-core 已废弃移除），
 * 本模型届时对齐扩展。
 *
 * 存储（Round 1 拆分）：索引 `$CORUM_HOME/projects/<projectId>/project.json`
 * （轻字段），详字段落 `<cwd>/.corum/project/project.json`（见 project-store.ts）。
 * @module @corum/corum-agent/project
 */

import { realpathSync } from 'node:fs'
import { normalize } from 'node:path'

/**
 * 一个 corum 项目（Round 1 拆分形态：索引轻字段 + 项目侧详字段）。
 *
 * 「项目数据跟随项目走」（2026-09-14 Round 1）后，持久层一分为二：
 *   索引（`$CORUM_HOME/projects/<id>/project.json`）只留 6 个轻字段
 *   （id/name/cwd/addedAt/lastOpenedAt/version）——listProjects() 只枚举索引，
 *   cwd 失联也仍能列出该条目并提示「目录不可用」；
 *   详字段（description/workTypes/group 等）落项目侧
 *   `<cwd>/.corum/project/project.json`（ProjectInfo），由 loadProject()
 *   合并出完整 CorumProject。
 */
export interface CorumProject {
  /** 项目唯一 id（slug，lower-kebab-case）。即索引目录名。 */
  id: string
  /** 用户可见项目名。 */
  name: string
  /**
   * **工程类型**（工作区的类型标记）：`project` | `task`。
   *
   * 用户 2026-09-14 定的统一模型：TASK 模式下工作区**其实也是一个项目**，两种模式
   * 共用同一套文件行为，只由本字段区分工程类型（`architecture.project.unified-with-type-field`）。
   *
   * ⚠️ **与 {@link CorumProject.workTypes} 无关**：`workTypes` 是「项目自定义**工作**类型」
   * （泳道：general/ui/debug…），本字段是「**工程**类型」。两者语义正交，勿混用。
   *
   * 三条不变式（见 {@link canTransitionProjectType} / {@link projectTypeOf}）：
   *   A · **具权威性**：模式不由用户本次选择决定，由工作区已存的 type 决定；
   *   B · **单调不可降级**：`task → project` 允许（需确认），`project → task` 禁止；
   *   C · **互斥**：同一工作区只有一个 type，两模式不共存。
   *
   * 缺省（旧存量条目）按 {@link DEFAULT_PROJECT_TYPE}（`project`）读——旧条目都是
   * 项目模式创建的，缺省为 project 既符合史实，也满足不变式 B（不产生隐式降级）。
   */
  type?: ProjectType
  /** 项目工作目录（绝对路径；代码所在，可为空 = 尚未关联工作区）。 */
  cwd?: string
  /** 简短描述（可选）。 */
  description?: string
  /**
   * 项目自定义工作类型（在框架兜底 BUILTIN_WORK_TYPES 之上扩展）。
   * 完整类型表 = BUILTIN_WORK_TYPES + 本字段（按 slug 去重，内置优先）。
   * 缺省/空 = 仅框架兜底类型。
   */
  workTypes?: WorkType[]
  /**
   * 项目组（项目的运行时组织，一个项目只有一个）。所有运行时（对话/调度/
   * assign_task/list_team_tasks）都围绕项目组成员分配；非项目组成员不参与、
   * 不可见、不调度。缺省 = 空项目组（仅框架默认带入的 PM）。
   */
  group?: ProjectGroup
  /** 创建时间戳（Unix epoch ms）。 */
  createdAt: number
  /** 最后打开时间戳（项目选择器排序用）。 */
  lastOpenedAt: number
  /** 乐观锁版本号（每次 save 自增）。 */
  version: number
}

/**
 * 项目组（虚拟组织）：项目的运行时成员集合。成员引用全局 AgentProfile
 * （只有一份配置，不是拷贝），来源可以是整个团队 / 某团队的指定 Agent /
 * 无团队的独立 Agent。
 */
export interface ProjectGroup {
  /** 项目组成员列表。 */
  members: ProjectGroupMember[]
}

/** 项目组成员（引用一个全局 AgentProfile）。 */
export interface ProjectGroupMember {
  /** 引用的全局 profile id。 */
  profileId: string
  /**
   * 调度角色：pm（会话统筹 + 人机交互入口 + 协调工具）或 member（普通执行成员）。
   * 一个项目组至少一个 pm。
   */
  role: 'pm' | 'member'
  /**
   * 数据层专业角色（权限网关用，可选）。缺省推导：pm → pm；member → dev。
   * 这与调度 role 解耦：一个执行成员可戴 QA/PD/TL 等专业帽子，后续由团队管理界面任命。
   */
  profession?: 'pd' | 'techLead' | 'dev' | 'qa'
  /** 来源团队 id（可追溯「这个成员来自哪个团队」；独立 Agent 无此字段）。 */
  fromTeam?: string
}

// ── 工程类型（工作区的类型标记）────────────────────────────────────────

/**
 * 工程类型：工作区是「项目」还是「任务」。
 *
 * 用户 2026-09-14 统一模型（`architecture.project.unified-with-type-field`）：
 * 两种模式对用户是同一件事（都是打开工作区做开发），`type` 只是**类型标记**
 * ——类型不同 ⇒ 保存的数据不同、管理方式不同，但**文件行为统一**。
 */
export type ProjectType = 'project' | 'task'

/** 合法工程类型表（运行时校验/遍历用）。 */
export const PROJECT_TYPES: readonly ProjectType[] = ['project', 'task']

/**
 * 存量缺省类型：**旧条目一律是项目模式创建的**（`task` 模式此前根本没有项目条目，
 * 它只有伪项目目录 `projects/task/`）。故缺省读作 `project` 既符合史实，
 * 也满足不变式 B（不会把已存在的工作区隐式**降级**成 task）。
 */
export const DEFAULT_PROJECT_TYPE: ProjectType = 'project'

/** 判断一个值是否是合法工程类型。 */
export function isProjectType(value: unknown): value is ProjectType {
  return value === 'project' || value === 'task'
}

/**
 * 读一个项目的**权威**工程类型（不变式 A：type 由工作区自身持有）。
 *
 * 缺省/脏值 → {@link DEFAULT_PROJECT_TYPE}。调用方**不得**用「用户本次选择」
 * 覆盖本函数的结果——用户选择只触发校验/提示（见 {@link canTransitionProjectType}
 * 与 project-service 的判定表门禁）。
 */
export function projectTypeOf(project: Pick<CorumProject, 'type'> | undefined): ProjectType {
  return project !== undefined && isProjectType(project.type) ? project.type : DEFAULT_PROJECT_TYPE
}

/**
 * 工程类型迁移判定（不变式 B：**单调不可降级**）。
 *
 * 用户 2026-09-14 裁定原话：「当该工作区以 task 方式创建后，用户在项目口径创建新项目时
 * 打开，发现里面已经有 task 的工程痕迹，则提醒用户是否要升级为 project（设计上 project
 * 是更高级的组织和管理方式）」；「如果是 task 模式打开一个 project 项目，则提示用户是
 * 项目模式，是否按照项目模式开启。**拒绝按照 task 模式开启**」；「这个 type 肯定不能改」。
 *
 * | from \ to | project | task |
 * | --- | --- | --- |
 * | project | 幂等（允许，同口径重开） | **禁止**（降级） |
 * | task | **允许但需用户确认**（升级） | 幂等（允许，同口径重开） |
 *
 * @returns 判定结果：`same` 同口径重开（恢复原项目）／`upgrade` 升级（需确认）／
 *   `downgrade` 降级（禁止）。
 */
export function classifyProjectTypeTransition(
  from: ProjectType,
  to: ProjectType,
): 'same' | 'upgrade' | 'downgrade' {
  if (from === to) return 'same'
  return from === 'task' && to === 'project' ? 'upgrade' : 'downgrade'
}

/**
 * 类型迁移是否允许（不变式 B 的可判定形式）。
 * `task → project` 允许（调用方仍须先取得用户确认）；`project → task` 恒 false。
 */
export function canTransitionProjectType(from: ProjectType, to: ProjectType): boolean {
  return classifyProjectTypeTransition(from, to) !== 'downgrade'
}

/**
 * 工作区身份规范形：**由 cwd 决定**（`architecture.project.type-is-authoritative-and-monotonic`
 * 「一工作区一条目、身份由 cwd 决定」）。
 *
 * 必须 realpath 归一，否则同一目录会被判成两个工作区：
 *   - 尾斜杠：`/a/b/` 与 `/a/b`（存量实测 217 条 task 会话里两者并存）；
 *   - 软链：macOS `/tmp` → `/private/tmp`（`agent-service.ts:1506` 的
 *     `createAgentForTask` 已有同款先例：attach workspace 前先 realpathSync）。
 *
 * 目录不存在（已删/已移动）时 realpath 会抛错 ⇒ 退回「去尾斜杠 + 归一分隔符」的
 * 字形规范形：死条目的身份仍可比较（供迁移去重），只是拿不到软链解析。
 */
export function canonicalWorkspaceKey(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.trim() === '') return undefined
  const trimmed = cwd.trim()
  try {
    return realpathSync(trimmed)
  } catch {
    // 目录不可达：字形归一（折叠重复分隔符、去尾斜杠；保留根 `/`）。绝不 throw——
    // 死条目的身份仍需可比，迁移/列表都不该因一条失联目录整体失败。
    const collapsed = normalize(trimmed).normalize('NFC')
    return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed
  }
}

/** 项目 id 合法性：lower-kebab-case，与 profile id 同规则。 */
export function isValidProjectId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/** 从项目名派生一个合法 projectId（slug 化；冲突由 store 层加后缀处理）。 */
export function slugifyProjectId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'project' : slug
}

// ── 工作类型（session type）────────────────────────────────────────────

/**
 * 一个工作类型泳道：任务按 type 路由到对应会话，实现「session 专注度」——
 * 同 type 的工作进同一会话，不同 type 互不插入（如 A 的开发会话不插 B/C 任务）。
 *
 * 类型表 = 框架兜底类型 + 项目自定义类型（见 CorumProject.workTypes）。
 */
export interface WorkType {
  /** 类型 slug（lower-kebab-case），进 sessionId 的 type 段。 */
  slug: string
  /** 用户可见名（如「通用」「UI」「核心开发」）。 */
  label: string
  /** 说明（可选：该泳道处理什么工作，供路由/展示）。 */
  description?: string
  /** 是否框架兜底内置（内置不可删除/改名）。 */
  builtin: boolean
}

/**
 * 框架兜底工作类型：所有项目预置，覆盖通用问答与常见泳道。
 * 项目可在其上做自定义扩展，但不可删除这些内置项。
 */
export const BUILTIN_WORK_TYPES: readonly WorkType[] = [
  { slug: 'general', label: '通用', description: '一般问答、未归类任务的细化', builtin: true },
  { slug: 'ui', label: 'UI', description: 'UI 绘制、界面相关 BUG 与任务', builtin: true },
  { slug: 'debug', label: '调试', description: '调试、问题排查、修 BUG', builtin: true },
]

/** 保留的兜底 type slug（未归类任务的默认归属）。 */
export const GENERAL_WORK_TYPE = 'general'

/** type slug 合法性：lower-kebab-case。 */
export function isValidWorkTypeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug)
}

/**
 * 解析一个项目的完整工作类型表：框架兜底类型在前，项目自定义类型追加
 * （按 slug 去重，内置优先——自定义与内置同 slug 时忽略自定义，防覆盖兜底）。
 * @param project - 项目实体（其 workTypes 为自定义扩展，可缺省）。
 * @returns 完整可用类型表（内置 + 自定义）。
 */
export function resolveWorkTypes(project: Pick<CorumProject, 'workTypes'>): WorkType[] {
  const table = new Map<string, WorkType>()
  for (const t of BUILTIN_WORK_TYPES) table.set(t.slug, t)
  for (const t of project.workTypes ?? []) {
    if (!isValidWorkTypeSlug(t.slug)) continue
    if (table.has(t.slug)) continue // 内置优先，忽略同 slug 自定义
    table.set(t.slug, { ...t, builtin: false })
  }
  return [...table.values()]
}

/**
 * 项目组成员的 profile id 集合（运行时成员边界）。
 * 空项目组（无 group 或 members 为空）返回空集合——仅框架默认带入的 PM 不在此列。
 */
export function groupMemberIds(project: Pick<CorumProject, 'group'>): ReadonlySet<string> {
  return new Set((project.group?.members ?? []).map(m => m.profileId))
}

/** 判断一个 profile 是否是项目组成员（参与该项目工作/调度的边界）。 */
export function isGroupMember(project: Pick<CorumProject, 'group'>, profileId: string): boolean {
  return (project.group?.members ?? []).some(m => m.profileId === profileId)
}

/** 取项目组的 PM 成员（会话统筹 + 人机交互入口；空项目组应至少有一个）。 */
export function groupPm(project: Pick<CorumProject, 'group'>): ProjectGroupMember | undefined {
  return (project.group?.members ?? []).find(m => m.role === 'pm')
}
