/**
 * MemoryService 接口 + 业务集成测试（真装官方存储栈）。
 *
 * wiring 参照 corum-agent project-data.spec.ts：dsh-storage hub + dsh-storage-json
 * 后端 + dsh-storage-domain 设施，CORUM_HOME 指向 /tmp 隔离目录——不动真实 dev home。
 *
 * 覆盖面（按「接口」与「业务」两类组织）：
 *   接口层 —— putFact / searchFacts / listFacts / getFact / invalidate / setImportance
 *             / deleteFact 七个公开方法（含 @Remote 端点的同名语义，端点即转发）。
 *   业务层 —— 写入幂等、recency-wins 合并（标失效不删 + supersedes 溯源）、
 *             applicable/recall 双模式检索（失效 ≠ 忘记）、scope 过滤、关键词、
 *             访问强化、人工修剪三动作、硬删除不可逆。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import { MemoryService } from '../src/memory-service.ts'
import { READ_PROMOTE_THRESHOLD } from '../src/memory-policy.ts'
import type { MemoryFact, MemoryScope } from '../src/memory-entities.ts'

let home: string
const prevCorumHome = process.env.CORUM_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-mem-home-'))
  process.env.CORUM_HOME = home
})

afterEach(() => {
  if (prevCorumHome === undefined) delete process.env.CORUM_HOME
  else process.env.CORUM_HOME = prevCorumHome
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function setup(): Promise<{ ctx: Context; mem: MemoryService }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root: join(home, 'storages') })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  // Service 基类构造即 provide（cordis Service 语义），无需手动 ctx.provide。
  const mem = ctx.get('memory') ?? new MemoryService(ctx)
  return { ctx, mem }
}

/** 造一条写入入参。 */
function input(overrides: Partial<Parameters<MemoryService['putFact']>[0]> = {}) {
  return {
    fact: '用户偏好深色模式',
    scope: 'global' as MemoryScope,
    author: 'test',
    ...overrides,
  }
}

describe('MemoryService 接口层', () => {
  it('putFact 写入后 getFact 能取回，字段完整且默认值正确', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '用户偏好深色模式' }))
    expect(fact.id).toBeTruthy()
    expect(fact.importance).toBe(50) // 默认
    expect(fact.entity).toBe('')
    expect(fact.relation).toBe('')
    expect(fact.validAt).toBeNull()
    expect(fact.invalidAt).toBeNull()
    expect(fact.supersedes).toEqual([])
    expect(fact.evidence).toEqual([])

    const got = await mem.getFact(fact.id)
    expect(got).not.toBeNull()
    expect(got!.fact).toBe('用户偏好深色模式')
    expect(got!.applicable).toBe(true)
    expect(got!.retained).toBe(true)
  })

  it('putFact 带自定义 id 时幂等（重复写入覆盖同一条）', async () => {
    const { mem } = await setup()
    const id = 'fixed-id'
    const r1 = await mem.putFact(input({ id, fact: 'v1' }))
    const r2 = await mem.putFact(input({ id, fact: 'v2' }))
    expect(r1.fact.id).toBe(id)
    expect(r2.fact.id).toBe(id)
    // 同 id 覆盖后只有一条，内容为 v2。
    const all = await mem.listFacts()
    expect(all).toHaveLength(1)
    expect(all[0].fact).toBe('v2')
  })

  it('listFacts 返回全部并按记忆强度降序', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'low', importance: 10 }))
    await mem.putFact(input({ fact: 'high', importance: 90 }))
    const all = await mem.listFacts()
    expect(all).toHaveLength(2)
    expect(all[0].fact).toBe('high')
    expect(all[1].fact).toBe('low')
  })

  it('getFact 不存在的 id 返回 null', async () => {
    const { mem } = await setup()
    expect(await mem.getFact('nonexistent')).toBeNull()
  })

  it('setImportance 越界值被 clamp 到 [0,100]', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input())
    const up = await mem.setImportance(fact.id, 999)
    expect(up!.importance).toBe(100)
    const down = await mem.setImportance(fact.id, -5)
    expect(down!.importance).toBe(0)
  })

  it('setImportance / invalidate / deleteFact 对不存在 id 安全（null / false）', async () => {
    const { mem } = await setup()
    expect(await mem.setImportance('nope', 50)).toBeNull()
    expect(await mem.invalidate('nope')).toBeNull()
    expect(await mem.deleteFact('nope')).toBe(false)
  })
})

