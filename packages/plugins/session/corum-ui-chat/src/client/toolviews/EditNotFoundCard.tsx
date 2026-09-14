/**
 * fork（corum）：「编辑未命中」专用卡（2026-09-13 用户裁定）。
 *
 * 为什么单独一张卡：edit 工具的 FS_EDIT_NOT_FOUND（fork #14 附定位提示）是
 * 「什么都没改、只是没找到 anchor」——不是 Error。模型侧语义不动（isError 仍为
 * true，模型据此判断编辑失败）；本卡只改**呈现层**：模型读「失败 + 定位提示」，
 * 人看「什么都没改 + 候选位置」。
 *
 * 注册面：keyed slot `tool.call.toolview`（key = 'edit'）——keyed 命中**替换**
 * 整行通用卡（官方 dsh-client-ui-tool 的 renderSlot 契约），所以本组件必须同时
 * 覆盖三态：
 *   ① 未命中卡（isError + FS_EDIT_NOT_FOUND + 解析成功）→ 本文件的玻璃卡；
 *   ② 成功/运行/其它错误 → 官方视觉对齐的紧凑行（filePath 链接 + 可展开原文）；
 *   ③ 解析不出（官方无提示错误/未知格式）→ 卡头 + **纯文本**错误原文（不崩）。
 *
 * 数据契约：edit-not-found.ts 的 parseEditNotFound（标记行 → 人读块 → undefined
 * 回落），UI 内不散落正则。
 */
