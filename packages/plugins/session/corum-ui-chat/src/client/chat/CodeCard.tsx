/**
 * fork（corum）：代码段卡 —— 把官方 CodeBlock 的黑条 banner 换成 corum 毛玻璃卡。
 *
 * 设计源（唯一权威）：`doc/UXDesign/design.pen` 帧 qLyn3（dark theme A）：
 *   - 帧 lIHmW = code-card-expanded
 *   - 帧 jWH6J = code-card-collapsed
 *
 * 头行（iconbox + 标题 + 语言 chip + 行数 chip + spacer + 复制 + 在终端运行 + chevron）；
 * 展开体 = 逐行代码（行号 + mono 代码文本，无语法高亮——设计稿是单色）；
 * 折叠体 = 单行摘要（首行 + `…（共 N 行）`）。
 *
 * 展开态默认值遵循本仓现有卡片的惯例：FileToolCard / SubagentCard 的 disclosure
 * 用 `useState(false)` 即默认折叠（长块首屏不占满）。本卡同样默认折叠。
 *
 * 复制：复用官方 `writeClipboard`（`@deepseek-ai/dsh-client-ui-primitives`），
 * 与官方 CodeBlock 同款 1000ms copied 态、用 `t('copy')` / `t('copied')` 换文案。
 *
 * 在终端运行：本轮 UI-only——点击显示「功能待实现」提示，不做任何 IPC/服务接线。
 */
import { Fragment, memo, useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Copy, FileCode, Play, SquareTerminal } from 'lucide-react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { isScriptFence } from './code-fence-kind.ts'
import {
  StreamingHighlightSession, grammarLoadCount, highlightLines, subscribeGrammarLoaded,
  type HighlightSpan, type StreamingHighlightFrame,
} from './highlight.ts'
import css from './CodeCard.module.css'

/** 框架注入的 t（chat namespace + common 词汇）。 */
type TFunc = ChatViewSlotProps['t']

/**
 * 流式臂里「已完成行」的分组大小（**与官方 `CodeBlock` 同值**）。
 *
 * 作用：已完成的行按 32 行一组冻结成**元素组**，跨帧复用同一个 React 元素
 * （`key` 取该组首行号），于是增量增长时 React 只对「最后未满的一组 + 尾部行」
 * 做 reconcile —— 已结算的几十上百行连 diff 都不做。
 */
const STREAMING_LINE_GROUP_SIZE = 32

/**
 * 把一行的高亮 span 渲染成带 inline style 的 `<span>` 序列（shiki 的
 * `style.color` 实际值是 `var(--shiki-token-*)`，颜色仍归主题表管）。
 *
 * `fallback` 该行 span 为空时用原文兜底——保证任何情况下文本都不丢。
 */
function renderSpans(spans: readonly HighlightSpan[], fallback: string): ReactNode {
  if (spans.length === 0) return fallback
  return spans.map((span, index) => <span style={span.style} key={index}>{span.text}</span>)
}

/**
 * 一行代码（行号 + 正文）—— **模块级组件**，两条臂共用。
 *
 * ⚠️ 必须是模块级而不是卡内内联箭头：内联组件每次渲染都是**新类型**，React 会
 * unmount/remount 整棵子树 —— 那会**恰好摧毁流式臂要保住的元素复用**，行多了就是
 * 每帧全量重建。模块级身份稳定，`memo` 才真正生效。
 */
const CodeLine = memo(function CodeLine({ index, spans, text }: {
  index: number
  spans: readonly HighlightSpan[] | undefined
  text: string
}) {
  return (
    <div className={css.codeLine}>
      <span className={css.lineNo}>{index + 1}</span>
      <code className={css.codeText}>
        {/* 有高亮 → 逐 span 上色；无高亮（不支持的语言 / 语法未就绪）→ 纯文本原文。
            两种形态的文本内容完全一致，只有着色与否的差别。 */}
        {spans === undefined ? text : renderSpans(spans, text)}
      </code>
    </div>
  )
})

export interface CodeCardProps {
  /** 围栏代码体（不含围栏标记）。 */
  code: string
  /** 围栏语言（info string）；无语言时为 undefined。 */
  lang: string | undefined
  /**
   * 该围栏是否**仍在增长**（助手消息流式输出中）。
   *
   * 官方的同名 prop（`ui-primitives` `CodeBlockProps.streaming`）就是这条通路：
   * `true` 时走 `StreamingHighlightSession` 的**增量分词**臂（只重算新增文本，
   * 已完成行连同元素一起冻结复用）；`false`/缺省时走整块高亮臂。
   * 由 `AssistantProse` 透传（它本来就从框架拿到 `streaming`）。
   */
  streaming?: boolean
  /** Locale seat。 */
  t: TFunc
}

