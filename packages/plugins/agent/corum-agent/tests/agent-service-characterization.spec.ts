/**
 * 特征化测试（characterization）：把**今天**的行为钉死，供本轮搬迁对照（P0-b）。
 *
 * ## 为什么必须先写这个（而不是搬完再补测试）
 *
 * 本轮要搬的 6/7/8 三簇**本来就在测试盲区里**（`agent-service.ts` 2877 行里，
 * 没有任何测试真的构造服务并跑这些方法）。于是上场那条教训会重演：
 *
 * > `findLaneAgent` 的 `return undefined` 被切掉后，**编译通过、测试全绿**
 * > —— 只有 `git diff` 对照 HEAD 才发现。
 *
 * `git diff` 能证明「我搬得一样」，但证明不了「搬完还能跑」。本文件的定位就是补上后者：
 * **先钉住真实输出**（含降级路径、含边界值），搬完再跑同一批断言。
 *
 * ## 一条纪律
 *
 * 本文件里**不写「应该怎样」**，只写「今天实际怎样」。若某条断言看起来像在保护一个
 * 缺陷（例如 `integrated` 静默失效），那也**照钉不误**，并在注释里标注「这是现状，
 * 搬迁必须保持；修它是另一件事」——特征化测试一旦掺进期望行为，就无法用来做等价判据了。
 *
 * @module @corum/corum-agent/tests/agent-service-characterization
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BOOT_AT, LONG_AGO, makeHarness, sessionEvent, type Harness } from './harness.ts'

let h: Harness | undefined

afterEach(() => {
  h?.cleanup()
  h = undefined
})

/**
 * 让 `agentRunning(childId)` 返回 **true**（子会话在 registry 里且 status='running'）。
 *
 * 为什么需要它：中断判据是**三态**的 —— `undefined`（问不到）/ `false`（确认没在跑）/
 * `true`（在跑）。只有 `true` 能让判据①②都不命中，从而把「未闭合 turn 却不判中断」
 * 这条路径单独隔离出来；否则 `not-running` 会掩盖其它断言（实测踩过）。
 */
function provideRunningChild(harness: Harness, childId: string): void {
  harness.provide('agents', {
    list: () => [{ session: { id: childId }, status: 'running' }],
  })
}

/* ────────────────────────── 簇 7：子会话进度（P1） ────────────────────────── */

