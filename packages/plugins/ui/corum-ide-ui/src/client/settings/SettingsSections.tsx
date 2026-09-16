/**
 * Settings sections — 聚合入口（重构 2：19 个 section 全拆独立文件后，本文件瘦身
 * 为共享面 re-export + SECTION_DEFS 聚合注册）。
 *
 * - 共享面（CorumRpcContext / CorumSettingsContext / useCorumSettings /
 *   SectionNavContext / useSectionNav / GlassButton / InfoCard）已抽到
 *   `./shared.tsx`，本文件 re-export 保持既有 import 路径（index.tsx /
 *   SettingsShell.tsx / SettingsGeneralSection.tsx 零破坏）。
 * - 19 个 section 组件各自住在 `./sections/Settings*Section.tsx`。
 * - `SECTION_DEFS` 聚合 import 19 个 section + 按 SectionDef.navGroup 自声明分组
 *   （归属分组由 section 自己声明；缺省归 'extensions'）。
 */
import type { ReactNode } from 'react'
import type { SettingsKey } from '../settings-locales.ts'
import { AppearanceSection } from './sections/SettingsAppearanceSection.tsx'
import { EditorSection } from './sections/SettingsEditorSection.tsx'
import { NotificationsSection } from './sections/SettingsNotificationsSection.tsx'
import { ShortcutsSection } from './sections/SettingsShortcutsSection.tsx'
import { TerminalSection } from './sections/SettingsTerminalSection.tsx'
import { AgentSettingsSection } from './sections/SettingsAgentSettingsSection.tsx'
import { PermissionsSection } from './sections/SettingsPermissionsSection.tsx'
import { MemorySection } from './sections/SettingsMemorySection.tsx'
import { PrivacySection } from './sections/SettingsPrivacySection.tsx'
import { DataSection } from './sections/SettingsDataSection.tsx'
import { HooksSection } from './sections/SettingsHooksSection.tsx'
import { AgentPresetsSection } from './sections/SettingsAgentPresetsSection.tsx'
import { AccountSection } from './sections/SettingsAccountSection.tsx'
import { McpSection } from './sections/SettingsMcpSection.tsx'
import { SkillsSection } from './sections/SettingsSkillsSection.tsx'
import { PolishSection } from './sections/SettingsPolishSection.tsx'
import { AdvancedSection } from './sections/SettingsAdvancedSection.tsx'
import { ProfilesSection } from './sections/SettingsProfilesSection.tsx'
import { ExtensionsSection } from './sections/SettingsExtensionsSection.tsx'

// 共享面 re-export（保持 SettingsShell.tsx / SettingsGeneralSection.tsx /
// index.tsx 的既有 import 路径零破坏）。
export {
  CorumRpcContext,
  CorumSettingsContext,
  NotificationPrefsContext,
  SectionNavContext,
  useCorumRpc,
  useCorumSettings,
  useNotificationPrefs,
  useSectionNav,
  GlassButton,
  InfoCard,
} from './shared.tsx'
export type { CorumSettingsFace, NotificationPrefsFace, NotificationPrefsService, SectionActions } from './shared.tsx'

/* ── 导出 section 组件映射 ──────────────────────────────────────────── */

/** 设置中心导航分组（5 组，现状保持）。 */
export type SettingsNavGroup = 'general' | 'agent' | 'data' | 'extensions' | 'advanced'

export interface SectionDef {
  id: string
  order: number
  /**
   * 导航标签的 **locale key**（不是显示文本本身）。
   *
   * 为什么存 key 而非字符串/预绑定 thunk：导航行由 `settings.section` 槽投影，
   * 而该槽的 `label` 支持 `SlotLabel = string | (() => string)`——**thunk 每次读取
   * 时求值**（`@deepseek-ai/dsh-client-ui-slots` 的 `resolveSlotLabel`），因此
   * 注册期给的 thunk 会跟随当前语言，**无需重新注册**。官方 `ui-settings-general`
   * 的 General 条目就是这么写的（`label: () => t('general.nav')`）。
   * 但 `SECTION_DEFS` 是**模块级常量**，拿不到注册期的 `t`（它在 `index.tsx` 的
   * effect 里经 `ctx.locale.bind(NS)` 得到）⇒ 此处只声明 key，由注册处绑成
   * `() => t(def.label)`。
   */
  label: SettingsKey
  /** 归属分组（自声明）；缺省归 'extensions'（扩展）。 */
  navGroup?: SettingsNavGroup
  /**
   * section 组件；多数无 props。
   *
   * 声明了**子槽**的 section 会额外收到渲染器：
   * - `extensions`（插件管理）收 `renderTabSlot`（`settings.plugins.tab`）
   * - `data`（数据管理）收 `renderSlot`（`settings.data.item`）
   *
   * 两者合成一个可选 props 形 —— 组件各自只取自己需要的那个。
   */
  Component: (props?: {
    renderTabSlot?: () => ReactNode
    renderSlot?: (key: string, owner: object, opts?: { only?: string }) => ReactNode
  }) => ReactNode}

