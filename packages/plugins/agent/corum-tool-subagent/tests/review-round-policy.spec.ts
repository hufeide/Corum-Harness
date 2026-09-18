/**
 * Review 轮次纯策略单测（台账 2026-09-18 真机缺陷收口）。
 *
 * 覆盖 `packages/desktop/src/host/corum-review-round-policy.ts` 的两条判定：
 *   - `isGuestRound` —— guest 轮次（子会话与父会话共用工作区）；
 *   - `resolveSnapshotSource` —— 一次 `snapshot` 该实时重算还是回放冻结态。
 *
 * 为什么测试放在本包（corum-tool-subagent）而不是 desktop 包：desktop 没有 vitest
 * 装置，本包是 host 侧已有 vitest 的包；被测模块是 desktop host 的实现细节、**零 import
 * 的纯函数**，所以跨包相对路径 import 只产生「测试 → 实现」一条依赖（同一约定的先例见
 * 同目录 `review-bash-writes.spec.ts` 头部说明）。
 *
 * 两条判定各自对应一个真机缺陷，负例（不该判成 case）比正例更重要：
 *   1. 三个**只读**调研子会话（0 次写调用）被记上了**完全相同的 7 个路径**，全是父 Agent
 *      正在编辑的文件，审查卡里 9/9 条全被打上「子 Agent」标签 —— 根因是并集兜底按 mtime
 *      在**共用**工作区里挑改动。所以「共用工作区 ⇒ 必须判成 guest」是这张网的第一护栏。
 *   2. 隔离子 Agent 的 worktree 集成后会被回收，而卡片恰在事后展开：实时重算读到的是
 *      「文件不存在」⇒ 全删，或 pre-image 也取不回时条目被静默丢掉 ⇒ 改动区为空。
 *      所以「工作区不在 ⇒ 绝不 live」是第二护栏。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MAX_FROZEN_ROUNDS,
  MAX_SESSION_LEDGER,
  isGuestRound,
  resolveSnapshotSource,
  selectFrozenEvictions,
} from '../../../../desktop/src/host/corum-review-round-policy.ts'

/** 在线（非回放）会话 + 已知是工作区所有者的默认上下文；每个 case 只覆盖关心的字段。 */
const online = { fromJournal: false, knownWorkspaceOwner: true } as const

