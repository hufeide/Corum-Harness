/** Shell chrome and General-nav dictionaries (fork of official
 *  ui-settings-general/src/client/locales.ts); feature rows own their copy.
 *
 * 1:1 复刻 design.pen 设置中心文案：
 * - trigger / title / close / general.nav（原有）
 * - search: 搜索设置…
 * - scope.global: 全局 / scope.project: 本项目
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'general.nav': '通用',
  'search': '搜索设置…',
  'scope.global': '全局',
  'scope.project': '本项目',
  // 导航分组标题（SettingsShell 的 NAV_GROUPS）
  'group.general': '通用',
  'group.agent': 'AGENT',
  'group.data': '数据与隐私',
  'group.extensions': '扩展',
  'group.advanced': '高级',
  // section 导航标签（SECTION_DEFS 的 label key）
  'nav.appearance': '外观',
  'nav.notifications': '通知',
  'nav.shortcuts': '快捷键',
  'nav.permissions': '权限',
  'nav.rules': '规则与指令',
  'nav.memory': '记忆',
  'nav.terminal': '终端',
  'nav.hooks': 'Hooks 与自动化',
  'nav.agentLoop': '高级 Agent Loop',
  'nav.agentPresets': 'Agent 预设',
  'nav.subagent': '子 Agent',
  'nav.account': '账户与用量',
  'nav.privacy': '隐私',
  'nav.data': '数据管理',
  'nav.mcp': 'MCP 与集成',
  'nav.skills': '技能',
  'nav.aiPolish': 'AI 润色',
  'nav.advanced': '高级',
  'nav.profiles': '配置档案',
  'nav.extensions': '插件管理',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'general.nav': 'General',
  'search': 'Search settings…',
  'scope.global': 'Global',
  'scope.project': 'Project',
  'group.general': 'General',
  'group.agent': 'AGENT',
  'group.data': 'Data & Privacy',
  'group.extensions': 'Extensions',
  'group.advanced': 'Advanced',
  'nav.appearance': 'Appearance',
  'nav.notifications': 'Notifications',
  'nav.shortcuts': 'Shortcuts',
  'nav.permissions': 'Permissions',
  'nav.rules': 'Rules & Instructions',
  'nav.memory': 'Memory',
  'nav.terminal': 'Terminal',
  'nav.hooks': 'Hooks & Automation',
  'nav.agentLoop': 'Advanced Agent Loop',
  'nav.agentPresets': 'Agent Presets',
  'nav.subagent': 'Subagents',
  'nav.account': 'Account & Usage',
  'nav.privacy': 'Privacy',
  'nav.data': 'Data Management',
  'nav.mcp': 'MCP & Integrations',
  'nav.skills': 'Skills',
  'nav.aiPolish': 'AI Polish',
  'nav.advanced': 'Advanced',
  'nav.profiles': 'Profiles',
  'nav.extensions': 'Plugins',
} satisfies Record<SettingsKey, string>
