/**
 * fork（corum）增量测试：literal edit 失败时的**定位提示**（BUG-28 的正解）。
 *
 * 官方只回 `old_string was not found in "<path>"`；本 fork 在此之上给出「最相近的几处 +
 * 行号」，以及多处命中时的「命中行号」。这些用例钉住三件事：
 *   ① 提示真的出现在**错误信息里**（模型看得到，不是只写进日志）；
 *   ② 只提示、不改写（错误仍抛 FS_EDIT_NOT_FOUND / FS_AMBIGUOUS_EDIT，内容没被改）；
 *   ③ 输出有界（候选数、单行长度、总长），不把工具结果撑爆。
 */
import { describe, expect, it } from 'vitest'
import { applyLiteralEdit } from '../src/fsio.ts'
import {
  editNotFoundHint, findBlockCandidates, findEditCandidates, findFirstMismatch,
  MARKER_PREFIX, matchLineNumbers, mergedLineCandidates,
} from '../src/edit-candidates.ts'

const FILE = [
  'export function total(items) {',
  '  // sum every price',
  '  const sum = items.reduce((a, b) => a + b.price, 0)',
  '  return sum',
  '}',
  '',
  'export function totalWithTax(items) {',
  '    const sum = items.reduce((a, b) => a + b.price, 0)',
  '    return sum * 1.1',
  '}',
].join('\n')

describe('findEditCandidates — 最相近候选', () => {
  it('缩进不同但文本相同 → 明确标为「同文本、缩进不同」并给行号', () => {
    const candidates = findEditCandidates(FILE, '  const sum = items.reduce((a, b) => a + b.price, 0)')
    expect(candidates.length).toBeGreaterThan(0)
    const exact = candidates.find(c => c.reason === 'same-text-different-whitespace')
    expect(exact?.line).toBe(8) // 第 8 行是 4 空格缩进的那份
  })

  it('近似行也给出（带相似度），按相似度降序、其次行号升序', () => {
    const candidates = findEditCandidates(FILE, 'const sum = items.reduce((acc, item) => acc + item.cost, 0)')
    expect(candidates.length).toBeGreaterThan(0)
    for (let index = 1; index < candidates.length; index += 1) {
      const previous = candidates[index - 1]
      const current = candidates[index]
      expect(previous.similarity >= current.similarity).toBe(true)
    }
  })

  it('完全不相干 → 空数组（不硬凑候选）', () => {
    expect(findEditCandidates(FILE, 'this text shares nothing at all with the file')).toEqual([])
  })

  it('候选条数有上限（缺省 3）', () => {
    const repeated = Array.from({ length: 20 }, () => 'const value = compute(input)').join('\n')
    expect(findEditCandidates(repeated, 'const value = compute(inputs)').length).toBe(3)
  })

  it('大文件不逐行打分（超过扫描上限直接空数组，失败路径不拖慢）', () => {
    const huge = Array.from({ length: 20_001 }, (_, index) => `line ${index}`).join('\n')
    expect(findEditCandidates(huge, 'const sum = items.reduce(...)')).toEqual([])
  })

  it('全空行 / 太短的锚点不产生候选（噪声行不误导模型）', () => {
    expect(findEditCandidates(FILE, '}\n)\n{')).toEqual([])
  })
})

describe('editNotFoundHint — 提示文案', () => {
  it('有候选：给行号 + 原行 + 「没有任何改动」声明 + 下一步', () => {
    const hint = editNotFoundHint('src/x.ts', FILE, '  const sum = items.reduce((a, b) => a + b.price, 0)')
    expect(hint).toContain('Closest places in the file')
    expect(hint).toContain('nothing has been changed')
    expect(hint).toContain('line 8:')
    expect(hint).toContain('different indentation')
    expect(hint).toContain('Retry with the exact text')
  })

  it('无候选：明说「什么都不接近」并劝阻重试同一条锚点', () => {
    const hint = editNotFoundHint('src/x.ts', FILE, 'nothing here matches anything in this file at all')
    expect(hint).toContain('Nothing in the file is close to that old_string')
    expect(hint).toContain('do not retry the same anchor')
  })

  it('输出有界：候选行截断、整段不超过上限', () => {
    const longLine = `const x = ${'a'.repeat(500)}`
    const hint = editNotFoundHint('src/x.ts', `prefix\n${longLine}`, longLine.replace('a', 'b'))
    expect(hint.length).toBeLessThanOrEqual(1201)
    expect(hint).toContain('…')
  })
})