/**
 * 所有 section 定义（用于 index.tsx 批量注册）。
 * 归属分组由 section 自声明 `navGroup`，缺省归 'extensions'。
 * 「子 Agent」迁归 AGENT；「MCP/技能/插件管理」归扩展；「插件」独立入口已去掉
 * （ExtensionsSection「插件管理」承接）。
 */
export const SECTION_DEFS: SectionDef[] = [
  { id: 'appearance', order: 10, label: 'nav.appearance', navGroup: 'general', Component: AppearanceSection },
  // ➕ M3 新建：编辑器分区（用户裁定 #1「要单独有一个编辑器的设置页面」；设计稿与本文件均为新增）。
  { id: 'editor', order: 15, label: 'nav.editor', navGroup: 'general', Component: EditorSection },
  { id: 'notifications', order: 20, label: 'nav.notifications', navGroup: 'general', Component: NotificationsSection },
  { id: 'shortcuts', order: 30, label: 'nav.shortcuts', navGroup: 'general', Component: ShortcutsSection },
  { id: 'permissions', order: 65, label: 'nav.permissions', navGroup: 'agent', Component: PermissionsSection },
  // ➖ rules（规则与指令）分区已按用户裁定移除（2026-09-16）。
  //   依据：C1「自定义 Agent 预设已覆盖这个能力 …… 我的设计理念就是以 Agent 为单位
  //   进行管控」+ B4「移除系统提示词前缀」⇒ 全局提示词注入不提供用户可写出口，
  //   「全局自定义指令」与「人格 Personality」两个入口一并取消（PRD §4.1 / §6.4 / §11 C1）。
  //   ⚠️ 不要恢复：本分区在设计与正确性上都已被 Agent 预设取代。
  { id: 'memory', order: 60, label: 'nav.memory', navGroup: 'agent', Component: MemorySection },
  { id: 'terminal', order: 18, label: 'nav.terminal', navGroup: 'general', Component: TerminalSection },
  { id: 'hooks', order: 90, label: 'nav.hooks', navGroup: 'agent', Component: HooksSection },
  // ✏️ M2 重构：原 `agent-loop`（「高级 Agent Loop」）改名并扩容为 `agent-settings`（「智能体设置」），
  //    同时**并入**原 `subagent`（「子 Agent」）分区 —— 用户 2026-09-16 第二批裁定
  //    「子 Agent 并入智能体设置」⇒ 导航由 24 项收敛为 23 项。
  //    ⚠️ 顺带移除了原分区里的「系统提示词前缀」（用户裁定 B4/C1：以 Agent 为单位管控，
  //    全局提示词入口会造成污染）与两个无真源的自造项（重试次数 / 重试间隔）。
  { id: 'agent-settings', order: 55, label: 'nav.agentSettings', navGroup: 'agent', Component: AgentSettingsSection },
  { id: 'agent-presets', order: 110, label: 'nav.agentPresets', navGroup: 'agent', Component: AgentPresetsSection },
  { id: 'account', order: 120, label: 'nav.account', navGroup: 'data', Component: AccountSection },
  { id: 'privacy', order: 130, label: 'nav.privacy', navGroup: 'data', Component: PrivacySection },
  { id: 'data', order: 140, label: 'nav.data', navGroup: 'data', Component: DataSection },
  { id: 'mcp', order: 150, label: 'nav.mcp', navGroup: 'extensions', Component: McpSection },
  { id: 'skills', order: 160, label: 'nav.skills', navGroup: 'extensions', Component: SkillsSection },
  // fork（corum）：AI 润色配置（2026-09-09 重建；导航 id 沿用历史值 ai-polish）。
  { id: 'ai-polish', order: 165, label: 'nav.aiPolish', navGroup: 'extensions', Component: PolishSection },
  { id: 'advanced', order: 170, label: 'nav.advanced', navGroup: 'advanced', Component: AdvancedSection },
  { id: 'profiles', order: 180, label: 'nav.profiles', navGroup: 'advanced', Component: ProfilesSection },
  // 扩展组次序按设计稿：插件管理 → MCP 与集成 → 技能 → AI 润色 → Ollama(195) → 本地文生图(197)。
  { id: 'extensions', order: 145, label: 'nav.extensions', navGroup: 'extensions', Component: ExtensionsSection },
]

/**
 * section id → 归属分组（SettingsShell 分组投影的数据源；重构 2 决策 4：
 * 归属由 section 自声明，缺省归 'extensions'）。
 *
 * - 19 个壳自有 section：从 SECTION_DEFS 的 navGroup 自声明派生。
 * - `general`：由 index.tsx 单独注册（非 SECTION_DEFS），恒归 'general'。
 * - `models`：跨 bundle section（@corum/corum-ui-settings-models 注册），
 *   按 PLAN 映射表固定归 'agent'（现状同）。
 * - 其余跨 bundle section（artgen / ollama 等）未在此表 → 缺省归 'extensions'。
 */
export const NAV_GROUP_BY_ID: Record<string, SettingsNavGroup> = {
  general: 'general',
  ...Object.fromEntries(SECTION_DEFS.map(d => [d.id, d.navGroup ?? 'extensions'])),
  models: 'agent',
}