describe('特征化 · getChildSessionProgressRemote（簇 7 / P1）', () => {
  it('恒存在的 identity 字段：role 来自内存表、isolated 来自会话 cwd', async () => {
    h = makeHarness()
    // role 记在内存表里（tracker 的 roles），isolated 走 childWorktreeIsolation。
    // 表已随 P1-b 搬进 SubagentProgressTracker，spec 一律经 harness 视图访问。
    h.state.subagentRoles.set('child-a', 'worker')
    h.usePersistence({ 'child-a': { cwd: '/repo/.corum-worktrees/wt-1', events: [] } })

    const out = await h.service.getChildSessionProgressRemote('child-a')
    expect(out).toEqual({ role: 'worker', isolated: true })
  })

  it('非隔离子会话 → isolated: false（不是 undefined）', async () => {
    h = makeHarness()
    h.usePersistence({ 'child-b': { cwd: '/repo/plain', events: [] } })
    const out = await h.service.getChildSessionProgressRemote('child-b')
    expect(out).toEqual({ isolated: false })
  })

  it('会话读不到 → 只返回 identity（早期返回路径，不伪造 progress）', async () => {
    h = makeHarness()
    // 不提供该会话 ⇒ persistence.open 抛错 ⇒ 走 catch → return identity
    h.usePersistence({})
    const out = await h.service.getChildSessionProgressRemote('no-such-session')
    expect(out).toEqual({})
  })

  it('事件窗口为空 → 只返回 identity（不产生 progress 字段）', async () => {
    h = makeHarness()
    h.usePersistence({ 'child-c': { cwd: '/repo/plain', events: [] } })
    const out = await h.service.getChildSessionProgressRemote('child-c')
    expect(out).toEqual({ isolated: false })
    expect('progress' in out).toBe(false)
  })

  it('★ 全量折叠的逐字段口径（turn/step/currentAction/done/stopReason/todos/lastActive）', async () => {
    h = makeHarness()
    const now = BOOT_AT + 30_000  // 本进程运行期间（见 harness 的 BOOT_AT 注释）
    h.usePersistence({
      'child-d': {
        cwd: '/repo/plain',
        events: [
          sessionEvent('turn/start', { turn: 1 }, now - 500, 1),
          sessionEvent('step/end', { turn: 1, step: 2 }, now - 400, 2),
          sessionEvent('tool/call', { name: 'bash' }, now - 300, 3),
          sessionEvent('todo/write', { todos: [{ text: 'T1', status: 'pending' }] }, now - 200, 4),
          sessionEvent('turn/end', { reason: { kind: 'completed' } }, now - 100, 5),
        ],
      },
    })
    const out = await h.service.getChildSessionProgressRemote('child-d')
    expect(out).toEqual({
      isolated: false,
      progress: {
        turn: 1,
        step: 2,
        done: true,
        stopReason: 'completed',
        // tool/call 设了 currentAction，但 turn/end 会清掉它 ⇒ 最终不带该键
        lastActive: now - 100,
        todos: [{ text: 'T1', status: 'pending' }],
      },
    })
  })

  it('assistant/message 含 text 块 → 清掉 currentAction（避免工具动作滞留）', async () => {
    h = makeHarness()
    // ⚠️ 时间戳必须**晚于本进程启动**：否则会额外命中「pre-boot 半途失去运行」判据
    // （那条判据会让 done=true / interrupted=true），把本条断言的焦点搅浑。
    const now = BOOT_AT + 30_000  // 本进程运行期间（见 harness 的 BOOT_AT 注释）
    provideRunningChild(h, 'child-e')
    h.usePersistence({
      'child-e': {
        events: [
          sessionEvent('turn/start', { turn: 1 }, now - 300, 1),
          sessionEvent('tool/call', { name: 'bash' }, now - 200, 2),
          sessionEvent('assistant/message', { message: { content: [{ type: 'text', text: 'hi' }] } }, now - 100, 3),
        ],
      },
    })
    const out = await h.service.getChildSessionProgressRemote('child-e')
    expect(out.progress?.currentAction).toBeUndefined()
    // turn 未闭合、且不在启动前 ⇒ 不算中断：done 保持 false
    expect(out.progress?.done).toBe(false)
    expect(out.progress?.interrupted).toBeUndefined()
  })

  it('★ 未闭合 turn + 进程启动前 → done+interrupted（pre-boot 判据，独立成条）', async () => {
    h = makeHarness()
    h.provide('agents', { list: () => [] })
    h.usePersistence({
      'child-e2': {
        events: [
          sessionEvent('turn/start', { turn: 1 }, LONG_AGO, 1),
          sessionEvent('assistant/message', { message: { content: [{ type: 'text', text: 'hi' }] } }, LONG_AGO + 1, 2),
        ],
      },
    })
    const out = await h.service.getChildSessionProgressRemote('child-e2')
    expect(out.progress).toMatchObject({ done: true, interrupted: true })
  })

  it('assistant/message 只有 tool-call 块 → currentAction 保留', async () => {
    h = makeHarness()
    const now = BOOT_AT + 30_000  // 本进程运行期间（见 harness 的 BOOT_AT 注释）
    h.usePersistence({
      'child-f': {
        events: [
          sessionEvent('turn/start', { turn: 1 }, now - 300, 1),
          sessionEvent('tool/call', { name: 'grep' }, now - 200, 2),
          sessionEvent('assistant/message', { message: { content: [{ type: 'tool-call' }] } }, now - 100, 3),
        ],
      },
    })
    const out = await h.service.getChildSessionProgressRemote('child-f')
    expect(out.progress?.currentAction).toBe('grep')
  })

  it('step/end 只在 (turn 相同 ∧ step 更大) 时推进 step（乱序事件不倒退）', async () => {
    h = makeHarness()
    const now = BOOT_AT + 30_000  // 本进程运行期间（见 harness 的 BOOT_AT 注释）
    h.usePersistence({
      'child-g': {
        events: [
          sessionEvent('turn/start', { turn: 2 }, now - 400, 1),
          sessionEvent('step/end', { turn: 2, step: 5 }, now - 300, 2),
          sessionEvent('step/end', { turn: 2, step: 1 }, now - 200, 3),
          sessionEvent('step/end', { turn: 1, step: 9 }, now - 100, 4),
        ],
      },
    })
    const out = await h.service.getChildSessionProgressRemote('child-g')
    expect(out.progress?.turn).toBe(2)
    expect(out.progress?.step).toBe(5)
  })

  it('★ 半途失去运行：host 启动前的未闭合 turn → done+interrupted，并广播一次', async () => {
    h = makeHarness()
    h.usePersistence({
      'child-h': {
        events: [
          sessionEvent('turn/start', { turn: 1 }, LONG_AGO, 1),
          sessionEvent('tool/call', { name: 'bash' }, LONG_AGO + 1, 2),
        ],
      },
    })
    // 让 agentRunning 问不到（agents.list 缺席）⇒ undefined ⇒ 判据①不命中，落到判据②
    // （lastActive 早于本进程启动 ⇒ pre-boot）。这条正是「pre-boot」判据的单测形态。
    h.provide('agents', {})
    const out = await h.service.getChildSessionProgressRemote('child-h')
    expect(out.progress?.done).toBe(true)
    expect(out.progress?.interrupted).toBe(true)
    expect(out.progress?.stopReason).toBeUndefined()

    const frames = h.eventsOf('corum/subagent/interrupted')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      sessionId: 'child-h',
      reason: 'pre-boot',
      turn: 1,
      step: 0,
      lastActive: LONG_AGO + 1,
    })
  })

  it('★ 中断广播按子会话去重（反复拉取只广播一次）', async () => {
    h = makeHarness()
    h.usePersistence({
      'child-i': { events: [sessionEvent('turn/start', { turn: 1 }, LONG_AGO, 1)] },
    })
    h.provide('agents', {})
    await h.service.getChildSessionProgressRemote('child-i')
    await h.service.getChildSessionProgressRemote('child-i')
    await h.service.getChildSessionProgressRemote('child-i')
    expect(h.eventsOf('corum/subagent/interrupted')).toHaveLength(1)
  })

  it('中断广播带 parentSessionId（内存表命中时）', async () => {
    h = makeHarness()
    h.state.subagentParents.set('child-j', 'parent-1')
    h.usePersistence({
      'child-j': { events: [sessionEvent('turn/start', { turn: 1 }, LONG_AGO, 1)] },
    })
    h.provide('agents', {})
    await h.service.getChildSessionProgressRemote('child-j')
    expect(h.eventsOf('corum/subagent/interrupted')[0]).toMatchObject({ parentSessionId: 'parent-1' })
  })

  it('中断广播的父会话兜底：帧没记过 → 读持久化 header.parentSession', async () => {
    h = makeHarness()
    h.usePersistence({
      'child-k': {
        parentSession: 'parent-from-header',
        events: [sessionEvent('turn/start', { turn: 1 }, LONG_AGO, 1)],
      },
    })
    h.provide('agents', {})
    await h.service.getChildSessionProgressRemote('child-k')
    expect(h.eventsOf('corum/subagent/interrupted')[0]).toMatchObject({ parentSessionId: 'parent-from-header' })
  })

  it('turn 已闭合 → 不判中断、不广播（有权威终局原因）', async () => {
    h = makeHarness()
    h.usePersistence({
      'child-l': {
        events: [
          sessionEvent('turn/start', { turn: 1 }, LONG_AGO, 1),
          sessionEvent('turn/end', { reason: { kind: 'aborted' } }, LONG_AGO + 1, 2),
        ],
      },
    })
    h.provide('agents', {})
    const out = await h.service.getChildSessionProgressRemote('child-l')
    expect(out.progress).toMatchObject({ done: true, stopReason: 'aborted' })
    expect(out.progress?.interrupted).toBeUndefined()
    expect(h.eventsOf('corum/subagent/interrupted')).toHaveLength(0)
  })

  it('新 turn 开始 → 清掉上一轮的 stopReason 与 todos', async () => {
    h = makeHarness()
    const now = BOOT_AT + 30_000  // 本进程运行期间（见 harness 的 BOOT_AT 注释）
    provideRunningChild(h, 'child-m')
    h.usePersistence({
      'child-m': {
        events: [
          sessionEvent('turn/start', { turn: 1 }, now - 900, 1),
          sessionEvent('todo/write', { todos: [{ text: 'old' }] }, now - 800, 2),
          sessionEvent('turn/end', { reason: { kind: 'completed' } }, now - 700, 3),
          sessionEvent('turn/start', { turn: 2 }, now - 600, 4),
        ],
      },
    })
    const out = await h.service.getChildSessionProgressRemote('child-m')
    expect(out.progress).toMatchObject({ turn: 2, done: false })
    expect(out.progress?.stopReason).toBeUndefined()
    expect(out.progress?.todos).toBeUndefined()
  })
})

