/**
 * 壳层状态文件（`~/.corum-desktop/shell.json`）。
 *
 * 存**主进程语义**的少量开关，与 `combos.json` 同目录同风格（`combos.ts` 先例）：
 *   - `trayResidentHintShown`：常驻模式的一次性引导是否已给过（`tray.ts`）；
 *   - `dockHidden`：是否隐藏 Dock 图标（只留菜单栏，`dock.ts`）。
 *
 * 为什么放壳层文件而不是设置中心：这些都是**随壳启动就要决定**的事（关窗是否退出、
 * Dock 图标在不在），等 host / 设置服务起来就晚了；而且它们属于「这台机器的壳层
 * 偏好」，不是产品级配置。
 *
 * @module corum-desktop/electron/shell-state
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'

/** 壳层状态文件路径（`~/.corum-desktop/shell.json`）。 */
export const SHELL_STATE_PATH = join(os.homedir(), '.corum-desktop', 'shell.json')

/** 壳层状态（字段全部可选：老文件缺字段时按缺省语义走）。 */
export interface ShellState {
  /** 常驻模式的一次性引导已展示（`takeTrayResidentHint`）。 */
  trayResidentHintShown?: boolean
  /** 隐藏 Dock 图标、只留菜单栏（`dock.ts`）。缺省 = 显示 Dock（并存模式）。 */
  dockHidden?: boolean
}

/** 读壳层状态（文件缺失/损坏一律当空状态，不能因为一个开关位挡住启动）。 */
export function readShellState(): ShellState {
  try {
    if (!existsSync(SHELL_STATE_PATH)) return {}
    const parsed: unknown = JSON.parse(readFileSync(SHELL_STATE_PATH, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as ShellState
  } catch {
    return {}
  }
}

/**
 * 写壳层状态（合并写：调用方只给要改的字段）。
 * @param patch - 要写入的字段。
 * @returns 写入后的完整状态（写失败时返回合并结果本身，调用方语义不受影响）。
 */
export function patchShellState(patch: ShellState): ShellState {
  const next = { ...readShellState(), ...patch }
  try {
    mkdirSync(dirname(SHELL_STATE_PATH), { recursive: true })
    writeFileSync(SHELL_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch (error) {
    process.stderr.write(`[corum-desktop] shell state write failed: ${String(error)}\n`)
  }
  return next
}
