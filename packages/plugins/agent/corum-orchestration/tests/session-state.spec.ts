/**
 * `@corum/corum-orchestration` 的**会话级机制状态**单测。
 *
 * 为什么补这个文件（2026-09-18）：本包的 `package.json` 一直声明 `"test": "vitest run"`，
 * 但仓库里**没有任何测试文件** ⇒ 该脚本恒以 exit 1 失败（`No test files found`）。
 * 补上后既修掉这个长期红灯，又把本包新加的会话级状态语义直接钉住。
 *
 * 覆盖的是**纯状态语义**（不碰 git / 文件系统）：
 *   ① `claimPendingIntegrationNotice` —— 认领式去重（双实例只发一条通知的关键）；
 *   ② `setModelOverride` / `modelOverrideOf` / `clearModelOverride`（含「返回副本」防外部改内部态）；
 *   ④ `rememberChildSpawn` / `takeChildSpawn`（取走即删）；
 *   ⑤ 会话隔离：不同 sessionId 互不影响。
 *
 * 构造范式与 `corum-tool-subagent/tests/isolation.spec.ts` 一致：
 * `new CorumOrchestration(new Context())`——`storageDomain` 缺席时本服务回落纯内存（见其构造函数）。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CorumOrchestration, type CorumChildSpawnFacts } from '../src/index.ts'

/** 建一个内存态（未装配 storageDomain）的编排服务实例。 */
function makeService(): CorumOrchestration {
  return new CorumOrchestration(new Context())
}

describe('claimPendingIntegrationNotice — 待集成通知的认领式去重', () => {
  it('★ 同一个分支只被认领一次（第二次返回 false）', () => {
    // 由来（2026-09-18 实机）：corum-tool-subagent 在 preset 里是**双实例**（worker + research），
    // 两个实例各注册一个 {global:true} 的 subagent/end 监听 ⇒ 同一 settle 被处理两次。
    // 「待集成」通知是纯读（entriesOf 不消费状态）⇒ 不去重就发两条逐字相同的通知
    // （实测：同一会话 seq 23 与 25 内容一致）。本方法就是那个去重闸门。
    const svc = makeService()
    expect(svc.claimPendingIntegrationNotice('sess-1', 'wt/aaa')).toBe(true)
    expect(svc.claimPendingIntegrationNotice('sess-1', 'wt/aaa'), '第二次必须 false（已被认领）').toBe(false)
  })

  it('不同分支各自可认领（去重粒度是「会话+分支」，不是整个会话）', () => {
    const svc = makeService()
    expect(svc.claimPendingIntegrationNotice('sess-1', 'wt/aaa')).toBe(true)
    expect(svc.claimPendingIntegrationNotice('sess-1', 'wt/bbb')).toBe(true)
    expect(svc.claimPendingIntegrationNotice('sess-1', 'wt/aaa')).toBe(false)
    expect(svc.claimPendingIntegrationNotice('sess-1', 'wt/bbb')).toBe(false)
  })

  it('不同会话互不影响（同名分支在两个会话里各自可认领一次）', () => {
    const svc = makeService()
    expect(svc.claimPendingIntegrationNotice('sess-1', 'wt/same')).toBe(true)
    expect(svc.claimPendingIntegrationNotice('sess-2', 'wt/same')).toBe(true)
    expect(svc.claimPendingIntegrationNotice('sess-1', 'wt/same')).toBe(false)
    expect(svc.claimPendingIntegrationNotice('sess-2', 'wt/same')).toBe(false)
  })

  it('key 用不可打印分隔符拼装 ⇒ 会话名与分支名的边界不会撞车', () => {
    // `a` + `b\u0000c` 与 `a\u0000b` + `c` 若用可打印字符拼接会撞成同一个 key。
    const svc = makeService()
    expect(svc.claimPendingIntegrationNotice('a', 'b\u0000c')).toBe(true)
    expect(svc.claimPendingIntegrationNotice('a\u0000b', 'c')).toBe(true)
  })
})

