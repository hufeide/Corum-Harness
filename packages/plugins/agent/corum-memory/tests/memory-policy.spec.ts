/**
 * memory-policy 纯函数契约测试：分层派生 + 读时降权衰减 + 适用/留存判定 + 合并失效。
 *
 * 核心语义（对齐 Graphiti）——**「失效 ≠ 忘记」**，三个正交维度：
 *   - 分层只由 importance 决定（到期不改变「它是什么」）；
 *   - applicable（适用）由 validAt→invalidAt 窗口决定；到期翻转 applicable，
 *     但**不影响** retained（留存）与 effectiveScore（记忆强度）；
 *   - effectiveScore 是记忆强度，**不因到期归零**；
 *   - 合并失效只针对「当前 applicable」的同 entity+relation 事实。
 */
import { describe, expect, it } from 'vitest'
import type { MemoryFact } from '../src/memory-entities.ts'
import {
  tierFor,
  isApplicable,
  isRetained,
  effectiveScoreFor,
  toView,
  conflictsToInvalidate,
} from '../src/memory-policy.ts'

const NOW = 1_800_000_000_000 // 固定 now，测试可复现

function base(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: 'f1',
    entity: 'corum-memory',
    relation: 'uses',
    fact: 'corum-memory uses dsh-storage-domain',
    importance: 50,
    validAt: NOW - 10 * 24 * 60 * 60 * 1000, // 10 天前成立
    invalidAt: null,
    source: 'test',
    scope: 'project',
    supersedes: [],
    evidence: [],
    author: 'system',
    createdAt: NOW - 10 * 24 * 60 * 60 * 1000,
    lastAccessedAt: null,
    ...overrides,
  }
}

describe('tierFor 分层派生（只由 importance 决定）', () => {
  it('importance >= 80 → archival', () => {
    expect(tierFor(base({ importance: 80 }))).toBe('archival')
  })
  it('importance 50-79 → long', () => {
    expect(tierFor(base({ importance: 50 }))).toBe('long')
  })
  it('importance 20-49 → session', () => {
    expect(tierFor(base({ importance: 20 }))).toBe('session')
  })
  it('importance < 20 → transient', () => {
    expect(tierFor(base({ importance: 19 }))).toBe('transient')
  })
  it('到期不改变分层（失效 ≠ 降级为 archival）', () => {
    // 关键修正：到期不再把分层改写成 archival；importance 50 到期后仍是 long。
    expect(tierFor(base({ importance: 50, invalidAt: NOW - 1 }))).toBe('long')
  })
})

describe('isApplicable 适用判定（成立窗口，与留存无关）', () => {
  it('未设 invalidAt → applicable', () => {
    expect(isApplicable(base(), NOW)).toBe(true)
  })
  it('invalidAt 已过 → 不 applicable（到期，但非忘记）', () => {
    expect(isApplicable(base({ invalidAt: NOW - 1 }), NOW)).toBe(false)
  })
  it('invalidAt 未到 → applicable', () => {
    expect(isApplicable(base({ invalidAt: NOW + 1000 }), NOW)).toBe(true)
  })
  it('validAt 未到（未来才成立）→ 不 applicable', () => {
    expect(isApplicable(base({ validAt: NOW + 1000, invalidAt: null }), NOW)).toBe(false)
  })
  it('validAt 为 null → 自创建起成立', () => {
    expect(isApplicable(base({ validAt: null, invalidAt: null }), NOW)).toBe(true)
  })
})

describe('isRetained 留存判定（忘记 = 显式删除）', () => {
  it('记录存在即被记住，到期不影响留存', () => {
    expect(isRetained(base({ invalidAt: NOW - 1 }))).toBe(true)
  })
})

describe('effectiveScoreFor 读时降权（记忆强度，不因到期归零）', () => {
  it('到期事实仍有正分数（不再 applicable，但记忆强度保留）', () => {
    const expired = base({ invalidAt: NOW - 1 })
    expect(effectiveScoreFor(expired, NOW)).toBeGreaterThan(0)
  })
  it('刚成立的事实保持 importance 满分', () => {
    const fresh = base({ validAt: NOW, createdAt: NOW })
    expect(effectiveScoreFor(fresh, NOW)).toBe(fresh.importance)
  })
  it('越老衰减越狠（指数半衰期）', () => {
    const young = base({ validAt: NOW - 1_000 }) // 1 秒前
    const old = base({ validAt: NOW - 30 * 24 * 60 * 60 * 1000 }) // 30 天前
    expect(effectiveScoreFor(young, NOW)).toBeGreaterThan(effectiveScoreFor(old, NOW))
  })
  it('访问强化：最近被检索命中 → 抗衰（分数更高）', () => {
    const accessed = base({ lastAccessedAt: NOW - 1_000 }) // 1 秒前访问
    const untouched = base({ lastAccessedAt: null })
    expect(effectiveScoreFor(accessed, NOW)).toBeGreaterThan(effectiveScoreFor(untouched, NOW))
  })
})

describe('toView 派生视图（三维正交）', () => {
  it('到期事实：applicable=false 但 retained=true 且 effectiveScore>0', () => {
    const v = toView(base({ importance: 80, invalidAt: NOW - 1 }), NOW)
    expect(v.applicable).toBe(false)
    expect(v.retained).toBe(true)
    expect(v.effectiveScore).toBeGreaterThan(0)
    expect(v.tier).toBe('archival') // importance 80 → archival，与到期无关
  })
})

describe('conflictsToInvalidate 合并失效候选', () => {
  it('同 scope+entity+relation 且当前 applicable 的事实是冲突候选', () => {
    const existing = [base(), base({ id: 'f2', entity: 'other' }), base({ id: 'f3', invalidAt: NOW - 1 })]
    const candidates = conflictsToInvalidate({ entity: 'corum-memory', relation: 'uses', scope: 'project' }, existing, NOW)
    expect(candidates.map(f => f.id)).toEqual(['f1'])
  })
  it('已到期（不 applicable）的旧事实不再参与冲突判定', () => {
    const existing = [base({ id: 'f3', invalidAt: NOW - 1 })]
    expect(conflictsToInvalidate({ entity: 'corum-memory', relation: 'uses', scope: 'project' }, existing, NOW)).toEqual([])
  })
  it('entity 和 relation 都为空时不判冲突（事实自成实体）', () => {
    const existing = [base({ entity: '', relation: '' })]
    expect(conflictsToInvalidate({ entity: '', relation: '', scope: 'project' }, existing, NOW)).toEqual([])
  })
})
