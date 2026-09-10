/**
 * 渲染层 ↔ macOS 菜单栏托盘的桥（corum-desktop）。
 *
 * 分工（为什么不在主进程算未读数）：通知账本只存在 renderer 的 store 里
 * （`notifications.ts`），主进程**不复制**这份状态 —— 复制就会出现两套数字打架
 * （renderer 清空/已读后主进程还挂着旧值）。所以主进程只当「显示端」：
 *   - renderer → 主进程：`setNotificationCount({ unread, total })`，store 一变推一次；
 *   - 主进程 → renderer：`onOpenNotificationCenter()`，菜单里点「通知中心」时展开面板。
 *
 * **只装主窗**（`isFloatingWindow()`）：菜单栏那个数字是「全局未读」这一本账，
 * 浮窗有自己的 store（只装本窗直接反馈，见 `mount-notifications.tsx`），
 * 两边都推就会互相覆盖 —— 最后谁后推谁赢，数字会来回跳。
 *
 * @module corum-desktop/client/tray-bridge
 */

import type { NotificationStore } from './notifications.ts'
import { isFloatingWindow } from './window-role.ts'

/** `window.corumDesktop` 的窄化面（只用到托盘三项；本地能力接口，红线 3）。 */
interface TrayBridgeFace {
  setNotificationCount?: (count: { unread: number; total: number }) => void
  getTrayHint?: () => Promise<{ resident: boolean; firstTime: boolean }>
  onOpenNotificationCenter?: (callback: () => void) => () => void
}

/** 取桌面桥（非桌面壳 / 老 preload 返回 undefined，调用方静默降级）。 */
function desktopBridge(): TrayBridgeFace | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { corumDesktop?: TrayBridgeFace }).corumDesktop
}

/**
 * 装托盘桥：未读数推送 + 托盘菜单动作 + 常驻模式一次性提示。
 * @param store - 通知 store（主窗的全局账本）。
 * @returns 退订函数（随插件生命周期清理）。
 */
export function installTrayBridge(store: NotificationStore): () => void {
  const bridge = desktopBridge()
  if (bridge?.setNotificationCount === undefined) return () => {}
  // 浮窗不推未读：见模块头「只装主窗」。
  if (isFloatingWindow()) return () => {}

  const push = (): void => {
    const items = store.getSnapshot()
    bridge.setNotificationCount?.({
      unread: items.filter(item => !item.read).length,
      total: items.length,
    })
  }
  // 订阅前先推一次：插件装配时 store 里可能已经有内容（HMR 重建、早于桥的事件）。
  push()
  const unsubscribe = store.subscribe(push)

  // 托盘菜单「通知中心」：展开面板（`expandAll` 让 5s 自动收起的历史条目回到视野里，
  // 与点 bell 的路径一致 —— 见 NotificationHost 的 onOpenPanel）。
  const offCenter = bridge.onOpenNotificationCenter?.(() => {
    store.expandAll()
    store.setPanelOpen(true)
  })

  /**
   * 常驻模式一次性提示（`takeTrayResidentHint` 已在主进程侧去重落盘）。
   *
   * 为什么用通知而不是弹窗：它要说明的是「关窗不等于退出」这件事本身，用通知中心
   * 说一遍足够，弹窗会打断用户。给出「点菜单栏图标可回来」的出路是关键 —— 只说
   * 「已常驻」而不说怎么回来，等于制造一个找不回的窗口。
   */
  void bridge.getTrayHint?.().then((hint) => {
    if (hint?.firstTime !== true) return
    store.notify({
      tone: 'info',
      title: '已常驻菜单栏',
      message: '关闭窗口不会退出应用（后台任务继续跑），点菜单栏图标可随时回来。',
    })
  }).catch(() => {
    // 提示拉取失败不算错误：它只是引导文案，静默跳过。
  })

  return () => {
    unsubscribe()
    offCenter?.()
  }
}
