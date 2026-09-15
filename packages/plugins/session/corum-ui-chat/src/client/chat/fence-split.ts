/**
 * fork（corum）：在顶层代码围栏处拆分助手 markdown 文本。
 *
 * 背景：官方 {@link MarkdownText} 把整段 markdown 文本交给 {@link CodeBlock}
 * 渲染，而 CodeBlock 的 bannerWrap 用 `var(--dsw-alias-bg-base)` 填底（暗色主题
 * 下 = `#0D0817` 黑条）。没有 React seam 能插入官方 markdown pipeline（render.tsx
 * 硬导入 CodeBlock，renderNode / renderCode 都是模块私有），所以本模块在
 * fork 层把文本按**顶层**代码围栏拆成段：代码段走 corum 自有的 CodeCard，
 * 非代码段仍走官方 MarkdownText。
 *
 * 拆分必须用真正的 mdast 解析（`mdast-util-from-markdown` + `micromark-extension-gfm`
 * + `mdast-util-gfm`，与官方渲染器的流式臂 `parseGfm` 同语法），而不是行正则——
 * 只有 mdast 语法能看到列表、引用、波浪围栏、>3 反引号围栏、缩进代码块和
 * `position.offset` 边界。
 *
 * 安全栅栏（bail-out）——以下任一条件命中时，整段文本走官方 MarkdownText、不产卡片：
 *   - 解析异常
 *   - 文本不含任何顶层 `code` 节点（最常见路径，必须零可观测开销）
 *   - 任何深度的 `footnoteReference` / `footnoteDefinition` / `definition` 节点
 *     （脚注编号与引用目标是 per-MarkdownText-call 状态，跨段会断裂）
 *   - 任何深度的 `html` 节点
 *   - 任何深度的 `table` 节点
 *   - 任何 `code` 节点的 `lang` 为 `math`
 *   - 任何 `code` 节点不是根的直接子节点（即 `code` 嵌在 listItem / blockquote 等）
 *
 * 切片：非代码段从原始文本中用每个节点的 `position.start.offset` /
 * `position.end.offset` 切出，保留边界空白、不丢内容。代码段用 mdast
 * `code` 节点的 `value` 作为代码体。
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Code, Root, RootContent } from 'mdast'

/** 非代码段：透传给官方 MarkdownText 的文本。 */
export interface MarkdownSegment {
  readonly kind: 'markdown'
  readonly text: string
}

/** 代码段：围栏代码体 + 语言（无语言时 lang = undefined）。 */
export interface CodeSegment {
  readonly kind: 'code'
  readonly code: string
  readonly lang: string | undefined
}

/** 拆分结果的代码段类型联合。 */
export type Segment = MarkdownSegment | CodeSegment

/** bail-out：整段走官方 MarkdownText。 */
export interface PlainResult {
  readonly kind: 'plain'
}

/** 拆分成功：交替的 markdown / code 段。 */
export interface SplitResult {
  readonly kind: 'split'
  readonly segments: readonly Segment[]
}

/** splitFences 的返回值。 */
export type FenceSplit = PlainResult | SplitResult

/**
 * 在顶层代码围栏处拆分助手 markdown 文本。
 *
 * @param text - 助手消息的 markdown 原文。
 * @returns `plain` = bail-out（整段走官方 MarkdownText）；`split` = 交替段。
 */
export function splitFences(text: string): FenceSplit {
  let tree: Root
  try {
    tree = fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    })
  } catch {
    return { kind: 'plain' }
  }

  const children = tree.children as RootContent[]

  // 收集顶层 code 节点，同时对所有非顶层-code 子树做 bail-out 检查。
  // 顶层 code 是允许的；非顶层 code（嵌在 list/blockquote 等）是 bail-out。
  const topCodeNodes: Code[] = []
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child === undefined) continue
    if (child.type === 'code') {
      // 顶层 code：lang === 'math' → bail-out（math 块由官方 MarkdownText 处理）。
      if (child.lang === 'math') return { kind: 'plain' }
      topCodeNodes.push(child)
    } else if (hasBailoutNode(child)) {
      // 非顶层-code 子树命中 bail-out → 整段走官方。
      return { kind: 'plain' }
    }
  }

  // 最常见路径：无顶层 code 节点 → 零开销 bail-out。
  if (topCodeNodes.length === 0) {
    return { kind: 'plain' }
  }

  // 逐段切片：在顶层 code 节点之间切出非代码段，代码段用 node.value。
  const segments: Segment[] = []
  let cursor = 0 // 原文中的字节偏移

  for (const code of topCodeNodes) {
    const start = code.position?.start.offset
    const end = code.position?.end.offset
    if (start === undefined || end === undefined) {
      return { kind: 'plain' }
    }
    // code 节点之前的非代码段（可能为空字符串，跳过）。
    const before = text.slice(cursor, start)
    if (before.length > 0) {
      segments.push({ kind: 'markdown', text: before })
    }
    // 代码段：value 是围栏内代码体（不含围栏标记）。
    segments.push({ kind: 'code', code: code.value, lang: code.lang ?? undefined })
    cursor = end
  }

  // 最后一个 code 节点之后的尾部非代码段。
  const tail = text.slice(cursor)
  if (tail.length > 0) {
    segments.push({ kind: 'markdown', text: tail })
  }

  if (segments.length === 0) {
    return { kind: 'plain' }
  }

  return { kind: 'split', segments }
}

/**
 * 递归检查子树是否包含 bail-out 节点。
 * 仅对非顶层-code 子树调用（顶层 code 由调用方直接收集）。
 * 命中：footnoteReference / footnoteDefinition / definition / html / table；
 * 任何 code 节点（含 lang === 'math'）——因为这里看到的所有 code 都是非顶层的。
 */
function hasBailoutNode(node: RootContent): boolean {
  switch (node.type) {
    case 'footnoteReference':
    case 'footnoteDefinition':
    case 'definition':
    case 'html':
    case 'table':
      return true
    case 'code':
      // 到达这里的 code 一定是非顶层的（顶层 code 由调用方收集，不走进此函数）。
      return true
  }

  if ('children' in node && node.children !== undefined) {
    for (const child of node.children as RootContent[]) {
      if (hasBailoutNode(child)) return true
    }
  }

  return false
}
