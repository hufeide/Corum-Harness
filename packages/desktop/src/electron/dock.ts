/**
 * macOS Dock 侧的常驻能力（未读徽标 + 右键菜单 + 图标显隐 + 遮挡时轻提示）。
 *
 * 与 `tray.ts` 的分工：托盘是**菜单栏**的载体（用户被别的东西挡住时也能看见未读），
 * Dock 是**下方 Dock 栏**的载体。两者的可见性/损毁完全独立 —— 用户可能把菜单栏塞满、
 * 也可能开了「自动隐藏 Dock」，所以**两边都要有**入口与未读提示，且数字必须同源
 * （都由主窗 renderer 推送，见 `shell-menu.ts` 的说明）。
 *
 * 四项能力：
 *   ① **未读徽标**（`app.dock.setBadge`）：Dock 图标右上角的红气泡，与菜单栏标题共用
 *      同一个 `countLabel()`（`99+` 封顶），清零写 `''`。
 *      ⚠️ **官方文档明写**：*"You need to ensure that your application has the permission
 *      to display notifications for this method to work."*
 *      （<https://www.electronjs.org/docs/latest/api/dock#docksetbadgetext-macos>）
 *      本仓当前是未签名开发态 → 通知授权拿不到 → **徽标静默不显示**（实测：设置 3 条
 *      未读后 Dock 图标区域红色像素为 0，且无任何报错）。所以：
 *        - 代码保留（签名 + 授权到位后自动生效，属「零改动启用」）；
 *        - **Dock 侧的未读在未签名阶段由菜单状态行承载**（右键 Dock 图标即可看到
 *          `3 条未读 · 共 7 条`），菜单栏数字仍是主载体。
 *   ② **右键菜单**（`app.dock.setMenu`）：与菜单栏托盘**同一份模板**
 *      （`buildShellMenu`），保持一致的功能树。
 *   ③ **图标显隐**（`app.dock.hide()/show()`）：只留菜单栏的模式，状态落在
 *      `~/.corum-desktop/shell.json` 的 `dockHidden`，启动时恢复。
 *      ⚠️ 官方文档的**已知问题**：*"Calling `dock.hide()` within one second of a
 *      previous call will have no effect."* —— 所以本模块把显隐变更**串行化 + 至少间隔
 *      1.1s**（`MIN_DOCK_CHANGE_GAP_MS`），否则连续切换会静默失效。
 *   ④ **遮挡时的轻提示**（`app.dock.bounce('informational')`）：新通知到达而主窗不在
 *      眼前时让 Dock 图标跳一下（1 秒）。这是**未签名阶段唯一还能用的「喊人」手段**：
 *      系统通知被签名卡住，Dock 弹跳不需要任何授权。
 *      官方说明：*"This method can only be used while the app is not focused; when the
 *      app is focused it will return -1."* —— 即「窗口在前面时不打扰」由系统保证，
 *      正是我们要的语义；再加 15s 节流防连环跳。
 *
 * Dock 点击还原窗口不需要额外代码：`app.on('activate')` 已经处理（见 `main.ts`）。
 *
 * @module corum-desktop/electron/dock
 */

import { app } from 'electron'
import { buildShellMenu, countLabel, type ShellCount, type ShellMenuHost } from './shell-menu.ts'
import { patchShellState, readShellState } from './shell-state.ts'

/**
 * 两次 Dock 显隐变更之间的最小间隔（ms）。
 *
 * 1.1s 而非 1s：官方文档说「1 秒内重复调用无效」，卡在边界上仍可能被系统判定为
 * 同一批变更，留 100ms 余量。
 */
const MIN_DOCK_CHANGE_GAP_MS = 1100

/** Dock 弹跳的节流间隔（ms）：同一波通知只跳一次，避免连环跳变成骚扰。 */
const BOUNCE_THROTTLE_MS = 15_000

/** Dock 要的额外输入：菜单动作（`ShellMenuHost`）+ 「该不该喊人」的判定。 */
export interface CorumDockHost extends ShellMenuHost {
  /**
   * 此刻是否值得用 Dock 弹跳提示用户（主窗隐藏 / 最小化 / 未聚焦）。
   * 由 `main.ts` 依窗口状态回答 —— 本模块不持有窗口引用。
   */
  shouldAttractAttention(): boolean
}

/** Dock 的对外句柄。 */
export interface CorumDock {
  /** 更新未读数（renderer 推送；驱动徽标 + 菜单状态行 + 必要时弹跳）。 */
  setCount(count: ShellCount): void
  /**
   * 重建 Dock 右键菜单。
   *
   * 为什么需要单独暴露：勾选态（开机自启 / 隐藏 Dock 图标）变了之后，已经挂在
   * Dock 上的那份菜单实例还是旧状态 —— 未读数没变就不会触发 `setCount` 的重建路径。
   */
  refresh(): void
  /** 当前是否隐藏了 Dock 图标。 */
  isHidden(): boolean
  /** 设置 Dock 图标显隐（落盘 + 立即生效，内部按官方限制串行化）。 */
  setHidden(hidden: boolean): void
  /** 关闭前清理（Dock 菜单/徽标随进程消失，这里只是对称性动作）。 */
  destroy(): void
}

/**
 * 建 macOS Dock 侧的常驻能力。
 * @param host - 菜单动作与「该不该喊人」判定。
 * @returns Dock 句柄；非 macOS 或 Dock 不可用时返回 null。
 */
