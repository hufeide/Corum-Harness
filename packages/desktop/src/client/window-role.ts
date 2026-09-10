/**
 * 渲染进程的**窗口角色**判定（主窗 / 浮窗）。
 *
 * 桌面客户端插件在**每个** Electron 窗口里都会加载（主窗与浮窗同源同 bundle），
 * 而有些能力必须**只归属主窗**：
 *   - 全局通知事件桥（`notification-bridge.ts`）：浮窗也订阅宿主事件 → 同一事件
 *     两处各弹一份；
 *   - 系统通知镜像（同上）；
 *   - 托盘未读数（`tray-bridge.ts`）：菜单栏上那个数字只该反映主窗这本「全局账」。
 * 判据是同一个 URL 契约：浮窗由主进程以 `?floating=<slotKey>` 打开
 * （见 `electron/ipc.ts` 的 `corum:open-floating`）。
 *
 * 为什么单独一个模块：这条判定此前在三个文件里各写了一遍；判定与用法一旦漂移
 * （比如某处改成 `get('floating') !== null`、某处忘了 `typeof window`），就会出现
 * 「浮窗多一份通知」这类只有实机才看得见的漏判。集中一处 + 一处注释。
 * @module corum-desktop/client/window-role
 */

/**
 * 本窗口是否为**浮窗**（`?floating=<slotKey>`）。
 * @returns 浮窗返回 true；主窗 / 非浏览器环境返回 false。
 */
export function isFloatingWindow(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('floating')
}
