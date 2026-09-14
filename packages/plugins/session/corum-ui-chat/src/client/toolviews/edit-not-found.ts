/**
 * fork（corum）：「编辑未命中」专用卡的数据解析器（2026-09-13）。
 *
 * 数据源 = corum-fs-local fork 在 FS_EDIT_NOT_FOUND 错误信息末尾追加的
 * **版本化标记行**（`<<<corum-edit-not-found:v1 {json}`，见 fork 侧
 * edit-candidates.ts 的 EditNotFoundPayload）。解析策略三级回落：
 *   ① 标记行（首选；逐字段窄化，不认识/缺字段一律降级）；
 *   ② 人类可读块（旧 fork / 无标记时的兜底，解析 `line N:` / `lines A-B` 候选行）；
 *   ③ 都不认识 → 返回 undefined，卡片回落**纯文本渲染、不崩**（任务书红线）。
 *
 * 本文件保持纯函数、无 React、无 cordis（与 fork 侧 edit-candidates.ts 同纪律），
 * fixture 测试直接喂 fork 产出的真实样例文本。
 *
 * @module @corum/corum-ui-chat/toolviews/edit-not-found
 */

/** 版本化标记行前缀（与 fork 侧 MARKER_PREFIX 逐字一致；跨包不同步 import，逐字常量即契约）。 */
export const MARKER_PREFIX = '<<<corum-edit-not-found:v1 '

/** 失败分档（fork payload.reason；UI 底部说明按它分流）。 */
export type EditMissReason = 'anchor-miss' | 'no-previous-content' | 'insufficient-context'

/** 解析后的一条候选（行号可点击跳转 + 等宽原文 + 相似度 + 重复行合并）。 */
export interface EditMissCandidate {
  /** 起始行（1-based）。 */
  readonly line: number
  /** 块跨度（单行候选为 1）。 */
  readonly span: number
  /** 原文片段（fork 侧已截断）。 */
  readonly text: string
  /** 相似度 0..1。 */
  readonly similarity: number
  /** 与本条原文完全相同的其它行号（重复代码，已合并为一行）。 */
  readonly duplicates: readonly number[]
  /** 去掉首尾空白后完全相同（仅缩进/行尾空白差）。 */
  readonly sameText: boolean
}

/** 真正的失配行（anchor 与最佳候选块逐行对位的第一个不匹配行）。 */
export interface EditMissMismatch {
  readonly anchorLine: number
  readonly anchorText: string
  readonly fileLine: number
  readonly fileText: string
  readonly similarity: number
}

/** 解析结果（卡片直接消费；字段缺失时按降级语义填空）。 */
export interface EditMissModel {
  readonly reason: EditMissReason
  /** 锚点行数（>1 时候选按块展示）。 */
  readonly anchorLines: number
  readonly candidates: readonly EditMissCandidate[]
  readonly mismatch?: EditMissMismatch
  /** 候选被整体截断时的人读原文（降级态展示用）。 */
  readonly rawText: string
}

/** 有限窄化助手：未知/缺失一律回 undefined（调用方决定降级）。 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function asReason(value: unknown): EditMissReason | undefined {
  return value === 'anchor-miss' || value === 'no-previous-content' || value === 'insufficient-context'
    ? value
    : undefined
}

/** 解析版本化标记行 payload（① 首选路径）。 */
function parseMarkerPayload(json: unknown, rawText: string): EditMissModel | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const record = json as Record<string, unknown>
  if (record.version !== 1) return undefined
  const candidatesRaw = Array.isArray(record.candidates) ? record.candidates : []
  const candidates: EditMissCandidate[] = []
  for (const entry of candidatesRaw) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const line = asNumber(item.line)
    const text = asString(item.text)
    if (line === undefined || text === undefined) continue
    const duplicates = Array.isArray(item.duplicates)
      ? item.duplicates.filter((n): n is number => typeof n === 'number')
      : []
    candidates.push({
      line,
      span: asNumber(item.span) ?? 1,
      text,
      similarity: asNumber(item.similarity) ?? 0,
      duplicates,
      sameText: false,
    })
  }
  let mismatch: EditMissMismatch | undefined
  if (typeof record.mismatch === 'object' && record.mismatch !== null) {
    const m = record.mismatch as Record<string, unknown>
    const anchorLine = asNumber(m.anchorLine)
    const fileLine = asNumber(m.fileLine)
    if (anchorLine !== undefined && fileLine !== undefined) {
      mismatch = {
        anchorLine,
        anchorText: asString(m.anchorText) ?? '',
        fileLine,
        fileText: asString(m.fileText) ?? '',
        similarity: asNumber(m.similarity) ?? 0,
      }
    }
  }
  return {
    reason: asReason(record.reason) ?? 'anchor-miss',
    anchorLines: asNumber(record.anchorLines) ?? 1,
    candidates,
    ...mismatch === undefined ? {} : { mismatch },
    rawText,
  }
}

