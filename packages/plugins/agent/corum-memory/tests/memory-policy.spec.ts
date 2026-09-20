/**
 * memory-policy 纯函数契约测试：存续期 + 衰减 + 适用/留存判定 + 合并 + 持久化判定。
 *
 * 锁住底座「组织形式」的关键语义：
 *   - 两个正交时间：断言窗口（validAt→invalidAt）决定 applicable；
 *     存续期（retention→expiresAt）决定 retained；
 *   - 衰减是读时计算，不落库；记忆被遗忘（expiresAt 已过）→ score=0，
 *     断言到期（invalidAt 已过）**不**归零；
 *   - 持久化判定：显式 permanent / author=user→long / 读阈值→long；
 *   - 访问强化：最近被检索命中 → 抗衰。
 */
import { describe, expect, it } from 'vitest'
import type { MemoryFact } from '../src/memory-entities.ts'
import {
  expiresAtFor,
  resolveRetentionOnWrite,
  promoteRetentionOnRead,
  isApplicable,
  isRetained,
  effectiveScoreFor,
  scoreMatch,
  toView,
  conflictsToInvalidate,
  READ_PROMOTE_THRESHOLD,
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
    retention: 'temporary',
    expiresAt: null,
    readCount: 0,
    supersedes: [],
    evidence: [],
    author: 'system',
    createdAt: NOW - 10 * 24 * 60 * 60 * 1000,
    lastAccessedAt: null,
    ...overrides,
  }
}

describe('expiresAtFor 存续期 TTL', () => {
  it('temporary → 2 天', () => {
    expect(expiresAtFor('temporary', NOW)).toBe(NOW + 2 * 24 * 60 * 60 * 1000)
  })
  it('short → 3 个月（约 90 天）', () => {
    expect(expiresAtFor('short', NOW)).toBe(NOW + 3 * 30 * 24 * 60 * 60 * 1000)
  })
  it('long → 1 年', () => {
    expect(expiresAtFor('long', NOW)).toBe(NOW + 365 * 24 * 60 * 60 * 1000)
  })
  it('permanent → null（永不）', () => {
    expect(expiresAtFor('permanent', NOW)).toBeNull()
  })
})

describe('resolveRetentionOnWrite 持久化判定（写入时）', () => {
  it('显式 permanent（纪律/永久事实源）→ permanent', () => {
    expect(resolveRetentionOnWrite('permanent', 'agent:s1')).toBe('permanent')
  })
  it('显式 long → long', () => {
    expect(resolveRetentionOnWrite('long', 'agent:s1')).toBe('long')
  })
  it('author=user（手动添加）→ long，即使未声明', () => {
    expect(resolveRetentionOnWrite(undefined, 'user')).toBe('long')
    expect(resolveRetentionOnWrite('temporary', 'user')).toBe('long')
  })
  it('未声明且非 user → temporary（默认）', () => {
    expect(resolveRetentionOnWrite(undefined, 'agent:s1')).toBe('temporary')
  })
})

describe('promoteRetentionOnRead 持久化升级（读阈值）', () => {
  it('readCount 达阈值 → long', () => {
    expect(promoteRetentionOnRead(base({ retention: 'temporary', readCount: READ_PROMOTE_THRESHOLD }))).toBe('long')
  })
  it('readCount 未达阈值 → 保持原档', () => {
    expect(promoteRetentionOnRead(base({ retention: 'temporary', readCount: READ_PROMOTE_THRESHOLD - 1 }))).toBe('temporary')
  })
  it('已是 permanent 不降级', () => {
    expect(promoteRetentionOnRead(base({ retention: 'permanent', readCount: READ_PROMOTE_THRESHOLD }))).toBe('permanent')
  })
})

describe('isApplicable 适用判定（断言窗口，与留存无关）', () => {
  it('未设 invalidAt → applicable', () => {
    expect(isApplicable(base(), NOW)).toBe(true)
  })
  it('invalidAt 已过 → 不 applicable（断言到期，但非遗忘）', () => {
    expect(isApplicable(base({ invalidAt: NOW - 1 }), NOW)).toBe(false)
  })
  it('validAt 未到 → 不 applicable', () => {
    expect(isApplicable(base({ validAt: NOW + 1000, invalidAt: null }), NOW)).toBe(false)
  })
})