describe('MemoryService 业务层 — 写入与合并', () => {
  it('recency-wins：同 entity+relation 的新事实标旧事实失效，且 supersedes 溯源，不物理删除', async () => {
    const { mem } = await setup()
    const old = await mem.putFact(input({ entity: 'stack', relation: 'uses', fact: 'stack uses Postgres' }))
    const neu = await mem.putFact(input({ entity: 'stack', relation: 'uses', fact: 'stack uses MySQL' }))

    // 新事实 supersedes 指向旧事实。
    expect(neu.invalidated).toEqual([old.fact.id])
    expect(neu.fact.supersedes).toEqual([old.fact.id])

    // 旧事实仍在（未删除），只是标了 invalidAt → 不 applicable，但 retained。
    const oldView = await mem.getFact(old.fact.id)
    expect(oldView).not.toBeNull()
    expect(oldView!.applicable).toBe(false)
    expect(oldView!.retained).toBe(true)
    expect(oldView!.invalidAt).not.toBeNull()
  })

  it('不同 entity 或不同 relation 不触发合并', async () => {
    const { mem } = await setup()
    const a = await mem.putFact(input({ entity: 'A', relation: 'uses', fact: 'A uses X' }))
    const b = await mem.putFact(input({ entity: 'B', relation: 'uses', fact: 'B uses X' }))
    expect(b.invalidated).toEqual([])
    expect((await mem.getFact(a.fact.id))!.applicable).toBe(true) // A 未被失效
  })

  it('entity 和 relation 都为空时（自成实体）永不合并', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '独立事实 1' }))
    const r2 = await mem.putFact(input({ fact: '独立事实 2' }))
    expect(r2.invalidated).toEqual([])
    expect(await mem.listFacts()).toHaveLength(2)
  })
})

describe('MemoryService 业务层 — 持久化判定（4 规则）', () => {
  it('规则1/2：显式 permanent（纪律/永久事实源）→ permanent 且 expiresAt=null', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '用户纪律：所有代码必须走测试', retention: 'permanent' }))
    expect(fact.retention).toBe('permanent')
    expect(fact.expiresAt).toBeNull()
    expect((await mem.getFact(fact.id))!.retained).toBe(true)
  })

  it('规则3：author=user（手动添加）→ long', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '手动添加的事实', author: 'user' }))
    expect(fact.retention).toBe('long')
    expect(fact.expiresAt).not.toBeNull() // long 有 1 年 TTL
  })

  it('默认（agent 写入、未声明）→ temporary 且 2 天 TTL', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '普通 agent 记忆', author: 'agent:s1' }))
    expect(fact.retention).toBe('temporary')
    expect(fact.expiresAt).toBe(fact.createdAt + 2 * 24 * 60 * 60 * 1000)
  })

  it('规则4：readCount 达阈值 → 升级为 long', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '高频读取的事实', author: 'agent:s1' }))
    expect(fact.retention).toBe('temporary')

    // 连续检索 5 次（readCount 达阈值）。
    for (let i = 0; i < READ_PROMOTE_THRESHOLD; i++) {
      await mem.searchFacts({ query: '高频读取', mode: 'recall' })
    }
    const after = await mem.getFact(fact.id)
    expect(after!.retention).toBe('long')
    expect(after!.readCount).toBe(READ_PROMOTE_THRESHOLD)
  })
})

