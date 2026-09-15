/**
 * fork（corum）：助手正文调度器 —— 在顶层代码围栏处拆分文本，代码段走
 * {@link CodeCard}，非代码段走官方 {@link MarkdownText}。
 *
 * 调用 {@link splitFences}：`plain` → 整段一个 MarkdownText；`split` → 交替段。
 * 同一份 `labels` / `mentions` / `streaming` 透传给每个 MarkdownText。
 *
 * 间距：官方 MarkdownText 根是 `<div class="markdown">`，其 CSS 清零首/尾子
 * 边距，fork 的 AssistantMarkdown.module.css 给 `.body { gap: 16px }`。
 * 本调度器是一个 flex item，需自带段间节奏——用垂直布局 + 16px gap（与 .body 一致）。
 */
import { memo, useMemo } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions, MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { splitFences } from './fence-split.ts'
import { CodeCard } from './CodeCard.tsx'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './AssistantProse.module.css'

export interface AssistantProseProps {
  text: string
  streaming: boolean
  labels: MarkdownLabels
  fileMentions: MarkdownFileMentions | undefined
  t: ChatViewSlotProps['t']
}

export const AssistantProse = memo(function AssistantProse({
  text, streaming, labels, fileMentions, t,
}: AssistantProseProps) {
  const result = useMemo(() => splitFences(text), [text])

  if (result.kind === 'plain') {
    return (
      <MarkdownText
        text={text}
        streaming={streaming}
        labels={labels}
        fileMentions={fileMentions}
      />
    )
  }

  return (
    <div className={css.split}>
      {result.segments.map((segment, i) => {
        if (segment.kind === 'markdown') {
          return (
            <MarkdownText
              key={i}
              text={segment.text}
              streaming={streaming}
              labels={labels}
              fileMentions={fileMentions}
            />
          )
        }
        return (
          <CodeCard
            key={i}
            code={segment.code}
            lang={segment.lang}
            // 流式臂的通路（与官方 CodeBlock 的 `streaming` 同义）：本组件本来就从框架
            // 拿到 `streaming`，原先只透传给了 MarkdownText，**漏传给了代码卡** ⇒
            // 代码卡永远走整块重算臂。同时 `key={i}` 是**位置稳定**的（同一个围栏在
            // segments 里的下标不随增长变化），正是官方要求的 stream-stable key ——
            // 增量缓存才能在跨 chunk 的多次渲染间存活。
            streaming={streaming}
            t={t}
          />
        )
      })}
    </div>
  )
})