import { memo, useState } from 'react'
import { ChevronDown, ChevronUp, FileEdit, FileX2 } from 'lucide-react'
import { DiffBlock, diffTotals, type DiffBlockLabels, type DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../locale.ts'
import { editFilePath, parseEditNotFound, type EditMissModel } from './edit-not-found.ts'
import css from './EditNotFoundCard.module.css'

/** 框架按注册 locale 注入的 t（key 集 = 'chat' namespace 的 ChatKey 联合）。 */
type TFunc = PropsLocale<'chat'>['t']

/** 注册壳（EditToolView）额外注入的 props。 */
export interface EditToolViewExtraProps {
  /** 行号点击 → corumEditor.openFile + revealLine 跳转（壳经 chatRuntime 桥注入）。 */
  openLineAt?: (path: string | undefined, line: number) => void
}

/** 结果文本提取（与官方 toolRowModel 同口径：content 里 text block 拼接）。 */
function resultText(props: ToolCallViewProps): string | undefined {
  if (!('kind' in props.block)) return undefined
  const texts: string[] = []
  for (const block of props.block.content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  return texts.length === 0 ? undefined : texts.join('\n')
}

/** 路径摘要：cwd 相对化（与官方 relativizeToCwd 同语义的最小版）。 */
function shortenPath(path: string, cwd: string | undefined): string {
  if (cwd !== undefined && cwd !== '' && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  return path
}

/** 底部浅色说明：按失败分档翻人话（fork 末句归因的 UI 版）。 */
function footnoteText(model: EditMissModel, t: TFunc): string {
  switch (model.reason) {
    case 'anchor-miss':
      return model.anchorLines > 1
        ? t('editMiss.footnote.anchorMissMulti', { n: model.anchorLines })
        : t('editMiss.footnote.anchorMiss')
    case 'no-previous-content':
      return t('editMiss.footnote.noPrevious')
    case 'insufficient-context':
      return t('editMiss.footnote.insufficient')
  }
}

/** 相似度徽标文案。 */
function similarityLabel(candidate: { similarity: number; sameText: boolean }, t: TFunc): string {
  if (candidate.sameText) return t('editMiss.sameText')
  return `${Math.round(candidate.similarity * 100)}%`
}

/** 未命中卡本体（三态之①）。 */
function MissCard({ model, filePath, rawText, openLine, t }: {
  model: EditMissModel
  filePath: string | undefined
  rawText: string
  openLine: (line: number) => void
  t: TFunc
}) {
  return (
    <div className={css.card} data-edit-miss="">
      <div className={css.head}>
        <span className={css.headIcon}><FileX2 size={15} strokeWidth={2} /></span>
        <span className={css.title}>{t('editMiss.title')}</span>
        {filePath !== undefined && <span className={css.filePath} title={filePath}>{filePath}</span>}
        <span className={css.badge}>{t('editMiss.noChanges')}</span>
      </div>
      {model.candidates.length > 0 && (
        <div className={css.candidates}>
          {model.candidates.map((candidate, index) => (
            <div className={css.candidateRow} key={`${candidate.line}-${index}`}>
              <button
                type="button"
                className={css.lineLink}
                onClick={() => { openLine(candidate.line) }}
                title={t('editMiss.jumpTitle')}
              >
                {candidate.span > 1
                  ? `L${candidate.line}-${candidate.line + candidate.span - 1}`
                  : candidate.duplicates.length > 0
                    ? `L${[candidate.line, ...candidate.duplicates].join(', ')}`
                    : `L${candidate.line}`}
              </button>
              {candidate.duplicates.length > 0 && (
                <span className={css.dupTag}>{t('editMiss.duplicate')}</span>
              )}
              <span className={css.snippet} title={candidate.text}>{candidate.text}</span>
              <span className={css.simBadge}>{similarityLabel(candidate, t)}</span>
            </div>
          ))}
        </div>
      )}
      {model.mismatch !== undefined && (
        <div className={css.mismatch}>
          <span className={css.mismatchTitle}>{t('editMiss.mismatchTitle')}</span>
          <div className={css.mismatchRow}>
            <span className={css.mismatchLabel}>{t('editMiss.mismatchAnchor', { n: model.mismatch.anchorLine })}</span>
            <span className={css.snippet} title={model.mismatch.anchorText}>{model.mismatch.anchorText}</span>
          </div>
          <div className={css.mismatchRow}>
            <span className={css.mismatchLabel}>
              <button
                type="button"
                className={css.lineLink}
                onClick={() => { if (model.mismatch !== undefined) openLine(model.mismatch.fileLine) }}
              >
                {t('editMiss.mismatchFile', { n: model.mismatch.fileLine })}
              </button>
            </span>
            <span className={css.snippet} title={model.mismatch.fileText}>{model.mismatch.fileText}</span>
            <span className={css.simBadge}>{Math.round(model.mismatch.similarity * 100)}%</span>
          </div>
        </div>
      )}
      {/* 降级态：有分档但零候选 → 附人读原文（截断标记行之外的部分）。 */}
      {model.candidates.length === 0 && (
        <div className={css.fallbackText}>{rawText.split('\n').filter(line => !line.startsWith('<<<corum-edit-not-found')).join('\n')}</div>
      )}
      <div className={css.footnote}>{footnoteText(model, t)}</div>
    </div>
  )
}

/** DiffBlock 的本地化 chrome（labels 契约见 primitives DiffBlock.d.ts）。 */
function diffLabels(t: TFunc): DiffBlockLabels {
  return {
    copy: t('editMiss.diff.copy'),
    copied: t('editMiss.diff.copied'),
    collapseAria: t('editMiss.diff.collapseAria'),
    expandAria: (hidden: number) => t('editMiss.diff.expandAria', { hidden }),
    collapse: t('editMiss.diff.collapse'),
    expand: (hidden: number) => t('editMiss.diff.expand', { hidden }),
    files: (count: number) => t('editMiss.diff.files', { count }),
  }
}

/** 从 edit 参数构造 intended diff（官方 intendedDiff 的 edit 分支同口径：old/new 全量段）。 */
function intendedDiffHunk(argsRaw: string, filePath: string | undefined): DiffHunk | undefined {
  if (filePath === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const args = parsed as Record<string, unknown>
    const oldText = typeof args.old_string === 'string' ? args.old_string : undefined
    const newText = typeof args.new_string === 'string' ? args.new_string : undefined
    if (newText === undefined) return undefined
    return { path: filePath, oldText: oldText ?? null, newText }
  } catch {
    return undefined
  }
}

/** 紧凑行（三态之②：成功/运行/其它错误）——官方 FileMutationRow 对齐：
 *  单行头（图标 + 标题 + 文件链接 + ±统计 + 展开 chevron）+ 可展开 DiffBlock。 */
function CompactRow({ filePath, displayPath, state, bodyRaw, output, diff, openFile, t }: {
  filePath: string | undefined
  displayPath: string
  state: 'running' | 'ok' | 'error' | 'stopped'
  bodyRaw: string | undefined
  output: string | undefined
  /** 成功态的 intended diff（官方 diffCardModel 的 edit 分支同口径）。 */
  diff: DiffHunk | undefined
  openFile: (() => void) | undefined
  t: TFunc
}) {
  const [expanded, setExpanded] = useState(false)
  const hasDiff = diff !== undefined && state === 'ok'
  const expandable = hasDiff || bodyRaw !== undefined || output !== undefined
  const open = expanded && expandable
  const totals = hasDiff ? diffTotals([diff]) : undefined
  return (
    <div className={css.card} data-edit-compact="" data-state={state}>
      <div className={css.head} style={{ padding: '6px 14px' }}>
        <span className={css.headIcon}><FileEdit size={15} strokeWidth={2} /></span>
        <span className={css.title}>{t('editMiss.compactTitle')}</span>
        {filePath !== undefined && openFile !== undefined
          ? (
            <button type="button" className={css.lineLink} style={{ fontSize: 12 }} onClick={openFile}>
              {displayPath}
            </button>
          )
          : filePath !== undefined && <span className={css.filePath}>{displayPath}</span>}
        {totals !== undefined && (
          <span className={css.simBadge}>+{totals.added} −{totals.removed}</span>
        )}
        {expandable && (
          <button
            type="button"
            className={css.lineLink}
            aria-expanded={open}
            onClick={() => { setExpanded(v => !v) }}
          >
            {open ? <ChevronUp size={14} strokeWidth={2} /> : <ChevronDown size={14} strokeWidth={2} />}
          </button>
        )}
      </div>
      {open && hasDiff && (
        <div style={{ padding: '0 8px 8px' }}>
          <DiffBlock diffs={[diff]} labels={diffLabels(t)} />
        </div>
      )}
      {open && !hasDiff && (
        <div className={css.fallbackText}>
          {output ?? bodyRaw ?? ''}
        </div>
      )}
    </div>
  )
}

/**
 * edit 工具的 keyed toolview（tool.call.toolview, key='edit'）。
 *
 * 分流：
 *   - settled + isError + error.code === 'FS_EDIT_NOT_FOUND' → 解析提示文本：
 *     成功 → MissCard；失败 → 卡头 + 纯文本原文（不崩，红线）。
 *   - 其余（成功 / 运行中 / 其它错误码）→ CompactRow（成功态不回归红卡）。
 */
export const EditNotFoundCard = memo(function EditNotFoundCard(props: ToolCallViewProps & EditToolViewExtraProps & { t: TFunc }) {
  const { block, cwd, openFile, t } = props
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const filePath = editFilePath(argsRaw)
  const displayPath = filePath === undefined ? '' : shortenPath(filePath, cwd)
  const errorText = resultText(props) ?? ''
  const isMiss = settled && block.isError && block.error?.code === 'FS_EDIT_NOT_FOUND'

  /** 行号点击 → corumEditor.openFile + revealLine 跳转（壳经 chatRuntime 桥注入）。 */
  const openLine = (line: number): void => {
    props.openLineAt?.(filePath, line)
  }

  if (isMiss) {
    const model = parseEditNotFound(errorText)
    if (model !== undefined) {
      // 有候选 → 完整卡；零候选 → 降级态卡（徽标 + 浅色原文 + 分档说明），
      // 与有候选态同一张卡壳，只是候选表为空。
      return <MissCard model={model} filePath={displayPath === '' ? filePath : displayPath} rawText={errorText} openLine={openLine} t={t} />
    }
    // 解析失败回落：卡头 + 纯文本错误原文（绝不崩；reason 未知 → 通用 anchor-miss 说明）。
    return (
      <div className={css.card} data-edit-miss-fallback="">
        <div className={css.head}>
          <span className={css.headIcon}><FileX2 size={15} strokeWidth={2} /></span>
          <span className={css.title}>{t('editMiss.title')}</span>
          {filePath !== undefined && <span className={css.filePath}>{displayPath}</span>}
          <span className={css.badge}>{t('editMiss.noChanges')}</span>
        </div>
        <div className={css.fallbackText}>{errorText}</div>
        <div className={css.footnote}>{t('editMiss.footnote.anchorMiss')}</div>
      </div>
    )
  }

  const state = !settled ? 'running' : block.isError ? 'error' : 'ok'
  return (
    <CompactRow
      filePath={filePath}
      displayPath={displayPath}
      state={state}
      bodyRaw={argsRaw === '' ? undefined : argsRaw}
      output={settled && !block.isError ? undefined : errorText === '' ? undefined : errorText}
      diff={intendedDiffHunk(argsRaw, filePath)}
      openFile={filePath === undefined ? undefined : () => { openFile(filePath) }}
      t={t}
    />
  )
})
