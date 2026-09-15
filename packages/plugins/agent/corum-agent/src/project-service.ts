/**
 * CorumProjectService — corum 项目服务（轻量版）。
 *
 * 打通「创建项目 → 拿 projectId」链路，为团队调度事件日志提供落点边界
 * （见 docs/agent-foundation/TEAM-SCHEDULER-EVENT-LOG.md）。每个项目是
 * `$CORUM_HOME/projects/<projectId>/` 一个独立目录，天然多项目隔离。
 *
 * 继承 TypertRemoteService，通过 @Remote 暴露 /api/corumProject/* 端点，
 * 供浏览器半（项目选择器 / AgentTestPanel）经桌面 IPC 桥调用。
 *
 * 这是轻量版——只承载 projectId 生成 + 项目元信息 CRUD。PRD §3 的完整
 * 项目实体（计划/需求/任务/BUG）的项目数据层在本包内演进（project-core
 * 已废弃移除）。
 * @module @corum/corum-agent/project-service
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { CorumProject, ProjectGroup, ProjectGroupMember, ProjectType, WorkType } from './project.ts'
import {
  DEFAULT_PROJECT_TYPE,
  classifyProjectTypeTransition,
  canTransitionProjectType,
  isProjectType,
  isValidProjectId,
  isValidWorkTypeSlug,
  projectTypeOf,
  resolveWorkTypes,
  slugifyProjectId,
} from './project.ts'
import { loadProject, listProjects, saveProject, projectDir, loadProjectIndex, deleteProject, projectCwdExists, findProjectByCwd, PROJECT_DATA_DIR } from './project-store.ts'
import { listSessionsForWorkspace } from './session-index.ts'
import { ensurePmProfile, PM_PROFILE_ID } from './agent-service.ts'
import { loadTeam } from './team-store.ts'
import { isValidProfileId } from './profile.ts'
import { loadProfile } from './profile-store.ts'
import { publishDomainEvent } from './events.ts'
import { ensureWorkspaceAgentsMd } from './workspace-agents.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** corum 项目服务（项目创建/列表 → projectId）。 */
    corumProject: CorumProjectService
  }
}

/** 创建项目的 RPC 入参。 */
export interface CreateProjectInput {
  /** 项目名（必填，用于派生 projectId slug）。 */
  name: string
  /** 工作目录（可选，绝对路径）。 */
  cwd?: string
  /** 描述（可选）。 */
  description?: string
  /**
   * 工程类型（缺省 `project`）。**不是**「用户选择就算数」——若该工作区已有
   * 条目，类型由已有条目决定，本字段只触发门禁校验（见 {@link openProjectByPath}）。
   */
  type?: ProjectType
}

/**
 * `openProjectByPath` 的结果：按「打开/创建判定表」分流。
 *
 * 判定表（`architecture.project.type-is-authoritative-and-monotonic`）：
 *
 * | 工作区现状 | 用户起的口径 | 行为 |
 * | --- | --- | --- |
 * | 无痕迹 | task / project | 直接创建（`wizard`） |
 * | 已有 `type:'task'` | project | **提醒是否升级**（`upgrade-required`） |
 * | 已有 `type:'project'` | task | **提示按项目模式开启**（`mode-conflict`），拒绝按 task 开 |
 * | 已有 type（任一） | 同口径 | **恢复原有项目**（`existing`），不再新建 |
 */
export type OpenProjectByPathResult =
  | { kind: 'existing'; project: CorumProject }
  | { kind: 'wizard'; cwd: string; suggestedName: string; requestedType: ProjectType }
  /** 已有 task 工作区，用户要以 project 打开 ⇒ 需用户确认「升级为 project」。 */
  | { kind: 'upgrade-required'; project: CorumProject; requestedType: 'project' }
  /**
   * 已有 project 工作区，用户要以 task 打开 ⇒ **拒绝**，只能按项目模式开启。
   * `project` 字段带上原项目，供 UI 直接转为「按项目模式打开」。
   */
  | { kind: 'mode-conflict'; project: CorumProject; requestedType: 'task' }

