/**
 * Monaco 实例的同 bundle 引用桥（P2-1，.dbg/event-bus-audit-2026-09.md）。
 *
 * 原实现把编辑器实例挂 `window.__corumMonacoEditor`（MonacoEditor 写、EditorColumn
 * 读），unmount 时写 `undefined`——可变单例挂 window 属红线 1 的形态（规范 §1 的合法
 * 例外只认「write-once read-only」，这里是可写可清）。两处消费点同在
 * `packages/desktop/src/client` 这一个 bundle 内，故消解为**模块级引用**即可：
 * 同 bundle 内模块状态不跨 bundle，不构成红线 1 的「跨 bundle 共享可变状态」。
 *
 * 语义保持：create 时挂载、dispose 时清空（`undefined` = 无活动编辑器）。
 *
 * @module corum-desktop/client/editor/monaco-bridge
 */

/** 快捷键兜底需要的最小 Monaco 面（EditorColumn 只用 trigger 的前两个形参）。 */
export interface CorumMonacoInstance {
  /**
   * 触发 Monaco command（'keyboard' 来源，语义与 keybinding 一致）。
   * 注：真实 `editor.trigger(source, handlerId, payload)` 还有第三个形参，
   * 本桥只暴露消费面所需的两个（写入端做一次收窄断言）。
   */
  trigger: (source: string, handlerId: string) => void
  /**
   * 滚动定位到指定行并选中（「编辑未命中」卡行号跳转，2026-09-13）。
   * 对应 monaco revealLineInCenter + setPosition + focus；实例无活动模型时 no-op。
   */
  revealLine?: (line: number) => void
}

let corumMonacoInstance: CorumMonacoInstance | undefined

/** 挂载/清空当前编辑器实例（MonacoEditor create/dispose）。 */
export function setCorumMonacoInstance(instance: CorumMonacoInstance | undefined): void {
  corumMonacoInstance = instance
}

/** 读当前编辑器实例（无活动编辑器时 undefined）。 */
export function getCorumMonacoInstance(): CorumMonacoInstance | undefined {
  return corumMonacoInstance
}
