/**
 * DiffViewer — VS Code 语义的双侧只读 diff 视图（「与已选项目比较」的呈现）。
 * 用 monaco 的 `editor.createDiffEditor`，双侧 readOnly，original=先选文件、
 * modified=后选文件。模型不共享主编辑器的 per-path cache（diff 是临时只读
 * 视图，卸载即 dispose），URI 用 `inmemory://diff/…` 避免与真实文件模型撞车。
 *
 * 主题复用 corum-light/corum-dark（defineCorumThemes 全局一次性注册，与
 * MonacoEditor 同源）；`useShadowDOM: false` 与主编辑器一致（避免 overflow
 * widget 进 shadow root 的问题——见 dev-conventions §7.1）。
 * @module corum-desktop/client/editor/DiffViewer
 */
import { useEffect, useRef } from 'react'
import { editor, Uri } from 'monaco-editor'

export interface DiffViewerProps {
  /** 原文（先选的文件）相对路径。 */
  original: string
  /** 新文（后选的文件）相对路径。 */
  modified: string
  /** Monaco 语言 id（取 modified 的语言）。 */
  language: string
  /** 读文件内容（corumFs/read RPC 直通）。 */
  readFile: (path: string) => Promise<{ ok: boolean; error?: { message?: string }; value?: { content: string; language: string } }>
  /** 主题。 */
  dark: boolean
}

export function DiffViewer({ original, modified, language, readFile, dark }: DiffViewerProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const diffRef = useRef<editor.IStandaloneDiffEditor | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const diff = editor.createDiffEditor(host, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      automaticLayout: true,
      useShadowDOM: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      renderOverviewRuler: false,
      // VS Code 默认：内联差异高亮 + 忽略前导/尾随空白关闭（精确对比）
      renderIndicators: true,
      ignoreTrimWhitespace: false,
    })
    diffRef.current = diff

    let cancelled = false
    void (async () => {
      const [ra, rb] = await Promise.all([readFile(original), readFile(modified)])
      if (cancelled) return
      const contentA = ra.ok && ra.value !== undefined ? ra.value.content : `（无法读取 ${original}：${ra.error?.message ?? '未知错误'}）`
      const contentB = rb.ok && rb.value !== undefined ? rb.value.content : `（无法读取 ${modified}：${rb.error?.message ?? '未知错误'}）`
      const uriA = Uri.parse(`inmemory://diff${original}`)
      const uriB = Uri.parse(`inmemory://diff${modified}`)
      const modelA = editor.createModel(contentA, language, uriA)
      const modelB = editor.createModel(contentB, language, uriB)
      diff.setModel({ original: modelA, modified: modelB })
    })()

    return () => {
      cancelled = true
      const model = diff.getModel()
      diff.dispose()
      diffRef.current = null
      // diff 模型独立创建（非共享 cache），随视图销毁
      model?.original.dispose()
      model?.modified.dispose()
    }
    // original/modified/language 在同一 diff tab 生命周期内不变（tab 级固定），
    // 变化即重开 tab（新 path），故只需 mount 一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 主题跟随
  useEffect(() => {
    editor.setTheme(dark ? 'corum-dark' : 'corum-light')
  }, [dark])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} data-diff-viewer="" />
}
