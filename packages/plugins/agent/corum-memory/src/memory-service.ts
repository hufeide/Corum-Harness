/**
 * MemoryService —— corum 记忆底座 host 服务。
 *
 * 职责（只承载「组织形式」，不绑定记忆来源）：
 *   - 事实级存储：单域 corum_memory、单表 facts，key = factId。
 *   - 写入：重要性写入门槛 + 同 entity+relation 的 recency-wins 合并（标失效不删）。
 *   - 检索：按 scope/tier/关键词过滤，按读时降权 effectiveScore 排序；命中即
 *     更新 lastAccessedAt（访问强化）。
 *   - 人工修剪三动作：失效标记（invalidate，可逆）/ 重要性调整（pin）/ 硬删除
 *     （delete，仅合规/用户显式要求，绕过策略）。
 *
 * 存储复用官方 dsh-storage-domain（ctx.storageDomain 由官方插件注入）。
 * 服务是 TypertRemoteService，@Remote 端点暴露 /api/memory/* 供 client 面板调用。
 *
 * @module @corum/corum-memory/memory-service
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
// 拉进 declare module '@deepseek-ai/cordis' { storageDomain: DomainFacility } 合并面，
// 使 ctx.get('storageDomain') 有正确类型（与 corum-orchestration 同款 import type {}）。
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { MemoryFact, MemoryFactView, MemoryScope } from './memory-entities.ts'
import { memoryDomainSpec, memoryFactSchema } from './memory-entities.ts'
import { conflictsToInvalidate, toView } from './memory-policy.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** 事实表句柄。 */
type FactsTable = KvTable<string, MemoryFact>
/** 打开后的域句柄。 */
type MemoryDomain = Domain<ReturnType<typeof memoryDomainSpec>>

/** 写入门槛：importance 低于此值的事实直接拒收（caller 侧判定，非底座硬规则，可显式传入）。 */
export const DEFAULT_MIN_IMPORTANCE = 0

/** 写入一条事实的入参（author 由调用方显式声明，不猜）。 */
export interface PutFactInput {
  /** 缺省生成 uuid；调用方可复用其自有 id（幂等写）。 */
  id?: string
  entity?: string
  relation?: string
  fact: string
  importance?: number
  validAt?: number
  invalidAt?: number
  source?: string
  scope: MemoryScope
  evidence?: string[]
  /** 写入者：'user' | 'system' | 'agent:<sessionId>'。 */
  author: string
}

/** 检索过滤条件。 */
export interface SearchFactsInput {
  scope?: MemoryScope
  /** 关键词（在 fact 文本上做子串匹配，大小写不敏感）。 */
  query?: string
  /** 只返回有效事实（默认 true）；false 时含失效/到期事实，用于「查看历史」。 */
  activeOnly?: boolean
  /** 最多返回条数（默认 100）。 */
  limit?: number
}

/** 写入结果。 */
export interface PutFactResult {
  fact: MemoryFact
  /** 本次写入因 recency-wins 而被标记失效的旧事实 id。 */
  invalidated: string[]
}

export class MemoryService extends TypertRemoteService {
  /** 打开后的域（懒开 + 缓存）。storageDomain 缺失时（单测/未装配）为 undefined。 */
  private domainPromise: Promise<MemoryDomain> | undefined

  constructor(ctx: Context) {
    super(ctx, 'memory')
    // 域懒开：storageDomain 由官方插件提供，装配顺序上它先于本服务（见挂载注释）。
    // 首次真正读写时才 open，避免冷启动就开域（无记忆也零开销）。
    this.domainPromise = undefined
    this.ctx.effect(() => () => {
      if (this.domainPromise !== undefined) {
        void this.domainPromise.then(d => d.close(), () => {})
      }
    }, 'memory.domainClose')
  }

  /** 懒开域（幂等）。 */
  private async domain(): Promise<MemoryDomain | undefined> {
    const storageDomain = this.ctx.get('storageDomain')
    if (storageDomain === undefined) return undefined
    if (this.domainPromise === undefined) {
      this.domainPromise = storageDomain.open(memoryDomainSpec())
    }
    return this.domainPromise
  }

  /** 事实表（未开域返回 undefined）。 */
  private async table(): Promise<FactsTable | undefined> {
    const d = await this.domain()
    return d?.table('facts')
  }

  // ── 写 ────────────────────────────────────────────────────────────

  /** 写入（或幂等覆盖）一条事实。若与既有同 entity+relation 冲突，标旧事实失效。 */
  async putFact(input: PutFactInput): Promise<PutFactResult> {
    const now = Date.now()
    const id = input.id ?? randomUUID()
    const fact: MemoryFact = memoryFactSchema.parse({
      id,
      entity: input.entity ?? '',
      relation: input.relation ?? '',
      fact: input.fact,
      importance: input.importance ?? 50,
      validAt: input.validAt ?? null,
      invalidAt: input.invalidAt ?? null,
      source: input.source ?? '',
      scope: input.scope,
      supersedes: [],
      evidence: input.evidence ?? [],
      author: input.author,
      createdAt: now,
      lastAccessedAt: null,
    })

    const table = await this.table()
    if (table === undefined) return { fact, invalidated: [] }

    // recency-wins 合并：找出同 entity+relation 的活跃旧事实，标失效。
    const existing = [...table.entries()].map(([, f]) => f)
    const stale = conflictsToInvalidate(fact, existing, now)
    const invalidated: string[] = []
    for (const old of stale) {
      const invalidatedFact: MemoryFact = { ...old, invalidAt: now, supersedes: [...old.supersedes] }
      await table.put(old.id, invalidatedFact)
      invalidated.push(old.id)
    }
    // 新事实 supersedes 指向被失效的旧事实（可审计追溯）。
    const toPut: MemoryFact = invalidated.length > 0
      ? { ...fact, supersedes: invalidated }
      : fact
    await table.put(id, toPut)
    return { fact: toPut, invalidated }
  }

