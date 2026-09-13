/**
 * Settings sections 跨文件共享类型（重构 2 拆文件后，多个 section 文件共用的
 * skill / MCP 投影类型——原先散落在 SettingsSections.tsx 各段）。
 */
export interface SkillInfo {
  name: string
  description: string
  path: string
  currentVersion?: string
  versionCount: number
  createdAt?: string
}
export interface SkillVersion { id: string; date: string; label: string }
export interface SkillBinding { name: string; versionId: string }
export interface ProfileSummary { id: string; nickname?: string; skills: SkillBinding[] }
export interface ScannedSkill { name: string; description: string; sourcePath: string }
/** 绑定某 skill 的 Agent 投影（详情页「绑定关系」列表用）。 */
export interface SkillAgentBind { agentId: string; agentName: string; versionId: string }
/** 「导入内置技能」的结构化摘要（host 侧 skillManager/importBuiltinSkills 返回）。 */
export interface BuiltinSkillImportResult {
  ok: boolean
  error?: string
  /** 随包内置技能目录（排查用）。 */
  shippedRoot?: string
  /** 本次新装上的技能名。 */
  installed: string[]
  /** 因同名已存在而原样保留（不覆盖）的技能名。 */
  skipped: string[]
  /** 因用户删除过而不复活的技能名。 */
  tombstoned: string[]
}
/** MCP 绑定弹窗的 host 服务投影（mcpManager/listServers 返回项）。 */
export interface McpServerSummaryWire {
  name: string
  description?: string
  transport: string
  endpoint: string
  disabled?: boolean
}
