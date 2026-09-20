/**
 * memory-policy 纯函数契约测试：分层派生 + 读时降权衰减 + 活跃判定 + 合并失效。
 *
 * 锁住底座「组织形式」的关键语义（用户拍板「只做读时降权，不做后台任务」）：
 *   - 分层由 importance × 时间窗派生；
 *   - 衰减是**读时**计算，不落库；到期事实 active=false 且 score=0（但不删）；
 *   - 访问强化：最近被检索命中的事实抗衰（半衰期 ×2）；
 *   - 合并失效：同 scope+entity+relation 的活跃事实是冲突候选。
 */
import { describe, expect, it } from 'vitest'
import type { MemoryFact } from '../src/memory-entities.ts'
import {
  tierFor,
  isActive,
  effectiveScoreFor,
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

describe('tierFor 分层派生', () => {
  it('importance >= 80 且未失效 → archival', () => {
    expect(tierFor(base({ importance: 80 }), NOW)).toBe('archival')
  })
  it('importance 50-79 → long', () => {
    expect(tierFor(base({ importance: 50 }), NOW)).toBe('long')
  })
  it('importance 20-49 → session', () => {
    expect(tierFor(base({ importance: 20 }), NOW)).toBe('session')
  })
  it('importance < 20 → transient', () => {
    expect(tierFor(base({ importance: 19 }), NOW)).toBe('transient')
  })
  it('已失效事实 → archival（历史降级）', () => {
    expect(tierFor(base({ importance: 50, invalidAt: NOW - 1 }), NOW)).toBe('archival')
  })
})

describe('isActive 活跃判定', () => {
  it('未设 invalidAt → active', () => {
    expect(isActive(base(), NOW)).toBe(true)
  })
  it('invalidAt 已过 → inactive', () => {
    expect(isActive(base({ invalidAt: NOW - 1 }), NOW)).toBe(false)
  })
  it('invalidAt 未到 → active', () => {
    expect(isActive(base({ invalidAt: NOW + 1000 }), NOW)).toBe(true)
  })
})

describe('effectiveScoreFor 读时降权', () => {
  it('到期事实 score = 0（不删，但不参与排序）', () => {
    expect(effectiveScoreFor(base({ invalidAt: NOW - 1 }), NOW)).toBe(0)
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

describe('conflictsToInvalidate 合并失效候选', () => {
  it('同 scope+entity+relation 的活跃事实是冲突候选', () => {
    const existing = [base(), base({ id: 'f2', entity: 'other' }), base({ id: 'f3', invalidAt: NOW - 1 })]
    const candidates = conflictsToInvalidate({ entity: 'corum-memory', relation: 'uses', scope: 'project' }, existing, NOW)
    expect(candidates.map(f => f.id)).toEqual(['f1'])
  })
  it('entity 和 relation 都为空时不判冲突（事实自成实体）', () => {
    const existing = [base({ entity: '', relation: '' })]
    expect(conflictsToInvalidate({ entity: '', relation: '', scope: 'project' }, existing, NOW)).toEqual([])
  })
})
