/**
 * 折叠语义的**等价判据**（P1-a）。
 *
 * ## 这个文件在证明什么
 *
 * 本轮 P1 把「子会话事件折叠」从两份实现（增量 + 全量，各 6 个 `case`，靠源头注释
 * 人肉维持一致）合并成 `child-progress.ts` 里**唯一一份**纯函数。
 *
 * 合并这类重复实现，最大的风险不是「写错」，而是**悄悄改了边角语义**——例如某个可选键
 * 在缺省时由「不带键」变成 `undefined` 占位，或某个 `case` 的 `break` 少了一层。这类差异
 * 在 30 条手写断言里很容易漏。
 *
 * 所以本文件不复述语义，而是**直接把 HEAD 里的原始实现取出来跑**，与新的纯函数对同一批
 * 事件做**逐字段 + 逐键**比对：
 *
 *   HEAD 原文（git show HEAD:…/agent-service.ts 的 slice 区间）
 *        ↓ 提取两个 switch 的公共体
 *   动态构造的对照实现  ⇄  foldProgressEvent / foldProgressAll
 *
 * 覆盖到「两份实现分歧」的所有形态：无关事件、乱序 step、重复事件、todos 重置、
 * turn 边界、以及**每个 case 单独喂**（保证 case 覆盖是穷举的）。
 *
 * ## 为什么区间写死
 *
 * 提取依赖行号，而 HEAD 版本的文件不会变 ⇒ 区间稳定。若将来 HEAD 前移导致取不到，
 * 本文件会 **fail-loud**（不是静默跳过）——静默跳过会让这条判据变成装饰。
 *
 * @module @corum/corum-agent/tests/fold-equivalence
 */

import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { stopReasonOfTurnEnd } from '@corum/corum-api-remotes/corum-events'
import { foldProgressAll, foldProgressEvent, initialProgressState, type ProgressState } from '../src/child-progress.ts'
import { sessionEvent } from './harness.ts'

/** 从 HEAD 读 `agent-service.ts`（拆分开始前、含两份原始 switch 的版本）。 */
function headServiceSource(): string {
  const out = execFileSync(
    'git',
    ['show', 'HEAD:packages/plugins/agent/corum-agent/src/agent-service.ts'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  return out
}

/** switch 体的起点（增量与全量两份实现用的是同一个 switch 头）。 */
const SWITCH_START = "  switch (event.type) {"
/** switch 体的收尾（`\n    }\n` —— 与 switch 自己的缩进对齐）。 */
const SWITCH_END = "\n    }\n"

/**
 * 把 TypeScript 原文里的 `as { … }` 类型断言去掉（`new Function` 只吃 JS）。
 *
 * 必须做括号配平扫描，不能用正则：断言体里还有嵌套花括号
 * （`as { message?: { content?: Array<{ type: string }> } }`），贪婪或懒惰的正则都会切错。
 *
 * ⚠️ 只处理**类型位置**的 `as {`；字符串字面量里不会出现该形态（HEAD 原文里已核对）。
 */
function stripTypeAssertions(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const at = src.indexOf(' as {', i)
    if (at < 0) { out += src.slice(i); break }
    out += src.slice(i, at)
    let depth = 0
    let j = at + 3 // 指向 `{`
    for (; j < src.length; j++) {
      const ch = src[j]
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { j++; break } }
    }
    if (depth !== 0) throw new Error('fold-equivalence: 类型断言的括号未配平——提取区间已失效')
    i = j
  }
  return out
}

/**
 * 从原文构造的 state 对象里去掉**帧元信息**字段（`sessionId` / `lastActive`）。
 *
 * 理由：`foldProgressEvent` 的等价对象是纯折叠状态，而原文那个 `return {}` 是**帧**的
 * 构造（同一段代码兼任两职，包含 `sessionId` 与 `lastActive: event.time`）。不剔除就
 * 会拿「状态」比「帧」，键集合必然不等。
 */
function stripFrameOnlyKeys(src: string): string {
  return src
    .split('\n')
    // 两种形态都要匹配：裸键 `sessionId,` 与赋值 `lastActive: event.time,`
    // （实测漏了后者 ⇒ 生成的 JS parse 失败于散落的 `lastActive: …`）。
    .filter(line => !/^\s*(sessionId|lastActive)\s*[,:]/.test(line))
    .join('\n')
}