describe('isGuestRound — guest 轮次判定', () => {
  it('主会话（没有父会话、且在线见过它的事件）就是工作区所有者，不是 guest', () => {
    expect(isGuestRound({
      parentSession: undefined,
      parentCwd: undefined,
      workspace: '/repo',
      ...online,
    })).toBe(false)
  })

  it('★ 子会话与父会话 cwd 相同 ⇒ guest（只读调研子会话就是这一形态）', () => {
    expect(isGuestRound({
      parentSession: 'corum-task-8e6359fc',
      parentCwd: '/Users/kukucai/work/kkc-desktop',
      workspace: '/Users/kukucai/work/kkc-desktop',
      ...online,
    })).toBe(true)
  })

  it('隔离子会话（worktree ≠ 父 cwd）不是 guest，并集兜底保留', () => {
    expect(isGuestRound({
      parentSession: 'corum-task-8e6359fc',
      parentCwd: '/Users/kukucai/work/kkc-desktop',
      workspace: '/Users/kukucai/work/kkc-desktop/.corum-worktrees/wt-57e92c',
      ...online,
    })).toBe(false)
  })

  it('父子关系已知但父工作区未知 ⇒ guest（宁可少补一次，也不把来源不明的改动记到子 Agent 头上）', () => {
    expect(isGuestRound({
      parentSession: 'corum-task-8e6359fc',
      parentCwd: undefined,
      workspace: '/repo',
      ...online,
    })).toBe(true)
  })

  it('空串与缺省同义（会话 header 里的字段可能是空串）', () => {
    expect(isGuestRound({ parentSession: '', parentCwd: undefined, workspace: '/repo', ...online })).toBe(false)
    expect(isGuestRound({ parentSession: 'p', parentCwd: '', workspace: '/repo', ...online })).toBe(true)
  })

  it('cwd 的软链形态差异由调用方 realpath 归一（本函数只做字符串相等）', () => {
    // 记录口径：归一不在纯函数里做，避免这里出现 I/O。调用方（corum-review）已归一。
    expect(isGuestRound({
      parentSession: 'p',
      parentCwd: '/private/tmp/repo',
      workspace: '/tmp/repo',
      ...online,
    })).toBe(false)
  })

  it('★ 事故形态锚点：三个只读调研子会话全部被判成 guest（并集兜底一律不跑）', () => {
    // 现场参数取自真机（2026-09-18，父会话 corum-task-8e6359fc，父 cwd 即主树）：
    // 三个子会话 0 次写调用，却各自被记上**完全相同的 7 个路径**。
    const parentCwd = '/Users/kukucai/work/kkc-desktop'
    const children = [
      '7b10789a-623d-4f4b-bce7-e53d4373fb04',
      '2a7049d1-5295-4c85-af79-797d772d8f7d',
      '8b1c9b64-af7a-491b-9410-011597feecd0',
    ]
    expect(children).toHaveLength(3)
    for (const _child of children) {
      expect(isGuestRound({ parentSession: 'corum-task-8e6359fc', parentCwd, workspace: parentCwd, ...online }))
        .toBe(true)
    }
  })

  it('★ 重启后仍判得对：journal 带出 parent/parentCwd ⇒ 回放轮次的判定与在线时一致', () => {
    // `restoreRounds` 从 journal 的 `parent`/`parentCwd` 复原 ledger，所以回放出来的
    // 轮次结论不变（否则重启会把同一个缺陷带回来）。
    expect(isGuestRound({
      parentSession: 'corum-task-8e6359fc',
      parentCwd: '/repo',
      workspace: '/repo',
      fromJournal: true,
      knownWorkspaceOwner: false,
    })).toBe(true)
  })

  it('★★ 旧版 journal（没有 parent 字段）回放出的轮次 ⇒ 按 guest 处理（缺陷不能随重启复活）', () => {
    expect(isGuestRound({
      parentSession: undefined,
      parentCwd: undefined,
      workspace: '/repo',
      fromJournal: true,
      knownWorkspaceOwner: false,
    })).toBe(true)
  })

  it('★ 回放轮次一旦被证明是工作区所有者（见到它的会话事件且无父会话）⇒ 恢复并集兜底', () => {
    expect(isGuestRound({
      parentSession: undefined,
      parentCwd: undefined,
      workspace: '/repo',
      fromJournal: true,
      knownWorkspaceOwner: true,
    })).toBe(false)
  })

  it('非回放的会话若父子关系未知 ⇒ 不是 guest（在线路径永远先经过 session/event 记账）', () => {
    expect(isGuestRound({
      parentSession: undefined,
      parentCwd: undefined,
      workspace: '/repo',
      fromJournal: false,
      knownWorkspaceOwner: false,
    })).toBe(false)
  })
})

