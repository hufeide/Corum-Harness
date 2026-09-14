/**
 * fork（corum）：literal edit 失败时的**定位提示**（纯函数，无 IO、无状态）。
 *
 * ## 为什么需要
 *
 * 官方 `applyLiteralEdit` 在锚点对不上时只回一句
 * `old_string was not found in "<path>"` —— 模型拿不到任何「差在哪」的信息，于是原地
 * 重试同一条锚点（BUG-28：同一会话里 edit 连撞两次以上，白烧步骤；全库统计里
 * 「old_string 未命中」占 edit 失败的一半以上）。本模块把失败变成**可行动的信息**：
 * 最接近的几处（带行号），以及「同一段文本只是缩进不同」这种最常见的差法。
 *
 * ## 2026-09-13 第二轮（三条提示质量修复 + 版本化标记行）
 *
 * 实测暴露三个误导（与 UI「编辑未命中」专用卡同源，一并修）：
 *   ① **多行 anchor 只给单行候选**——末句「用其中一行原文重试」会把 N 行锚点悄悄
 *     换成 1 行，可能改错位置 → 多行锚点给**块级候选**（起始行 + 跨度 + 首行原文）；
 *   ② **候选全 100% similar 反而误导**（锚点多行、逐行都能对上、整块对不上）→
 *     给出**真正的失配行**：anchor 与候选块逐行对比的第一个不匹配行 + 各自原文；
 *   ③ **重复代码行重复列**（line 66 与 80 完全相同）→ 相同原文候选**合并为一行**，
 *     标注「这几行彼此相同（重复代码）」。
 *
 * 数据契约：提示段末尾追加一行 {@link MARKER_PREFIX} 版本化 JSON 标记（单行、
 * 与正文以 `\n` 分隔）。UI 优先解析标记行；缺标记（旧 fork / 官方错误）回落解析
 * 人类可读块；都不认识则**纯文本渲染、不崩**。payload 结构见
 * {@link EditNotFoundPayload}（version 1）。
 *
 * ## 边界（有意为之）
 *
 * - **只提示，不改写**：绝不替模型模糊应用（那是 B2「影子 fs 提供者」的范畴，已明确不做）。
 *   文本里写明 "nothing was changed"，避免模型误以为已经改过。
 * - 输出有上限（候选 ≤3 条、每条 ≤200 字符、总长 ≤1200 字符）——工具结果是模型上下文的一部分。
 * - 相似度用轻量的有界编辑距离（行级、长度截断），不做全文对齐；这是提示不是裁决。
 * - 大文件有扫描上限（{@link MAX_SCAN_LINES} 行）：超出则只提示「文件较大」。
 *
 * @module @corum/corum-fs-local/edit-candidates
 */

/** 单条候选（1-based 行号 + 该行原文 + 差法 + 相似度）。 */
export interface EditCandidate {
  /** 1-based 行号（与编辑器/read 工具的口径一致）。 */
  readonly line: number
  /** 该行原文（已截断）。 */
  readonly text: string
  /** `same-text-different-whitespace` = 去掉首尾空白后完全相同（缩进/行尾空白差）；`similar` = 近似。 */
  readonly reason: 'same-text-different-whitespace' | 'similar'
  /** 相似度 0..1（trimmed 行之间的有界编辑距离推导）。 */
  readonly similarity: number
}

/** 扫描上限：超过这么多行就不再逐行打分（只给一句提示），避免大文件拖慢失败路径。 */
export const MAX_SCAN_LINES = 20_000
/** 单行比较的字符上限（超长行截断比较，避免 O(n²) 爆炸）。 */
const MAX_COMPARE_CHARS = 200
/** 候选条数上限。 */
const MAX_CANDIDATES = 3
/** 候选展示的字符上限。 */
const MAX_CANDIDATE_TEXT = 200
/** 整段提示的字符上限。 */
const MAX_HINT_CHARS = 1200
/** 相似度阈值（低于它不展示，避免噪声候选误导模型）。 */
const MIN_SIMILARITY = 0.6