/** 创建向导提交入参（completeSetup）。 */
export interface CompleteSetupInput {
  /** 项目名（必填）。 */
  name: string
  /** 空目录绝对路径（必填，即向导来源目录）。 */
  cwd: string
  /** 整队加入的团队 id 列表。 */
  teamIds?: string[]
  /** 单个加入的成员（可带 fromTeam 表示团队部分成员来源）。 */
  members?: Array<{ profileId: string; fromTeam?: string }>
  /** 工程类型（缺省 project；无痕迹工作区按此创建）。 */
  type?: ProjectType
}

/**
 * CorumProjectService — corum 项目服务。
 *
 * 单例（注册在 host 根 ctx），负责：创建/列出/打开项目，返回真实 projectId。
 */
export class CorumProjectService extends TypertRemoteService {
  static inject = ['agents', 'sessions']

  constructor(ctx: Context) {
    super(ctx, 'corumProject')
  }

  /**
   * 创建一个新项目，返回分配了唯一 projectId 的项目实体。
   * projectId 由 name slug 化，冲突时追加 -2/-3 后缀。
   * 项目组默认带入框架预置的 PM 助理（会话统筹 + 人机交互入口）作为第一个成员。
   *
   * **一工作区一条目**（身份由 cwd 决定）：若 `cwd` 已有条目，**恢复它、不再新建**
   * （不新增 slug）。重复 slug 的合并由迁移负责，本方法只保证不再制造新的重复。
   */
  createProject(input: CreateProjectInput): CorumProject {
    const name = input.name.trim()
    if (name === '') throw new Error('dev-agent: project name must not be empty')
    const requestedType = input.type ?? DEFAULT_PROJECT_TYPE
    if (!isProjectType(requestedType)) throw new Error(`dev-agent: invalid project type "${String(input.type)}"`)

    // 一工作区一条目：同 cwd 已有条目 ⇒ 恢复它（不改 type——type 具权威性）。
    const cwd = input.cwd?.trim()
    if (cwd !== undefined && cwd !== '') {
      const existing = findProjectByCwd(cwd)
      if (existing !== undefined) {
        this.ctx.logger.info(`corumProject: 工作区已有条目 "${existing.project.id}"（${cwd}）——恢复，不新建`)
        return this.touchProject(existing.project.id)
      }
    }

    const base = slugifyProjectId(name)
    let id = base
    for (let n = 2; loadProject(id) !== undefined; n += 1) id = `${base}-${n}`
    const now = Date.now()
    // 项目组默认带 PM（框架预置 PM 助理，确保其 profile 存在）。
    ensurePmProfile()
    const group: ProjectGroup = { members: [{ profileId: PM_PROFILE_ID, role: 'pm' }] }
    const project: CorumProject = {
      id,
      name,
      type: requestedType,
      ...(cwd !== undefined && cwd !== '' ? { cwd } : {}),
      ...(input.description !== undefined && input.description.trim() !== '' ? { description: input.description.trim() } : {}),
      group,
      createdAt: now,
      lastOpenedAt: now,
      version: 0,
    }
    saveProject(project)
    // 选定工作区即创建 AGENTS.md（用户定：该文件有则注入、无则不注入；
    // 幂等，不覆盖用户/历史内容）。仅当项目绑定了工作目录。
    if (project.cwd !== undefined && ensureWorkspaceAgentsMd(project.cwd)) {
      this.ctx.logger.info(`corumProject: 已在工作区创建 AGENTS.md (${project.cwd})`)
    }
    // PM 兜底成员是项目组的初始事实，必须进领域事件（持久日志 seq 0 + 实时流）。
    publishDomainEvent(this.ctx, 'corum/group/member-added', { projectId: id, member: group.members[0] })
    this.ctx.logger.info(`corumProject: created "${id}" — ${name}（type=${requestedType}，PM 助理已带入项目组）(${projectDir(id)})`)
    return project
  }

  /** 记录一次「打开项目」（刷新 lastOpenedAt 排序）。 */
  touchProject(id: string): CorumProject {
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    const next = { ...project, lastOpenedAt: Date.now() }
    saveProject(next)
    return next
  }

  // ── TypertRemoteService @Remote 端点（/api/corumProject/*） ──────────

