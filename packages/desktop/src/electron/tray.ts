/**
 * macOS 菜单栏常驻托盘（tray / status item）。
 *
 * 用户定调（2026-09-10）：「托盘常驻要做」「被遮挡时**托盘提示消息数量**」
 * 「先做 macOS，Linux/Windows 放 TODO 低优先级」。
 *
 * 常驻的**意义**（不是「多一个图标」这么简单）：主窗关闭不再退出应用 —— 后台的
 * 会话轮次、子 Agent、编排批次继续跑，用户随时经菜单栏图标回到窗口。因此本模块
 * 与主进程的关窗语义是一套东西（见 `main.ts` 的 `mainWindow.on('close')`）：
 * 只有托盘真的建起来了（macOS），关窗才降级为隐藏；没有托盘就维持原语义
 * （关窗即退出），避免用户关掉窗口后**再也找不回**应用。
 *
 * 未读数是菜单栏上的**文字标题**（`tray.setTitle`），不是图标角标：
 *   ① macOS 的 status item 没有「徽标」这种原生概念，能表达数字的只有标题文字；
 *   ② 标题数字与通知中心 bell 的数字**同源**（都是主窗 store 里 `!read` 的条数），
 *      不允许两处各算一套；
 *   ③ 有未读才写数字、清零后清空标题 —— 菜单栏空间紧张，常驻的「0」是噪音。
 *
 * 跨平台现状：本模块**只在 darwin 上建托盘**（其余平台返回 null）。
 *   - Windows：需要 16x16 `.ico` + `app.setAppUserModelId`（任务栏/通知分组），
 *     且 `click`/`double-click` 语义与 mac 不同（详见
 *     `docs/ASSESSMENT-tray-floating-system-notification.md`）；
 *   - Linux：GNOME 无原生托盘（需 AppIndicator 扩展 + libappindicator），部分
 *     桌面环境下 `click` 事件根本不触发（只能靠菜单）。
 *   两条都属「先不做，记 TODO」的低优先级项，故这里显式早返回而不是留半成品。
 *
 * @module corum-desktop/electron/tray
 */

import { Tray, app, nativeImage } from 'electron'
import { join } from 'node:path'
import { buildShellMenu, countLabel, type ShellCount, type ShellMenuHost } from './shell-menu.ts'
import { patchShellState, readShellState } from './shell-state.ts'

/**
 * 托盘图标的逻辑尺寸（pt）。
 *
 * macOS 菜单栏高度 22pt，图标惯例 18pt（与系统图标视觉重量相当）。@2x 表示用
 * 36px 位图另附，避免 Retina 下拉丝（见 `trayImage`）。
 */
const ICON_PT = 18

/** 托盘要的额外输入：shell 静态资源目录（菜单动作见 `ShellMenuHost`）。 */
export interface CorumTrayHost extends ShellMenuHost {
  /** shell 静态资源目录（dev 与打包态不同，由 main 侧解析）。 */
  assetsDir: string
}

/** 托盘的对外句柄。 */
export interface CorumTray {
  /** 更新未读数（主窗 renderer 推送；驱动标题文字 + tooltip + 菜单状态行）。 */
  setCount(count: ShellCount): void
  /**
   * 重建菜单栏菜单（勾选态变化后需要；未读数没变时不会走 `setCount` 的重建路径）。
   */
  refresh(): void
  /** 销毁托盘（退出前调用；否则 macOS 上会残留一个点不动的图标）。 */
  destroy(): void
}

/**
 * 构造托盘图标：**Template Image**（只取 alpha 通道）。
 *
 * 为什么必须走 template：品牌图标是「深色外框 + 浅色内部」的单色图形（同一份
 * 位图里既有接近黑也有接近白的像素）。直接当彩色图标用会**必然在一侧失效**——
 * 深色菜单栏下黑框看不见、浅色菜单栏下白内部看不见。template 让 macOS 只用
 * alpha 当形状，浅色模式画黑、深色模式画白，两种模式都自动正确。
 *
 * @param assetsDir - shell 静态资源目录（内含 `icon.png`）。
 * @returns 18pt 图标（含 @2x 表示）；资源缺失时返回空图标（托盘退化为「只有数字」）。
 */
function trayImage(assetsDir: string): Electron.NativeImage {
  const source = nativeImage.createFromPath(join(assetsDir, 'icon.png'))
  if (source.isEmpty()) return source
  const image = source.resize({ width: ICON_PT, height: ICON_PT, quality: 'best' })
  // @2x 表示：Retina 上按 36px 采样，不加会糊。
  // 用 `dataURL`（PNG）而不是 `buffer`：buffer 分支的语义是「原始像素」，
  // 传 PNG 字节在部分 Electron 版本上会被当成裸 RGBA 解出一张乱图；
  // dataURL 自带格式声明，无歧义。
  image.addRepresentation({
    scaleFactor: 2,
    width: ICON_PT * 2,
    height: ICON_PT * 2,
    dataURL: source.resize({ width: ICON_PT * 2, height: ICON_PT * 2, quality: 'best' }).toDataURL(),
  })
  image.setTemplateImage(true)
  return image
}