/** 有界编辑距离（两行 trimmed 文本；长度超过上限时先截断）。 */
function boundedDistance(a: string, b: string): number {
  const left = a.length > MAX_COMPARE_CHARS ? a.slice(0, MAX_COMPARE_CHARS) : a
  const right = b.length > MAX_COMPARE_CHARS ? b.slice(0, MAX_COMPARE_CHARS) : b
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  let previous = new Array<number>(right.length + 1)
  let current = new Array<number>(right.length + 1)
  for (let j = 0; j <= right.length; j += 1) previous[j] = j
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i
    const charLeft = left.charCodeAt(i - 1)
    for (let j = 1; j <= right.length; j += 1) {
      const cost = charLeft === right.charCodeAt(j - 1) ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[right.length]
}

/** 相似度 0..1（基于 trimmed 文本的有界编辑距离）。 */
function similarityOf(a: string, b: string): number {
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 1
  return 1 - boundedDistance(a, b) / longest
}

/**
 * 从 oldString 里挑「有辨识度的锚点行」：去掉空行后按长度降序取前若干条唯一行。
 * 单行 oldString 时就是它自己；多行时用最长的那几行（最短行往往是 `}` `)` 这类噪声）。
 * 保留 raw 形态：判「只是缩进/首尾空白不同」时要拿**锚点自己的原文**与文件行原文比，
 * 否则任何带缩进的行都会被误标成「缩进不同」。
 */
function anchorLines(oldString: string): readonly { raw: string; trimmed: string }[] {
  const uniq = new Map<string, string>()
  for (const raw of oldString.split('\n')) {
    const trimmed = raw.trim()
    // 太短的行（`}`、`)`）没有辨识度，不参与；**过长也不过早丢弃**——相似度函数自己会
    // 截断到 MAX_COMPARE_CHARS 比较（丢掉整条会让「长锚点对不上」这类失败拿不到任何提示）。
    if (trimmed.length >= 4 && !uniq.has(trimmed)) uniq.set(trimmed, raw)
  }
  return [...uniq.entries()]
    .map(([trimmed, raw]) => ({ raw, trimmed }))
    .sort((a, b) => b.trimmed.length - a.trimmed.length)
    .slice(0, 3)
}

/**
 * 在文件内容里找最接近 oldString 的若干行。
 *
 * @param content - 文件当前内容（**必须是 LF 归一化后的**，与 `applyLiteralEdit` 的输入一致）。
 * @param oldString - 未命中的锚点（内部会按 LF 归一化）。
 * @param limit - 最多返回几条（缺省 3）。
 * @returns 按相似度降序、其次行号升序的候选；没有任何候选时为空数组。
 */
export function findEditCandidates(content: string, oldString: string, limit = MAX_CANDIDATES): readonly EditCandidate[] {
  const anchors = anchorLines(oldString)
  if (anchors.length === 0) return []
  const lines = content.split('\n')
  if (lines.length > MAX_SCAN_LINES) return []
  const found: EditCandidate[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    let best: EditCandidate | undefined
    for (const anchor of anchors) {
      if (trimmed === anchor.trimmed) {
        // 去空白后相同：唯一差别就是缩进/首尾空白（判据用**锚点自己的原文**比对）。
        const sameText = raw !== anchor.raw
        best = { line: index + 1, text: raw, reason: sameText ? 'same-text-different-whitespace' : 'similar', similarity: 1 }
        break
      }
      const similarity = similarityOf(trimmed, anchor.trimmed)
      if (similarity >= MIN_SIMILARITY && (best === undefined || similarity > best.similarity)) {
        best = { line: index + 1, text: raw, reason: 'similar', similarity }
      }
    }
    if (best !== undefined) found.push(best)
  }
  found.sort((a, b) => b.similarity - a.similarity || a.line - b.line)
  return found.slice(0, limit)
}

// ── 第二轮（2026-09-13）：块级候选 / 失配行 / 重复合并 / 版本化标记行 ────────

/** 版本化标记行前缀（单行 JSON 紧跟其后；UI 优先解析它，缺省回落人读块）。 */
export const MARKER_PREFIX = '<<<corum-edit-not-found:v1 '

/**
 * UI 数据契约 payload（version 1）。
 *
 * 字段全可选兼容演进：UI 解析时逐字段窄化，不认识/缺字段一律降级（缺候选画
 * 降级态、payload 缺直接走人读块/纯文本）。新增字段必须向后兼容（只加不改）。
 */
export interface EditNotFoundPayload {
  readonly version: 1
  /** 失败分档（UI 底部说明按它分流）：anchor 未命中 / 取不到改前内容 / 上下文不足。 */
  readonly reason: 'anchor-miss' | 'no-previous-content' | 'insufficient-context'
  readonly anchorLines: number
  readonly candidates: readonly EditNotFoundPayloadCandidate[]
  readonly mismatch?: EditNotFoundPayloadMismatch
}

/** payload 候选行（单行 span=1；多行锚点 span>1）。 */
export interface EditNotFoundPayloadCandidate {
  readonly line: number
  readonly span: number
  readonly text: string
  readonly similarity: number
  /** 与本候选原文完全相同的其它行号（重复代码，已合并）。 */
  readonly duplicates?: readonly number[]
}

/** payload 失配行（anchor 与最佳候选块逐行对位的第一个不匹配行）。 */
export interface EditNotFoundPayloadMismatch {
  readonly anchorLine: number
  readonly anchorText: string
  readonly fileLine: number
  readonly fileText: string
  readonly similarity: number
}

/** 构建期的可变 payload（editNotFoundHint 内部用；对外只暴露 EditNotFoundPayload）。 */
interface MutablePayload {
  version: 1
  reason: EditNotFoundPayload['reason']
  anchorLines: number
  candidates: EditNotFoundPayloadCandidate[]
  mismatch?: EditNotFoundPayloadMismatch
}

/** 多行锚点的块级候选（起始行 + 跨度 + 首行原文 + 块相似度）。 */
export interface BlockCandidate {
  readonly line: number
  readonly span: number
  readonly text: string
  readonly similarity: number
}

/**
 * 在文件内容里找与多行 oldString 最接近的若干**块**（按 trimmed 逐行均分打分）。
 *
 * @param content - 文件当前内容（LF 归一化）。
 * @param oldString - 未命中的多行锚点（内部按 LF 归一化）。
 * @param limit - 最多返回几块（缺省 3）。
 */
export function findBlockCandidates(content: string, oldString: string, limit = MAX_CANDIDATES): readonly BlockCandidate[] {
  const lines = content.split('\n')
  if (lines.length > MAX_SCAN_LINES) return []
  const anchorAll = oldString.split('\n')
  // 参与打分的行：去空行 + 去掉没有辨识度的短行（`}`、`)`）；全被滤掉时退回全量。
  const scoring = anchorAll.filter(raw => raw.trim().length >= 4)
  const effective = (scoring.length > 0 ? scoring : anchorAll).map(raw => raw.trim())
  if (effective.length === 0) return []
  const span = anchorAll.length
  const scored: BlockCandidate[] = []
  for (let start = 0; start + span <= lines.length; start += 1) {
    // 打分窗口：候选块与锚点各取前 effective.length 行做 trimmed 逐行对位均分。
    let total = 0
    for (let offset = 0; offset < effective.length; offset += 1) {
      total += similarityOf(lines[start + offset].trim(), effective[offset])
    }
    const similarity = total / effective.length
    if (similarity >= MIN_SIMILARITY) {
      scored.push({ line: start + 1, span, text: lines[start], similarity })
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity || a.line - b.line)
  return scored.slice(0, limit)
}

/**
 * 真正的失配行：anchor 与候选块**逐行对位**的第一个不匹配行（② 的修复）。
 *
 * 「逐行各自 100%、整块对不上」时，逐行相似度全都满分等于什么都没说；本函数
 * 找出**块内**第一个对不上的行（trimmed 比对），返回双方原文与该行相似度。
 *
 * @param content - 文件当前内容（LF 归一化）。
 * @param oldString - 未命中的锚点（LF 归一化）。
 * @param startLine - 候选块起始行（1-based）。
 * @returns 第一个不匹配行的定位；整块（trimmed）完全一致时为 undefined。
 */
export function findFirstMismatch(
  content: string,
  oldString: string,
  startLine: number,
): { anchorLine: number; anchorText: string; fileLine: number; fileText: string; similarity: number } | undefined {
  const lines = content.split('\n')
  const anchors = oldString.split('\n')
  for (let offset = 0; offset < anchors.length; offset += 1) {
    const fileIndex = startLine - 1 + offset
    const fileText = fileIndex < lines.length ? lines[fileIndex] : ''
    if (anchors[offset].trim() !== fileText.trim()) {
      return {
        anchorLine: offset + 1,
        anchorText: anchors[offset],
        fileLine: startLine + offset,
        fileText,
        similarity: similarityOf(anchors[offset].trim(), fileText.trim()),
      }
    }
  }
  return undefined
}

/** 单行候选按**原文完全相同**合并后的形态（③ 的修复）。 */
export interface MergedCandidate extends EditCandidate {
  /** 与本条原文完全相同的其它行号（升序；不含本条自己的 line）。 */
  readonly duplicates: readonly number[]
}

/**
 * 相同原文的候选合并为一行（实测 line 66 与 80 完全相同的情形）。
 *
 * @param content - 文件当前内容（LF 归一化）。
 * @param oldString - 未命中的锚点。
 * @returns 合并后的候选（仍 ≤3 条；duplicates 非空表示重复代码）。
 */
export function mergedLineCandidates(content: string, oldString: string): readonly MergedCandidate[] {
  const lines = content.split('\n')
  const merged: MergedCandidate[] = []
  for (const candidate of findEditCandidates(content, oldString, MAX_CANDIDATES * 3)) {
    const existing = merged.find(entry => entry.text === candidate.text)
    if (existing !== undefined) {
      // 同文本折叠：相似度取高者；行号并入 duplicates（与全量扫描去重）。
      merged[merged.indexOf(existing)] = {
        ...existing,
        similarity: Math.max(existing.similarity, candidate.similarity),
        duplicates: [...new Set([...existing.duplicates, candidate.line])].sort((a, b) => a - b),
      }
      continue
    }
    // 扫描全文中所有**原文完全相同**的行（不只候选集），一并并入 duplicates。
    const duplicates: number[] = []
    for (let index = 0; index < lines.length; index += 1) {
      if (index + 1 !== candidate.line && lines[index] === candidate.text) duplicates.push(index + 1)
    }
    merged.push({ ...candidate, duplicates })
    if (merged.length >= MAX_CANDIDATES) break
  }
  return merged
}

/** 截断到候选展示上限（超长省略号结尾）。 */
function clip(text: string): string {
  return text.length > MAX_CANDIDATE_TEXT ? `${text.slice(0, MAX_CANDIDATE_TEXT)}…` : text
}

/**
 * FS_EDIT_NOT_FOUND 时追加在官方文案之后的定位提示。
 *
 * 结构（第二轮）：
 *   ① 单行锚点 → 行候选（重复合并 + 「彼此相同」标注）；多行锚点 → 块候选（起始行 +
 *      跨度）+ 真正的失配行（首个不匹配行双方原文）；
 *   ② 末句按锚点行数分档（单行「用该行原文重试」/ 多行「用整块原文重试」）；
 *   ③ 末尾 {@link MARKER_PREFIX} 版本化 JSON 行（UI 数据契约；见 EditNotFoundPayload）。
 *
 * @param displayPath - 展示用路径（只用于文案）。
 * @param content - 文件当前内容（LF 归一化）。
 * @param oldString - 未命中的锚点。
 * @returns 以换行开头的提示段；无候选时返回一句「没有任何相近行」+ 行动建议。
 */
export function editNotFoundHint(displayPath: string, content: string, oldString: string): string {
  const lineCount = content.split('\n').length
  const tooLarge = lineCount > MAX_SCAN_LINES
  const anchorCount = oldString === '' ? 0 : oldString.split('\n').length
  const parts: string[] = []
  /** 标记行 payload（随各分支填充；无候选/大文件只带分档与锚点行数）。 */
  const payload: MutablePayload = {
    version: 1,
    reason: tooLarge ? 'insufficient-context' : 'anchor-miss',
    anchorLines: anchorCount,
    candidates: [],
  }

  if (tooLarge) {
    parts.push(`\nThe file is large (over ${MAX_SCAN_LINES} lines) — read the region you meant to edit and copy the exact text.`)
  } else if (anchorCount > 1) {
    // 多行锚点（① 修复）：块级候选 + 真正的失配行（② 修复）。
    const blocks = findBlockCandidates(content, oldString)
    if (blocks.length === 0) {
      parts.push('\nNothing in the file is close to that old_string — read the file (or the region) and copy the exact text; do not retry the same anchor.')
      payload.reason = 'insufficient-context'
    } else {
      parts.push(`\nClosest ${anchorCount}-line blocks in the file (informational only — nothing has been changed):`)
      const mismatch = findFirstMismatch(content, oldString, blocks[0].line)
      for (const block of blocks) {
        parts.push(`\n  lines ${block.line}-${block.line + block.span - 1} (${block.span} lines): ${clip(block.text)}  [${Math.round(block.similarity * 100)}% similar]`)
        payload.candidates.push({ line: block.line, span: block.span, text: clip(block.text), similarity: block.similarity })
      }
      if (mismatch !== undefined) {
        parts.push(`\nFirst mismatch vs the block at line ${blocks[0].line}:`)
        parts.push(`\n  anchor line ${mismatch.anchorLine}: ${clip(mismatch.anchorText)}`)
        parts.push(`\n  file line ${mismatch.fileLine}: ${clip(mismatch.fileText)}  [${Math.round(mismatch.similarity * 100)}% similar]`)
        payload.mismatch = mismatch
      }
      parts.push(`\nRetry with the whole ${anchorCount}-line block copied exactly (the file is "${displayPath}"); replacing only one line of a multi-line anchor can edit the wrong place.`)
    }
  } else {
    // 单行锚点：行候选 + 相同原文合并（③ 修复）。
    const candidates = mergedLineCandidates(content, oldString)
    if (candidates.length === 0) {
      parts.push('\nNothing in the file is close to that old_string — read the file (or the region) and copy the exact text; do not retry the same anchor.')
      payload.reason = 'insufficient-context'
    } else {
      parts.push('\nClosest places in the file (informational only — nothing has been changed):')
      for (const candidate of candidates) {
        const note = candidate.reason === 'same-text-different-whitespace'
          ? '  [same text, different indentation/leading whitespace]'
          : `  [${Math.round(candidate.similarity * 100)}% similar]`
        const linesLabel = candidate.duplicates.length === 0
          ? `line ${candidate.line}`
          : `lines ${[candidate.line, ...candidate.duplicates].join(', ')}`
        parts.push(`\n  ${linesLabel}: ${clip(candidate.text)}${note}`)
        if (candidate.duplicates.length > 0) {
          parts.push('  [these lines are identical to each other (duplicate code)]')
        }
        payload.candidates.push({
          line: candidate.line,
          span: 1,
          text: clip(candidate.text),
          similarity: candidate.similarity,
          ...candidate.duplicates.length > 0 ? { duplicates: candidate.duplicates } : {},
        })
      }
      parts.push(`\nRetry with the exact text from one of those lines (the file is "${displayPath}"); if you already applied this edit successfully, the anchor no longer exists in that form.`)
    }
  }

  // 版本化标记行（数据契约）：UI 优先解析；模型读到的是同一信息，单行 JSON 不影响理解。
  parts.push(`\n${MARKER_PREFIX}${JSON.stringify(payload)}`)
  const hint = parts.join('')
  return hint.length > MAX_HINT_CHARS ? `${hint.slice(0, MAX_HINT_CHARS)}…` : hint
}

/**
 * oldString 在内容里出现的**行号**（1-based，按出现顺序）。
 * 供 FS_AMBIGUOUS_EDIT 文案列出「命中在哪几行」，让模型直接挑一处加长锚点。
 *
 * @param content - 文件当前内容（LF 归一化）。
 * @param oldString - 已归一化的锚点。
 * @returns 每个命中起点的行号；无命中时为空数组。
 */
export function matchLineNumbers(content: string, oldString: string): readonly number[] {
  if (oldString.length === 0) return []
  const lines: number[] = []
  let from = 0
  for (;;) {
    const at = content.indexOf(oldString, from)
    if (at < 0) break
    let line = 1
    for (let index = 0; index < at; index += 1) if (content.charCodeAt(index) === 10) line += 1
    lines.push(line)
    from = at + Math.max(1, oldString.length)
  }
  return lines
}
