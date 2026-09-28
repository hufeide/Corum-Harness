/**
 * 子会话进度**落盘快照**（A2）契约测试。
 *
 * 为什么值得单独测：这份文件是**加速用的旁路数据**，它的正确性判据是「坏了只该慢，不该错、不该让会话起不来」：
 *   ① 往返：写进去的条目读得回来（冷启动 O(1) 的前提）；
 *   ② 容错：文件不存在 / 坏 JSON / 形状不对 ⇒ 空表，**不抛**；
 *   ③ 容量：超过上限时保留**最近活动**的（否则文件会随委派无上限增长）；
 *   ④ 版本字段：留给将来改形状时做迁移判据。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readSubagentProgressStore,
  writeSubagentProgressStore,
  SUBAGENT_PROGRESS_STORE_CAP,
  SUBAGENT_PROGRESS_STORE_VERSION,
  type DurableProgress,
} from '../src/subagent-progress-store.ts'

const tempPath = () => join(mkdtempSync(join(tmpdir(), 'corum-progress-')), 'subagent-progress.json')

const entry = (lastActive: number): DurableProgress => ({ turn: 1, step: 2, done: true, stopReason: 'completed', lastActive })

describe('subagent-progress-store（落盘快照）', () => {
  it('① 往返：写进去的条目读得回来', () => {
    const path = tempPath()
    writeSubagentProgressStore({ 'child-a': entry(100) }, path)
    expect(readSubagentProgressStore(path)).toEqual({ 'child-a': entry(100) })
  })

  it('② 文件不存在 ⇒ 空表（不抛）', () => {
    expect(readSubagentProgressStore(tempPath())).toEqual({})
  })

  it('② 坏 JSON ⇒ 空表（不抛；下次写会自愈）', () => {
    const path = tempPath()
    writeFileSync(path, '{ 这不是 JSON')
    expect(readSubagentProgressStore(path)).toEqual({})
  })

  it('② 形状不对（byId 不是对象）⇒ 空表', () => {
    const path = tempPath()
    writeFileSync(path, JSON.stringify({ version: 1, byId: 'nope' }))
    expect(readSubagentProgressStore(path)).toEqual({})
  })

  it('③ 超过上限 ⇒ 保留最近活动的那些', () => {
    const path = tempPath()
    const byId: Record<string, DurableProgress> = {}
    for (let i = 0; i < SUBAGENT_PROGRESS_STORE_CAP + 20; i += 1) byId[`child-${i}`] = entry(i)
    writeSubagentProgressStore(byId, path)
    const read = readSubagentProgressStore(path)
    expect(Object.keys(read)).toHaveLength(SUBAGENT_PROGRESS_STORE_CAP)
    // 最新的在、最旧的被裁掉。
    expect(read[`child-${SUBAGENT_PROGRESS_STORE_CAP + 19}`]).toBeDefined()
    expect(read['child-0']).toBeUndefined()
  })

  it('④ 文件带版本字段（改形状时做迁移判据）', () => {
    const path = tempPath()
    writeSubagentProgressStore({ 'child-a': entry(1) }, path)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version: number }
    expect(parsed.version).toBe(SUBAGENT_PROGRESS_STORE_VERSION)
  })
})
