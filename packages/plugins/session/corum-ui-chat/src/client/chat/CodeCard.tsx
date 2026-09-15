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
import { memo, useCallback, useState } from 'react'
import { ChevronDown, ChevronUp, Copy, FileCode, Play, SquareTerminal } from 'lucide-react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { isScriptFence } from './code-fence-kind.ts'
import css from './CodeCard.module.css'

/** 框架注入的 t（chat namespace + common 词汇）。 */
type TFunc = ChatViewSlotProps['t']

export interface CodeCardProps {
  /** 围栏代码体（不含围栏标记）。 */
  code: string
  /** 围栏语言（info string）；无语言时为 undefined。 */
  lang: string | undefined
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
export const CodeCard = memo(function CodeCard({ code, lang, t }: CodeCardProps) {
  // 默认**展开**（用户 2026-09-15 更正：代码/脚本片段默认不折叠）。
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)
  const [runHint, setRunHint] = useState(false)
  const isScript = isScriptFence(lang)

  const lines = code.split('\n')
  const lineCount = lines.length

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
        {lang !== undefined && lang !== '' && (
          <span className={css.chip}>
            <span className={css.chipLang}>{lang}</span>
          </span>
        )}
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
        <div className={css.body} data-corum-code-body="">
          {lines.map((line, i) => (
            <div className={css.codeLine} key={i}>
              <span className={css.lineNo}>{i + 1}</span>
              <code className={css.codeText}>{line}</code>
            </div>
          ))}
        </div>
      ) : (
        <div className={css.collapsedBody} data-corum-code-summary="">
          <span className={css.summaryText}>{summary}</span>
        </div>
      )}
    </div>
  )
})