describe('matchLineNumbers — 多处命中的行号', () => {
  it('按出现顺序给出 1-based 行号', () => {
    const content = 'a\nneedle\nb\nneedle\nneedle'
    expect(matchLineNumbers(content, 'needle')).toEqual([2, 4, 5])
  })

  it('无命中 → 空数组', () => {
    expect(matchLineNumbers('a\nb', 'zzz')).toEqual([])
  })
})

describe('applyLiteralEdit — 失败信息（模型可见面）', () => {
  it('未命中：错误信息含候选与行号，且仍抛 FS_EDIT_NOT_FOUND', () => {
    let error: unknown
    try {
      applyLiteralEdit(FILE, 'const sum = items.reduce((a, b) => a + b.price, 1)', 'x', false, 'src/x.ts')
    } catch (caught) { error = caught }
    const message = error instanceof Error ? error.message : ''
    expect(message).toContain('old_string was not found in "src/x.ts"')
    expect(message).toContain('Closest places in the file')
    expect((error as { code?: string }).code).toBe('FS_EDIT_NOT_FOUND')
  })

  it('多处命中：错误信息列出命中行号，且仍抛 FS_AMBIGUOUS_EDIT', () => {
    const content = 'one\nconst value = 1\ntwo\nconst value = 1\n'
    let error: unknown
    try {
      applyLiteralEdit(content, 'const value = 1', 'const value = 2', false, 'src/y.ts')
    } catch (caught) { error = caught }
    const message = error instanceof Error ? error.message : ''
    expect(message).toContain('matched 2 times')
    expect(message).toContain('at lines 2, 4')
    expect((error as { code?: string }).code).toBe('FS_AMBIGUOUS_EDIT')
  })

  it('成功路径与官方一致：仍然只做字面替换（增量不碰行为）', () => {
    const outcome = applyLiteralEdit('const value = 1\n', 'const value = 1', 'const value = 2', false, 'src/z.ts')
    expect(outcome.replacements).toBe(1)
    expect(outcome.content).toBe('const value = 2\n')
  })

  it('空 old_string：保持官方文案（不附候选，也不额外报错形态）', () => {
    let error: unknown
    try { applyLiteralEdit(FILE, '', 'x', false, 'src/x.ts') } catch (caught) { error = caught }
    expect((error as Error).message).toBe('old_string must be a non-empty string')
  })
})

// ── 第二轮（2026-09-13）：三条提示质量修复 + 版本化标记行 ──────────────────

describe('mergedLineCandidates — ③ 相同原文合并', () => {
  const DUP = [
    'function a() {',
    '  return compute(input)', // line 2
    '}',
    'function b() {',
    '  return compute(input)', // line 5（与 line 2 完全相同）
    '}',
  ].join('\n')

  it('完全相同的两行合并为一行，另一行号进 duplicates', () => {
    const candidates = mergedLineCandidates(DUP, 'return compute(input)')
    const merged = candidates.find(c => c.text === '  return compute(input)')
    expect(merged).toBeDefined()
    expect(merged?.duplicates).toEqual([5])
  })

  it('提示文案：合并行列出全部行号并标注「彼此相同（重复代码）」', () => {
    const hint = editNotFoundHint('src/dup.ts', DUP, 'return compute(inputs)')
    expect(hint).toContain('lines 2, 5:')
    expect(hint).toContain('identical to each other (duplicate code)')
  })

  it('payload 候选带 duplicates 行号数组', () => {
    const hint = editNotFoundHint('src/dup.ts', DUP, 'return compute(inputs)')
    const marker = hint.split('\n').find(line => line.startsWith(MARKER_PREFIX))
    const payload = JSON.parse(marker!.slice(MARKER_PREFIX.length)) as {
      candidates: { line: number; duplicates?: number[] }[]
    }
    expect(payload.candidates[0].line).toBe(2)
    expect(payload.candidates[0].duplicates).toEqual([5])
  })
})

