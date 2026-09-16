/**
 * 界面字体真源（PRD v2 §4.3.2 AP3：整个软件 UI 使用的字族）。
 *
 * ## 作用范围
 * 全仓 **194 处** UI 字族栈已改为 `var(--corum-ui-font-family, <原栈>)`
 * （见 `scripts/migrate-ui-scale.py --family`）。本模块把所选字族写到**根元素**。
 *
 * ⚠️ **代码字族（mono/Menlo/Consolas，64 处）不属本面**，未被改动 ——
 * 编辑器与终端是各自的分区（用户 `#1`/`#9`：四个「面」相互独立）。
 *
 * ## ⭐ 本面特有风险：字体加载与回退
 *
 * 用户可能选一个**本机并不存在**的字族。因此本模块**从不单独写入字族名**，
 * 而是写入 **`所选字族, <原栈>`** —— 这样第一个名字失效时，浏览器会沿栈继续回退，
 * **不会渲染成方框**。
 *
 * 这也是为什么 194 处声明**保留整栈作为 fallback**：单靠变量本身无法保证回退链，
 * 必须「值里带候选」。
 *
 * ## 与其它三个「面」的关系（PRD §4.3.1）
 * | 面 | 真源 |
 * |---|---|
 * | **界面字体**（本模块）/ 界面字号 | `--corum-ui-font-family` / `--corum-ui-font-scale` |
 * | 界面密度 | `--corum-density-scale` |
 * | 会话正文字号 | `ui-theme.fontSize`（官方）|
 * | 终端 / 编辑器字族与字号 | 各自分区（未上线）|
 *
 * ## 存放位置
 * 沿用 `corum.*` localStorage 先例（同强调色 / 字号 / 密度）；消费方与 Shell 同在一个 bundle。
 *
 * @module corum-ide-ui/client/ui-font-family
 */

/** 持久化键。 */
const UI_FONT_FAMILY_KEY = 'corum.appearance.uiFontFamily'

/** 承载所选字族的根级 CSS 变量（必须与 194 处声明一致）。 */
export const UI_FONT_FAMILY_VAR = '--corum-ui-font-family'

/**
 * 无显式选择时的默认 UI 字族栈。
 *
 * ⚠️ 必须与 `theme.css` 里被替换掉的原栈**逐字一致**，
 * 这样「未选择」与「改造前」在渲染上完全等价。
 */
export const UI_FONT_FAMILY_DEFAULT = "'Inter', -apple-system, 'PingFang SC', 'SF Pro Text', system-ui, sans-serif"

/** 可选字族（label 为展示名，stack 为**完整栈**，首位是目标字族）。 */
export const UI_FONT_FAMILY_OPTIONS: readonly { id: string; label: string; stack: string }[] = [
  { id: 'default', label: 'Inter（默认）', stack: UI_FONT_FAMILY_DEFAULT },
  { id: 'system', label: '系统默认', stack: "-apple-system, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif" },
  { id: 'pingfang', label: '苹方', stack: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif" },
  { id: 'yahei', label: '微软雅黑', stack: "'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif" },
]

/** 默认档 id。 */
export const UI_FONT_FAMILY_DEFAULT_ID = 'default'

/**
 * 读持久化的字族档 id（异常 / 未知一律回落默认）。
 * @returns 生效的字族档 id。
 */
export function readUiFontFamilyId(): string {
  if (typeof localStorage === 'undefined') return UI_FONT_FAMILY_DEFAULT_ID
  try {
    const raw = localStorage.getItem(UI_FONT_FAMILY_KEY)
    if (raw === null) return UI_FONT_FAMILY_DEFAULT_ID
    return UI_FONT_FAMILY_OPTIONS.some(o => o.id === raw) ? raw : UI_FONT_FAMILY_DEFAULT_ID
  } catch {
    return UI_FONT_FAMILY_DEFAULT_ID
  }
}

/** 订阅者集合。 */
const listeners = new Set<() => void>()

/** 内存镜像。 */
let currentId: string | null = null

/**
 * 取当前字族档 id。
 * @returns 生效的字族档 id。
 */
export function getUiFontFamilyId(): string {
  if (currentId === null) currentId = readUiFontFamilyId()
  return currentId
}

/**
 * 把当前字族栈写到根元素。
 *
 * 默认档时**移除**变量（回落 194 处声明自带的原栈）⇒ 与改造前逐像素一致。
 *
 * @param id - 字族档 id；省略则用当前值。
 */
export function applyUiFontFamily(id: string = getUiFontFamilyId()): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const opt = UI_FONT_FAMILY_OPTIONS.find(o => o.id === id) ?? UI_FONT_FAMILY_OPTIONS[0]
  if (opt.id === UI_FONT_FAMILY_DEFAULT_ID) {
    root.style.removeProperty(UI_FONT_FAMILY_VAR)
    return
  }
  // ⚠️ 写入**完整栈**（不是单个字族名）—— 保证本机缺字时能沿栈回退。
  root.style.setProperty(UI_FONT_FAMILY_VAR, opt.stack)
}

/**
 * 设置字族档：持久化 + 写变量 + 通知订阅者。
 * @param id - 目标档 id；未知值回落默认。
 */
export function setUiFontFamily(id: string): void {
  const next = UI_FONT_FAMILY_OPTIONS.some(o => o.id === id) ? id : UI_FONT_FAMILY_DEFAULT_ID
  if (next === getUiFontFamilyId()) return
  currentId = next
  try {
    localStorage.setItem(UI_FONT_FAMILY_KEY, next)
  } catch { /* 容量满 / 隐私模式：仅本次会话生效 */ }
  applyUiFontFamily(next)
  for (const fn of listeners) fn()
}

/**
 * 订阅字族变更。
 * @param fn - 变更回调。
 * @returns 取消订阅。
 */
export function subscribeUiFontFamily(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