describe('特征化 · getSubagentSessionMetaRemote（簇 7 / P1）', () => {
  it('取首条 user/message 的 text 块拼成 prompt', async () => {
    h = makeHarness()
    h.usePersistence({
      'child-n': {
        events: [
          sessionEvent('turn/start', { turn: 1 }, 1_000, 1),
          sessionEvent('user/message', { content: [{ type: 'text', text: '任务指令 A' }] }, 1_100, 2),
          sessionEvent('user/message', { content: [{ type: 'text', text: '后续追问（不取）' }] }, 1_200, 3),
        ],
      },
    })
    expect(await h.service.getSubagentSessionMetaRemote('child-n')).toEqual({ meta: { prompt: '任务指令 A' } })
  })

  it('兼容 data.message.content 形态（与 assistant/message 同形的那条路径）', async () => {
    h = makeHarness()
    h.usePersistence({
      'child-o': {
        events: [
          sessionEvent('user/message', { message: { content: [{ type: 'text', text: 'B 形态' }] } }, 1_100, 1),
        ],
      },
    })
    expect(await h.service.getSubagentSessionMetaRemote('child-o')).toEqual({ meta: { prompt: 'B 形态' } })
  })

  it('多个 text 块按序拼接后 trim', async () => {
    h = makeHarness()
    h.usePersistence({
      'child-p': {
        events: [
          sessionEvent('user/message', { content: [{ type: 'text', text: ' 前 ' }, { type: 'text', text: ' 后 ' }] }, 1_100, 1),
        ],
      },
    })
    expect(await h.service.getSubagentSessionMetaRemote('child-p')).toEqual({ meta: { prompt: '前  后' } })
  })

  it('首条 user/message 的 text 为空 → 继续找下一条（不是直接返回 {}）', async () => {
    h = makeHarness()
    h.usePersistence({
      'child-q': {
        events: [
          sessionEvent('user/message', { content: [{ type: 'image' }] }, 1_100, 1),
          sessionEvent('user/message', { content: [{ type: 'text', text: '真正的指令' }] }, 1_200, 2),
        ],
      },
    })
    expect(await h.service.getSubagentSessionMetaRemote('child-q')).toEqual({ meta: { prompt: '真正的指令' } })
  })

  it('没有 user/message → {}', async () => {
    h = makeHarness()
    h.usePersistence({
      'child-r': { events: [sessionEvent('turn/start', { turn: 1 }, 1_000, 1)] },
    })
    expect(await h.service.getSubagentSessionMetaRemote('child-r')).toEqual({})
  })

  it('会话读不到 → {}（不抛）', async () => {
    h = makeHarness()
    h.usePersistence({})
    expect(await h.service.getSubagentSessionMetaRemote('no-such')).toEqual({})
  })
})