describe('MemoryService 业务层 — 存续期遗忘（非持久化按 TTL 衰减）', () => {
  it('temporary 写入时 expiresAt = createdAt + 2天（非持久化 TTL 落定）', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '临时记忆', retention: 'temporary', author: 'agent:s1' }))
    expect(fact.expiresAt).toBe(fact.createdAt + 2 * 24 * 60 * 60 * 1000)
    expect((await mem.getFact(fact.id))!.retained).toBe(true) // 刚写入，未过期
  })

  it('permanent 永不过期（expiresAt=null → retained 恒 true）', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '永久纪律', retention: 'permanent' }))
    expect(fact.expiresAt).toBeNull()
    expect((await mem.getFact(fact.id))!.retained).toBe(true)
  })
})

describe('MemoryService 业务层 — 检索（applicable / recall 双模式，失效 ≠ 忘记）', () => {
  it('applicable 模式（默认）只返回当前适用的事实', async () => {
    const { mem } = await setup()
    const { fact: alive } = await mem.putFact(input({ fact: '当前适用的事实' }))
    // 写入时给定过去 invalidAt → 到期，不 applicable。
    await mem.putFact(input({ id: 'expired-2', fact: '到期事实 B', invalidAt: 1 }))

    const applicable = await mem.searchFacts({ mode: 'applicable' })
    const ids = applicable.map(f => f.id)
    expect(ids).toContain(alive.id)
    expect(ids).not.toContain('expired-2')
  })

  it('recall 模式返回全部（含到期），回忆「发生过什么」', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: '仍在适用的日程' }))
    await mem.putFact(input({ id: 'expired', fact: '10月31日前的日程提醒', invalidAt: 1 }))

    const applicable = await mem.searchFacts({ mode: 'applicable' })
    expect(applicable.map(f => f.id)).not.toContain('expired')

    const recall = await mem.searchFacts({ mode: 'recall' })
    expect(recall.map(f => f.id)).toContain('expired')
  })

  it('日程场景端到端：到期后 applicable 不再召回，但 recall 仍可召回', async () => {
    const { mem } = await setup()
    const now = Date.now()
    // 「10月31日前每天提醒日程」：validAt=now，invalidAt=now+1天 内适用；构造到期版。
    const { fact } = await mem.putFact(input({
      entity: 'schedule',
      relation: 'reminds',
      fact: '每天提醒用户日程',
      validAt: now - 2 * 86400_000,
      invalidAt: now - 86400_000, // 已到期
    }))

    // 到期 → 不 applicable，但 retained。
    const view = await mem.getFact(fact.id)
    expect(view!.applicable).toBe(false)
    expect(view!.retained).toBe(true)

    // applicable 检索不召回（不再提醒）；recall 检索召回（记忆仍在）。
    expect((await mem.searchFacts({ mode: 'applicable' })).map(f => f.id)).not.toContain(fact.id)
    expect((await mem.searchFacts({ mode: 'recall' })).map(f => f.id)).toContain(fact.id)
  })

  it('scope 过滤只返回对应作用域', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'global 事实', scope: 'global' }))
    await mem.putFact(input({ fact: 'project 事实', scope: 'project' }))
    await mem.putFact(input({ fact: 'agent 事实', scope: 'agent' }))

    const projectOnly = await mem.searchFacts({ scope: 'project', mode: 'recall' })
    expect(projectOnly).toHaveLength(1)
    expect(projectOnly[0].fact).toBe('project 事实')
  })

  it('query 关键词子串匹配（大小写不敏感）', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'DeepSeek Harness fork' }))
    await mem.putFact(input({ fact: '另一个事实' }))
    const hit = await mem.searchFacts({ query: 'deepseek', mode: 'recall' })
    expect(hit).toHaveLength(1)
    expect(hit[0].fact).toBe('DeepSeek Harness fork')
  })

  it('多策略检索：按 entity 命中召回（即使 fact 文本不含关键词）', async () => {
    const { mem } = await setup()
    // fact 文本是「使用 PostgreSQL」，但 entity 是 'stack'——问「stack」应能按实体召回。
    await mem.putFact(input({ entity: 'stack', relation: 'uses', fact: '使用 PostgreSQL 作为数据库' }))
    await mem.putFact(input({ fact: '另一个无关事实' }))

    const hit = await mem.searchFacts({ query: 'stack', mode: 'recall' })
    expect(hit).toHaveLength(1)
    expect(hit[0].entity).toBe('stack')
  })

  it('多策略检索：按 relation 命中召回', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ entity: 'A', relation: 'owns', fact: 'A 拥有某个仓库' }))
    await mem.putFact(input({ fact: '另一个无关事实' }))

    const hit = await mem.searchFacts({ query: 'owns', mode: 'recall' })
    expect(hit).toHaveLength(1)
    expect(hit[0].relation).toBe('owns')
  })

  it('多策略检索：匹配分高者排前（fact 命中 > entity 命中）', async () => {
    const { mem } = await setup()
    // fact 直接命中「stack」的，应排在仅 entity 命中「stack」的前面。
    await mem.putFact(input({ id: 'entity-only', entity: 'stack', relation: 'uses', fact: '使用 PostgreSQL' }))
    await mem.putFact(input({ id: 'fact-hit', fact: 'stack 是核心组件' }))

    const hit = await mem.searchFacts({ query: 'stack', mode: 'recall' })
    expect(hit[0].id).toBe('fact-hit') // fact 命中(4) > entity 命中(3)
  })

  it('无关键词时退化为纯记忆强度排序', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'low', importance: 10 }))
    await mem.putFact(input({ fact: 'high', importance: 90 }))
    const all = await mem.searchFacts({ mode: 'recall' })
    expect(all[0].fact).toBe('high')
    expect(all[1].fact).toBe('low')
  })

  it('limit 限制返回条数', async () => {
    const { mem } = await setup()
    await mem.putFact(input({ fact: 'a', importance: 90 }))
    await mem.putFact(input({ fact: 'b', importance: 80 }))
    await mem.putFact(input({ fact: 'c', importance: 70 }))
    const top2 = await mem.searchFacts({ mode: 'recall', limit: 2 })
    expect(top2).toHaveLength(2)
    expect(top2.map(f => f.fact)).toEqual(['a', 'b']) // 降序前 2
  })
})