  /** 创建项目。 */
  @Remote('createProject')
  createProjectRemote(name: string, cwd?: string, description?: string, type?: ProjectType): { project: CorumProject } {
    return {
      project: this.createProject({
        name,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(type !== undefined ? { type } : {}),
      }),
    }
  }

  /** 列出所有项目（最近打开在前；available=false = 目录不可用）。 */
  @Remote('listProjects')
  listProjectsRemote(): { projects: CorumProject[]; availability: Record<string, boolean> } {
    const entries = listProjects()
    const availability: Record<string, boolean> = {}
    for (const e of entries) availability[e.project.id] = e.available
    return { projects: entries.map(e => e.project), availability }
  }

  /**
   * 列出某一工作区的会话（可选按工程类型过滤）——「**会话按 type 隔离显示**」的
   * 数据源（`architecture.project.unified-with-type-field` 边界：数据文件统一、
   * 会话按 type 隔离）。
   */
  @Remote('listWorkspaceSessions')
  listWorkspaceSessionsRemote(cwd: string, type?: ProjectType): {
    sessions: Array<{ sessionId: string; cwd: string; profileId: string; type: ProjectType; laneKey: string | null }>
  } {
    const sessions = listSessionsForWorkspace(cwd, isProjectType(type) ? type : undefined)
      .map(({ sessionId, entry }) => ({
        sessionId,
        cwd: entry.cwd,
        profileId: entry.profileId,
        type: entry.type,
        laneKey: entry.laneKey ?? null,
      }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    return { sessions }
  }

  /** 打开项目（刷新 lastOpenedAt；cwd 失联报「目录不可用」）。 */
  @Remote('openProject')
  openProjectRemote(id: string): { project: CorumProject } {
    if (!isValidProjectId(id)) throw new Error(`dev-agent: invalid project id "${id}"`)
    const index = loadProjectIndex(id)
    if (index !== undefined && !projectCwdExists(index.cwd)) {
      throw new Error(`dev-agent: 目录不可用 "${index.cwd ?? ''}"（项目目录被移动或删除——可删除该项目条目，目录恢复后自动接回）`)
    }
    return { project: this.touchProject(id) }
  }

  /**
   * 删除项目条目（历史列表「是否删除该项目」入口）。只删索引目录
   * （$CORUM_HOME/projects/<id>/），绝不碰项目工作区（详字段/事件日志就在
   * 那里；cwd 失联场景下更不能越界删用户目录）。
   */
  @Remote('deleteProject')
  deleteProjectRemote(id: string): { ok: true } {
    if (!isValidProjectId(id)) throw new Error(`dev-agent: invalid project id "${id}"`)
    deleteProject(id)
    this.ctx.logger.info(`corumProject: [${id}] 索引条目已删除（项目工作区未动）`)
    return { ok: true }
  }

  /**
   * 按工作目录打开项目（侧栏「打开项目」→ 原生选目录后的入口）。
   *
   * **判定表门禁**（`architecture.project.type-is-authoritative-and-monotonic`，
   * 核心是三不变式：type 具权威性 / 单调不可降级 / 互斥）：
   *
   * | 工作区现状 | 用户起的口径 | 行为 |
   * | --- | --- | --- |
   * | 无痕迹 | task / project | `wizard`（直接创建） |
   * | 已有 `type:'task'` | project | `upgrade-required`（提醒是否升级） |
   * | 已有 `type:'project'` | task | `mode-conflict`（提示按项目模式开启；**拒绝**按 task 开） |
   * | 已有 type（任一） | 同口径 | `existing`（**恢复原有项目，不再新建**） |
   *
   * ⚠️ **不变式 A**：模式**不由本次选择决定**。已有条目的 type 是权威，本方法的
   * `requestedType` 只用于「与已有 type 比对」进而分流，**绝不改写已存的 type**。
   * 升级（task → project）也**不在本方法内落盘**——要等用户确认后经
   * {@link upgradeProjectType} 显式执行（本方法只报告「需要确认」）。
   *
   * @param cwd - 待打开的工作目录绝对路径。
   * @param requestedType - 用户本次起的口径（缺省 project）。UI 的「任务模式」入口传 `task`。
   */
  @Remote('openProjectByPath')
  openProjectByPathRemote(cwd: string, requestedType?: ProjectType): OpenProjectByPathResult {
    const clean = cwd.trim()
    if (clean === '') throw new Error('dev-agent: path must not be empty')
    const want: ProjectType = isProjectType(requestedType) ? requestedType : DEFAULT_PROJECT_TYPE
    // 一工作区一条目：按**工作区身份**（realpath 归一）查，不用字符串直比——
    // 存量实测 "/a/b/" 与 "/a/b" 同指一个目录（217 条 task 会话里两者并存）。
    const existing = findProjectByCwd(clean)?.project
    if (existing !== undefined) {
      const stored = projectTypeOf(existing)
      const verdict = classifyProjectTypeTransition(stored, want)
      if (verdict === 'same') {
        // 同口径再次打开 ⇒ 恢复原有项目情况，不再新建。
        return { kind: 'existing', project: this.touchProject(existing.id) }
      }
      if (verdict === 'upgrade') {
        // task 工作区 + project 口径 ⇒ 提醒用户是否升级（**不擅自升级**）。
        this.ctx.logger.info(`corumProject: [${existing.id}] task 工作区被以 project 口径打开——需用户确认升级`)
        return { kind: 'upgrade-required', project: existing, requestedType: 'project' }
      }
      // 降级（project → task）⇒ **拒绝**，只提示「这是项目模式，是否按项目模式开启」。
      this.ctx.logger.info(`corumProject: [${existing.id}] 拒绝以 task 模式打开 project 工作区`)
      return { kind: 'mode-conflict', project: existing, requestedType: 'task' }
    }
    let entries: string[]
    try {
      entries = readdirSync(clean)
    } catch {
      throw new Error(`dev-agent: 目录不可读 "${clean}"`)
    }
    // 无痕迹 = 已是条目但没有（目录非空则拒绝收编，避免误把既有代码目录当新项目）。
    if (entries.length > 0) {
      // 统一模型下「已有 task 工程痕迹」也算痕迹：task 模式创建的会话留下了
      // `$CORUM_HOME/sessions/--<cwd>--` 与可能的 `<cwd>/.corum/`。此时以 project
      // 口径打开应**提醒升级**（不变式 B），而不是直接拒绝。
      const trace = this.detectLegacyTaskTrace(clean)
      if (trace !== undefined && want === 'project') {
        this.ctx.logger.info(`corumProject: 目录 "${clean}" 有 task 痕迹（${trace}）——需用户确认升级为 project`)
        return { kind: 'upgrade-required', project: trace, requestedType: 'project' }
      }
      throw new Error(`dev-agent: 目录 "${clean}" 非空且未关联任何项目——请先关联已有项目，或另选空目录创建新项目`)
    }
    return { kind: 'wizard', cwd: clean, suggestedName: basename(clean), requestedType: want }
  }

  /**
   * 侦测目录里的 **task 工程痕迹**（无索引条目但被 task 模式用过）。
   *
   * 存量事实：task 模式此前**根本不建项目条目**（只往伪项目目录写
   * `task-sessions.json`），所以「task 工作区」在索引里查不到——正是判定表
   * 「已有 `type:'task'` 痕迹」那一行的来源。痕迹判据（任一命中即可）：
   *   ① 统一索引里有该工作区的 `type='task'` 会话（迁移后）；
   *   ② 目录里有 `<cwd>/.corum/`（项目数据目录，两种模式共用同一落点）。
   *
   * 命中时**合成一个未落盘的候选条目**（`type:'task'`），仅供 UI 显示「这是 task
   * 工作区，是否升级为 project」——**不写盘**（用户确认后才经
   * {@link upgradeProjectType} 落盘）。
   */
  private detectLegacyTaskTrace(cwd: string): CorumProject | undefined {
    const hasTaskSessions = listSessionsForWorkspace(cwd, 'task').length > 0
    const hasDataDir = projectCwdExists(cwd) && existsSync(join(cwd, PROJECT_DATA_DIR))
    if (!hasTaskSessions && !hasDataDir) return undefined
    const now = Date.now()
    const hint = slugifyProjectId(basename(cwd))
    return {
      // 未落盘候选：id 只是 UI 展示用的建议 slug（真升级时才确保唯一性）。
      id: hint,
      name: basename(cwd),
      type: 'task',
      cwd,
      createdAt: now,
      lastOpenedAt: now,
      version: 0,
    }
  }

  /**
   * 把工作区**升级**为 project（`task → project`，不变式 B 唯一允许的类型变更）。
   *
   * 只做类型翻转 + 细节落盘，**不改数据文件**（统一模型下两模式共用同一套文件，
   * 升级只是「管理方式」变了，没有数据需要搬）。调用方必须先取得用户确认
   * （判定表的 `upgrade-required` 分支）。
   *
   * 幂等：已是 project 时直接返回当前实体（不重复写）。
   */
  @Remote('upgradeProjectType')
  upgradeProjectTypeRemote(id: string): { project: CorumProject } {
    const project = this.requireProject(id)
    const stored = projectTypeOf(project)
    if (stored === 'project') return { project }
    if (!canTransitionProjectType(stored, 'project')) {
      throw new Error(`dev-agent: 不允许把工作区 "${id}" 从 ${stored} 变更为 project`)
    }
    const next = { ...project, type: 'project' as ProjectType, lastOpenedAt: Date.now() }
    saveProject(next)
    this.ctx.logger.info(`corumProject: [${id}] type 升级 ${stored} → project（用户已确认）`)
    return { project: loadProject(id) ?? next }
  }

  /**
   * 创建向导提交（空目录 → 新项目）：创建项目（自动带 PM 兜底成员），
   * 再按选择整队/单个拉成员进项目组。返回最终项目实体（group 已落）。
   */
  @Remote('completeSetup')
  completeSetupRemote(input: CompleteSetupInput): { project: CorumProject } {
    const project = this.createProject({
      name: input.name,
      cwd: input.cwd,
      ...(input.type !== undefined ? { type: input.type } : {}),
    })
    for (const teamId of input.teamIds ?? []) {
      this.addTeamToGroupRemote(project.id, teamId)
    }
    for (const member of input.members ?? []) {
      this.addMemberToGroupRemote(
        project.id,
        member.profileId,
        ...(member.fromTeam !== undefined ? [member.fromTeam] : []),
      )
    }
    const final = loadProject(project.id)
    this.ctx.logger.info(`corumProject: setup complete "${project.id}"（${final?.group?.members.length ?? 0} 成员）`)
    return { project: final ?? project }
  }

  /** 列出项目的完整工作类型表（框架兜底 + 项目自定义）。 */
  @Remote('listWorkTypes')
  listWorkTypesRemote(id: string): { workTypes: WorkType[] } {
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    return { workTypes: resolveWorkTypes(project) }
  }

  /**
   * 给项目新增一个自定义工作类型（泳道）。
   * slug 必须合法且不与现有（含内置）冲突。
   */
  @Remote('addWorkType')
  addWorkTypeRemote(id: string, slug: string, label: string, description?: string): { workTypes: WorkType[] } {
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    const cleanSlug = slug.trim().toLowerCase()
    if (!isValidWorkTypeSlug(cleanSlug)) throw new Error(`dev-agent: invalid work type slug "${slug}"`)
    const cleanLabel = label.trim()
    if (cleanLabel === '') throw new Error('dev-agent: work type label must not be empty')
    const existing = resolveWorkTypes(project)
    if (existing.some(t => t.slug === cleanSlug)) {
      throw new Error(`dev-agent: work type "${cleanSlug}" already exists`)
    }
    const custom: WorkType = {
      slug: cleanSlug,
      label: cleanLabel,
      ...(description !== undefined && description.trim() !== '' ? { description: description.trim() } : {}),
      builtin: false,
    }
    saveProject({ ...project, workTypes: [...(project.workTypes ?? []), custom] })
    this.ctx.logger.info(`corumProject: [${id}] add work type "${cleanSlug}" — ${cleanLabel}`)
    return { workTypes: resolveWorkTypes({ ...project, workTypes: [...(project.workTypes ?? []), custom] }) }
  }

  // ── 项目组成员管理（引用式：拉整个团队 / 团队指定 Agent / 独立 Agent） ──

  /** 列出项目组成员（项目组 = 项目的运行时组织）。 */
  @Remote('listGroupMembers')
  listGroupMembersRemote(id: string): { members: ProjectGroupMember[] } {
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    return { members: project.group?.members ?? [] }
  }

  /**
   * 把一个团队整体拉进项目组（团队所有成员加入，记录 fromTeam 来源）。
   * 已在项目组的成员跳过（去重）。
   */
  @Remote('addTeamToGroup')
  addTeamToGroupRemote(id: string, teamId: string): { group: ProjectGroup } {
    const project = this.requireProject(id)
    const team = loadTeam(teamId)
    if (team === undefined) throw new Error(`dev-agent: team "${teamId}" not found`)
    const members = [...(project.group?.members ?? [])]
    const existing = new Set(members.map(m => m.profileId))
    const addedMembers: ProjectGroupMember[] = []
    for (const profileId of team.memberProfileIds) {
      if (existing.has(profileId)) continue
      const member: ProjectGroupMember = { profileId, role: 'member', fromTeam: teamId }
      members.push(member)
      addedMembers.push(member)
      existing.add(profileId)
    }
    const group: ProjectGroup = { members }
    saveProject({ ...project, group })
    this.ctx.logger.info(`corumProject: [${id}] add team "${teamId}" to group（+${addedMembers.length} 成员）`)
    for (const member of addedMembers) {
      publishDomainEvent(this.ctx, 'corum/group/member-added', { projectId: id, member })
    }
    return { group }
  }

  /**
   * 把单个 Agent 拉进项目组：可来自某团队（记 fromTeam）或无团队的独立 Agent。
   */
  @Remote('addMemberToGroup')
  addMemberToGroupRemote(id: string, profileId: string, fromTeam?: string, role?: 'pm' | 'member'): { group: ProjectGroup } {
    const project = this.requireProject(id)
    if (!isValidProfileId(profileId)) throw new Error(`dev-agent: invalid profile id "${profileId}"`)
    if (loadProfile(profileId) === undefined) throw new Error(`dev-agent: profile "${profileId}" not found`)
    const members = [...(project.group?.members ?? [])]
    if (members.some(m => m.profileId === profileId)) {
      throw new Error(`dev-agent: profile "${profileId}" 已在项目组`)
    }
    if (fromTeam !== undefined && loadTeam(fromTeam) === undefined) {
      throw new Error(`dev-agent: team "${fromTeam}" not found`)
    }
    members.push({
      profileId,
      role: role ?? 'member',
      ...(fromTeam !== undefined ? { fromTeam } : {}),
    })
    const member: ProjectGroupMember = members[members.length - 1]
    const group: ProjectGroup = { members }
    saveProject({ ...project, group })
    this.ctx.logger.info(`corumProject: [${id}] add member "${profileId}"（role=${role ?? 'member'}${fromTeam !== undefined ? ` from ${fromTeam}` : ''}）`)
    publishDomainEvent(this.ctx, 'corum/group/member-added', { projectId: id, member })
    return { group }
  }

  /** 从项目组移除一个成员（PM 不可移除——项目组必须始终有一个 PM）。 */
  @Remote('removeGroupMember')
  removeGroupMemberRemote(id: string, profileId: string): { group: ProjectGroup } {
    const project = this.requireProject(id)
    const members = project.group?.members ?? []
    const target = members.find(m => m.profileId === profileId)
    if (target === undefined) throw new Error(`dev-agent: profile "${profileId}" 不在项目组`)
    if (target.role === 'pm' && members.filter(m => m.role === 'pm').length === 1) {
      throw new Error('dev-agent: 项目组必须保留至少一个 PM，不可移除唯一的 PM')
    }
    const next = members.filter(m => m.profileId !== profileId)
    const group: ProjectGroup = { members: next }
    saveProject({ ...project, group })
    this.ctx.logger.info(`corumProject: [${id}] remove member "${profileId}"`)
    publishDomainEvent(this.ctx, 'corum/group/member-removed', { projectId: id, profileId })
    return { group }
  }

  /** 取项目（不存在则报错）。 */
  private requireProject(id: string): CorumProject {
    if (!isValidProjectId(id)) throw new Error(`dev-agent: invalid project id "${id}"`)
    const project = loadProject(id)
    if (project === undefined) throw new Error(`dev-agent: project "${id}" not found`)
    return project
  }
}

export default CorumProjectService
