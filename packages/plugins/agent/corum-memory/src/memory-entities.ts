/**
 * corum 记忆底座 —— 事实实体 schema 与存储域声明。
 *
 * 设计（讨论定稿）：
 *   - 最小单元是「事实」而非消息/文档：一条带元数据的原子断言。
 *   - 存储复用官方 dsh-storage-domain（defineDomain + domainTable），零 fork。
 *   - 单一域 `corum_memory`、单表 `facts`，key = factId；scope 字段区分
 *     agent / project / global，检索时按 scope 过滤。
 *   - 「记什么」由写入方决定（schema 只是容器形状，不绑定领域）；底座只承载
 *     「组织形式」：重要性、时间窗（validAt/invalidAt）、合并（supersedes）、
 *     衰减（读时降权）、驱逐（invalidAt 失效标记 + 硬删除）。
 *
 * 分层（tier）与有效分（effectiveScore）都是**派生视图**，不落库——单一事实源
 * 是 importance / validAt / invalidAt / lastAccessedAt，见 memory-policy.ts。
 *
 * @module @corum/corum-memory/memory-entities
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'

/** 记忆作用域：agent（跨会话 Agent 记忆）/ project（项目库记忆）/ global（全局）。 */
export const memoryScopeSchema = z.enum(['agent', 'project', 'global'])
export type MemoryScope = z.infer<typeof memoryScopeSchema>

/**
 * 事实记录（落库 schema）。
 *
 * 字段语义：
 *   - entity：规范化实体标识（如 'corum-memory'、'user:alice'）。空串 = 事实自成
 *     一个实体。写时实体解析不在底座内（后续接 Graphiti 或调用方自解），底座只存。
 *   - relation：关系名（如 'uses'、'owns'、'prefers'）；纯标签，不强制三元组。
 *   - fact：原子事实文本（唯一必填）。
 *   - importance：重要性 0-100，写入门槛 + 分层 + 衰减的单一事实源。
 *   - validAt / invalidAt：事实成立/失效时间窗（epoch ms）。null = 无界
 *     （validAt null 视作「自创建起成立」；invalidAt null 视作「仍有效」）。
 *     失效是**标记**不是删除——旧状态可审计恢复。
 *   - supersedes：本条事实显式取代的旧事实 id（recency-wins 合并的数据基础）。
 *   - evidence：证据链（会话 id / 文件路径 / 人工录入出处），支持「回到原文」。
 *   - author：写入者（'user' | 'system' | 'agent:<sessionId>'），人工修剪信任前置。
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
  supersedes: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  author: z.string().default('system'),
  createdAt: z.number().int().nonnegative(),
  lastAccessedAt: z.number().int().nonnegative().nullable().default(null),
})
export type MemoryFact = z.infer<typeof memoryFactSchema>

/** 域声明形（defineDomain 的返回：字面量收窄后的 spec）。 */
export type MemoryDomainSpec = ReturnType<typeof memoryDomainSpec>

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

/** 事实的派生视图：存储字段 + 读时计算的分层、记忆强度与适用/留存。 */
export interface MemoryFactView extends MemoryFact {
  /** 分层（派生，不落库）：transient / session / long / archival。 */
  readonly tier: MemoryTier
  /** 读时降权后的记忆强度（派生，不落库）：检索排序依据；不因到期归零。 */
  readonly effectiveScore: number
  /** 当前是否「适用/成立」（派生，不落库）：validAt→invalidAt 窗口内为真。 */
  readonly applicable: boolean
  /** 是否「还被记住」（派生，不落库）：存在即真；忘记 = 显式删除。 */
  readonly retained: boolean
}

/** 分层档位。 */
export type MemoryTier = 'transient' | 'session' | 'long' | 'archival'

export type MemoryDomainSpecOf = MemoryDomainSpec
