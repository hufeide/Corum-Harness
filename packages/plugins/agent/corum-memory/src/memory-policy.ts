/**
 * corum 记忆底座 —— 纯函数层：分层派生 + 衰减（读时降权）+ 活跃判定。
 *
 * 全部无状态纯函数，不落库、无后台任务、可单测。底座只提供「组织形式」：
 *   - tierFor：由 importance × 时间窗派生分层（transient/session/long/archival）。
 *   - effectiveScoreFor：由 importance × 时间衰减 × 访问强化派生有效分。
 *   - isActive：由 invalidAt + validAt 判定当前是否有效。
 *   - toView：合并三者成 MemoryFactView。
 *
 * 衰减策略（用户拍板「只做读时降权，不做后台任务」）：
 *   - 指数衰减，半衰期由分层决定：archival 几乎不衰、long 慢衰、session 快衰、
 *     transient 极快衰。检索排序时实时算，可逆、零后台风险。
 *   - 访问强化：lastAccessedAt 越近，衰减越缓（刚被用到的事实抗衰）。
 *   - 到期事实（invalidAt 已过）不参与检索排序（active=false 被过滤），但**不删**。
 *
 * @module @corum/corum-memory/memory-policy
 */

import type { MemoryFact, MemoryFactView, MemoryTier } from './memory-entities.ts'

/** 各分层的衰减半衰期（毫秒）。archival 半衰期极长 → 几乎不衰。 */
export const TIER_HALF_LIFE_MS: Record<MemoryTier, number> = {
  transient: 30 * 60 * 1000, // 30 分钟
  session: 6 * 60 * 60 * 1000, // 6 小时
  long: 30 * 24 * 60 * 60 * 1000, // 30 天
  archival: 365 * 24 * 60 * 60 * 1000, // 1 年
}

/** 访问强化窗口：lastAccessedAt 在此窗口内时，衰减放缓（×0.5）。 */
export const ACCESS_BOOST_WINDOW_MS = 24 * 60 * 60 * 1000 // 1 天

/** 分层阈值：importance 低于此值则降档（权重按 tier 时间常数）。 */
export const TIER_IMPORTANCE_FLOOR: Record<MemoryTier, number> = {
  transient: 0,
  session: 20,
  long: 50,
  archival: 80,
}

/**
 * 由 importance × 时间窗派生分层。
 *
 * 规则：
 *   - invalidAt 已过 → archival（已失效事实只在「查看历史」时出现，最低优先级）。
 *   - importance >= 80 且无 invalidAt → archival（稳定高价值事实）。
 *   - importance >= 50 → long。
 *   - importance >= 20 → session。
 *   - 其余 → transient。
 */
export function tierFor(fact: MemoryFact, now: number = Date.now()): MemoryTier {
  const expired = fact.invalidAt !== null && fact.invalidAt <= now
  if (expired) return 'archival'
  if (fact.invalidAt === null && fact.importance >= 80) return 'archival'
  if (fact.importance >= 50) return 'long'
  if (fact.importance >= 20) return 'session'
  return 'transient'
}

/** 当前是否有效：未被失效、且（若设了 invalidAt）未到期。 */
export function isActive(fact: MemoryFact, now: number = Date.now()): boolean {
  if (fact.invalidAt !== null && fact.invalidAt <= now) return false
  return true
}

/**
 * 读时降权后的有效分（0-100）。
 *
 * 指数衰减：score = importance × 0.5^(age / halfLife)。
 *   - age 由 validAt（缺省用 createdAt）起算，到 now。
 *   - 访问强化：lastAccessedAt 在窗口内则半衰期翻倍（衰减放缓一半）。
 *   - 到期事实直接 0（不参与排序）。
 */
export function effectiveScoreFor(fact: MemoryFact, now: number = Date.now()): number {
  if (!isActive(fact, now)) return 0
  const tier = tierFor(fact, now)
  const halfLife = TIER_HALF_LIFE_MS[tier]
  const born = fact.validAt ?? fact.createdAt
  const age = Math.max(0, now - born)

  // 访问强化：最近被检索命中 → 半衰期 ×2（抗衰）。
  let effectiveHalfLife = halfLife
  if (fact.lastAccessedAt !== null && now - fact.lastAccessedAt <= ACCESS_BOOST_WINDOW_MS) {
    effectiveHalfLife = halfLife * 2
  }

  const score = fact.importance * Math.pow(0.5, age / effectiveHalfLife)
  return Math.round(score * 100) / 100
}

/** 合并成派生视图。 */
export function toView(fact: MemoryFact, now: number = Date.now()): MemoryFactView {
  return {
    ...fact,
    tier: tierFor(fact, now),
    effectiveScore: effectiveScoreFor(fact, now),
    active: isActive(fact, now),
  }
}

/**
 * 合并裁决（recency-wins with explicit invalidation）：写入一条新事实时，
 * 若它与某条已存在的「同 entity + 同 relation」事实冲突，旧事实应被标
 * invalidAt（失效），并把新事实的 supersedes 指向旧事实 id——不物理删除。
 *
 * 本函数是**纯判定**：输入候选新事实 + 现存事实集合，输出「哪些旧事实该失效」。
 * 实际写库在 service 层（它负责读表、调用本函数、再写回）。
 */
export function conflictsToInvalidate(
  incoming: Pick<MemoryFact, 'entity' | 'relation' | 'scope'>,
  existing: readonly MemoryFact[],
  now: number = Date.now(),
): MemoryFact[] {
  if (incoming.entity === '' && incoming.relation === '') return []
  return existing.filter(f =>
    f.scope === incoming.scope &&
    f.entity === incoming.entity &&
    f.relation === incoming.relation &&
    isActive(f, now),
  )
}