/**
 * 由 HEAD 原文动态构造一个「原始折叠实现」。
 *
 * 做法：取 `switch (event.type) { … }` 整段 + 紧跟的「无变化判定」+「构造新状态」
 * 表达式，拼成一个与原始方法同形的函数体，交给 `new Function` 求值。
 * `stopReasonOfTurnEnd` 经参数注入（原文在模块作用域里引用它）。
 *
 * ⚠️ 原文的 `this.subagentProgress.delete/set`（LRU 置顶）与 `sessionId` / `event.time`
 * **不属于纯折叠**（那是持有者的记账），故刻意排除；`foldProgressEvent` 的等价对象是
 * 「原文构造出的 state 对象」。
 */
function makeOriginalFold(src: string): (prev: ProgressState, event: SessionEvent) => ProgressState | undefined {
  const start = src.indexOf(SWITCH_START)
  if (start < 0) throw new Error('fold-equivalence: 在 HEAD 里找不到 switch 头——提取区间已失效')
  const end = src.indexOf(SWITCH_END, start)
  if (end < 0) throw new Error('fold-equivalence: 在 HEAD 里找不到 switch 尾——提取区间已失效')
  const switchBody = src.slice(start, end + SWITCH_END.length)

  // 增量实现的尾部：无变化判定 → LRU 置顶 → `return { … }`。
  const tailStart = src.indexOf('if (turn === prev.turn && step === prev.step', start)
  if (tailStart < 0) throw new Error('fold-equivalence: 在 HEAD 里找不到无变化判定——提取区间已失效')
  const tailEnd = src.indexOf('\n  }\n', tailStart)
  if (tailEnd < 0) throw new Error('fold-equivalence: 在 HEAD 里找不到增量方法的收尾——提取区间已失效')
  const tail = src.slice(tailStart, tailEnd)
  if (!tail.includes('return {') || !tail.includes('lastActive: event.time')) {
    throw new Error('fold-equivalence: 增量尾部形态变了（提取区间已失效）')
  }
  // 丢掉 LRU 置顶（持有者记账，不属于纯折叠），只留「无变化判定」与「构造 state」。
  const guardEnd = tail.indexOf('\n    }') + '\n    }'.length
  if (guardEnd <= 0) throw new Error('fold-equivalence: 无法定位无变化判定的收尾')
  const guard = tail.slice(0, guardEnd)
  // 取**完整的** `return { … }`（配对扫到它的右括号），不能截到 `\n  }`——那会把
  // 对象字面量截断（实测报 `sessionId is not defined`）。
  const retStart = tail.indexOf('return {')
  if (retStart < 0) throw new Error('fold-equivalence: 找不到构造 state 的 return')
  let depth = 0
  let retEnd = -1
  for (let k = retStart; k < tail.length; k++) {
    if (tail[k] === '{') depth++
    else if (tail[k] === '}') { depth--; if (depth === 0) { retEnd = k + 1; break } }
  }
  if (retEnd < 0) throw new Error('fold-equivalence: return 对象未配平')
  const stateExpr = stripFrameOnlyKeys(tail.slice(retStart, retEnd))

  const body = stripTypeAssertions(`
    let turn = prev.turn
    let step = prev.step
    let currentAction = prev.currentAction
    let done = prev.done
    let stopReason = prev.stopReason
    let todos = prev.todos
${switchBody}
${guard}
    ${stateExpr}
  `)
  // eslint-disable-next-line no-new-func -- 对照实现必须来自 HEAD 原文，不能手抄
  const factory = new Function('stopReasonOfTurnEnd', `
    return function foldOriginal(prev, event) {
      ${body}
    }
  `) as (f: typeof stopReasonOfTurnEnd) => (prev: ProgressState, event: SessionEvent) => ProgressState | undefined
  return factory(stopReasonOfTurnEnd)
}

