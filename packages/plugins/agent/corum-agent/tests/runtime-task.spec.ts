/**
 * P2-6（.dbg/event-bus-audit-2026-09.md）：TaskRef 声明与构造口径对账。
 *
 * 缺陷面：`Task.label` 在类型上必填，但历史事件/旧调用可能缺省（`normalizeTask`
 * 的 undefined 检查即为此）；`taskRef` 直接透传会把 undefined 写进 `corum/task/*`
 * 领域事件载荷（路由键失效）。本 spec 钉死「label 恒为 laneLabel 口径、空
 * transferNote 不进载荷」两条不变量。
 */
import { describe, expect, it } from 'vitest'
import { laneLabel, makeTaskSource, normalizeTask, taskRef, type Task } from '../src/runtime-task.ts'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    projectId: 'p-1',
    profileId: 'dev',
    entityType: 'task',
    label: 'req-1:dev',
    type: 'dev',
    summary: '把模块拆成三块',
    source: makeTaskSource('user', {}),
    status: 'pending',
    ...overrides,
  }
}

describe('laneLabel — 泳道路由标签口径', () => {
  it('关联需求 → <requirementId>:<type>；未关联/空串 → <type>', () => {
    expect(laneLabel('dev', 'req-1')).toBe('req-1:dev')
    expect(laneLabel('dev')).toBe('dev')
    expect(laneLabel('dev', '')).toBe('dev')
  })
})

describe('normalizeTask — 补全队列条目缺省', () => {
  it('缺 label → 按 laneLabel 兜底', () => {
    const normalized = normalizeTask(task({ label: undefined as unknown as string }))
    expect(normalized.label).toBe('dev')
  })

  it('已有 label 原样保留', () => {
    expect(normalizeTask(task()).label).toBe('req-1:dev')
  })

  it('缺 source → 由 actor 构造（缺 actor 回落 user）', () => {
    const normalized = normalizeTask(task({ source: undefined as unknown as Task['source'], actor: 'runtime' }))
    expect(normalized.source.via).toBe('dependency')
  })
})

describe('taskRef — 领域事件载荷（P2-6 不变量）', () => {
  it('label 缺省时按 laneLabel 兜底，绝不产出 undefined（路由键失效防护）', () => {
    const ref = taskRef(task({ label: undefined as unknown as string, type: 'dev', requirementId: 'req-9' }))
    expect(ref.label).toBe('req-9:dev')
    expect(ref.label).not.toBeUndefined()
  })

  it('label 为空串时同样兜底', () => {
    expect(taskRef(task({ label: '', type: 'qa' })).label).toBe('qa')
  })

  it('transferNote 空串不进载荷（声明可选即构造口径）', () => {
    expect('transferNote' in taskRef(task({ transferNote: '' }))).toBe(false)
    expect('transferNote' in taskRef(task({ transferNote: undefined }))).toBe(false)
  })

  it('transferNote 非空原样进载荷', () => {
    expect(taskRef(task({ transferNote: '上下文一句话' })).transferNote).toBe('上下文一句话')
  })

  it('可选字段（entityId/requirementId/priority）缺省时不出现在载荷里', () => {
    const ref = taskRef(task())
    expect('entityId' in ref).toBe(false)
    expect('priority' in ref).toBe(false)
    expect(ref.requirementId).toBeUndefined()
  })
})