export function createCorumDock(host: CorumDockHost): CorumDock | null {
  if (process.platform !== 'darwin') return null
  const dock = app.dock
  if (dock === undefined) return null

  let count: ShellCount = { unread: 0, total: 0 }
  let hidden = readShellState().dockHidden === true
  /** 上次显隐变更的时间戳 + 待执行的延迟变更（官方「1 秒内重复调用无效」的绕行）。 */
  let lastVisibilityChangeAt = 0
  let pendingVisibility: NodeJS.Timeout | null = null
  /** 上次弹跳时间（节流用）。 */
  let lastBounceAt = 0

  /**
   * 应用 Dock 图标显隐（串行化）。
   *
   * `app.dock.hide()` 会把应用切成 accessory（不再出现在 Dock 与 ⌘Tab 里）——
   * 这正是「只留菜单栏」想要的；恢复路径是菜单栏托盘的同一个勾选项（托盘在
   * 菜单栏上始终可见，所以不存在「关掉后找不回」的死角）。
   */
  const applyVisibility = (): void => {
    const run = (): void => {
      lastVisibilityChangeAt = Date.now()
      try {
        if (hidden) dock.hide()
        else void dock.show()
      } catch (error) {
        // 极少数会话环境（无 Dock）会抛；吞掉不影响启动。
        process.stderr.write(`[corum-desktop] dock visibility change failed: ${String(error)}\n`)
      }
    }
    const waited = Date.now() - lastVisibilityChangeAt
    if (waited < MIN_DOCK_CHANGE_GAP_MS) {
      // 官方已知问题：1 秒内的第二次 hide/show 会被忽略 → 延迟到窗口外再执行。
      if (pendingVisibility !== null) clearTimeout(pendingVisibility)
      pendingVisibility = setTimeout(() => {
        pendingVisibility = null
        run()
      }, MIN_DOCK_CHANGE_GAP_MS - waited)
      return
    }
    run()
  }

  const applyBadge = (): void => {
    try {
      // 清零写空串（Dock 上常驻一个红「0」是噪音，与菜单栏标题同一策略）。
      dock.setBadge(count.unread > 0 ? countLabel(count.unread) : '')
    } catch (error) {
      process.stderr.write(`[corum-desktop] dock badge failed: ${String(error)}\n`)
    }
  }

  const menu = (): void => {
    try {
      dock.setMenu(buildShellMenu(count, host))
    } catch (error) {
      process.stderr.write(`[corum-desktop] dock menu failed: ${String(error)}\n`)
    }
  }

  /**
   * 遮挡时轻提示：让 Dock 图标跳一下（1 秒，informational）。
   *
   * 三道闸门（缺一不可，否则会变成骚扰）：① 主窗不在眼前（`host.shouldAttractAttention`）；
   * ② 15s 节流；③ 系统层面的「应用聚焦时返回 -1」——窗口在前台时苹果自己就不跳。
   */
  const bounce = (): void => {
    if (!host.shouldAttractAttention()) return
    if (Date.now() - lastBounceAt < BOUNCE_THROTTLE_MS) return
    lastBounceAt = Date.now()
    try {
      const id = dock.bounce('informational')
      if (process.env.CORUM_DEV_HMR !== undefined) {
        process.stderr.write(`[corum-shell] dock bounce id=${String(id)} (>=0 表示真的跳了)\n`)
      }
    } catch (error) {
      process.stderr.write(`[corum-desktop] dock bounce failed: ${String(error)}\n`)
    }
  }

  applyVisibility()
  applyBadge()
  menu()

  if (process.env.CORUM_DEV_HMR !== undefined) {
    // 自检（dev）：Dock 徽标可能「设了但不显示」—— 官方要求通知授权，而本仓开发态
    // 未签名拿不到授权（Electron 43 的类型里没有可读授权状态的 API，故只能如实打印
    // 我们设进去的值 + 提醒它可能不显示；实机验证靠截图看红色气泡）。
    process.stderr.write(
      `[corum-shell] dock: visible=${String(dock.isVisible())} hidden=${String(hidden)} `
      + `badge="${dock.getBadge()}" (未签名/未授权时 macOS 不绘制徽标)\n`,
    )
  }

  return {
    setCount: (next) => {
      // renderer 推来的数据一律当作不可信：钳成非负整数。
      const unread = Number.isFinite(next.unread) ? Math.max(0, Math.floor(next.unread)) : 0
      const total = Number.isFinite(next.total) ? Math.max(0, Math.floor(next.total)) : 0
      if (unread === count.unread && total === count.total) return
      const increased = unread > count.unread
      count = { unread, total }
      applyBadge()
      menu()
      // 只有「新增未读」且窗口不在眼前时才喊人；清空/已读不该有动静。
      if (increased) bounce()
    },
    refresh: menu,
    isHidden: () => hidden,
    setHidden: (next) => {
      if (next === hidden) return
      hidden = next
      patchShellState({ dockHidden: next })
      applyVisibility()
      menu()
    },
    destroy: () => {
      if (pendingVisibility !== null) {
        clearTimeout(pendingVisibility)
        pendingVisibility = null
      }
      // 退出时把徽标清掉：进程没了 Dock 图标自然消失，但保留徽标值会让
      // 「同一时刻另一个实例」看到过期数字（单实例锁下罕见，纯防御）。
      try {
        dock.setBadge('')
      } catch {
        // 退出路径，忽略。
      }
    },
  }
}