/** 一批覆盖各 case 与各边界的事件窗口。 */
function scenarios(): Array<{ name: string; events: SessionEvent[] }> {
  const t = 1_700_000_000_000
  return [
    { name: '空窗口', events: [] },
    { name: '仅 turn/start', events: [sessionEvent('turn/start', { turn: 1 }, t, 1)] },
    { name: 'turn/start 无 turn 字段（缺省 0）', events: [sessionEvent('turn/start', {}, t, 1)] },
    { name: 'turn 倒退不覆盖（t > turn 才生效）', events: [sessionEvent('turn/start', { turn: 5 }, t, 1), sessionEvent('turn/start', { turn: 2 }, t, 2)] },
    { name: 'step/end 推进', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('step/end', { turn: 1, step: 3 }, t, 2)] },
    { name: 'step/end 乱序回退（应不倒退）', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('step/end', { turn: 1, step: 9 }, t, 2), sessionEvent('step/end', { turn: 1, step: 2 }, t, 3)] },
    { name: 'step/end 异 turn 不生效', events: [sessionEvent('turn/start', { turn: 2 }, t, 1), sessionEvent('step/end', { turn: 1, step: 7 }, t, 2)] },
    { name: 'step/end 缺字段', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('step/end', {}, t, 2)] },
    { name: 'tool/call 设 currentAction', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('tool/call', { name: 'bash' }, t, 2)] },
    { name: 'tool/call 空名不生效', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('tool/call', { name: '' }, t, 2)] },
    { name: 'tool/call 无 name 字段', events: [sessionEvent('tool/call', {}, t, 1)] },
    { name: 'assistant/message text 清 currentAction', events: [sessionEvent('tool/call', { name: 'grep' }, t, 1), sessionEvent('assistant/message', { message: { content: [{ type: 'text' }] } }, t, 2)] },
    { name: 'assistant/message reasoning 清 currentAction', events: [sessionEvent('tool/call', { name: 'grep' }, t, 1), sessionEvent('assistant/message', { message: { content: [{ type: 'reasoning' }] } }, t, 2)] },
    { name: 'assistant/message 仅 tool-call 不清', events: [sessionEvent('tool/call', { name: 'grep' }, t, 1), sessionEvent('assistant/message', { message: { content: [{ type: 'tool-call' }] } }, t, 2)] },
    { name: 'assistant/message 空 content', events: [sessionEvent('tool/call', { name: 'grep' }, t, 1), sessionEvent('assistant/message', {}, t, 2)] },
    { name: 'turn/end 各 kind', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('turn/end', { reason: { kind: 'error' } }, t, 2)] },
    { name: 'turn/end 无 reason', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('turn/end', {}, t, 2)] },
    { name: 'turn/end 无 kind', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('turn/end', { reason: {} }, t, 2)] },
    { name: 'todo/write 写入', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('todo/write', { todos: [{ content: 'A', status: 'pending' }] }, t, 2)] },
    { name: 'todo/write 缺 todos（清空）', events: [sessionEvent('todo/write', { todos: [{ content: 'A', status: 'pending' }] }, t, 1), sessionEvent('todo/write', {}, t, 2)] },
    // ⚠️ 必须显式覆盖「step 已推进后再开新 turn」——否则 `turn/start` 里的 `step = 0`
    // 在等价判据里**不可观测**（实测：把这一句删掉，本文件照样全绿）。这是本文件第一版
    // 的真实盲区，补上后删该句即红。
    { name: '★ 新 turn 重置 step（前一轮 step 已推进）', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('step/end', { turn: 1, step: 7 }, t, 2), sessionEvent('turn/start', { turn: 2 }, t, 3)] },
    { name: '★ 新 turn 不回退 step 当 t ≤ turn（不应重置）', events: [sessionEvent('turn/start', { turn: 3 }, t, 1), sessionEvent('step/end', { turn: 3, step: 4 }, t, 2), sessionEvent('turn/start', { turn: 3 }, t, 3)] },
    { name: 'turn/start 重置 todos 与 stopReason', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('todo/write', { todos: [{ content: 'A', status: 'pending' }] }, t, 2), sessionEvent('turn/end', { reason: { kind: 'completed' } }, t, 3), sessionEvent('turn/start', { turn: 2 }, t, 4)] },
    { name: '无关事件不产生变化', events: [sessionEvent('user/message', { content: [] }, t, 1)] },
    { name: 'step/start 不产生变化', events: [sessionEvent('step/start', {}, t, 1)] },
    { name: '无关事件夹在中间', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('user/message', {}, t, 2), sessionEvent('tool/call', { name: 'x' }, t, 3)] },
    { name: '重复同一事件（第二次应无变化）', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('turn/start', { turn: 1 }, t, 2)] },
    { name: '完整一轮', events: [sessionEvent('turn/start', { turn: 1 }, t, 1), sessionEvent('step/end', { turn: 1, step: 1 }, t, 2), sessionEvent('tool/call', { name: 'bash' }, t, 3), sessionEvent('todo/write', { todos: [{ content: 'A', status: 'in_progress' }] }, t, 4), sessionEvent('assistant/message', { message: { content: [{ type: 'text' }] } }, t, 5), sessionEvent('step/end', { turn: 1, step: 2 }, t, 6), sessionEvent('turn/end', { reason: { kind: 'completed' } }, t, 7)] },
  ]
}

