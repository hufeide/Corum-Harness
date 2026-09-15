/**
 * corumProject 跨域 RPC 契约（/api/corumProject/*）。
 *
 * 给 client 半消费方 type-only 引用：方法名常量替代裸字符串，args/result 类型
 * 与服务实现（project-service.ts 的 @Remote 端点）同源。与 contract/agent.ts
 * 同为纯类型 + 字符串常量，无运行时副作用。
 *
 * 注意：openProject 的 wire 参数名是 **id**（不是 projectId）——消费方传错键名
 * 运行时才炸（2026-08 曾实踩）；契约表以服务端实现为准。
 * @module @corum/corum-agent/contract
 */

import type { CorumProject, ProjectGroup, ProjectGroupMember, ProjectType, WorkType } from '../project.ts'
import type { CompleteSetupInput, OpenProjectByPathResult } from '../project-service.ts'

// ── 复用的 wire 投影类型（与 project.ts / project-service.ts 同源 re-export） ──

export type { CorumProject, ProjectGroup, ProjectGroupMember, ProjectType, WorkType }
export type { CompleteSetupInput, OpenProjectByPathResult }

/**
 * corumProject 被消费方实际调用的 @Remote 方法名常量（wire 值与装饰器字符串一致）。
 */
export const CORUM_PROJECT_METHODS = {
  /** 创建项目（自动带 PM 兜底成员进项目组）。 */
  createProject: 'createProject',
  /** 列出所有项目（最近打开在前）。 */
  listProjects: 'listProjects',
  /** 打开项目（刷新 lastOpenedAt）。参数名是 id。 */
  openProject: 'openProject',
  /** 按工作目录打开项目（判定表门禁：existing / wizard / upgrade-required / mode-conflict）。 */
  openProjectByPath: 'openProjectByPath',
  /** 把工作区**升级**为 project（`task → project`，不变式 B 唯一允许的类型变更）。 */
  upgradeProjectType: 'upgradeProjectType',
  /** 列出某工作区的会话（可选按工程类型过滤）——会话按 type 隔离显示的数据源。 */
  listWorkspaceSessions: 'listWorkspaceSessions',
  /** 创建向导提交（空目录 → 新项目 + 拉成员进项目组）。 */
  completeSetup: 'completeSetup',
  /** 列出项目的完整工作类型表（框架兜底 + 项目自定义）。 */
  listWorkTypes: 'listWorkTypes',
  /** 给项目新增一个自定义工作类型（泳道）。 */
  addWorkType: 'addWorkType',
  /** 列出项目组成员。 */
  listGroupMembers: 'listGroupMembers',
  /** 把一个团队整体拉进项目组。 */
  addTeamToGroup: 'addTeamToGroup',
  /** 把单个 Agent 拉进项目组。 */
  addMemberToGroup: 'addMemberToGroup',
  /** 从项目组移除一个成员（PM 不可移除）。 */
  removeGroupMember: 'removeGroupMember',
  /** 删除项目索引条目（只删 $CORUM_HOME/projects/<id>/，不碰项目工作区）。 */
  deleteProject: 'deleteProject',
} as const

/** corumProject 已契约化的方法名（CORUM_PROJECT_METHODS 的值联合）。 */
export type CorumProjectMethod = (typeof CORUM_PROJECT_METHODS)[keyof typeof CORUM_PROJECT_METHODS]

// ── 每端点的 args（命名参数对象）/ result 类型 ─────────────────────────────

/** createProject 入参：name 必填，cwd/description 可选。 */
export type CreateProjectArgs = {
  name: string
  cwd?: string
  description?: string
}
/** createProject 返回：新建项目实体（group 已含 PM 兜底成员）。 */
export interface CreateProjectResult {
  project: CorumProject
}

/** listProjects 返回：全部项目（最近打开在前）+ 每项 cwd 存活标记
 * （available=false = 目录被移动/改名，「目录不可用」）。 */
export interface ListProjectsResult {
  projects: CorumProject[]
  /** projectId → cwd 是否存活（缺省视为 true，兼容旧 host）。 */
  availability?: Record<string, boolean>
}

/** openProject 入参。**参数名是 id**（wire 契约，见文件头注释）。 */
export type OpenProjectArgs = {
  id: string
}
/** openProject 返回：打开后的项目实体（lastOpenedAt 已刷新）。 */
export interface OpenProjectResult {
  project: CorumProject
}

/** openProjectByPath 入参：待打开的工作目录绝对路径 + 用户本次起的口径。
 *  `requestedType` 缺省 `project`；它**只触发门禁校验**，不改写工作区已存的 type
 *  （不变式 A：type 具权威性）。 */
export type OpenProjectByPathArgs = {
  cwd: string
  requestedType?: ProjectType
}
/** openProjectByPath 返回（判定表四种分流）：
 *  `existing`（同口径恢复原项目）/ `wizard`（无痕迹，直接创建）/
 *  `upgrade-required`（task 工作区 + project 口径 ⇒ 需用户确认升级）/
 *  `mode-conflict`（project 工作区 + task 口径 ⇒ 拒绝，只能按项目模式开）。 */
