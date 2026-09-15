/**
 * 流式增量高亮的**契约**单测（2026-09-16，用户要求「行为与官方一致」后新增）。
 *
 * 为什么必须单独钉住：`CodeCard` 的流式臂只用 `StreamingHighlightSession.updateFrame`
 * 返回的「新增已完成行 + 尾部行」，并**把已完成行连同 React 元素一起冻结复用**
 * ⇒ 一旦这套增量拼接与「整块重算」的结果出现任何偏差（少一行、错位、吞字符），
 * 用户看到的就是**着色错位的代码**，而且是那种「不报错、只是慢慢变错」的静默缺陷。
 *
 * 所以本文件用**逐字符喂入**模拟真实的流式增长，断言三件事：
 *   ① 增量拼接的结果 == 一次性 `highlightLines` 的结果（**逐行逐 span 深度相等**）；
 *   ② 行数 == 最终文本的行数（不多不少，行号不会错位）；
 *   ③ 纯追加不重置 generation；非追加（改写）必须重置 —— 这是缓存正确性的边界。
 */
import { describe, expect, it } from 'vitest'
import { StreamingHighlightSession, highlightLines, type HighlightSpan } from '../src/client/chat/highlight.ts'

/** 逐字符喂入，按 `updateFrame` 的语义累加：appended 追加、tail 覆盖。 */
function streamGrow(full: string, lang: string | undefined, chunk = 1) {
  const session = new StreamingHighlightSession()
  let completed: HighlightSpan[][] = []
  let firstFrame: ReturnType<typeof session.updateFrame>
  let lastFrame: ReturnType<typeof session.updateFrame>
  const generations: number[] = []
  for (let end = chunk; end <= full.length + chunk; end += chunk) {
    const text = full.slice(0, Math.min(end, full.length))
    const frame = session.updateFrame(text, lang)
    if (firstFrame === undefined) firstFrame = frame
    lastFrame = frame
    if (frame === undefined) continue
    generations.push(frame.generation)
    completed = [...completed, ...frame.appended]
    if (text === full) return { completed, tail: frame.tail, generations, lastFrame: frame }
  }
  return { completed, tail: lastFrame?.tail ?? [], generations, lastFrame }
}

const flatten = (lines: readonly (readonly HighlightSpan[])[]): string[][] =>
  lines.map(line => line.map(span => span.text))

/**
 * 该行**非空白** token 的「颜色 + 文本」序列。
 *
 * 用它的原因（实测得的机制事实，别改成整段 `toEqual`）：流式臂走
 * `codeToTokensBase`（按行 + 承接 grammarState），参考臂 `highlightLines` 走
 * `codeToTokens`；前者会把空白**并入相邻 token**（`" CardState"` 而不是 `" "` + `"CardState"`）。
 * 官方同样如此（`CodeBlock` 的流式臂也用 `updateFrame`）。两种切分的**渲染结果完全一致**
 * （空白自身不带色、只是被算进前一个 span），但 span 边界不同 ⇒ 逐 span 比较必然假红。
 * 真正要钉的是**可见部分**：同一段文本拿到同一个主题色。
 */
const visibleTokens = (line: readonly HighlightSpan[] | undefined): string[] =>
  (line ?? [])
    .filter(span => span.text.trim() !== '')
    .map(span => `${String(span.style.color)}|${span.text.replace(/\s+/g, '')}`)

const CODE = [
  'interface CardState {',
  "  kind: 'file' | 'code' | 'script'",
  '  expanded: boolean',
  '}',
  '',
  'export function isScriptCard(state: CardState): boolean {',
  "  return state.kind === 'script'",
  '}',
].join('\n')

describe('StreamingHighlightSession — 增量结果必须等于整块重算', () => {
  it('逐字符喂入后，已完成行 + 尾部行 == highlightLines 的整块结果（**非空白 token 的颜色与文本**逐行相等）', () => {
    const whole = highlightLines(CODE, 'ts')
    expect(whole).toBeDefined()
    const grown = streamGrow(CODE, 'ts', 3)
    const assembled = [...grown.completed, ...grown.tail]
    expect(assembled).toHaveLength((whole ?? []).length)
    expect(assembled.map(visibleTokens)).toEqual((whole ?? []).map(visibleTokens))
  })

  it('span 的 style（主题变量色）也逐行一致 —— 增量不能丢着色', () => {
    const whole = highlightLines(CODE, 'ts') ?? []
    const grown = streamGrow(CODE, 'ts', 5)
    const assembled = [...grown.completed, ...grown.tail]
    expect(assembled.map(line => line.filter(s => s.text.trim() !== '').map(s => s.style.color)))
      .toEqual(whole.map(line => line.filter(s => s.text.trim() !== '').map(s => s.style.color)))
  })

  it('两个臂的**行数**一致（空白切分差异不得影响行数，否则行号会错位）', () => {
    const whole = highlightLines(CODE, 'ts') ?? []
    const grown = streamGrow(CODE, 'ts', 4)
    expect([...grown.completed, ...grown.tail]).toHaveLength(whole.length)
  })

  it('文本零丢失：每行 span 拼接 == 该行原文', () => {
    const grown = streamGrow(CODE, 'ts', 7)
    const assembled = [...grown.completed, ...grown.tail]
    expect(assembled.map(line => line.map(s => s.text).join(''))).toEqual(CODE.split('\n'))
  })

  it('**纯追加不重置 generation**（缓存才可能跨帧复用）；非追加必须重置', () => {
    const session = new StreamingHighlightSession()
    const a = session.updateFrame('const a = 1\n', 'ts')
    const b = session.updateFrame('const a = 1\nconst b = 2\n', 'ts')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(b?.generation).toBe(a?.generation)

    const rewritten = session.updateFrame('let z = 9\n', 'ts')
    expect(rewritten).toBeDefined()
    expect(rewritten?.generation).not.toBe(b?.generation)
  })

  it('同一 (code, lang) 重复调用返回**同一个 frame 对象**（调用方据此跳过重建）', () => {
    const session = new StreamingHighlightSession()
    const a = session.updateFrame('const a = 1\n', 'ts')
    const b = session.updateFrame('const a = 1\n', 'ts')
    expect(b).toBe(a)
  })

  it('不支持的语言 ⇒ frame 为 undefined（调用方回落纯文本，不报错）', () => {
    const session = new StreamingHighlightSession()
    expect(session.updateFrame('main = putStrLn "hi"', 'haskell')).toBeUndefined()
    expect(session.updateFrame('whatever', undefined)).toBeUndefined()
  })

  it('appended 只给新完成的行，不做整段重算（长文本的增量成本证据）', () => {
    const session = new StreamingHighlightSession()
    const first = 'const a = 1\nconst b = 2\n'
    session.updateFrame(first, 'ts')
    const second = session.updateFrame(`${first}const c = 3\n`, 'ts')
    // 第二次只应新增「第 3 行」这一条已完成行，而不是把前两行再吐一遍。
    expect(second?.appended).toHaveLength(1)
    expect(second?.appended[0]?.map(s => s.text).join('')).toBe('const c = 3')
  })
})