/**
 * 解析人类可读块（② 回落路径）：`  line 8: … [same text…]` / `  lines 6-8 (3 lines): … [91% similar]`
 * / `  lines 2, 5: … [duplicate code]`。只取候选表，失配行段落对 UI 价值低（无标记的旧
 * 文本里也可读，但字段脆弱——只解析行号跨度与原文，相似度按徽标解析）。
 */
function parseHumanBlock(rawText: string): EditMissModel | undefined {
  const candidates: EditMissCandidate[] = []
  for (const line of rawText.split('\n')) {
    // 块候选：  lines 6-8 (3 lines): <text>  [91% similar]
    const block = /^ {2}lines (\d+)-(\d+) \(\d+ lines\): (.*?)(?: {2}\[(\d+)% similar\])?$/.exec(line)
    if (block !== null) {
      candidates.push({
        line: Number(block[1]),
        span: Number(block[2]) - Number(block[1]) + 1,
        text: block[3],
        similarity: block[4] === undefined ? 0 : Number(block[4]) / 100,
        duplicates: [],
        sameText: false,
      })
      continue
    }
    // 行候选（含合并行）：  line 8: <text>  [same text, different indentation…]
    //                      lines 2, 5: <text>  [91% similar]
    const single = /^ {2}(line (\d+)|lines (\d+(?:, \d+)*)): (.*?)(?: {2}\[(same text, different indentation|(\d+)% similar).*)?$/.exec(line)
    if (single !== null) {
      const lines = single[2] !== undefined
        ? [Number(single[2])]
        : (single[3] ?? '').split(', ').map(Number)
      candidates.push({
        line: lines[0] ?? 0,
        span: 1,
        text: single[4],
        similarity: single[6] === undefined ? 1 : Number(single[6]) / 100,
        duplicates: lines.slice(1),
        sameText: single[5] === 'same text, different indentation',
      })
    }
  }
  if (candidates.length === 0) return undefined
  return {
    reason: 'anchor-miss',
    anchorLines: candidates.some(c => c.span > 1) ? 2 : 1,
    candidates,
    rawText,
  }
}

/**
 * 解析 FS_EDIT_NOT_FOUND 错误文本为卡片模型。
 *
 * @param errorText - tool-result 的完整错误文本（含 fork 提示段）。
 * @returns 卡片模型；标记与人读块都不认识时返回 undefined（调用方纯文本渲染）。
 */
export function parseEditNotFound(errorText: string): EditMissModel | undefined {
  // ① 版本化标记行（优先；行内 JSON 解析失败不阻断回落）。
  for (const line of errorText.split('\n')) {
    if (!line.startsWith(MARKER_PREFIX)) continue
    try {
      const parsed: unknown = JSON.parse(line.slice(MARKER_PREFIX.length))
      const model = parseMarkerPayload(parsed, errorText)
      if (model !== undefined) return model
    } catch {
      // JSON 截断/损坏 → 走人读块回落。
    }
    break
  }
  // ② 人类可读块回落。
  return parseHumanBlock(errorText)
}

/** 从 argsRaw 提取 file_path（edit 工具的参数形；解析失败回 undefined）。 */
export function editFilePath(argsRaw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed === 'object' && parsed !== null) {
      const path = (parsed as Record<string, unknown>).file_path
      if (typeof path === 'string' && path !== '') return path
    }
  } catch {
    // 非 JSON → 无路径。
  }
  return undefined
}
