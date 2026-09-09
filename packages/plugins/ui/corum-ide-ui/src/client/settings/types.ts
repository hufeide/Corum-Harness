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
/** MCP 绑定弹窗的 host 服务投影（mcpManager/listServers 返回项）。 */
export interface McpServerSummaryWire {
  name: string
  description?: string
  transport: string
  endpoint: string
  disabled?: boolean
}
