/**
 * 池的单测（含**真进程**假 MCP server）。
 *
 * 覆盖用户拍板的每一条硬要求：
 *   · 一个服务名**只有一个进程**，多 Agent 共用（pid 相同）；
 *   · **独占**：并发调用被串行化（服务端 `maxConcurrent` 必须为 1）；
 *   · 忙时 **FIFO 排队 + 超时**，超时错误必须点名**当前持有者**；
 *   · 引用计数：最后一份授权撤销 ⇒ 进程停掉；仍有授权 ⇒ 进程不变；
 *   · 崩溃 ⇒ 下一次调用自动重连（换 pid）；
 *   · 定义（args/env）变了 ⇒ 换进程；定义没变 ⇒ **pid 不变**（用户验收判据）。
 *
 * 为什么用真子进程而不是 mock：`pid`、进程存活、协议握手、崩溃重连这些都只在真进程边界上成立。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpLeaseTimeoutError, McpPool, describeOwner } from '../src/pool.ts'
import { publicToolName } from '../src/tool-naming.ts'
import type { McpServerConfig } from '../src/types.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp.mjs')

/** 造一个「注册表里只有 fake 一个服务」的池（定义可被测试改写）。 */
function makePool(overrides: { leaseTimeoutMs?: number; leaseTtlMs?: number } = {}): {
  pool: McpPool
  definitions: Map<string, McpServerConfig>
} {
  const definitions = new Map<string, McpServerConfig>([
    ['fake', { name: 'fake', transport: 'stdio', command: process.execPath, args: [FIXTURE] }],
  ])
  const pool = new McpPool({
    resolve: name => definitions.get(name),
    log: () => {},
    ...overrides,
  })
  return { pool, definitions }
}

/** 夹具把结果包在 content[0].text 的 JSON 里。 */
function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: readonly { text?: string }[] }).content ?? []
  const text = content[0]?.text ?? '{}'
  return JSON.parse(text) as Record<string, unknown>
}

const ownerA = { agentId: 'agent-A' }
const ownerB = { agentId: 'agent-B' }

