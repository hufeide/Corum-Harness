/**
 * 界面密度真源（PRD v2 §4.3.2 AP7：列表与控件的纵向留白）。
 *
 * ## 作用范围
 *
 * 全仓 **1287 处** `gap` / `padding` / `margin` 已改为
 * `calc(<N>px * var(--corum-density-scale, 1))`（含 row-gap / column-gap 与四向变体；
 * 见 `scripts/migrate-ui-scale.py`）。本模块只负责把乘数写到**根元素**上。
 *
 * ⚠️ 未设变量时 fallback = 1 ⇒ **默认视觉与改造前逐像素一致**（纯结构改造）。
 *
 * ## 为什么用乘数而不是改 px
 * 与界面字号同理：**能一次覆盖全部处**，不存在「部分生效」的中间态。
 *
 * ## 与另外三个「面」的关系（PRD §4.3.1）
 * | 面 | 真源 |
 * |---|---|
 * | 界面字号 | `--corum-ui-font-scale`（`ui-font-scale.ts`）|
 * | **界面密度**（本模块）| `--corum-density-scale` |
 * | 会话正文字号 | `ui-theme.fontSize`（官方）|
 * | 终端 / 编辑器字号 | 各自分区（未上线）|
 *
 * 四者**相互独立**；本模块只动间距轴，不碰任何字号轴。
 *
 * ## 存放位置
 * 沿用 `corum.*` localStorage 先例（同强调色 / 界面字号）；消费方与 Shell 同在一个 bundle。
 *
 * @module corum-ide-ui/client/ui-density
 */

/** 持久化键。 */
const UI_DENSITY_KEY = 'corum.appearance.uiDensity'

/** 承载乘数的根级 CSS 变量（名字必须与 1287 处声明一致）。 */
export const UI_DENSITY_VAR = '--corum-density-scale'

/** 默认档（乘数 1，即不设变量）。 */
export const UI_DENSITY_DEFAULT_ID = 'standard'

/** 可选密度档（id → 展示名 + 乘数）。 */
export const UI_DENSITY_OPTIONS: readonly { id: string; label: string; scale: number }[] = [
  { id: 'compact', label: '紧凑', scale: 0.875 },
  { id: 'standard', label: '标准（默认）', scale: 1 },
  { id: 'relaxed', label: '宽松', scale: 1.125 },
]

/**
 * 读持久化的密度档 id（异常 / 未知一律回落默认）。
 * @returns 生效的密度档 id。
 */
export function readUiDensityId(): string {
  if (typeof localStorage === 'undefined') return UI_DENSITY_DEFAULT_ID
  try {
    const raw = localStorage.getItem(UI_DENSITY_KEY)
    if (raw === null) return UI_DENSITY_DEFAULT_ID
    return UI_DENSITY_OPTIONS.some(o => o.id === raw) ? raw : UI_DENSITY_DEFAULT_ID
  } catch {
    return UI_DENSITY_DEFAULT_ID
  }
}

/** 订阅者集合。 */
const listeners = new Set<() => void>()

/** 内存镜像。 */
let currentId: string | null = null

/**
 * 取当前密度档 id。
 * @returns 生效的密度档 id。
 */
export function getUiDensityId(): string {
  if (currentId === null) currentId = readUiDensityId()
  return currentId
}

/**
 * 把当前档位对应的乘数写到根元素。
 *
 * 默认档时**移除**变量（回落 fallback 1）⇒ 默认状态与改造前逐像素一致。
 *
 * @param id - 密度档 id；省略则用当前值。
 */
export function applyUiDensity(id: string = getUiDensityId()): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const opt = UI_DENSITY_OPTIONS.find(o => o.id === id) ?? UI_DENSITY_OPTIONS[1]
  if (opt.scale === 1) {
    root.style.removeProperty(UI_DENSITY_VAR)
    return
  }
  root.style.setProperty(UI_DENSITY_VAR, String(opt.scale))
}

/**
 * 设置密度档：持久化 + 写变量 + 通知订阅者。
 * @param id - 目标档 id；未知值回落默认。
 */
export function setUiDensity(id: string): void {
  const next = UI_DENSITY_OPTIONS.some(o => o.id === id) ? id : UI_DENSITY_DEFAULT_ID
  if (next === getUiDensityId()) return
  currentId = next
  try {
    localStorage.setItem(UI_DENSITY_KEY, next)
  } catch { /* 容量满 / 隐私模式：仅本次会话生效 */ }
  applyUiDensity(next)
  for (const fn of listeners) fn()
}

/**
 * 订阅密度变更。
 * @param fn - 变更回调。
 * @returns 取消订阅。
 */
export function subscribeUiDensity(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
