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
  'search': '搜索设置…',
  'scope.global': '全局',
  'scope.project': '本项目',
  // 导航分组标题（SettingsShell 的 NAV_GROUPS）
  'group.general': '通用',
  'group.agent': '智能体',
  'group.memory': '记忆',
  'group.data': '数据与隐私',
  'group.extensions': '扩展',
  'group.advanced': '高级',
  // section 导航标签（SECTION_DEFS 的 label key）
  'nav.appearance': '外观',
  'nav.editor': '编辑器',
  'nav.notifications': '通知',
  'nav.shortcuts': '快捷键',
  'nav.permissions': '权限',
  'nav.memory': '记忆',
  'nav.terminal': '终端',
  'nav.hooks': 'Hooks 与自动化',
  'nav.agentSettings': '智能体设置',
  'nav.agentPresets': 'Agent 预设',
  'nav.account': '账户与用量',
  'nav.privacy': '隐私',
  'nav.data': '数据管理',
  'nav.mcp': 'MCP 与集成',
  'nav.skills': '技能',
  'nav.aiPolish': 'AI 润色',
  'nav.advanced': '高级',
  'nav.extensions': '插件管理',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'search': 'Search settings…',
  'scope.global': 'Global',
  'scope.project': 'Project',
  'group.general': 'General',
  'group.agent': 'Agents',
  'group.memory': 'Memory',
  'group.data': 'Data & Privacy',
  'group.extensions': 'Extensions',
  'group.advanced': 'Advanced',
  'nav.appearance': 'Appearance',
  'nav.editor': 'Editor',
  'nav.notifications': 'Notifications',
  'nav.shortcuts': 'Shortcuts',
  'nav.permissions': 'Permissions',
  'nav.memory': 'Memory',
  'nav.terminal': 'Terminal',
  'nav.hooks': 'Hooks & Automation',
  'nav.agentSettings': 'Agent Settings',
  'nav.agentPresets': 'Agent Presets',
  'nav.account': 'Account & Usage',
  'nav.privacy': 'Privacy',
  'nav.data': 'Data Management',
  'nav.mcp': 'MCP & Integrations',
  'nav.skills': 'Skills',
  'nav.aiPolish': 'AI Polish',
  'nav.advanced': 'Advanced',
  'nav.extensions': 'Plugins',
} satisfies Record<SettingsKey, string>
