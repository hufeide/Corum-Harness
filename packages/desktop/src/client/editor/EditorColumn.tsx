/**
 * EditorColumn — the resident right-hand code editor in IDE mode, now the
 * MERGED ③ 编辑器区 card (design.pen cZcBX, 2026-09-03 改版：编辑器 + 资源管理器
 * 合一张玻璃卡，资源管理器不再是独立区域/槽位). Registered into the
 * `corum.editor` slot (a root-scope single slot declared ONLY by
 * @corum/corum-ide-ui, IDE mode only), so the editor is a resident column —
 * not a session tab — and disappears entirely in minimal mode.
 *
 * Card-internal structure follows the design frame's children order:
 *   editor-main (ljiCn: Editor Tabs → crumb → Code → Editor Status)
 *   │ in-card sash（资源管理器子面板宽度拖拽，命中区 8px，同 GridView Sash 机制）
 *   divider (f87vQ: 1px $glass-border 竖线)
 *   资源管理器 (WJ4dP: ExplorerPane 210px 默认，可拖 sash 调宽).
 *
 * 折叠态（design.pen waRkJ：L1 主界面 · 深色 · 资源管理器折叠）：
 *   资源管理器子面板完全消失（不再渲染 32px 竖条），编辑器占满整卡宽度。
 *   展开/关闭两钮移入 Editor Tabs 行尾（spacer 后）：
 *     btn-expand-explorer（panel-right-open 16×16，仅折叠态可见）
 *     btn-close-explorer（x 17×17，折叠态时作「关闭区域」、展开态不显示）
 *
 * Styles live in EditorColumn.module.css (design tokens only, no inline hex);
 * the Monaco theme flips with the global light/dark theme
 * (body[data-ds-dark-theme]).
 * @module corum-desktop/client/editor/EditorColumn
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PanelRightOpen, X } from 'lucide-react'
// Type-only: pulls the `corum.editor` SlotMap row (declared by @corum/corum-ide-ui,
// IDE mode only). The type import keeps this file compiling standalone without
// a runtime dependency on the shell plugin.
import type {} from '@corum/corum-ide-ui/client'
import { MonacoEditor, type MonacoFileModel } from './MonacoEditor.tsx'
import { ExplorerPane, type ExplorerPaneInjected } from './ExplorerPane.tsx'
import css from './EditorColumn.module.css'

/** Design-file demo content: mirrors the design's Code frame lines 1–7. */
const DEMO_FILE: MonacoFileModel = {
  path: 'docs/backend-requirements.md',
  language: 'markdown',
  value: [
    '矩道 Corum Harness',
    '## 1. 液态玻璃主题',
    '',
    '**优先级**: P0',
    'Set-Cookie: token=<jwt>;',
    'HttpOnly; Secure; SameSite=Strict;',
    'Path=/api; Max-Age=86400',
  ].join('\n'),
}

/** 本插件的注入面（见 client/index.ts apply）。 */
export interface EditorColumnInjected {
  /** 关闭本区域（隐藏叶子，可在插件中心「视图管理」恢复）。 */
  closeRegion: () => void
  /** 资源管理器子面板数据源 + generation 源（ExplorerPane 直通）。 */
  explorer: Pick<ExplorerPaneInjected, 'listDir' | 'generation'>
}

/** Full composed props of the root-scope editor slot (owner share + 本插件注入面). */
export type EditorColumnProps = PropsRuntime<'corum.editor'> & EditorColumnInjected

/** Open files as the design's editor tab strip (tab-file rows). */
const OPEN_TABS = [
  { title: 'requirements.md', active: true, dirty: true },
  { title: 'columns.ts', active: false, dirty: false },
]

/** 资源管理器子面板宽度边界（设计 210 默认；调宽区间 [160, 480]）。 */
const EXPLORER_DEFAULT_WIDTH = 210
const EXPLORER_MIN_WIDTH = 160
const EXPLORER_MAX_WIDTH = 480