/* ────────────────────────── 簇 8：变更摘要（P2） ────────────────────────── */

describe('特征化 · buildChangeSummary / emitChangeSummary（簇 8 / P2）', () => {
  /** 借服务的私有方法（搬迁后这些断言应原样成立——它们是等价判据）。 */
  const call = (harness: Harness, name: string, ...args: unknown[]): unknown =>
    (harness.service as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args)

  it('corumReview 与台账都缺席 → undefined（卡片降级）', async () => {
    h = makeHarness()
    h.usePersistence({})
    expect(await call(h, 'buildChangeSummary', 'child-1')).toBeUndefined()
  })

  it('corumReview 有文件 → filesChanged + files 逐字段透传（含 status）', async () => {
    h = makeHarness()
    h.provideGet('corumReview', {
      snapshot: async () => ({
        files: [
          { path: 'a.ts', added: 3, removed: 1, status: 'content' },
          { path: 'b.ts', added: 0, removed: 9, status: 'absent' },
          { path: 'c.ts', added: 1, removed: 0 },
        ],
      }),
    })
    expect(await call(h, 'buildChangeSummary', 'child-2')).toEqual({
      filesChanged: 3,
      files: [
        { path: 'a.ts', added: 3, removed: 1, status: 'content' },
        { path: 'b.ts', added: 0, removed: 9, status: 'absent' },
        // status 缺省时**不带该键**（不是 undefined 占位）
        { path: 'c.ts', added: 1, removed: 0 },
      ],
    })
  })

  it('corumReview.snapshot 抛错 → 降级为「无文件」，不抛给调用方', async () => {
    h = makeHarness()
    h.provideGet('corumReview', { snapshot: async () => { throw new Error('boom') } })
    expect(await call(h, 'buildChangeSummary', 'child-3')).toBeUndefined()
  })

  it('corumReview 返回空 files 且无台账 → undefined', async () => {
    h = makeHarness()
    h.provideGet('corumReview', { snapshot: async () => ({ files: [] }) })
    expect(await call(h, 'buildChangeSummary', 'child-4')).toBeUndefined()
  })

  it('台账命中 → worktreeSlug/branch/path + integrated 标记', async () => {
    h = makeHarness()
    h.provideGet('corumReview', { snapshot: async () => ({ files: [{ path: 'x.ts', added: 1, removed: 0 }] }) })
    h.provideGet('corumOrchestration', {
      entriesOf: () => [{ slug: 'wt-1', branch: 'corum/wt-1', path: '/repo/.corum-worktrees/wt-1', status: 'integrated' }],
    })
    // 父会话由 agents 服务反查（子会话 id 匹配）
    const session = Session.create(SessionId('child-5'))
    h.provide('agents', { list: () => [{ session: { id: 'child-5', header: { parentSession: 'parent-5' } } }] })

    expect(await call(h, 'buildChangeSummary', 'child-5')).toEqual({
      filesChanged: 1,
      files: [{ path: 'x.ts', added: 1, removed: 0 }],
      worktreeSlug: 'wt-1',
      worktreeBranch: 'corum/wt-1',
      worktreePath: '/repo/.corum-worktrees/wt-1',
      integrated: true,
    })
  })

  it('台账 entriesOf 抛错 → 台账侧降级，但文件列表保留', async () => {
    h = makeHarness()
    h.provideGet('corumReview', { snapshot: async () => ({ files: [{ path: 'y.ts', added: 2, removed: 0 }] }) })
    h.provideGet('corumOrchestration', { entriesOf: () => { throw new Error('ledger down') } })
    h.provide('agents', {
      list: () => [{ session: { id: 'child-6', header: { parentSession: 'parent-6' } } }],
    })
    expect(await call(h, 'buildChangeSummary', 'child-6')).toEqual({
      filesChanged: 1,
      files: [{ path: 'y.ts', added: 2, removed: 0 }],
    })
  })

  it('★ 反查到父会话但台账返回空 → 只剩 filesChanged（不带 worktree 键）', async () => {
    h = makeHarness()
    h.provideGet('corumReview', { snapshot: async () => ({ files: [{ path: 'z.ts', added: 1, removed: 1 }] }) })
    h.provideGet('corumOrchestration', { entriesOf: () => [] })
    h.provide('agents', { list: () => [{ session: { id: 'child-7', header: { parentSession: 'parent-7' } } }] })
    const out = await call(h, 'buildChangeSummary', 'child-7') as Record<string, unknown>
    expect(out.filesChanged).toBe(1)
    expect('worktreeSlug' in out).toBe(false)
    expect('integrated' in out).toBe(false)
  })

  it('★ agents.list 的两种形态都要能吃：函数（官方形态）与可迭代属性', async () => {
    // 源码注释（`childWorktreeIsolation` / `buildChangeSummary`）把 `agents.list` 误用
    // 记成过一次事故：**按属性 `for...of` 一个函数** ⇒ 抛 `function is not iterable`，
    // 被外层 try/catch 吞掉 ⇒ integrated 标记长期静默失效（2026-09-12）。
    // 现状实现已按 `typeof raw === 'function' ? raw() : raw` 两种形态兼容 ⇒ 断言**两种都通**。
    // 搬迁必须保持这条兼容（它是那次事故留下的修复，删掉即复活）。
    for (const [label, list] of [
      ['函数形态', () => [{ session: { id: 'child-8', header: { parentSession: 'parent-8' } } }]],
      ['可迭代属性形态', [{ session: { id: 'child-8', header: { parentSession: 'parent-8' } } }]],
    ] as const) {
      h = makeHarness()
      h.provideGet('corumReview', { snapshot: async () => ({ files: [{ path: 'q.ts', added: 1, removed: 0 }] }) })
      h.provideGet('corumOrchestration', {
        entriesOf: () => [{ slug: 'wt-q', branch: 'b', path: '/p', status: 'integrated' }],
      })
      h.provide('agents', { list })
      const out = await call(h, 'buildChangeSummary', 'child-8') as Record<string, unknown>
      expect(out, label).toMatchObject({
        filesChanged: 1,
        worktreeSlug: 'wt-q',
        integrated: true,
      })
      h.cleanup()
      h = undefined
    }
  })

  it('emitChangeSummary：进度表无该会话 → 不发帧（会话已 dispose）', async () => {
    h = makeHarness()
    h.provideGet('corumReview', { snapshot: async () => ({ files: [{ path: 'a', added: 1, removed: 0 }] }) })
    call(h, 'emitChangeSummary', 'child-9')
    await new Promise(r => setTimeout(r, 10))
    expect(h.eventsOf('corum/subagent/progress')).toHaveLength(0)
  })

  it('emitChangeSummary：有进度态 → 补发一帧带 changeSummary 的终态帧', async () => {
    h = makeHarness()
    h.provideGet('corumReview', { snapshot: async () => ({ files: [{ path: 'a', added: 1, removed: 0 }] }) })
    h.state.subagentProgress.seed('child-10', { turn: 3, step: 7, done: true, stopReason: 'completed' })

    call(h, 'emitChangeSummary', 'child-10')
    await new Promise(r => setTimeout(r, 10))

    const frames = h.eventsOf('corum/subagent/progress') as Array<Record<string, unknown>>
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      sessionId: 'child-10',
      turn: 3,
      step: 7,
      done: true,
      stopReason: 'completed',
      changeSummary: { filesChanged: 1 },
    })
  })
})