/**
 * 围栏代码卡（设计稿 qLyn3 lIHmW / jWH6J / JdYy4）——**按用途分两类**（2026-09-15 用户定调）：
 *
 *   · **代码片段**（`isScript === false`）：给人**读**的代码。头部 = 图标 + 「代码片段」+
 *     语言 chip + 行数 chip + 复制 + 折叠 chevron。**不出「在终端运行」**。
 *   · **脚本片段**（`isScript === true`）：给用户**去跑**的脚本 —— 典型场景是
 *     **受沙箱限制 Agent 无法自行执行**（例如需要写工作区外的路径），于是把命令交给用户执行。
 *     头部额外出现绿色「**在终端运行**」。图标/标题也随之区分（square-terminal / 「脚本片段」）。
 *
 * **默认展开**（2026-09-15 用户更正）：代码/脚本片段**默认不折叠**。
 * 注意与文件卡（read/edit/write）区别 —— 那三张卡是**默认收起**（用户 2026-09-15 定调），
 * 两类卡片的默认态**刻意不同**，别互相「统一」。
 */
export const CodeCard = memo(function CodeCard({ code, lang, streaming, t }: CodeCardProps) {
  // 默认**展开**（用户 2026-09-15 更正：代码/脚本片段默认不折叠）。
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)
  const [runHint, setRunHint] = useState(false)
  const isScript = isScriptFence(lang)

  const lines = code.split('\n')
  const lineCount = lines.length

  /**
   * 逐行语法高亮（按行 span 数组，`highlight.ts` = 官方 `ui-primitives` 的实现副本）。
   *
   * 用 `highlightLines` 而**不是** `highlightToHtml`：本卡是自建逐行渲染（带行号、
   * 带折叠态），`highlightToHtml` 返回一整棵 `<pre class="shiki">`，会把正文渲染权
   * 交回官方、行号与折叠态都得重做。按行接口只换正文，卡片外壳/行号/折叠态全不动。
   *
   * `useSyncExternalStore` 复合进依赖：语法是**异步加载**的（懒加载语言首调返回
   * undefined 并在后台 import），`grammarLoadCount` 变化触发重渲染，语法就绪后自动上色。
   * `lang` 不支持（或尚未加载完）→ `undefined` → 走无高亮的纯文本，仍是等宽。
   */
  const grammarGeneration = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const highlighted = useMemo(
    () => highlightLines(code, lang),
    [code, lang, grammarGeneration],
  )

  /*
    ── 流式臂：照抄官方的 token 级增量高亮 ────────────────────────────────
    行为与官方 `CodeBlock` 一致（TextMate 分词是按行、前向的：一行的 token 只取决于
    它自己的文本与进入它时的语法状态 ⇒ **追加文本永不改变已完成行的 token**），
    所以只对「新增文本」重新分词，已完成行连同**元素**一起冻结复用。

    与官方的两点刻意差异（都属于「按我们的壳适配」，不是行为差异）：
      ① 官方按 32 行分组产出 `renderLine`，行是裸 `\n` 分隔的文本行；
         我们是**每行一个带行号的 flex 行**（`css.codeLine`），所以按「单行元素」缓存
         （比官方更细的粒度）—— 未满 32 行时同样只 reconcile 尾部。
      ② 官方输出 `<pre class="shiki">`；我们保持自己的 `css.body` + `css.codeText` 壳。

    语法懒加载：未加载完 → `updateFrame` 返回 `undefined` → 走纯文本；
    `grammarGeneration`（`useSyncExternalStore`）变化会触发重跑，语法就绪后自动上色。
  */
  const sessionRef = useRef<StreamingHighlightSession | null>(null)
  const streamCacheRef = useRef<{
    code: string
    generation: number
    frame: StreamingHighlightFrame
    lines: ReactNode[]
    body: ReactNode
  } | null>(null)

  const streamedBody = useMemo(() => {
    if (streaming !== true || !expanded) {
      // 离开流式臂（已结算 / 折叠态）⇒ 丢弃会话与缓存，避免陈旧状态跨消息泄漏。
      sessionRef.current = null
      streamCacheRef.current = null
      return undefined
    }
    // `code.split('\n')` 与 `lines` 同源：同一份文本的行数必然一致（纯函数，无副作用）。
    const rendered = code.split('\n')
    sessionRef.current ??= new StreamingHighlightSession()
    const frame = sessionRef.current.updateFrame(code, lang)
    if (frame === undefined) {
      streamCacheRef.current = null
      return undefined
    }
    const previous = streamCacheRef.current
    if (previous?.frame === frame && previous.code === code) return previous.body
    const sameGeneration = previous?.generation === frame.generation
    const kept = sameGeneration ? [...previous.lines] : []
    for (const spans of frame.appended) {
      const idx = kept.length
      kept.push(<CodeLine key={idx} index={idx} spans={spans} text={rendered[idx] ?? ''} />)
    }
    const tailStart = kept.length
    const tail = frame.tail.map((spans, i) => (
      <CodeLine key={tailStart + i} index={tailStart + i} spans={spans} text={rendered[tailStart + i] ?? ''} />
    ))
    const body = (
      <div className={css.body} data-corum-code-body="">
        {[...kept, ...tail]}
      </div>
    )
    streamCacheRef.current = { code, generation: frame.generation, frame, lines: kept, body }
    return body
  }, [streaming, expanded, code, lang, grammarGeneration])

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(code).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, code])

  const onRun = useCallback(() => {
    setRunHint(true)
    window.setTimeout(() => { setRunHint(false) }, 1500)
  }, [])

  const firstLine = lines[0] ?? ''
  const summary = t('codeCard.summary', { first: firstLine, n: lineCount })

  return (
    <div className={css.card} data-corum-code-card="">
      <div className={css.head}>
        <span className={css.iconBox} data-fence-kind={isScript ? 'script' : 'code'}>
          {isScript
            ? <SquareTerminal size={14} strokeWidth={2} className={css.iconBoxIconSuccess} />
            : <FileCode size={14} strokeWidth={2} className={css.iconBoxIcon} />}
        </span>
        <span className={css.title}>{t(isScript ? 'codeCard.title.script' : 'codeCard.title.code')}</span>
        {/*
          语言位**恒在**（2026-09-16 用户定调「只要语言位保持与设计稿/官方一致」）。
          设计源：design.pen 三张代码卡的 head 都把 `lang` 画成**固定一栏**
          （`lIHmW` code-card-expanded 的 `kNCf8` / `jWH6J` collapsed / `JdYy4` script-card-expanded），
          官方 `CodeBlock` 同样是恒在的信息位（banner 里 `{lang ?? ''}`）。
          ⇒ **没写语言的围栏（裸 ```）保持空文本 + 定宽 padding 的占位**（左 padding 8px），
          头部结构与设计稿一致、不因有没有语言而抖动。
          ⚠️ 与高亮的关系：数据源就是围栏 info string（`fence-split.ts` 的 `node.lang`），
          **两家都不做「从代码内容猜语言」** —— 裸围栏不着色是正确行为，不是缺陷。
        */}
        <span className={css.chip}>
          <span className={css.chipLang}>{lang ?? ''}</span>
        </span>
        <span className={css.chip}>
          <span className={css.chipLines}>{t('codeCard.lines', { n: lineCount })}</span>
        </span>
        <span className={css.spacer} />
        <button
          type="button"
          className={css.btn}
          title={t('codeCard.copy')}
          aria-label={t('codeCard.copy')}
          onClick={onCopy}
        >
          <Copy size={13} strokeWidth={2} className={css.btnIconMuted} />
          <span className={css.btnLabel}>{copied ? t('copied') : t('copy')}</span>
        </button>
        {/* 「在终端运行」**只属于脚本片段**（2026-09-15 用户定调）：
            代码片段是给人读的，不该出现执行入口。 */}
        {isScript && (
          <button
            type="button"
            className={css.btn}
            data-run-in-terminal=""
            title={runHint ? t('codeCard.runHint') : t('codeCard.run')}
            aria-label={t('codeCard.run')}
            onClick={onRun}
          >
            <Play size={13} strokeWidth={2} className={css.btnIconSuccess} />
            <span className={css.btnLabelSuccess}>{runHint ? t('codeCard.runHint') : t('codeCard.run')}</span>
          </button>
        )}
        <button
          type="button"
          className={css.btn}
          title={expanded ? t('codeCard.collapse') : t('codeCard.expand')}
          aria-label={expanded ? t('codeCard.collapse') : t('codeCard.expand')}
          aria-expanded={expanded}
          onClick={() => { setExpanded(open => !open) }}
        >
          {expanded
            ? <ChevronUp size={13} strokeWidth={2} className={css.btnIconMuted} />
            : <ChevronDown size={13} strokeWidth={2} className={css.btnIconMuted} />}
        </button>
      </div>
      {expanded ? (
        streamedBody !== undefined ? streamedBody : (
          <div className={css.body} data-corum-code-body="">
            {lines.map((line, i) => (
              <CodeLine
                key={i}
                index={i}
                spans={highlighted === undefined ? undefined : (highlighted[i] ?? [])}
                text={line}
              />
            ))}
          </div>
        )
      ) : (
        <div className={css.collapsedBody} data-corum-code-summary="">
          <span className={css.summaryText}>{summary}</span>
        </div>
      )}
    </div>
  )
})
