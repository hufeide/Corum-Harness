/**
 * corum-desktop preload: exposes the `window.corumDesktop` IPC bridge to the
 * page. Sandboxed (CJS), so only ipcRenderer/contextBridge are reachable; the
 * renderer never touches Electron APIs directly.
 * @module corum-desktop/electron/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

const floatingListeners = new Set<(slotKey: string, detached: boolean) => void>()
const floatingDragListeners = new Set<(payload: { slotKey: string; dragging: boolean; x?: number; y?: number }) => void>()
const nativeNotificationClickListeners = new Set<(payload: { notificationId: string | null }) => void>()
const notificationCenterListeners = new Set<() => void>()

ipcRenderer.on('corum:floating-change', (_event, payload: { slotKey: string; detached: boolean }) => {
  for (const listener of [...floatingListeners]) listener(payload.slotKey, payload.detached)
})

ipcRenderer.on('corum:floating-drag', (_event, payload: { slotKey: string; dragging: boolean; x?: number; y?: number }) => {
  for (const listener of [...floatingDragListeners]) listener(payload)
})

// 系统通知被点击：主进程已唤醒/聚焦窗口，这里把 id 交给 renderer 执行跳转。
ipcRenderer.on('corum:native-notification-clicked', (_event, payload: { notificationId: string | null }) => {
  for (const listener of [...nativeNotificationClickListeners]) listener(payload)
})

// 托盘菜单点了「通知中心」：主进程已显示窗口，这里让 renderer 展开自己的通知面板。
ipcRenderer.on('corum:open-notification-center', () => {
  for (const listener of [...notificationCenterListeners]) listener()
})

contextBridge.exposeInMainWorld('corumDesktop', {
  /** Dev: hot-restart the host bridge child (host-side code changed). */
  restartHost: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('corum:host-restart'),

  /** Open one slot's content in a detached floating window (?floating=<slotKey>). */
  openFloating: (slotKey: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:open-floating', { slotKey }),

  /**
   * 发一条**系统通知**（macOS 通知中心）。返回 ok:false 表示平台不支持或失败，
   * 调用方应静默降级（应用内 toast 仍然在）。
   */
  notifyNative: (request: {
    title: string
    body?: string
    silent?: boolean
    notificationId?: string
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:notify-native', request),
  /** 订阅系统通知点击（主进程已唤醒窗口；这里执行跳转）。 */
  onNativeNotificationClick: (callback: (payload: { notificationId: string | null }) => void): (() => void) => {
    nativeNotificationClickListeners.add(callback)
    return () => {
      nativeNotificationClickListeners.delete(callback)
    }
  },

  // ── 托盘常驻（macOS 菜单栏）──────────────────────────────────────────

  /**
   * 把未读数推给主进程（菜单栏标题上的数字）。
   *
   * 单向 `send`（无返回值）：这是**显示**同步，renderer 不需要等待；主进程侧对
   * 形状做钳制（`ipc.ts`）。
   */
  setNotificationCount: (count: { unread: number; total: number }): void => {
    ipcRenderer.send('corum:notifications-count', count)
  },

  /**
   * 取「常驻模式」一次性提示的展示资格（renderer 的托盘桥装好后主动拉一次）。
   * @returns resident=当前是否托盘常驻；firstTime=这次该不该提示（拉取即落盘去重）。
   */
  getTrayHint: (): Promise<{ resident: boolean; firstTime: boolean }> =>
    ipcRenderer.invoke('corum:tray-hint'),
  /** 主进程托盘菜单点了「通知中心」→ 展开渲染层的通知面板。 */
  onOpenNotificationCenter: (callback: () => void): (() => void) => {
    notificationCenterListeners.add(callback)
    return () => {
      notificationCenterListeners.delete(callback)
    }
  },
  /** Main window: subscribe to slot detach/restore (floating open/close). */
  onFloatingChange: (callback: (slotKey: string, detached: boolean) => void): (() => void) => {
    floatingListeners.add(callback)
    return () => {
      floatingListeners.delete(callback)
    }
  },
  /** Main window: subscribe to floating-window drag coordinates (live dock preview). */
  onFloatingDrag: (callback: (payload: { slotKey: string; dragging: boolean; x?: number; y?: number }) => void): (() => void) => {
    floatingDragListeners.add(callback)
    return () => {
      floatingDragListeners.delete(callback)
    }
  },

  /** Save one session's log ZIP via a native save dialog; resolves the saved path or null when cancelled. */
  saveSessionLog: (sessionId: string): Promise<{ path: string | null; error?: string }> =>
    ipcRenderer.invoke('corum:save-session-log', { sessionId }),
  /** Import session log ZIP(s) via a native open dialog; resolves the import outcome. */
  importSessionLog: (): Promise<{ imported: string[]; skipped: string[]; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:import-session-log'),
  /** Physically delete one session after a native confirm dialog; running sessions are refused. */
  deleteSession: (sessionId: string): Promise<{ deleted: boolean; wasLive?: boolean; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:delete-session', { sessionId }),
  /** Pick a working directory via a native open-directory dialog (project cwd). */
  pickDirectory: (options?: { title?: string; defaultPath?: string }): Promise<{ path: string | null; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:pick-directory', options ?? {}),
  /** 壳层 combo 管理页：读取所有已配置且可用的 combo。 */
  listCombos: (): Promise<unknown[]> =>
    ipcRenderer.invoke('corum:combos-list'),
  /** 壳层 combo 管理页：按 combo 注入 env/cwd/覆盖规则并启动 dsh host。 */
  launchCombo: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('corum:combo-launch', { id }),
  /** 记录 combo 使用时间。 */
  touchCombo: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('corum:combo-touch', { id }),
})