/**
 * 建 macOS 菜单栏托盘。
 *
 * 菜单保持**极简**（三条 + 一条状态行）：托盘是「回到应用」的入口，不是第二个
 * 主界面 —— 塞满菜单项是常见反模式（用户记不住两套功能树，也压缩了菜单栏价值）。
 * @param host - 窗口动作与资源目录。
 * @returns 托盘句柄；非 macOS 或创建失败时返回 null（调用方据此保持「关窗即退出」）。
 */
export function createCorumTray(host: CorumTrayHost): CorumTray | null {
  if (process.platform !== 'darwin') return null

  let count: ShellCount = { unread: 0, total: 0 }
  let tray: Tray
  try {
    tray = new Tray(trayImage(host.assetsDir))
  } catch (error) {
    // 托盘建不起来（极少数无 GUI 会话环境）：不允许它拖垮整个应用启动。
    process.stderr.write(`[corum-desktop] tray unavailable: ${String(error)}\n`)
    return null
  }

  /** 重建菜单（未读数或勾选态变化后必须重建：状态行与「通知中心」后缀都在菜单里）。 */
  const rebuildMenu = (): void => {
    tray.setContextMenu(buildShellMenu(count, host))
  }

  /**
   * 把未读状态同步到三处可见面：标题数字 / tooltip / 菜单状态行。
   *
   * 标题只在有未读时写：`setTitle('')` 让图标独占空间，菜单栏不常驻一个「0」。
   * `fontType: 'monospacedDigit'` 让 9→10 位宽变化时标题不左右跳动。
   */
  const apply = (): void => {
    tray.setTitle(count.unread > 0 ? countLabel(count.unread) : '', { fontType: 'monospacedDigit' })
    tray.setToolTip(count.unread > 0
      ? `矩道 Corum · ${count.unread} 条未读通知`
      : '矩道 Corum · 常驻运行中')
    rebuildMenu()
  }

  apply()
  // 自检（dev）：上报托盘在屏幕上的实际位置。菜单栏图标由系统绘制，DOM/CDP 都看不见，
  // 实机验证只能靠 `screencapture -R` 截这一块 —— 坐标先打出来，截图脚本才不用猜。
  // ⚠️ 多显示器下这个坐标是**相对托盘所在显示器**的，不是全桌面坐标系（实测：
  // 3 屏环境下返回 x=765，而 System Events 报的全局位置是 x=2448，差值正是该屏的
  // 原点偏移）—— 截图前先拿 `menu bar item 1 of menu bar 2` 的全局位置交叉验证。
  if (process.env.CORUM_DEV_HMR !== undefined) {
    process.stderr.write(`[corum-shell] tray bounds: ${JSON.stringify(tray.getBounds())}\n`)
    // 刚建好时取到的 bounds 还是占位值（实测 `{x:0,y:1117,w:34,h:0}` —— status item
    // 尚未布局），布局完成后再报一次，实机截图脚本以这一条为准。
    setTimeout(() => {
      process.stderr.write(`[corum-shell] tray bounds (settled): ${JSON.stringify(tray.getBounds())}\n`)
    }, 2000)
  }
  // 退出前必须销毁：macOS 上残留的 status item 会留一个点不动的空位。
  // 幂等：`before-quit` 可能因 quit() 重入触发多次，重复 destroy 会抛
  // "Object has been destroyed"。
  let destroyed = false
  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    tray.destroy()
  }
  app.on('before-quit', destroy)

  return {
    setCount: (next) => {
      // renderer 推来的数据一律当作不可信：钳成非负整数，避免出现 "-3 条未读"。
      const unread = Number.isFinite(next.unread) ? Math.max(0, Math.floor(next.unread)) : 0
      const total = Number.isFinite(next.total) ? Math.max(0, Math.floor(next.total)) : 0
      if (unread === count.unread && total === count.total) return
      count = { unread, total }
      // 自检（dev）：未读数只在 renderer 的 store 里，这里是「renderer → 主进程」
      // 唯一可观测的落点；菜单栏由系统绘制、DOM 看不见，实机验证要靠它 + 截图。
      if (process.env.CORUM_DEV_HMR !== undefined) {
        process.stderr.write(`[corum-shell] tray count ← ${unread}/${total}\n`)
      }
      apply()
    },
    refresh: rebuildMenu,
    destroy,
  }
}

// ── 首次常驻提示（一次性）─────────────────────────────────────────────────

/**
 * 取「常驻模式」一次性提示的展示资格。
 *
 * 为什么需要它：关窗从「退出应用」变成「收到菜单栏」是**改变用户既有预期**的行为，
 * 静默改掉会让人以为应用没退出干净、或以为关不掉。系统通知在未签名态发不出去
 * （见 `docs/ASSESSMENT-tray-floating-system-notification.md` §0.5），而此刻窗口
 * 恰好是隐藏的、应用内 toast 也看不见 —— 所以提示的**时机**改在下次启动、窗口还
 * 在的时候，经应用内通知中心给出，并只在第一次给。
 * @param resident - 本次是否真的处于托盘常驻模式（没有托盘就不提示）。
 * @returns `firstTime` 为 true 表示这次该提示（并已就地落盘，不会重复）。
 */
export function takeTrayResidentHint(resident: boolean): { resident: boolean; firstTime: boolean } {
  if (!resident) return { resident: false, firstTime: false }
  const state = readShellState()
  if (state.trayResidentHintShown === true) return { resident: true, firstTime: false }
  patchShellState({ trayResidentHintShown: true })
  return { resident: true, firstTime: true }
}
