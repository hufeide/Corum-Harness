/**
 * PreviewView — 编辑区文件预览渲染层（HANDOFF §七.6，2026-09-05 第三十一轮）。
 *
 * 四类预览（EditorColumn 按 tab 类型分流）：
 *   - **Markdown**：复用官方 `MarkdownText` 原语（dsh-client-ui-primitives，
 *     与 chat 包 AssistantMarkdown 同一渲染管线：GFM/代码块/表格/KaTeX）。
 *     文本内容直接走 tab.content（corumFs/read），源码 ⟷ 预览可切换。
 *   - **SVG**：文本内联 `<svg>` 渲染（本地文件无 XSS 顾虑），源码可切换。
 *   - **图片**（jpg/jpeg/png/bmp/gif/webp）：corumFs/readBinary（base64）→
 *     `<img src={data:...}>`；二进制不进 Monaco（host read 端有防御）。
 *   - **视频**（mp4/webm/mov…）：`/corumfs/<path>` 同源 URL（host webserver
 *     流式 + Range），`<video controls>` 原生播放。
 *
 * @module corum-desktop/client/editor/PreviewView
 */

import { useEffect, useMemo, useState } from 'react'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { FileWarning } from 'lucide-react'
import css from './EditorColumn.module.css'

/** Markdown chrome 文案（无 locale 服务可用——中文环境硬编码，与 chat 包同形）。 */
const MD_LABELS: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
}

/** Markdown 预览：官方 MarkdownText 原语（settled 渲染，非 streaming）。 */
export function MarkdownPreview({ text }: { text: string }): React.ReactElement {
  return (
    <div className={css.previewMarkdown}>
      <MarkdownText text={text} labels={MD_LABELS} />
    </div>
  )
}

/** SVG 预览：文本内联渲染（本地工作区文件，与 VS Code 内联预览同语义）。 */
export function SvgPreview({ text, title }: { text: string; title: string }): React.ReactElement {
  return (
    <div className={css.previewMedia}>
      <div
        className={css.previewSvg}
        role="img"
        aria-label={title}
        // eslint-disable-next-line react/no-danger -- 本地工作区 SVG 文本内联预览（VS Code 同语义）
        dangerouslySetInnerHTML={{ __html: text }}
      />
    </div>
  )
}

/** 图片预览：readBinary（base64）→ `<img>`。 */
export function ImagePreview({
  path,
  title,
  readBinary,
}: {
  path: string
  title: string
  readBinary: (path: string) => Promise<{ ok: boolean; error?: { message?: string }; value?: { mime: string; base64: string } }>
}): React.ReactElement {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setSrc(null)
    setError(null)
    readBinary(path).then((result) => {
      if (!alive) return
      if (result.ok && result.value !== undefined) {
        setSrc(`data:${result.value.mime};base64,${result.value.base64}`)
      } else {
        setError(result.error?.message ?? '读取失败')
      }
    }).catch((err: unknown) => {
      if (alive) setError(String(err))
    })
    return () => { alive = false }
  }, [path, readBinary])
  if (error !== null) {
    return (
      <div className={css.previewPlaceholder}>
        <FileWarning size={20} strokeWidth={1.6} />
        <span>图片加载失败：{error}</span>
      </div>
    )
  }
  if (src === null) {
    return <div className={css.previewPlaceholder}><span>加载中…</span></div>
  }
  return (
    <div className={css.previewMedia}>
      <img className={css.previewImg} src={src} alt={title} draggable={false} />
    </div>
  )
}

/** 视频预览：`/corumfs/<path>` 同源流式 URL（host webserver 路由，支持 Range）。 */
export function VideoPreview({ path, title }: { path: string; title: string }): React.ReactElement {
  const src = useMemo(() => `/corumfs${path.split('/').map(encodeURIComponent).join('/')}`, [path])
  return (
    <div className={css.previewMedia}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- 本地文件预览无字幕轨 */}
      <video className={css.previewVideo} src={src} title={title} controls preload="metadata" />
    </div>
  )
}