describe('resolveSnapshotSource — 取数来源', () => {
  it('活轮次 + 工作区健在 ⇒ live（唯一能看见「进行中改动」的路）', () => {
    expect(resolveSnapshotSource({ hasLiveRound: true, workspaceAlive: true, hasFrozen: false }))
      .toEqual({ kind: 'live' })
  })

  it('活轮次 + 工作区健在 + 有冻结态 ⇒ 仍然 live（冻结态只在算不出来时兜底）', () => {
    expect(resolveSnapshotSource({ hasLiveRound: true, workspaceAlive: true, hasFrozen: true }))
      .toEqual({ kind: 'live' })
  })

  it('★ 活轮次但工作区已被回收 + 有冻结态 ⇒ frozen(workspace-gone)，绝不重算', () => {
    expect(resolveSnapshotSource({ hasLiveRound: true, workspaceAlive: false, hasFrozen: true }))
      .toEqual({ kind: 'frozen', reason: 'workspace-gone' })
  })

  it('★ 工作区已被回收且没有冻结态 ⇒ none（如实报「不知道」，也不假装文件全被删）', () => {
    expect(resolveSnapshotSource({ hasLiveRound: true, workspaceAlive: false, hasFrozen: false }))
      .toEqual({ kind: 'none' })
  })

  it('轮次已收尾 + 有冻结态 ⇒ frozen(round-closed)', () => {
    expect(resolveSnapshotSource({ hasLiveRound: false, workspaceAlive: false, hasFrozen: true }))
      .toEqual({ kind: 'frozen', reason: 'round-closed' })
  })

  it('什么都没见过 ⇒ none', () => {
    expect(resolveSnapshotSource({ hasLiveRound: false, workspaceAlive: false, hasFrozen: false }))
      .toEqual({ kind: 'none' })
  })

  it('★ 事故形态锚点：隔离 worktree 被回收之后，子 Agent 卡片的改动区必须是「冻结态」而不是空', () => {
    // 现场：轮次还在内存里（子会话只有 1 个 turn，closeRound 永不触发），
    // 而 workspace 指向的 .corum-worktrees/wt-xxxx 已被集成流程回收。
    const source = resolveSnapshotSource({ hasLiveRound: true, workspaceAlive: false, hasFrozen: true })
    expect(source).not.toEqual({ kind: 'live' })
    expect(source).toEqual({ kind: 'frozen', reason: 'workspace-gone' })
  })
})

describe('selectFrozenEvictions — 冻结态内存护栏', () => {
  it('未超上限 ⇒ 不淘汰任何一条', () => {
    expect(selectFrozenEvictions([
      { sessionId: 'a', at: 1 },
      { sessionId: 'b', at: 2 },
    ], 2)).toEqual([])
  })

  it('超出上限 ⇒ 按最旧优先淘汰，只淘汰超出部分', () => {
    expect(selectFrozenEvictions([
      { sessionId: 'a', at: 30 },
      { sessionId: 'b', at: 10 },
      { sessionId: 'c', at: 20 },
      { sessionId: 'd', at: 40 },
    ], 2)).toEqual(['b', 'c'])
  })

  it('上限为 0 ⇒ 全淘汰（设置成 0 就是「不留冻结态」）', () => {
    expect(selectFrozenEvictions([{ sessionId: 'a', at: 1 }, { sessionId: 'b', at: 2 }], 0))
      .toEqual(['a', 'b'])
  })

  it('同一时刻并列 ⇒ 按 sessionId 定序（结果稳定、可复现）', () => {
    expect(selectFrozenEvictions([
      { sessionId: 'b', at: 5 },
      { sessionId: 'a', at: 5 },
    ], 1)).toEqual(['a'])
  })

  it('默认上限是 16（冻结态会钉住 pre-image，不能无界增长）', () => {
    expect(MAX_FROZEN_ROUNDS).toBe(16)
  })
})

describe('会话 ledger 上限（会话 → cwd / 父会话 / 所有者 记账）', () => {
  it('上限是有限值（长进程里见过的会话数无界，不设护栏就是慢性内存泄漏）', () => {
    expect(Number.isFinite(MAX_SESSION_LEDGER)).toBe(true)
    expect(MAX_SESSION_LEDGER).toBeGreaterThan(0)
  })
})

/**
 * 落盘契约的读写对账（源码扫描）。
 *
 * 为什么用扫描而不是单测：这两条契约的**两端**（写侧 append、读侧 replay）都在
 * `corum-review.ts` 里分居两处，而真正的失效形态是「写侧加了字段、读侧没认」——
 * 例如 2026-09-18 收口时我给 journal 加了 `parent`/`parentCwd`，若读侧不同步，
 * 重启后 guest 轮次就认不出父会话，缺陷随重启复活。这种「一端改了另一端没改」
 * 只有把两侧的形一起断言才拦得住（同款做法先例：verify 门的 schema↔catch↔render
 * 三面对账）。
 */
