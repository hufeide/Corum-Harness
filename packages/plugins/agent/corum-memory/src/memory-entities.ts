/**
 * corum 记忆底座 —— 事实实体 schema 与存储域声明。
 *
 * 设计（讨论定稿）：
 *   - 最小单元是「事实」而非消息/文档：一条带元数据的原子断言。
 *   - 存储复用官方 dsh-storage-domain（defineDomain + domainTable），零 fork。
 *   - 单一域 `corum_memory`、单表 `facts`，key = factId；scope 字段区分
 *     agent / project / global，检索时按 scope 过滤。
 *   - 「记什么」由写入方决定（schema 只是容器形状，不绑定领域）；底座只承载
 *     「组织形式」。
 *
 * **存续期（retention）** —— 一等落库字段，四档，决定记忆**本身**存多久：
 *   - temporary（临时，1~3 天）/ short（短期，3 个月）/ long（长期，半年以上）
 *     / permanent（永久）。
 *   - `expiresAt` = 记忆消亡时刻（createdAt + 该档 TTL；permanent 为 null 永不）。
 *   - 到 `expiresAt` → `retained` 变 false（记忆**本身**被遗忘），与 `invalidAt`
 *     （断言不再成立）是**两个正交的时间概念**——见 memory-policy.ts。
 *
 * **持久化判定（4 规则，写入时 + 读时）**：
 *   1. 用户明确要求的纪律 → permanent（写入方显式声明 retention='permanent'）；
 *   2. 可判定永久的事实来源 → permanent（同上，写入方显式声明）；
 *   3. 用户手动添加（author='user'）→ long；
 *   4. 多次读取到阈值（readCount ≥ 5）→ long（读时升级，见 service）。
 *
 * @module @corum/corum-memory/memory-entities
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 记忆作用域：agent（跨会话 Agent 记忆）/ project（项目库记忆）/ global（全局）。 */
export const memoryScopeSchema = z.enum(['agent', 'project', 'global'])
export type MemoryScope = z.infer<typeof memoryScopeSchema>

/** 记忆存续期（retention）四档：决定记忆**本身**存多久。 */
export const memoryRetentionSchema = z.enum(['temporary', 'short', 'long', 'permanent'])
export type MemoryRetention = z.infer<typeof memoryRetentionSchema>

/**
 * 事实记录（落库 schema）。
 *
 * 字段语义：
 *   - entity：规范化实体标识（如 'corum-memory'、'user:alice'）。空串 = 事实自成
 *     一个实体。写时实体解析不在底座内（后续接 Graphiti 或调用方自解），底座只存。
 *   - relation：关系名（如 'uses'、'owns'、'prefers'）；纯标签，不强制三元组。
 *   - fact：原子事实文本（唯一必填）。
 *   - importance：重要性 0-100，写入门槛 + 衰减基数（0.5^(age/halfLife) 的分子）。
 *   - validAt / invalidAt：事实**断言**成立/失效时间窗（epoch ms）。null = 无界。
 *     断言过期 ≠ 记忆遗忘（见 retention/expiresAt）。
 *   - retention：记忆存续期（temporary/short/long/permanent），决定 expiresAt 与
 *     衰减半衰期。
 *   - expiresAt：记忆**本身**消亡时刻（epoch ms）；permanent 为 null（永不）。
 *   - readCount：被检索命中的累计次数，达阈值触发持久化升级（→ long）。
 *   - supersedes：本条事实显式取代的旧事实 id（recency-wins 合并的数据基础）。
 *   - evidence：证据链（会话 id / 文件路径 / 人工录入出处），支持「回到原文」。
 *   - author：写入者（'user' | 'system' | 'agent:<sessionId>'）；author='user'
 *     即「手动添加」→ 持久化判定规则 3（→ long）。
 *   - lastAccessedAt：最近一次被检索命中的时间（访问强化：刚被用到的事实抗衰）。
 */
export const memoryFactSchema = z.object({
  id: z.string().min(1),
  entity: z.string().default(''),
  relation: z.string().default(''),
  fact: z.string().min(1),
  importance: z.number().int().min(0).max(100).default(50),
  validAt: z.number().int().nonnegative().nullable().default(null),
  invalidAt: z.number().int().nonnegative().nullable().default(null),
  source: z.string().default(''),
  scope: memoryScopeSchema,
  retention: memoryRetentionSchema.default('temporary'),
  expiresAt: z.number().int().nonnegative().nullable().default(null),
  readCount: z.number().int().nonnegative().default(0),
  supersedes: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  author: z.string().default('system'),
  createdAt: z.number().int().nonnegative(),
  lastAccessedAt: z.number().int().nonnegative().nullable().default(null),
})
export type MemoryFact = z.infer<typeof memoryFactSchema>

/** 事实表：key = factId（裸 id，无前缀——域已按 scope 检索，不需复合键）。 */
export function memoryTables() {
  return {
    facts: domainTable<string, MemoryFact>(memoryFactSchema),
  } as const
}

/** 记忆域声明（纯声明，无 IO）。 */
export function memoryDomainSpec() {
  return defineDomain({
    name: 'corum_memory',
    version: 1,
    layout: 'per-record',
    tables: memoryTables(),
  })
}

/** 事实的派生视图：存储字段 + 读时计算的记忆强度与适用/留存。 */
export interface MemoryFactView extends MemoryFact {
  /** 读时降权后的记忆强度（派生，不落库）：检索排序依据；不因断言到期归零。 */
  readonly effectiveScore: number
  /** 当前是否「适用/成立」（派生，不落库）：validAt→invalidAt 断言窗口内为真。 */
  readonly applicable: boolean
  /** 是否「还被记住」（派生，不落库）：now < expiresAt；permanent 恒真。 */
  readonly retained: boolean
}