describe('isRetained 留存判定（存续期，与断言无关）', () => {
  it('permanent（expiresAt=null）恒 retained', () => {
    expect(isRetained(base({ retention: 'permanent', expiresAt: null }), NOW)).toBe(true)
  })
  it('expiresAt 已过 → 不 retained（真正遗忘）', () => {
    expect(isRetained(base({ retention: 'temporary', expiresAt: NOW - 1 }), NOW)).toBe(false)
  })
  it('expiresAt 未到 → retained', () => {
    expect(isRetained(base({ retention: 'short', expiresAt: NOW + 1000 }), NOW)).toBe(true)
  })
  it('断言到期（invalidAt 已过）不影响 retained', () => {
    expect(isRetained(base({ invalidAt: NOW - 1, expiresAt: null }), NOW)).toBe(true)
  })
})

describe('effectiveScoreFor 读时降权（记忆强度）', () => {
  it('记忆被遗忘（expiresAt 已过）→ score=0', () => {
    expect(effectiveScoreFor(base({ retention: 'temporary', expiresAt: NOW - 1 }), NOW)).toBe(0)
  })
  it('断言到期（invalidAt 已过）不归零', () => {
    // 用 long 档（半衰期半年，age=10 天几乎不衰），避免 temporary 短半衰期把分衰减到 0
    // 干扰「断言到期 vs 记忆遗忘」的区分。
    expect(effectiveScoreFor(base({ retention: 'long', invalidAt: NOW - 1, expiresAt: null }), NOW)).toBeGreaterThan(0)
  })
  it('刚成立的事实保持 importance 满分', () => {
    const fresh = base({ validAt: NOW, createdAt: NOW })
    expect(effectiveScoreFor(fresh, NOW)).toBe(fresh.importance)
  })
  it('越老衰减越狠（指数半衰期）', () => {
    const young = base({ validAt: NOW - 1_000 })
    const old = base({ validAt: NOW - 180 * 24 * 60 * 60 * 1000 })
    expect(effectiveScoreFor(young, NOW)).toBeGreaterThan(effectiveScoreFor(old, NOW))
  })
  it('访问强化：最近被检索命中 → 抗衰（分数更高）', () => {
    const accessed = base({ lastAccessedAt: NOW - 1_000 })
    const untouched = base({ lastAccessedAt: null })
    expect(effectiveScoreFor(accessed, NOW)).toBeGreaterThan(effectiveScoreFor(untouched, NOW))
  })
})

describe('toView 派生视图（三维正交）', () => {
  it('断言到期：applicable=false 但 retained=true 且 score>0', () => {
    const v = toView(base({ importance: 80, invalidAt: NOW - 1, retention: 'permanent', expiresAt: null }), NOW)
    expect(v.applicable).toBe(false)
    expect(v.retained).toBe(true)
    expect(v.effectiveScore).toBeGreaterThan(0)
  })
  it('存续期耗尽：retained=false 且 score=0', () => {
    const v = toView(base({ retention: 'temporary', expiresAt: NOW - 1 }), NOW)
    expect(v.retained).toBe(false)
    expect(v.effectiveScore).toBe(0)
  })
})

describe('scoreMatch 多策略匹配打分', () => {
  it('fact 文本命中权重最高（4）', () => {
    const f = base({ fact: '用户偏好深色模式' })
    expect(scoreMatch(f, '深色')).toBe(4)
  })
  it('entity 命中（3）', () => {
    const f = base({ entity: 'stack', fact: '无关事实' })
    expect(scoreMatch(f, 'stack')).toBe(3)
  })
  it('relation 命中（2）', () => {
    const f = base({ relation: 'uses', fact: '无关事实' })
    expect(scoreMatch(f, 'uses')).toBe(2)
  })
  it('source/evidence 命中（1）', () => {
    const f = base({ source: 'session-123', fact: '无关事实' })
    expect(scoreMatch(f, 'session')).toBe(1)
  })
  it('多字段同时命中则叠加', () => {
    const f = base({ fact: 'stack uses Postgres', entity: 'stack', relation: 'uses' })
    // fact 命中(4) + entity 命中(3) = 7（relation 'uses' 不含 'stack'，不命中）
    expect(scoreMatch(f, 'stack')).toBe(7)
  })
  it('无命中返回 0', () => {
    expect(scoreMatch(base({ fact: '用户偏好深色模式' }), '不存在')).toBe(0)
  })
  it('空 query 返回 0', () => {
    expect(scoreMatch(base(), '')).toBe(0)
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