describe('落盘契约读写对账（源码扫描）', () => {
  const src = readFileSync(
    new URL('../../../../desktop/src/host/corum-review.ts', import.meta.url),
    'utf8',
  )

  it('journal 写侧带 parent/parentCwd/via，读侧认得 parent/parentCwd', () => {
    expect(src).toContain('const parent = this.sessionParents.get(round.sessionId)')
    expect(src).toContain('...parent === undefined ? {} : { parent },')
    expect(src).toContain('...parentCwd === undefined ? {} : { parentCwd },')
    expect(src).toContain("if (line.parent !== undefined && line.parent !== '')")
    expect(src).toContain('this.setLedger(this.sessionParents, line.session, line.parent)')
    expect(src).toContain('this.setLedger(this.sessionCwds, line.parent, line.parentCwd)')
  })

  it('捕获来源标记：tool / union 两条路径都写，且类型允许', () => {
    expect(src).toContain("type CaptureVia = 'tool' | 'union'")
    expect(src).toContain("this.persistCapture(round, rel, pre, 'tool')")
    expect(src).toContain("this.persistCapture(round, rel, pre, 'union')")
  })

  it('冻结态落盘的写侧字段与读侧消费一致（t/session/workspace/round/at/files）', () => {
    expect(src).toContain("type FrozenLine = {")
    for (const field of ['session: string', 'workspace: string', 'round: number', 'at: number', 'files: ReviewFileEntry[]']) {
      expect(src).toContain(field)
    }
    expect(src).toContain("t: 'frozen',")
    expect(src).toContain('const line: FrozenLine = {')
    expect(src).toContain("if (line.t !== 'frozen' || typeof line.session !== 'string' || !Array.isArray(line.files)) continue")
  })

  it('冻结态落盘与回放都被接线（否则重启后子卡又变空）', () => {
    expect(src).toContain('void this.restoreFrozen()')
    expect(src).toContain('await this.persistFrozen(sessionId, {')
  })

  it('★ 单轮子会话必须自己结算轮次（否则「改后」永不进 git，diff 右侧无内容）', () => {
    // 现场：两个隔离子会话各只有 1 个 turn，而 closeRound 挂在下一次 turn/start ⇒
    // 它们的影子仓库 rev-list --all --count = 0、refs 为空，「改后」内容从未落库。
    expect(src).toContain("if (session.header?.origin === 'subagent') {")
    expect(src).toContain('void this.settleRound(round, round.touched)')
    // closeRound 与 settleRound 必须共用同一条落库路径（分叉过一次的代价就是两侧不对称）。
    expect(src).toContain('private async writeRoundCommits(')
    expect(src).toContain('const committed = await this.settleRound(round, touched)')
    expect(src).toContain('return this.writeRoundCommits(round, touched)')
  })

  it('★ diff 右侧从 git blobs 取（fileAfter），与工作区生死无关', () => {
    expect(src).toContain("@Remote('fileAfter')")
    expect(src).toContain("const entry = frozen?.files.find(f => f.path === path)")
    expect(src).toContain("['cat-file', 'blob', entry.hash]")
    // 左侧的 pre-image 引用也要落盘（只落引用，不落正文）。
    expect(src).toContain('preimages: await this.blobify(workspace, touched)')
    expect(src).toContain('function inflatePreimages(')
    // 未知/坏形态一律降级为 unavailable，绝不降级成 absent（那会让撤销删掉用户的文件）。
    expect(src).toContain("else out.set(path, { kind: 'unavailable' })")
    expect(src).not.toContain("else out.set(path, { kind: 'absent' })")
  })
})
