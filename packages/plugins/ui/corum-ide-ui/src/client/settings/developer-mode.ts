/**
 * developer-mode —— 「开发者模式」开关的持久化与订阅。
 *
 * 轻量实现：localStorage 持久化 + 同 bundle 内 useSyncExternalStore 订阅。
 * 仅设置域（settings）内共享，不跨 bundle，无需 cordis service（红线 1 不适用于
 * 单 bundle 内模块状态）。开启后：Agent 预设编辑页显示「继承自」下拉，可选择
 * 非标准模式做继承编排；关闭则固定继承标准模式并覆盖其 persona。
 * @module corum-ide-ui/client/settings/developer-mode
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'corum.settings.developerMode'
const CHANGE_EVENT = 'corum:developer-mode-change'

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 读取开发者模式开关（非响应式；组件内请用 useDeveloperMode）。 */
export function getDeveloperMode(): boolean {
  return read()
}

/** 写入并广播变更。 */
export function setDeveloperMode(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    // 忽略持久化失败（如隐私模式），仍广播让当前会话生效。
  }
  globalThis.dispatchEvent?.(new Event(CHANGE_EVENT))
}

function subscribe(cb: () => void): () => void {
  const handler = (): void => { cb() }
  globalThis.addEventListener?.(CHANGE_EVENT, handler)
  // 跨标签页同步（storage 事件仅在其他标签页触发）。
  globalThis.addEventListener?.('storage', handler)
  return () => {
    globalThis.removeEventListener?.(CHANGE_EVENT, handler)
    globalThis.removeEventListener?.('storage', handler)
  }
}

/** 响应式读取开发者模式开关。 */
export function useDeveloperMode(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}
