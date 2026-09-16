/**
 * 保存结果弹窗宿主的**纯选取逻辑**（无 React / 无 CSS 依赖，可直接单测）。
 *
 * 拆出来的原因：宿主组件（SaveDialogHost.tsx）import 了官方的 `Modal`
 * （`dsh-client-ui-primitives`），而该包带 `.css` 模块 ⇒ 在 vitest 里直接 import
 * 宿主会在加载期炸 `Unknown file extension ".css"`（组件样式不属于本仓可控面，
 * 也不该为了单测去加 CSS 转译）。把选择器放进这个 cordis-free 的窄模块，
 * 测试就能只依赖控制器类型。
 */
import type { SessionArchiveState } from './controller.ts'

/**
 * 从控制器快照里挑出当前该显示的保存弹窗的**会话 id**。
 *
 * 语义（**最新优先 + 逐条消解**，2026-09-16 定）：
 *   - 一次手势 = 一条 `open: true` 的条目；用户点「关闭」把它置回 `open: false`。
 *   - 可能同时存在**多条** open（例：保存会话 A 后没关弹窗，又去保存会话 B）。
 *     此时显示**最新**那条（用户刚做的动作最相关），关掉它之后下一条自然浮出，
 *     逐条消解 —— 既不堆叠多个遮罩，也**不丢**任何一条结论（错误信息不会被静默吞掉）。
 *   - 取「最新」= 对象键的最后一条（`publishSave` 用 `{...state, [id]: entry}` 追加，
 *     后写的键在插入序上靠后）。
 *
 * ⚠️ **只返回 id 字符串，不返回 `[id, entry]` 元组**：绑定 Hook 是
 * `useSyncExternalStoreWithSelector` 且**不传 eq**（= `Object.is` 比较，见
 * ui-renderer/src/client/bind.ts:24-26）⇒ 选择器每次返回**新对象/新数组**会让快照
 * 永不「相等」，触发无限重渲染。故这里只取原始值（string | undefined），
 * 条目本身在拿到 id 之后再取一次（同 ImportRow 的 entry 选择器做法）。
 * @param state - 控制器快照。
 * @returns 该显示的会话 id（store 键）；没有 open 条目时 undefined。
 */
export function selectOpenSaveSessionId(state: SessionArchiveState): string | undefined {
  let found: string | undefined
  for (const [id, entry] of Object.entries(state.bySession)) {
    if (entry?.open === true) found = id
  }
  return found
}
