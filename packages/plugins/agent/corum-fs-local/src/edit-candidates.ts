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

/**
 * FS_EDIT_NOT_FOUND 时追加在官方文案之后的定位提示。
 *
 * @param displayPath - 展示用路径（只用于文案）。
 * @param content - 文件当前内容（LF 归一化）。
 * @param oldString - 未命中的锚点。
 * @returns 以换行开头的提示段；无候选时返回一句「没有任何相近行」+ 行动建议。
 */
export function editNotFoundHint(displayPath: string, content: string, oldString: string): string {
  const candidates = findEditCandidates(content, oldString)
  const parts: string[] = []
  if (content.split('\n').length > MAX_SCAN_LINES) {
    parts.push(`\nThe file is large (over ${MAX_SCAN_LINES} lines) — read the region you meant to edit and copy the exact text.`)
  } else if (candidates.length === 0) {
    parts.push('\nNothing in the file is close to that old_string — read the file (or the region) and copy the exact text; do not retry the same anchor.')
  } else {
    parts.push('\nClosest places in the file (informational only — nothing has been changed):')
    for (const candidate of candidates) {
      const text = candidate.text.length > MAX_CANDIDATE_TEXT ? `${candidate.text.slice(0, MAX_CANDIDATE_TEXT)}…` : candidate.text
      const note = candidate.reason === 'same-text-different-whitespace'
        ? '  [same text, different indentation/leading whitespace]'
        : `  [${Math.round(candidate.similarity * 100)}% similar]`
      parts.push(`\n  line ${candidate.line}: ${text}${note}`)
    }
    parts.push(`\nRetry with the exact text from one of those lines (the file is "${displayPath}"); if you already applied this edit successfully, the anchor no longer exists in that form.`)
  }
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
