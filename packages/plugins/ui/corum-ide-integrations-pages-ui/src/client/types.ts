/**
 * SkillsPage 消费的 host 服务投影类型（自 @corum/corum-ide-ui 的
 * `settings/types.ts` 迁入本包，PR6）。
 *
 * 为什么复制而不是跨包 import：dsh 的 client bundle 会把 `@corum/*` 源码内联进
 * 每个消费方 bundle，跨包 import 会把整个设置壳包拉进集成中心的 bundle 图。
 * 这些类型与 `corum-skill-manager` 的 host 侧投影同形（字段名与可空性逐字一致），
 * 改动时两处需同步。
 *
 * @module corum-ide-integrations-pages-ui/client/types
 */

/** 技能库里的一个技能（skillManager/listAll 返回项）。 */
export interface SkillInfo {
  name: string
  description: string
  path: string
  currentVersion?: string
  versionCount: number
  createdAt?: string
}

/** 技能的一个版本快照（skillManager/getSkillHistory 返回项）。 */
export interface SkillVersion { id: string; date: string; label: string }

/** 某个 Agent 预设对某技能的绑定（名称 + pin 的版本）。 */
export interface SkillBinding { name: string; versionId: string }

/** Agent 预设的摘要投影（corumAgent/listProfiles 返回项；此处只取绑定用字段）。 */
export interface ProfileSummary { id: string; nickname?: string; skills: SkillBinding[] }

/** 「扫描目录」识别到的一个技能（skillManager/scanDirectory 返回项）。 */
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