/* ──────────────────── 簇 6：泳道存活表读取（P3） ──────────────────── */
/* 项目模式剥离（2026-09-26）：泳道会话的**创建**编排（createAgentForType /
 * createAgentForLane / laneSetupHooks）已迁到闭源仓 Corum-Harness-Project 的
 * `@corum/corum-project`。存活表仍由本服务的 AgentRegistry 持有，故这里保留
 * **读取面**的特征化断言（getAgentForType / getAgentForLane / resolveLaneBySessionId
 * / findLaneAgent）——它们是权限网关与 applySubagentModelForSession 的可信身份来源。 */

describe('特征化 · 泳道存活表查找（簇 6 / P3）', () => {
  it('getAgentForType / getAgentForLane 走同一条 instanceKey 拼接（含缺省 type）', () => {
    h = makeHarness()
    const agent = h.registerLaneAgent('proj1', 'profile1', { key: 'dev', type: 'dev' }, 'sess-lane-1')
    expect(h.service.getAgentForType('proj1', 'profile1', 'dev')).toBe(agent)
    expect(h.service.getAgentForLane('proj1', 'profile1', 'dev')).toBe(agent)
    // 缺省 type = GENERAL_WORK_TYPE ⇒ 与登记的 'dev' 不同键
    expect(h.service.getAgentForType('proj1', 'profile1')).toBeUndefined()
    expect(h.service.getAgentForLane('proj1', 'profile1', 'nope')).toBeUndefined()
  })

  it('resolveLaneBySessionId 只认登记过的会话（未登记 → undefined）', () => {
    h = makeHarness()
    expect(h.service.resolveLaneBySessionId('unknown')).toBeUndefined()
    h.registerLaneAgent('p', 'a', { key: 'dev', type: 'dev' }, 'sess-lane-2')
    expect(h.service.resolveLaneBySessionId('sess-lane-2')).toEqual({
      projectId: 'p', profileId: 'a', type: 'dev', laneKey: 'dev',
    })
  })

  it('findLaneAgent：命中返回登记项、未命中返回 undefined', () => {
    h = makeHarness()
    const find = (h.service as unknown as Record<string, (s: string) => unknown>).findLaneAgent
    // **正向控制**（必须先有）：证明这条断言不是空转 —— 若 findLaneAgent 被搬坏成
    // 永远返回 undefined，仅断言「未命中 → undefined」会照常绿。
    h.registerLaneAgent('proj', 'prof', { key: 'dev', type: 'dev' }, 'sess-found')
    expect(find.call(h.service, 'sess-found')).toMatchObject({ sessionId: 'sess-found' })
    // 未命中 → undefined
    expect(find.call(h.service, 'definitely-not-a-lane')).toBeUndefined()

    // ⚠️ 诚实标注（本文件实测过）：**删掉那句 `return undefined` 时，本条断言不会变红**
    // —— 返回类型是 `| undefined`，falling off the end 与显式 return 在运行时**不可区分**，
    // 正向控制也照样通过。这一形态（上场真实发生过、且编译与 930 测试全绿）**只有**
    // `scripts/verify-refactor-guard.sh` 的静态断言能拦下。测试与守卫在这里是互补的，
    // 别把「测试绿」当成「搬运无误」。
  })

  it('listAgentsRemote 列出 agents 表全部 profileId', () => {
    h = makeHarness()
    h.state.agents.set('p1', { session: Session.create(SessionId('s1')) })
    h.state.agents.set('p2', { session: Session.create(SessionId('s2')) })
    expect(h.service.listAgentsRemote()).toEqual({
      agents: [{ profileId: 'p1', created: true }, { profileId: 'p2', created: true }],
    })
  })

  it('getEventsRemote：未创建的 profile → 空事件（不发 session 读取）', () => {
    h = makeHarness()
    expect(h.service.getEventsRemote('no-profile', 0)).toEqual({ events: [] })
  })

  it('getEventsRemote：按 fromSeq 过滤 + 逐条简化投影', () => {
    h = makeHarness()
    const session = Session.create(SessionId('s-events'))
    const events: SessionEvent[] = [
      sessionEvent('turn/start', { turn: 1 }, 1_000, 1),
      sessionEvent('tool/call', { callId: 'c1', name: 'bash' }, 1_100, 2),
    ]
    ;(session as unknown as { snapshotEvents: () => readonly SessionEvent[] }).snapshotEvents = () => events
    h.state.agents.set('p-events', { session })

    const all = h.service.getEventsRemote('p-events', 0)
    expect(all.events.map(e => e.seq)).toEqual([1, 2])
    expect(all.events[1]).toMatchObject({ type: 'tool/call', data: { callId: 'c1', name: 'bash' } })

    const from2 = h.service.getEventsRemote('p-events', 2)
    expect(from2.events.map(e => e.seq)).toEqual([2])
  })
})