  // ── 读 ────────────────────────────────────────────────────────────

  /** 按条件检索事实，按有效分降序。命中即更新 lastAccessedAt（访问强化）。 */
  async searchFacts(input: SearchFactsInput = {}): Promise<MemoryFactView[]> {
    const table = await this.table()
    if (table === undefined) return []

    const now = Date.now()
    const scope = input.scope
    const q = input.query?.trim().toLowerCase() ?? ''
    const activeOnly = input.activeOnly ?? true
    const limit = input.limit ?? 100

    const rows: MemoryFact[] = []
    for (const [, f] of table.entries()) {
      if (scope !== undefined && f.scope !== scope) continue
      if (q !== '' && !f.fact.toLowerCase().includes(q)) continue
      const view = toView(f, now)
      if (activeOnly && !view.active) continue
      rows.push(f)
    }

    rows.sort((a, b) => effectiveScoreSort(b, now) - effectiveScoreSort(a, now))
    const kept = rows.slice(0, limit)

    // 访问强化：被返回（命中）的事实刷新 lastAccessedAt。fire-and-forget 不阻断读。
    for (const f of kept) {
      if (f.lastAccessedAt === null || now - f.lastAccessedAt > 1000 * 60 * 60) {
        void table.put(f.id, { ...f, lastAccessedAt: now }).catch(() => {})
      }
    }

    return kept.map(f => toView(f, now))
  }

  /** 按 id 取单条事实（含派生视图）。 */
  async getFact(id: string): Promise<MemoryFactView | null> {
    const table = await this.table()
    if (table === undefined) return null
    const f = table.get(id)
    return f === undefined ? null : toView(f, Date.now())
  }

  /** 列出全部事实（可选 scope 过滤），供面板浏览/人工修剪。 */
  async listFacts(scope?: MemoryScope): Promise<MemoryFactView[]> {
    const table = await this.table()
    if (table === undefined) return []
    const now = Date.now()
    const views: MemoryFactView[] = []
    for (const [, f] of table.entries()) {
      if (scope !== undefined && f.scope !== scope) continue
      views.push(toView(f, now))
    }
    views.sort((a, b) => b.effectiveScore - a.effectiveScore)
    return views
  }

  // ── 人工修剪三动作 ────────────────────────────────────────────────

  /** 失效标记：把事实标为「不再成立」（可逆——撤销可清除 invalidAt）。 */
  async invalidate(id: string): Promise<MemoryFactView | null> {
    const table = await this.table()
    if (table === undefined) return null
    const f = table.get(id)
    if (f === undefined) return null
    const next: MemoryFact = { ...f, invalidAt: Date.now() }
    await table.put(id, next)
    return toView(next, Date.now())
  }

  /** 重要性调整（pin：上调钉住 / 下调压底）。返回新视图。 */
  async setImportance(id: string, importance: number): Promise<MemoryFactView | null> {
    const table = await this.table()
    if (table === undefined) return null
    const f = table.get(id)
    if (f === undefined) return null
    const next: MemoryFact = { ...f, importance: Math.max(0, Math.min(100, Math.round(importance))) }
    await table.put(id, next)
    return toView(next, Date.now())
  }

  /** 硬删除（仅合规/用户显式要求，绕过一切策略，不可逆）。 */
  async deleteFact(id: string): Promise<boolean> {
    const table = await this.table()
    if (table === undefined) return false
    return table.delete(id)
  }

  // ── @Remote 端点（/api/memory/*）──────────────────────────────────

  @Remote('putFact')
  async putFactRemote(input: PutFactInput): Promise<PutFactResult> {
    return this.putFact(input)
  }

  @Remote('searchFacts')
  async searchFactsRemote(input: SearchFactsInput): Promise<MemoryFactView[]> {
    return this.searchFacts(input)
  }

  @Remote('listFacts')
  async listFactsRemote(scope?: MemoryScope): Promise<MemoryFactView[]> {
    return this.listFacts(scope)
  }

  @Remote('getFact')
  async getFactRemote(id: string): Promise<MemoryFactView | null> {
    return this.getFact(id)
  }

  @Remote('invalidate')
  async invalidateRemote(id: string): Promise<MemoryFactView | null> {
    return this.invalidate(id)
  }

  @Remote('setImportance')
  async setImportanceRemote(id: string, importance: number): Promise<MemoryFactView | null> {
    return this.setImportance(id, importance)
  }

  @Remote('deleteFact')
  async deleteFactRemote(id: string): Promise<boolean> {
    return this.deleteFact(id)
  }
}

/** 排序键：读时降权有效分（从 toView 里抽，避免重复计算）。 */
function effectiveScoreSort(f: MemoryFact, now: number): number {
  return toView(f, now).effectiveScore
}
