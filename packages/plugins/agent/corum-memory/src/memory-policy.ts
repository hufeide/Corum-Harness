/**
 * corum 记忆底座 —— 纯函数层：分层派生 + 衰减（读时降权）+ 适用/留存判定。
 *
 * 全部无状态纯函数，不落库、无后台任务、可单测。底座只提供「组织形式」。
 *
 * **核心语义（对齐 Graphiti 的时间知识图）——「失效 ≠ 忘记」**：
 *   一条事实的生命周期有**三个正交维度**，绝不用同一个字段/判定混在一起：
 *   - **适用窗口**（validAt → invalidAt）：事实**断言**何时为真（内容属性）。
 *   - **适用性**（applicable）：当前是否「成立、该驱动行为」。到期 → 不再适用，
 *     但**不影响留存**。
 *   - **留存**（retained）：作为「发生过的事」是否还被记住。到期**永不**自动忘记；
 *     忘记只来自**显式删除**（物理层），或未来更高层的显式裁决。
 *
 *   例：用户要求「10月31日前每天提醒日程」。10/31 前 applicable（提醒），
 *   11/1 后不再 applicable（不提醒），但作为「发生过的事」依然 retained、可被
 *   recall 检索召回。
 *
 * 检索因此拆成两种：
 *   - **applicable 检索**（默认）：只返回当前适用的事实，供 Agent 驱动当前行为。
 *   - **recall 检索**：返回全部（含已到期/失效），回忆「发生过什么」。
 *
 * 衰减策略（用户拍板「只做读时降权，不做后台任务」）：
 *   - effectiveScore 是**记忆强度**（importance × 时间衰减 × 访问强化），
 *     **不因到期归零**——它度量「还记得多牢」，不是「还适用吗」。
 *   - 适用性 applicable 是独立的布尔维度，不进分数。
 *   - 无后台定时器：applicable 每次读时实时算，可逆、零后台风险。
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

/** 访问强化窗口：lastAccessedAt 在此窗口内时，衰减放缓（半衰期 ×2）。 */
export const ACCESS_BOOST_WINDOW_MS = 24 * 60 * 60 * 1000 // 1 天

/**
 * 由 importance 派生分层。
 *
 * 规则（**只由 importance 决定，不看时间窗**——到期不改变「它是什么」）：
 *   - importance >= 80 → archival（稳定高价值事实）。
 *   - importance >= 50 → long。
 *   - importance >= 20 → session。
 *   - 其余 → transient。
 */
export function tierFor(fact: MemoryFact): MemoryTier {
  if (fact.importance >= 80) return 'archival'
  if (fact.importance >= 50) return 'long'
  if (fact.importance >= 20) return 'session'
  return 'transient'
}

/**
 * 当前是否「适用/成立」（该驱动行为）。
 *
 * 适用窗口为 [validAt, invalidAt)，两端开闭：
 *   - validAt === null → 自创建起成立；否则要求 now >= validAt。
 *   - invalidAt === null → 永不失效；否则要求 now < invalidAt。
 *
 * ⚠️ 此判定**只回答「现在成立吗」**，与「是否还被记住」（retained）无关。
 */
export function isApplicable(fact: MemoryFact, now: number = Date.now()): boolean {
  const born = fact.validAt === null || fact.validAt <= now
  const alive = fact.invalidAt === null || now < fact.invalidAt
  return born && alive
}

/**
 * 是否还被记住。
 *
 * 语义上：记录存在即被记住（忘记 = 显式删除 = 记录不存在）。到期**不**影响留存。
 * 保留为显式概念，供未来扩展（如 TTL 归档、批量遗忘裁决）时挂接。
 */
export function isRetained(_fact: MemoryFact): boolean {
  return true
}

/**
 * 读时降权后的记忆强度（0-100），**不因到期归零**。
 *
 * 指数衰减：score = importance × 0.5^(age / halfLife)。
 *   - age 由 validAt（缺省用 createdAt）起算，到 now。
 *   - 访问强化：lastAccessedAt 在窗口内则半衰期翻倍（衰减放缓一半）。
 *   - 到期事实仍有正分数——它只是不再「applicable」，仍是可 recall 的记忆。
 */
export function effectiveScoreFor(fact: MemoryFact, now: number = Date.now()): number {
  const tier = tierFor(fact)
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
    tier: tierFor(fact),
    effectiveScore: effectiveScoreFor(fact, now),
    applicable: isApplicable(fact, now),
    retained: isRetained(fact),
  }
}

/**
 * 合并裁决（recency-wins with explicit invalidation）：写入一条新事实时，
 * 若它与某条已存在的「同 entity + 同 relation」**且当前适用**的事实冲突，
 * 旧事实应被标 invalidAt（失效），并把新事实的 supersedes 指向旧事实 id——
 * 不物理删除。
 *
 * 本函数是**纯判定**：输入候选新事实 + 现存事实集合，输出「哪些旧事实该失效」。
 * 实际写库在 service 层（它负责读表、调用本函数、再写回）。
 * 已失效（不 applicable）的旧事实不再参与冲突判定——它已经失效，无需再标。
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
    isApplicable(f, now),
  )
}