describe('临时子 Agent 模型覆盖（选「临时」后的会话级状态）', () => {
  it('设置后读得到；清除后回到 undefined', () => {
    const svc = makeService()
    expect(svc.modelOverrideOf('sess-1')).toBeUndefined()
    svc.setModelOverride('sess-1', { provider: 'p', model: 'm', reasoningEffort: 'high' })
    expect(svc.modelOverrideOf('sess-1')).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    svc.clearModelOverride('sess-1')
    expect(svc.modelOverrideOf('sess-1')).toBeUndefined()
  })

  it('★ 写入与读出都是副本：外部改不动服务内部状态', () => {
    // 为什么重要：路由对象会被下游拼进 request.agentOptions 再交给 seam，
    // 若共享同一引用，调用方一个「顺手改一下」就会污染会话级状态。
    const svc = makeService()
    const written = { provider: 'p', model: 'm' }
    svc.setModelOverride('sess-1', written)
    written.model = 'MUTATED'

    const read = svc.modelOverrideOf('sess-1')
    expect(read?.model, '写入后改外部对象不得影响内部').toBe('m')
    if (read !== undefined) read.model = 'MUTATED-2'
    expect(svc.modelOverrideOf('sess-1')?.model, '读出的对象被改也不得影响内部').toBe('m')
  })

  it('按会话隔离', () => {
    const svc = makeService()
    svc.setModelOverride('sess-1', { provider: 'p', model: 'm1' })
    svc.setModelOverride('sess-2', { provider: 'p', model: 'm2' })
    expect(svc.modelOverrideOf('sess-1')?.model).toBe('m1')
    expect(svc.modelOverrideOf('sess-2')?.model).toBe('m2')
    svc.clearModelOverride('sess-1')
    expect(svc.modelOverrideOf('sess-1')).toBeUndefined()
    expect(svc.modelOverrideOf('sess-2')?.model, '清一个会话不得影响另一个').toBe('m2')
  })
})

describe('spawn 事实登记（异步失败时问用户所需）', () => {
  const facts: CorumChildSpawnFacts = {
    parentSessionId: 'sess-1',
    label: 'pong',
    role: 'worker',
    configured: { provider: 'localhost', model: 'nope' },
    continuable: true,
  }

  it('★ 取走即删（第二次取返回 undefined）', () => {
    // 取走即删是**双实例安全**的前提：两个实例都收到 subagent/end，
    // 若这是纯读，规则 1 的提问会被触发两次（问用户两遍）。
    const svc = makeService()
    svc.rememberChildSpawn('child-1', facts)
    expect(svc.takeChildSpawn('child-1')?.label).toBe('pong')
    expect(svc.takeChildSpawn('child-1'), '第二次必须取不到').toBeUndefined()
  })

  it('未登记的 id 取不到（不静默造事实）', () => {
    const svc = makeService()
    expect(svc.takeChildSpawn('never-registered')).toBeUndefined()
  })

  it('登记与读出都是副本：外部改不动内部事实', () => {
    const svc = makeService()
    const mutable = { ...facts, configured: { ...facts.configured } }
    svc.rememberChildSpawn('child-2', mutable)
    mutable.configured.model = 'MUTATED'
    expect(svc.takeChildSpawn('child-2')?.configured.model).toBe('nope')
  })

  it('按 id 隔离：登记两个互不干扰', () => {
    const svc = makeService()
    svc.rememberChildSpawn('child-a', facts)
    svc.rememberChildSpawn('child-b', { ...facts, label: 'other', continuable: false })
    expect(svc.takeChildSpawn('child-b')).toMatchObject({ label: 'other', continuable: false })
    expect(svc.takeChildSpawn('child-a')?.label).toBe('pong')
  })

  it('同一 id 重复登记时后来者覆盖前者（结算以最后一次 spawn 为准）', () => {
    const svc = makeService()
    svc.rememberChildSpawn('child-x', facts)
    svc.rememberChildSpawn('child-x', { ...facts, label: 'second' })
    expect(svc.takeChildSpawn('child-x')?.label).toBe('second')
  })
})