/** 逐字段 + **逐键**比对（键的存在性也是契约的一部分）。 */
function expectSameState(actual: ProgressState | undefined, expected: ProgressState | undefined, label: string): void {
  if (actual === undefined || expected === undefined) {
    expect(actual === undefined, `${label}: 一侧是 undefined 另一侧不是`).toBe(expected === undefined)
    return
  }
  expect(Object.keys(actual).sort(), `${label}: 键集合不同`).toEqual(Object.keys(expected).sort())
  expect(actual, `${label}: 字段值不同`).toEqual(expected)
}

describe('折叠等价判据：新纯函数 ≡ HEAD 原始实现', () => {
  const headSrc = headServiceSource()
  const foldOriginal = makeOriginalFold(headSrc)

  it('场景清单自检：窗口数与标题一致（防标题漂移成假陈述）', () => {
    expect(scenarios().length).toBe(28)
  })

  it('提取自检：HEAD 原文确实含两份 switch，且提取成功（失败即区间失效，不许静默跳过）', () => {
    // 两份实现（增量 + 全量）⇒ switch 头应出现 ≥ 2 次
    const hits = headSrc.split(SWITCH_START).length - 1
    expect(hits, 'HEAD 里 switch 头出现次数').toBeGreaterThanOrEqual(2)
    // 构造出的对照实现必须真的能跑
    expect(typeof foldOriginal).toBe('function')
    expect(foldOriginal(initialProgressState(), sessionEvent('turn/start', { turn: 1 }, 0, 1))).toEqual({ turn: 1, step: 0, done: false })
  })

  it('逐条折叠：28 个窗口 × 每条事件的中间态都与原文一致', () => {
    for (const { name, events } of scenarios()) {
      let mine = initialProgressState()
      let theirs = initialProgressState()
      for (const [i, event] of events.entries()) {
        const a = foldProgressEvent(mine, event)
        const b = foldOriginal(theirs, event)
        expectSameState(a, b, `${name} #${i}(${event.type})`)
        mine = a ?? mine
        theirs = b ?? theirs
      }
      expectSameState(mine, theirs, `${name} 终态`)
    }
  })

  it('全量折叠 foldProgressAll ≡ 逐条 foldProgressEvent（增量与全量不可能漂移）', () => {
    for (const { name, events } of scenarios()) {
      let step = initialProgressState()
      for (const event of events) step = foldProgressEvent(step, event) ?? step
      expect(foldProgressAll(events), `${name}: 全量 ≡ 逐条`).toEqual(step)
      // 且与原文的全量效果一致
      expectSameState(foldProgressAll(events), foldOriginal === undefined ? undefined : (() => {
        let s = initialProgressState()
        for (const e of events) s = foldOriginal(s, e) ?? s
        return s
      })(), `${name}: 全量 ≡ 原文`)
    }
  })

  it('每个 case 单独喂一条事件（保证 case 覆盖穷举，不靠窗口拼凑）', () => {
    const t = 1_700_000_000_000
    const solo: SessionEvent[] = [
      sessionEvent('turn/start', { turn: 1 }, t, 1),
      sessionEvent('step/end', { turn: 1, step: 1 }, t, 1),
      sessionEvent('tool/call', { name: 'x' }, t, 1),
      sessionEvent('assistant/message', { message: { content: [{ type: 'text' }] } }, t, 1),
      sessionEvent('turn/end', { reason: { kind: 'completed' } }, t, 1),
      sessionEvent('todo/write', { todos: [{ content: 'A', status: 'completed' }] }, t, 1),
    ]
    // 覆盖真实代码里的 6 个 case
    expect(new Set(solo.map(e => e.type)).size).toBe(6)
    for (const event of solo) {
      expectSameState(
        foldProgressEvent(initialProgressState(), event),
        foldOriginal(initialProgressState(), event),
        `单条 ${event.type}`,
      )
    }
  })

  it('SessionId 依赖自检（本判据不依赖会话对象，但保持与实现同源的类型）', () => {
    expect(String(SessionId('s'))).toBe('s')
  })
})