/** Track the global light/dark theme via body[data-ds-dark-theme]. */
function useDarkTheme(): boolean {
  const [dark, setDark] = useState<boolean>(
    () => document.body.hasAttribute('data-ds-dark-theme'),
  )
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.body.hasAttribute('data-ds-dark-theme'))
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/** The resident merged editor card (see module doc). */
export function EditorColumn({ closeRegion, explorer }: EditorColumnProps): React.ReactElement {
  const dark = useDarkTheme()
  /** 资源管理器子面板宽度（px；拖卡内 sash 调）。 */
  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT_WIDTH)
  /** 资源管理器子面板折叠态（design waRkJ：折叠 = 子面板完全消失，编辑器占满）。 */
  const [explorerCollapsed, setExplorerCollapsed] = useState(false)
  const onToggleExplorerCollapsed = useCallback(() => {
    setExplorerCollapsed((prev) => !prev)
  }, [])

  // 卡内 sash（沿用 GridView Sash 的 VSCode 拖拽机制）：向右拖 = 资源管理器
  // 变窄（子面板在卡右缘，sash 左移增宽、右移减宽）。
  const sashDragWidth = useRef(EXPLORER_DEFAULT_WIDTH)
  sashDragWidth.current = explorerWidth
  const onSashMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    let origin = e.clientX
    const style = document.createElement('style')
    style.textContent = '* { cursor: col-resize !important; user-select: none !important; -webkit-user-select: none !important; }'
    document.head.appendChild(style)
    const onMove = (ev: MouseEvent) => {
      ev.preventDefault()
      const delta = ev.clientX - origin
      origin = ev.clientX
      // sash 在子面板左缘：左移（delta<0）子面板增宽，右移减宽。
      const next = Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, sashDragWidth.current - delta))
      sashDragWidth.current = next
      setExplorerWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      style.remove()
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
  }, [])

  return (
    <div className={css.column} data-code-editor-column="">
      {/* ljiCn — editor-main（现有编辑器内容，flex:1 吸收剩余）。 */}
      <div className={css.editorMain}>
        {/* M2nKD — Editor Tabs（gap6 · pad[10,10,6,10]） */}
        <div className={css.tabs}>
          {OPEN_TABS.map((tab) => (
            <div
              key={tab.title}
              className={`${css.tab}${tab.active ? ` ${css.tabActive}` : ''}`}
              data-tab-active={tab.active || undefined}
            >
              {tab.dirty && <span className={css.tabDirty} />}
              <span className={css.tabTitle}>{tab.title}</span>
              <X size={13} strokeWidth={2} className={css.tabClose} />
            </div>
          ))}
          <div className={css.spacer} />
          {/* 折叠态：btn-expand-explorer（panel-right-open）展开资源管理器；
              btn-close-explorer（x）关闭整个编辑器区域（非折叠态不显示）。 */}
          {explorerCollapsed && (
            <button
              type="button"
              className={css.tbExpandExplorer}
              title="展开资源管理器"
              onClick={onToggleExplorerCollapsed}
            >
              <PanelRightOpen size={16} strokeWidth={2} />
            </button>
          )}
          {explorerCollapsed && (
            <button
              type="button"
              className={css.tbCloseExplorer}
              title="关闭此区域（可在插件中心「视图管理」恢复）"
              onClick={closeRegion}
            >
              <X size={17} strokeWidth={2} />
            </button>
          )}
        </div>

        {/* YlGBD — crumb（pad[0,14,8,14]） */}
        <div className={css.crumb}>docs › backend-requirements.md</div>

        {/* w1vUz — Code（Monaco，flex:1；主题随深浅翻转） */}
        <div className={css.code}>
          <MonacoEditor file={DEMO_FILE} dark={dark} className="corum-code-editor" />
        </div>

        {/* hogk5 — Editor Status（pad[6,14,8,14] gap10） */}
        <div className={css.status}>
          <span>行 7, 列 1</span>
          <span>UTF-8</span>
          <span>Markdown</span>
          <div className={css.statusSpacer} />
          <span className={css.dirtyDot} />
          <span className={css.dirtyText}>未保存</span>
        </div>
      </div>

      {/* 卡内 sash + divider + 资源管理器子面板（折叠态全部消失，编辑器占满）。 */}
      {!explorerCollapsed && (
        <>
          {/* 卡内 sash（资源管理器子面板调宽）。 */}
          <div className={css.sash} onMouseDown={onSashMouseDown} data-explorer-sash="" />

          {/* f87vQ — divider（1px $glass-border 竖线）。 */}
          <div className={css.divider} />

          {/* WJ4dP — 资源管理器子面板（210 默认可调宽）。 */}
          <div
            className={css.explorerPane}
            style={{ width: explorerWidth }}
          >
            <ExplorerPane
              listDir={explorer.listDir}
              generation={explorer.generation}
              closeRegion={closeRegion}
              onToggleCollapsed={onToggleExplorerCollapsed}
            />
          </div>
        </>
      )}
    </div>
  )
}