/** 等一小会（异步收尾用）。 */
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** pid 是否还活着。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('MCP 池：一个服务名一个进程，多 Agent 共用（2026-09-27 用户模型）', () => {
  it('★ 两个 Agent 共用同一个进程（pid 相同），且连接只有一份', async () => {
    const { pool } = makePool()
    const release = pool.retain('fake')
    try {
      const tools = await pool.listTools('fake')
      expect(tools.map(tool => tool.name)).toContain('echo')
      const first = payloadOf(await pool.callTool('fake', 'echo', { text: 'a' }, ownerA))
      const second = payloadOf(await pool.callTool('fake', 'echo', { text: 'b' }, ownerB))
      expect(first.pid).toBe(second.pid)
      const snapshots = pool.snapshot()
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.pid).toBe(first.pid)
      expect(snapshots[0]?.toolCount).toBe(tools.length)
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('★ 独占：并发调用被串行化（服务端 maxConcurrent 必须为 1）', async () => {
    const { pool } = makePool()
    const release = pool.retain('fake')
    try {
      await pool.listTools('fake')
      const [slow] = await Promise.all([
        pool.callTool('fake', 'slow', { delayMs: 150 }, ownerA),
        pool.callTool('fake', 'echo', { text: 'after' }, ownerB),
      ])
      const slowPayload = payloadOf(slow)
      const stats = payloadOf(await pool.callTool('fake', 'stats', {}, ownerA))
      expect(stats.maxConcurrent).toBe(1)
      expect(slowPayload.maxConcurrent).toBe(1)
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('★ 忙时排队 + 超时：错误必须点名当前持有者', async () => {
    const { pool } = makePool({ leaseTimeoutMs: 60 })
    const release = pool.retain('fake')
    try {
      await pool.listTools('fake')
      const running = pool.callTool('fake', 'slow', { delayMs: 400 }, ownerA)
      await expect(pool.callTool('fake', 'echo', { text: 'x' }, ownerB)).rejects.toBeInstanceOf(McpLeaseTimeoutError)
      await expect(pool.callTool('fake', 'echo', { text: 'x' }, ownerB)).rejects.toThrow(/agent-A/)
      await running
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('★ 排队中被中止（turn 结束/用户打断）⇒ 立刻让出排队位，且不占租约', async () => {
    const { pool } = makePool()
    const release = pool.retain('fake')
    try {
      await pool.listTools('fake')
      const running = pool.callTool('fake', 'slow', { delayMs: 250 }, ownerA)
      const controller = new AbortController()
      const queued = pool.callTool('fake', 'echo', { text: 'x' }, ownerB, { signal: controller.signal })
      await tick(30)
      expect(pool.snapshot()[0]?.queueLength).toBe(1)
      controller.abort(new Error('turn ended'))
      await expect(queued).rejects.toThrow(/aborted by its caller/)
      // 排队位立刻让出（不是等超时才清）
      expect(pool.snapshot()[0]?.queueLength).toBe(0)
      await running
      expect(pool.snapshot()[0]?.holder).toBeUndefined()
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('★ TTL 兜底：持有者崩死（永不释放）⇒ 租约被回收并点名原持有者', async () => {
    const warns: string[] = []
    const definitions = new Map<string, McpServerConfig>([
      ['fake', { name: 'fake', transport: 'stdio', command: process.execPath, args: [FIXTURE] }],
    ])
    const pool = new McpPool({
      resolve: name => definitions.get(name),
      leaseTimeoutMs: 5_000,
      leaseTtlMs: 60,
      log: (level, message) => { if (level === 'warn') warns.push(message) },
    })
    const release = pool.retain('fake')
    try {
      // 模拟"某个 Agent 拿了租约就再也没还"（崩死/被 kill）
      const deadLease = await pool.acquire('fake', { agentId: 'dead-agent', sessionId: 's-dead' })
      expect(pool.snapshot()[0]?.holder?.agentId).toBe('dead-agent')
      await tick(90)
      // 下一个调用者能拿到（TTL 已回收），warn 点名原持有者
      const liveLease = await pool.acquire('fake', ownerB)
      expect(pool.snapshot()[0]?.holder?.agentId).toBe('agent-B')
      expect(warns.join(' ')).toContain('dead-agent')
      expect(warns.join(' ')).toContain('reclaiming')
      // ⚠️ 真正的危险在这里：崩死者的**迟到释放**绝不能把别人的租约偷走（token 已经不是它了）
      deadLease()
      expect(pool.snapshot()[0]?.holder?.agentId).toBe('agent-B')
      // B 正常归还之后再发起调用（⚠️ 首版我把调用写在归还之前 ⇒ 它排队等满 leaseTimeout 超时，
      // 测试自己造了个 5 秒死锁；顺序错在测试，不在实现）
      liveLease()
      expect(pool.snapshot()[0]?.holder).toBeUndefined()
      const result = payloadOf(await pool.callTool('fake', 'echo', { text: 'next' }, ownerA))
      expect(result.text).toBe('next')
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('describeOwner：归属文本带 session/lane（拒绝与日志共用一处措辞）', () => {
    expect(describeOwner(undefined)).toBe('nobody')
    expect(describeOwner({ agentId: 'a1' })).toBe('agent a1')
    expect(describeOwner({ agentId: 'a1', sessionId: 's1', lane: 'work' })).toBe('agent a1 / session s1 / lane work')
  })
})

describe('MCP 池：引用计数与进程生命周期', () => {
  it('★ 最后一份授权撤销 ⇒ 进程停掉；仍有授权 ⇒ 进程不变', async () => {
    const { pool } = makePool()
    const releaseA = pool.retain('fake')
    const releaseB = pool.retain('fake')
    const pid = Number(payloadOf(await pool.callTool('fake', 'echo', {}, ownerA)).pid)
    releaseA()
    // 还有一份授权 ⇒ 同进程继续服务
    const stillThere = Number(payloadOf(await pool.callTool('fake', 'echo', {}, ownerB)).pid)
    expect(stillThere).toBe(pid)
    releaseB()
    await tick(200)
    expect(alive(pid)).toBe(false)
    await pool.disposeAll()
  })

  it('★ 崩溃后下一次调用自动重连（换 pid）', async () => {
    const { pool } = makePool()
    const release = pool.retain('fake')
    try {
      const before = Number(payloadOf(await pool.callTool('fake', 'crash', {}, ownerA)).pid)
      await tick(250)
      expect(alive(before)).toBe(false)
      const after = Number(payloadOf(await pool.callTool('fake', 'echo', { text: 'back' }, ownerA)).pid)
      expect(after).not.toBe(before)
      expect(alive(after)).toBe(true)
    } finally {
      release()
      await pool.disposeAll()
    }
  })
})

describe('MCP 池：定义指纹（改配置要不要换进程）', () => {
  it('★ args 变了 ⇒ 换进程；没变 ⇒ pid 不变', async () => {
    const { pool, definitions } = makePool()
    const release = pool.retain('fake')
    try {
      const first = Number(payloadOf(await pool.callTool('fake', 'echo', {}, ownerA)).pid)
      // 同一个定义再调：pid 必须不变（用户判据：不该因为无关改动重启进程）
      const again = Number(payloadOf(await pool.callTool('fake', 'echo', {}, ownerA)).pid)
      expect(again).toBe(first)
      // 定义本体变了（加一个 args）⇒ 必须换进程
      definitions.set('fake', { name: 'fake', transport: 'stdio', command: process.execPath, args: [FIXTURE, '--changed'] })
      const changed = Number(payloadOf(await pool.callTool('fake', 'echo', {}, ownerA)).pid)
      expect(changed).not.toBe(first)
      await tick(200)
      expect(alive(first)).toBe(false)
    } finally {
      release()
      await pool.disposeAll()
    }
  })

  it('★ 注册表里被停用的服务 ⇒ 不起进程、明确报错（改 disabled 立即生效，不必重写 preset）', async () => {
    const definitions = new Map<string, McpServerConfig>([
      ['off', { name: 'off', transport: 'stdio', command: process.execPath, args: [FIXTURE], disabled: true }],
    ])
    const pool = new McpPool({ resolve: name => definitions.get(name), log: () => {} })
    expect(() => pool.retain('off')).toThrow(/disabled/)
    expect(pool.snapshot()).toEqual([])
    await pool.disposeAll()
  })

  it('注册表里没有该服务 ⇒ 明确报错（不静默）', async () => {
    const { pool } = makePool()
    expect(() => pool.retain('nope')).toThrow(/not in the registry/)
    await pool.disposeAll()
  })
})

describe('工具命名：与官方 dsh-mcp-client 逐字一致', () => {
  it('干净情形就是 mcp__<server>__<tool>', () => {
    expect(publicToolName('srv', 'x')).toBe('mcp__srv__x')
    expect(publicToolName('chrome-devtools-9333', 'click')).toBe('mcp__chrome-devtools-9333__click')
  })

  it('★ 超长名走官方哈希截断（常量与结果都钉死）', () => {
    const raw = 'x'.repeat(80)
    const name = publicToolName('srv', raw)
    expect(name).toBe('mcp__srv__xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_cfc51d92f062')
    expect(name).toHaveLength(64)
    expect(name.endsWith('_cfc51d92f062')).toBe(true)
  })

  it('★ 官方微妙语义：**只要发生过字符替换就走哈希分支**（哪怕替换后很短）', () => {
    // 官方判据是 `normalized === joined && normalized.length <= 64` 两个条件**同时**成立才返回干净名，
    // 所以「替换过」即刻落到哈希分支——首版我的断言写成 `mcp__srv__a_b_c`（想当然），实测红。
    // 这里把官方真实行为钉死（含具体哈希），免得后人"顺手修正"成看起来更合理的样子。
    expect(publicToolName('srv', 'a/b c')).toBe('mcp__srv__a_b_c_4545e0115f58')
    expect(publicToolName('srv', 'a'.repeat(70))).toHaveLength(64)
  })
})