export type OpenProjectByPathRemoteResult = OpenProjectByPathResult

/** upgradeProjectType 入参：要升级的工作区条目 id。 */
export type UpgradeProjectTypeArgs = {
  id: string
}
/** upgradeProjectType 返回：升级后的项目实体（type 已为 project）。 */
export interface UpgradeProjectTypeResult {
  project: CorumProject
}

/** completeSetup 入参：创建向导提交。 */
export type CompleteSetupArgs = {
  input: CompleteSetupInput
}
/** completeSetup 返回：最终项目实体（group 已落）。 */
export interface CompleteSetupResult {
  project: CorumProject
}

/** listWorkTypes 入参。 */
export type ListWorkTypesArgs = {
  id: string
}
/** listWorkTypes 返回：完整工作类型表。 */
export interface ListWorkTypesResult {
  workTypes: WorkType[]
}

/** addWorkType 入参：slug 必须合法且不冲突。 */
export type AddWorkTypeArgs = {
  id: string
  slug: string
  label: string
  description?: string
}
/** addWorkType 返回：新增后的完整工作类型表。 */
export interface AddWorkTypeResult {
  workTypes: WorkType[]
}

/** listGroupMembers 入参。 */
export type ListGroupMembersArgs = {
  id: string
}
/** listGroupMembers 返回：项目组成员表。 */
export interface ListGroupMembersResult {
  members: ProjectGroupMember[]
}

/** addTeamToGroup 入参。 */
export type AddTeamToGroupArgs = {
  id: string
  teamId: string
}
/** addTeamToGroup 返回：合并后的项目组。 */
export interface AddTeamToGroupResult {
  group: ProjectGroup
}

/** addMemberToGroup 入参：fromTeam 标记团队来源，role 缺省 member。 */
export type AddMemberToGroupArgs = {
  id: string
  profileId: string
  fromTeam?: string
  role?: 'pm' | 'member'
}
/** addMemberToGroup 返回：合并后的项目组。 */
export interface AddMemberToGroupResult {
  group: ProjectGroup
}

/** removeGroupMember 入参。 */
export type RemoveGroupMemberArgs = {
  id: string
  profileId: string
}
/** removeGroupMember 返回：移除后的项目组。 */
export interface RemoveGroupMemberResult {
  group: ProjectGroup
}

/** deleteProject 入参。 */
export type DeleteProjectArgs = {
  id: string
}
/** deleteProject 返回：固定 ok。 */
export interface DeleteProjectResult {
  ok: true
}

/** listWorkspaceSessions 入参：工作区 cwd + 可选工程类型过滤。 */
export type ListWorkspaceSessionsArgs = {
  cwd: string
  type?: ProjectType
}
/** listWorkspaceSessions 返回：该工作区的会话（可按 type 过滤）。 */
export interface ListWorkspaceSessionsResult {
  sessions: Array<{ sessionId: string; cwd: string; profileId: string; type: ProjectType; laneKey: string | null }>
}

/**
 * corumProject 端点描述表：方法名 → 命名参数对象 / 返回体。
 * `{}` 表示该端点无参数。
 */
export interface CorumProjectEndpointTable {
  [CORUM_PROJECT_METHODS.createProject]: { args: CreateProjectArgs; result: CreateProjectResult }
  [CORUM_PROJECT_METHODS.listProjects]: { args: {}; result: ListProjectsResult }
  [CORUM_PROJECT_METHODS.openProject]: { args: OpenProjectArgs; result: OpenProjectResult }
  [CORUM_PROJECT_METHODS.openProjectByPath]: { args: OpenProjectByPathArgs; result: OpenProjectByPathRemoteResult }
  [CORUM_PROJECT_METHODS.upgradeProjectType]: { args: UpgradeProjectTypeArgs; result: UpgradeProjectTypeResult }
  [CORUM_PROJECT_METHODS.listWorkspaceSessions]: { args: ListWorkspaceSessionsArgs; result: ListWorkspaceSessionsResult }
  [CORUM_PROJECT_METHODS.completeSetup]: { args: CompleteSetupArgs; result: CompleteSetupResult }
  [CORUM_PROJECT_METHODS.listWorkTypes]: { args: ListWorkTypesArgs; result: ListWorkTypesResult }
  [CORUM_PROJECT_METHODS.addWorkType]: { args: AddWorkTypeArgs; result: AddWorkTypeResult }
  [CORUM_PROJECT_METHODS.listGroupMembers]: { args: ListGroupMembersArgs; result: ListGroupMembersResult }
  [CORUM_PROJECT_METHODS.addTeamToGroup]: { args: AddTeamToGroupArgs; result: AddTeamToGroupResult }
  [CORUM_PROJECT_METHODS.addMemberToGroup]: { args: AddMemberToGroupArgs; result: AddMemberToGroupResult }
  [CORUM_PROJECT_METHODS.removeGroupMember]: { args: RemoveGroupMemberArgs; result: RemoveGroupMemberResult }
  [CORUM_PROJECT_METHODS.deleteProject]: { args: DeleteProjectArgs; result: DeleteProjectResult }
}
