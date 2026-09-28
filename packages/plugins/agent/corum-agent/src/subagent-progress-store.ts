/**
 * 子会话进度的**持久化折叠快照**（2026-09-28 卡顿修复 A2）。
 *
 * 为什么需要（打包态实测，`docs/PENDING-ui-lag-multiround.md` §2.10/§2.11）：
 * `getChildSessionProgressRemote` 每次调用都要读子会话的持久化日志再折叠——一个 4.8 万条事件的
 * 子会话要 **1.35 s**。A 修复让**重复**调用走内存快照（600ms → 9ms），但**冷启动的首次**仍要扫全量
 * 日志（实测每个 distinct 子会话 0.3–1.4 s；47 轮会话有 59 个子会话并发 ⇒ 打开应用后第一波仍卡）。
 *
 * 本模块把「折出来的进度」落成一份小 JSON：进程重启后第一次拉取直接读它 ⇒ 首次也是 O(1)。
 * 写盘策略由调用方决定（终态**立即**写、运行中**节流**写），本模块只管读/写与容量上限。
 *
 * @module @corum/corum-agent/subagent-progress-store
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { storagesRoot } from './kv-store-migration.ts'
import { writeJsonAtomic } from './workspace-identity.ts'
import type { ProgressState } from './child-progress.ts'

/** 落盘条目：折叠态 + 最近活动时刻（中断判定要用）。 */
export type DurableProgress = ProgressState & { readonly lastActive: number }

/** 文件格式版本（将来改形状时用它做迁移判据）。 */
export const SUBAGENT_PROGRESS_STORE_VERSION = 1

/**
 * 落盘条目上限（按 `lastActive` 保留最新的）。
 *
 * 为什么要上限：委派会不断累积，而无上限的文件既拖慢启动读取、又是一条磁盘泄漏。
 * 500 与内存表上限（`SUBAGENT_PROGRESS_CAP` = 200）同量级，足够覆盖近期会话。
 */
export const SUBAGENT_PROGRESS_STORE_CAP = 500

interface SubagentProgressStoreFile {
  readonly version: number
  readonly byId: Record<string, DurableProgress>
}

/** 落盘路径（`$CORUM_HOME/storages/subagent-progress.json`）。 */
export function subagentProgressStorePath(): string {
  return join(storagesRoot(), 'subagent-progress.json')
}

/**
 * 读落盘条目。
 *
 * 容错：文件不存在、坏 JSON、形状不对 ⇒ 一律当**空表**（绝不抛）。
 * 理由：这是**加速用的旁路数据**，不是事实源——它坏了只该退化成「慢一点」，不该让会话起不来。
 *
 * @param path - 文件路径（测试注入临时路径；生产用 {@link subagentProgressStorePath}）。
 * @returns `sessionId → 条目` 映射。
 */
export function readSubagentProgressStore(path: string = subagentProgressStorePath()): Record<string, DurableProgress> {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SubagentProgressStoreFile>
    const byId = parsed.byId
    if (byId === null || typeof byId !== 'object') return {}
    return byId as Record<string, DurableProgress>
  } catch {
    return {}
  }
}

/**
 * 写落盘条目（原子写 + 按 `lastActive` 截断到上限）。
 *
 * @param byId - 全量映射（本模块不做增量：条目数量级小，整文件写更简单也更不易出错）。
 * @param path - 文件路径（测试注入）。
 */
export function writeSubagentProgressStore(
  byId: Record<string, DurableProgress>,
  path: string = subagentProgressStorePath(),
): void {
  const kept = Object.entries(byId)
    .sort((left, right) => right[1].lastActive - left[1].lastActive)
    .slice(0, SUBAGENT_PROGRESS_STORE_CAP)
  const file: SubagentProgressStoreFile = {
    version: SUBAGENT_PROGRESS_STORE_VERSION,
    byId: Object.fromEntries(kept),
  }
  writeJsonAtomic(path, file)
}
