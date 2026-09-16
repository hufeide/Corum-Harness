/**
 * 界面字号真源（PRD v2 §4.3.2 AP5：整个软件 UI 的基准字号）。
 *
 * ## 与「会话正文字号」的区别（用户裁定 `#9`）
 *
 * | | 作用域 | 真源 |
 * |---|---|---|
 * | **界面字号**（本模块）| 整个软件 UI（菜单/列表/按钮/卡片）| 本模块 + `--corum-ui-font-scale` |
 * | 会话正文字号 | 仅对话区正文 | `ui-theme.fontSize`（官方，另一个面）|
 *
 * 两者**相互独立**（§4.3.1 的四个面）。改本项**不影响**对话正文字号。
 *
 * ## 实现机制：乘数变量（不是 px→rem）
 *
 * 全仓 **615 处** `font-size` 已改为
 * `calc(<N>px * var(--corum-ui-font-scale, 1))`（见 `scripts/migrate-ui-font-size.py`
 * 与台账 `settings.rework.ui-font-size-scale-migrated`）。
 * 本模块只负责把该变量写到**根元素**上。
 *
 * ⚠️ 为什么用乘数而非 px→rem：改造是**纯机械、可脚本化**的，且
 * **能一次覆盖全部 615 处** ⇒ 不存在「有的地方变、有的不变」的半成品状态
 * （那比不做更糟，见 PRD §15.2/§15.8）。
 *
 * ## 为什么「基准字号」对外仍以 px 呈现
 *
 * 设计稿的外观页「界面字号」显示的是 px（14）。故本模块对外用 px
 * （默认 **14**），内部换算成乘数：`scale = base / 14`。
 * 这样页面文案与设计稿一致，而实现仍是单一乘数。
 *
 * ## 存放位置：沿用 `corum.*` localStorage 先例
 *
 * 与强调色同源判断（见 `appearance-accent.ts` 的说明）：纯 UI 偏好、
 * 无跨 bundle 语义 ⇒ 不新建设置 ns。消费方（Shell 写变量、外观页选值）
 * **同在 `corum-ide-ui` 一个 bundle 内**，模块级 store 安全（不违反红线 1）。
 *
 * @module corum-ide-ui/client/ui-font-scale
 */

/** 持久化键（沿用 `corum.*` UI 偏好命名）。 */
const UI_FONT_BASE_KEY = 'corum.appearance.uiFontBase'

/** 换算基准：设计稿的默认界面字号（px）。乘数 = base / 此值。 */
export const UI_FONT_BASE_DEFAULT_PX = 14

/** 承载乘数的根级 CSS 变量（与 615 处声明里引用的名字必须一致）。 */
export const UI_FONT_SCALE_VAR = '--corum-ui-font-scale'

/**
 * 可选的界面基准字号（px）。
 *
 * 范围与「会话正文字号」保持同构（12–17），便于用户理解两者是并列的「面」，
 * 但两者**互不影响**。
 */
export const UI_FONT_BASE_OPTIONS: readonly number[] = [12, 13, 14, 15, 16, 17]

/**
 * 读持久化的界面基准字号（异常 / 越界一律回落默认）。
 * @returns 生效的基准字号（px）。
 */
export function readUiFontBase(): number {
  if (typeof localStorage === 'undefined') return UI_FONT_BASE_DEFAULT_PX
  try {
    const raw = localStorage.getItem(UI_FONT_BASE_KEY)
    if (raw === null) return UI_FONT_BASE_DEFAULT_PX
    const n = Number.parseInt(raw, 10)
    return UI_FONT_BASE_OPTIONS.includes(n) ? n : UI_FONT_BASE_DEFAULT_PX
  } catch {
    return UI_FONT_BASE_DEFAULT_PX
  }
}

/** 订阅者集合（同 bundle 内共享）。 */
const listeners = new Set<() => void>()

/** 当前基准字号（内存镜像）。 */
let currentBase: number | null = null

/**
 * 取当前界面基准字号。
 * @returns 生效的基准字号（px）。
 */
export function getUiFontBase(): number {
  if (currentBase === null) currentBase = readUiFontBase()
  return currentBase
}

/**
 * 由基准字号算乘数。
 * @param base - 基准字号（px）。
 * @returns 乘数（默认 14px 时为 1）。
 */
export function scaleOf(base: number): number {
  return Math.round((base / UI_FONT_BASE_DEFAULT_PX) * 1000) / 1000
}

/**
 * 把当前乘数写到根元素（幂等；在默认值时可移除变量以回落 fallback）。
 *
 * @param base - 基准字号（px）；省略则用当前值。
 */
export function applyUiFontScale(base: number = getUiFontBase()): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (base === UI_FONT_BASE_DEFAULT_PX) {
    root.style.removeProperty(UI_FONT_SCALE_VAR)
    return
  }
  root.style.setProperty(UI_FONT_SCALE_VAR, String(scaleOf(base)))
}

/**
 * 设置界面基准字号：持久化 + 写变量 + 通知订阅者。
 * @param base - 目标基准字号（px）；越界回落默认。
 */
export function setUiFontBase(base: number): void {
  const next = UI_FONT_BASE_OPTIONS.includes(base) ? base : UI_FONT_BASE_DEFAULT_PX
  if (next === getUiFontBase()) return
  currentBase = next
  try {
    localStorage.setItem(UI_FONT_BASE_KEY, String(next))
  } catch { /* 容量满 / 隐私模式：仅本次会话生效 */ }
  applyUiFontScale(next)
  for (const fn of listeners) fn()
}

/**
 * 订阅界面字号变更。
 * @param fn - 变更回调。
 * @returns 取消订阅。
 */
export function subscribeUiFontBase(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