describe('findBlockCandidates / findFirstMismatch — ① 块级候选 + ② 失配行', () => {
  // 两个函数**不同名**（否则 beta 块只是 alpha 块的移位重复，均分并列时按行号先取到
  // alpha——那就是另一个块得分同样高、并非失配行的目标场景）。
  const BLOCK_FILE = [
    'export function beta(input) {',
    '  const total = compute(input)',
    '  return total * 2',
    '}',
  ].join('\n')
  // 锚点：beta 的 3 行，但第 3 行写错（return total 而非 return total * 2）。
  const ANCHOR = [
    'export function beta(input) {',
    '  const total = compute(input)',
    '  return total',
  ].join('\n')

  it('多行锚点给块级候选（起始行 + 跨度），不是单行候选', () => {
    const blocks = findBlockCandidates(BLOCK_FILE, ANCHOR)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks[0].span).toBe(3)
    expect(blocks[0].line).toBe(1)
  })

  it('失配行：指出第一个不匹配的行（anchor 第 3 行 ↔ 文件第 3 行）', () => {
    const mismatch = findFirstMismatch(BLOCK_FILE, ANCHOR, 1)
    expect(mismatch?.anchorLine).toBe(3)
    expect(mismatch?.fileLine).toBe(3)
    expect(mismatch?.fileText).toBe('  return total * 2')
  })

  it('整块（trimmed）完全一致时无失配行', () => {
    expect(findFirstMismatch(BLOCK_FILE, ANCHOR.replace('  return total', '  return total * 2'), 1)).toBeUndefined()
  })

  it('提示文案：块候选含跨度，失配行双方原文都给出，末句要求整块重试', () => {
    const hint = editNotFoundHint('src/b.ts', BLOCK_FILE, ANCHOR)
    expect(hint).toContain('Closest 3-line blocks')
    expect(hint).toContain('lines 1-3 (3 lines):')
    expect(hint).toContain('First mismatch')
    expect(hint).toContain('anchor line 3:')
    expect(hint).toContain('file line 3:   return total * 2')
    expect(hint).toContain('whole 3-line block')
  })

  it('payload：块候选带 span，mismatch 双方行号与原文齐全', () => {
    const hint = editNotFoundHint('src/b.ts', BLOCK_FILE, ANCHOR)
    const marker = hint.split('\n').find(line => line.startsWith(MARKER_PREFIX))
    const payload = JSON.parse(marker!.slice(MARKER_PREFIX.length)) as {
      anchorLines: number
      candidates: { line: number; span: number }[]
      mismatch?: { anchorLine: number; fileLine: number; fileText: string }
    }
    expect(payload.anchorLines).toBe(3)
    expect(payload.candidates[0]).toMatchObject({ line: 1, span: 3 })
    expect(payload.mismatch).toMatchObject({ anchorLine: 3, fileLine: 3, fileText: '  return total * 2' })
  })
})

describe('版本化标记行 — UI 数据契约', () => {
  it('有候选：末尾单行标记，JSON 可解析且 version=1 / reason=anchor-miss', () => {
    const hint = editNotFoundHint('src/x.ts', FILE, '  const sum = items.reduce((a, b) => a + b.price, 0)')
    const marker = hint.split('\n').find(line => line.startsWith(MARKER_PREFIX))
    expect(marker).toBeDefined()
    // 标记只占一行（JSON 单行序列化）。
    expect(marker).not.toContain('\n')
    const payload = JSON.parse(marker!.slice(MARKER_PREFIX.length)) as {
      version: number; reason: string; anchorLines: number; candidates: unknown[]
    }
    expect(payload.version).toBe(1)
    expect(payload.reason).toBe('anchor-miss')
    expect(payload.anchorLines).toBe(1)
    expect(payload.candidates.length).toBeGreaterThan(0)
  })

  it('无候选：标记行也在（reason=insufficient-context，candidates 空数组）', () => {
    const hint = editNotFoundHint('src/x.ts', FILE, 'nothing here matches anything in this file at all')
    const marker = hint.split('\n').find(line => line.startsWith(MARKER_PREFIX))
    const payload = JSON.parse(marker!.slice(MARKER_PREFIX.length)) as { reason: string; candidates: unknown[] }
    expect(payload.reason).toBe('insufficient-context')
    expect(payload.candidates).toEqual([])
  })

  it('输出有界仍成立（标记行计入总长）', () => {
    const longLine = `const x = ${'a'.repeat(500)}`
    const hint = editNotFoundHint('src/x.ts', `prefix\n${longLine}`, longLine.replace('a', 'b'))
    expect(hint.length).toBeLessThanOrEqual(1201)
  })
})
