/**
 * 「编辑未命中」专用卡解析器的共享 fixture 测试（2026-09-13）。
 *
 * 数据契约：fork（corum-fs-local）产出的真实错误文本（tests/fixtures/edit-not-found.ts，
 * 逐字拷贝自 applyLiteralEdit 抛出）→ UI 解析断言字段。三级回落：
 *   ① 版本化标记行（首选）；② 人读块（旧 fork 兜底）；③ 都不认识 → undefined
 *   （卡片纯文本渲染、不崩）。
 */
import { describe, expect, it } from 'vitest'
import { editFilePath, parseEditNotFound } from '../src/client/toolviews/edit-not-found.ts'
import {
  FIXTURE_BROKEN_MARKER, FIXTURE_LEGACY_NO_MARKER, FIXTURE_MULTI_BLOCK,
  FIXTURE_NO_CANDIDATES, FIXTURE_OFFICIAL_PLAIN, FIXTURE_SINGLE_DUP,
} from './fixtures/edit-not-found.ts'

describe('parseEditNotFound — ① 版本化标记行（首选路径）', () => {
  it('单行锚点 + 重复代码合并：duplicates 行号齐全、相似度透传', () => {
    const model = parseEditNotFound(FIXTURE_SINGLE_DUP)
    expect(model).toBeDefined()
    expect(model?.reason).toBe('anchor-miss')
    expect(model?.anchorLines).toBe(1)
    expect(model?.candidates).toHaveLength(1)
    const candidate = model?.candidates[0]
    expect(candidate?.line).toBe(66)
    expect(candidate?.span).toBe(1)
    expect(candidate?.text).toBe('  if (items.length === 0) return emptyResult()')
    expect(candidate?.similarity).toBeCloseTo(0.977, 2)
    expect(candidate?.duplicates).toEqual([80])
    expect(model?.mismatch).toBeUndefined()
  })

  it('多行锚点：块级候选（起始行 + 跨度）+ 失配行双方行号与原文', () => {
    const model = parseEditNotFound(FIXTURE_MULTI_BLOCK)
    expect(model?.anchorLines).toBe(3)
    expect(model?.candidates).toHaveLength(1)
    expect(model?.candidates[0]).toMatchObject({ line: 1, span: 3 })
    expect(model?.mismatch).toMatchObject({
      anchorLine: 3,
      fileLine: 3,
      anchorText: '  return { where }',
      fileText: '  return { where, order: defaultOrder }',
    })
  })

  it('完全没有候选（降级态）：reason=insufficient-context + 空候选数组', () => {
    const model = parseEditNotFound(FIXTURE_NO_CANDIDATES)
    expect(model).toBeDefined()
    expect(model?.reason).toBe('insufficient-context')
    expect(model?.candidates).toEqual([])
    // rawText 保留人读原文（降级态展示）。
    expect(model?.rawText).toContain('Nothing in the file is close')
  })
})

describe('parseEditNotFound — ② 人读块回落（无标记的旧文本）', () => {
  it('旧 fork 人读块：解析行候选 + 「仅缩进不同」标注 + 相似度徽标', () => {
    const model = parseEditNotFound(FIXTURE_LEGACY_NO_MARKER)
    expect(model).toBeDefined()
    expect(model?.candidates).toHaveLength(2)
    expect(model?.candidates[0]).toMatchObject({ line: 8, sameText: true })
    expect(model?.candidates[1]).toMatchObject({ line: 3, similarity: 1 })
  })

  it('标记行 JSON 损坏：不崩，回落人读块解析候选', () => {
    const model = parseEditNotFound(FIXTURE_BROKEN_MARKER)
    expect(model).toBeDefined()
    expect(model?.candidates[0]).toMatchObject({ line: 8 })
  })
})

describe('parseEditNotFound — ③ 未知格式回落', () => {
  it('官方无提示文本 → undefined（调用方纯文本渲染）', () => {
    expect(parseEditNotFound(FIXTURE_OFFICIAL_PLAIN)).toBeUndefined()
  })

  it('完全不相关的错误文本 → undefined', () => {
    expect(parseEditNotFound('EACCES: permission denied, open "/etc/passwd"')).toBeUndefined()
    expect(parseEditNotFound('')).toBeUndefined()
  })
})

describe('editFilePath — 工具参数路径提取', () => {
  it('正常 argsRaw 提取 file_path', () => {
    expect(editFilePath('{"file_path":"src/order/query.ts","old_string":"a","new_string":"b"}')).toBe('src/order/query.ts')
  })
  it('非 JSON / 缺字段 → undefined', () => {
    expect(editFilePath('not json')).toBeUndefined()
    expect(editFilePath('{"old_string":"a"}')).toBeUndefined()
  })
})
