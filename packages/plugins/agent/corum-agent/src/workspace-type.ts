/**
 * 工作区类型与工作类型（L1 助手）—— 从 `project.ts` 原样沉淀（2026-09-26 项目模式剥离）。
 *
 * ## 边界
 *
 * 项目模式已迁至闭源仓 **Corum-Harness-Project**，但这两组**类型学**是任务模式
 * （task mode）也在用的：`session-index.ts` 按 `ProjectType` 分区显示、统一索引
 * 迁移按类型判定归属。故它们留在开源侧 L1（纯类型学，**不含**项目实体 CRUD、
 * 不含项目组、不含磁盘路径）。
 *
 * | 组 | 符号 | 谁在用 |
 * | --- | --- | --- |
 * | 工程类型 | {@link ProjectType} / {@link isProjectType} / {@link projectTypeOf} / 判定表 | session-index、agent-service（task 门禁）、闭源 project-service |
 * | 工作类型（泳道） | {@link WorkType} / {@link BUILTIN_WORK_TYPES} / {@link resolveWorkTypes} | 闭源 project-service / runtime（泳道路由） |
 *
 * 闭源仓在 `src/shared/` 持一份**逐字副本**（用户已批准重复）——理由：开源侧不得
 * 依赖闭源包，而这两组类型是两仓共享的语义契约。
 *
 * @module @corum/corum-agent/workspace-type
 */

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
 * 与闭源 project-service 的判定表门禁）。
 */
export function projectTypeOf(project: { type?: ProjectType } | undefined): ProjectType {
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

// ── 工作类型（session type）────────────────────────────────────────────

/**
 * 一个工作类型泳道：任务按 type 路由到对应会话，实现「session 专注度」——
 * 同 type 的工作进同一会话，不同 type 互不插入（如 A 的开发会话不插 B/C 任务）。
 *
 * 类型表 = 框架兜底类型 + 项目自定义类型（见闭源仓 CorumProject.workTypes）。
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
export function resolveWorkTypes(project: { workTypes?: WorkType[] }): WorkType[] {
  const table = new Map<string, WorkType>()
  for (const t of BUILTIN_WORK_TYPES) table.set(t.slug, t)
  for (const t of project.workTypes ?? []) {
    if (!isValidWorkTypeSlug(t.slug)) continue
    if (table.has(t.slug)) continue // 内置优先，忽略同 slug 自定义
    table.set(t.slug, { ...t, builtin: false })
  }
  return [...table.values()]
}