describe('MemoryService 业务层 — 人工修剪三动作', () => {
  it('invalidate 标失效：applicable→false，但 retained 保持、可 recall 召回', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '待失效事实' }))
    const before = await mem.getFact(fact.id)
    expect(before!.applicable).toBe(true)

    const after = await mem.invalidate(fact.id)
    expect(after!.applicable).toBe(false)
    expect(after!.retained).toBe(true)
    expect(after!.invalidAt).not.toBeNull()

    expect((await mem.searchFacts({ mode: 'applicable' })).map(f => f.id)).not.toContain(fact.id)
    expect((await mem.searchFacts({ mode: 'recall' })).map(f => f.id)).toContain(fact.id)
  })

  it('setImportance 上调改变记忆强度（importance 是衰减基数）', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '待提升', importance: 10 }))
    const raised = await mem.setImportance(fact.id, 90)
    expect(raised!.importance).toBe(90)
    expect(raised!.effectiveScore).toBeGreaterThan(0)
  })

  it('deleteFact 硬删除后 recall 也召回不到（真正忘记，不可逆）', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '待删除事实' }))
    const ok = await mem.deleteFact(fact.id)
    expect(ok).toBe(true)
    expect(await mem.getFact(fact.id)).toBeNull()
    expect((await mem.searchFacts({ mode: 'recall' })).map(f => f.id)).not.toContain(fact.id)
  })
})

describe('MemoryService 业务层 — 访问强化（lastAccessedAt）', () => {
  it('searchFacts 命中后刷新 lastAccessedAt', async () => {
    const { mem } = await setup()
    const { fact } = await mem.putFact(input({ fact: '待访问事实' }))
    const before = await mem.getFact(fact.id)
    expect(before!.lastAccessedAt).toBeNull()

    await mem.searchFacts({ query: '待访问', mode: 'recall' })
    const after = await mem.getFact(fact.id)
    expect(after!.lastAccessedAt).not.toBeNull()
  })
})
