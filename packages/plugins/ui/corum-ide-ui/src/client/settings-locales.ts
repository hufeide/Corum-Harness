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
} satisfies Record<SettingsKey, string>
