/**
 * EditorColumn — the resident right-hand code editor in IDE mode, the
 * MERGED ③ 编辑器区 card (design.pen cZcBX). Registered into the
 * `corum.editor` slot (a root-scope single slot declared ONLY by
 * @corum/corum-ide-ui, IDE mode only).
 *
 * 真实文件读写（2026-09-04）：EditorColumn 管理已打开文件 tab 列表 + 活跃 tab
 * 的 Monaco 编辑器。文件内容经 corumFs/read RPC 加载、⌘S 经 corumFs/write
 * 保存。dirty 跟踪 = Monaco onChange 后内容与原始内容比对。状态栏显示真实
 * 行/列/编码/语言/dirty。
 *
 * 卡内结构：editor-main（Tabs → crumb → Code → Status）+ sash + divider +
 * 资源管理器子面板（ExplorerPane）。折叠态资源管理器完全消失，编辑器占满。
 *
 * @module corum-desktop/client/editor/EditorColumn
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PanelRightOpen, X } from 'lucide-react'
import type {} from '@corum/corum-ide-ui/client'
import { MonacoEditor, languageFromPath } from './MonacoEditor.tsx'
import { ExplorerPane, type ExplorerPaneInjected, type FsEntry } from './ExplorerPane.tsx'
import css from './EditorColumn.module.css'

/** One open file tab. */
interface EditorTab {
  /** Relative path under the project root (e.g. '/src/index.ts'). */
  readonly path: string
  /** Display title (basename). */
  readonly title: string
  /** File content as loaded from disk. */
  content: string
  /** Language id for Monaco. */
  language: string
  /** Whether the user has unsaved edits (content differs from last saved). */
  dirty: boolean
  /** Load error (file not found / permission etc.). */
  error: string | null
}

/** 本插件的注入面（见 client/index.ts apply）。 */
export interface EditorColumnInjected {
  /** 关闭本区域（隐藏叶子，可在插件中心「视图管理」恢复）。 */
  closeRegion: () => void
  /** 点亮编辑器区域（打开文件时自动显示，取消默认隐藏）。 */
  showEditor: () => void
  /** 资源管理器子面板数据源 + generation 源（ExplorerPane 直通）。 */
  explorer: Pick<ExplorerPaneInjected, 'listDir' | 'generation'>
  /** 读文件内容（corumFs/read RPC）。 */
  readFile: (path: string) => Promise<{ ok: boolean; error?: { message?: string }; value?: { content: string; language: string } }>
  /** 写文件内容（corumFs/write RPC，⌘S 保存）。 */
  writeFile: (path: string, content: string) => Promise<{ ok: boolean; error?: { message?: string } }>
}

/** Full composed props of the root-scope editor slot. */
export type EditorColumnProps = PropsRuntime<'corum.editor'> & EditorColumnInjected

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
export function EditorColumn({ closeRegion, showEditor, explorer, readFile, writeFile }: EditorColumnProps): React.ReactElement {
  const dark = useDarkTheme()
  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT_WIDTH)
  const [explorerCollapsed, setExplorerCollapsed] = useState(false)
  const onToggleExplorerCollapsed = useCallback(() => {
    setExplorerCollapsed((prev) => !prev)
  }, [])

  // ── Tab management ──
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const activeTab = useMemo(() => tabs.find(t => t.path === activePath) ?? null, [tabs, activePath])
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 })

  /** Open a file tab (or switch to it if already open). Called by ExplorerPane click. */
  const openFile = useCallback(async (path: string) => {
    // 打开文件时自动点亮编辑器区域（取消默认隐藏）。
    showEditor()
    // Already open? Just activate.
    const existing = tabs.find(t => t.path === path)
    if (existing !== undefined) {
      setActivePath(path)
      return
    }
    // Create a placeholder tab, then load content.
    const title = path.split('/').pop() ?? path
    const newTab: EditorTab = {
      path,
      title,
      content: '',
      language: languageFromPath(path, 'plaintext'),
      dirty: false,
      error: null,
    }
    setTabs(prev => [...prev, newTab])
    setActivePath(path)
    try {
      const result = await readFile(path)
      if (result.ok && result.value !== undefined) {
        setTabs(prev => prev.map(t => t.path === path
          ? { ...t, content: result.value!.content, language: result.value!.language || t.language }
          : t,
        ))
      } else {
        const msg = result.error?.message ?? '读取失败'
        setTabs(prev => prev.map(t => t.path === path ? { ...t, error: msg } : t))
      }
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === path ? { ...t, error: String(err) } : t))
    }
  }, [tabs, readFile])

  /** Close a tab. If it was active, activate the previous tab (or none). */
  const closeTab = useCallback((path: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.path === path)
      if (idx < 0) return prev
      const next = prev.filter(t => t.path !== path)
      // If closing the active tab, switch to the neighbour.
      if (activePath === path) {
        const neighbour = next[idx] ?? next[idx - 1] ?? null
        setActivePath(neighbour?.path ?? null)
      }
      return next
    })
  }, [activePath])

  /** Update content when the user types in Monaco (dirty tracking). */
  const onContentChange = useCallback((newContent: string) => {
    if (activePath === null) return
    setTabs(prev => prev.map(t => {
      if (t.path !== activePath) return t
      // dirty = content differs from the last-saved snapshot.
      // On first load, content === t.content, so dirty stays false until the user edits.
      // We compare against the content that was loaded (before any local edits).
      // Since we set t.content to the loaded value, any deviation = dirty.
      return { ...t, content: newContent, dirty: true }
    }))
  }, [activePath])

  /** Save the active file (⌘S). */
  const saveActive = useCallback(async () => {
    if (activeTab === null || activeTab.dirty === false) return
    try {
      const result = await writeFile(activeTab.path, activeTab.content)
      if (result.ok) {
        setTabs(prev => prev.map(t => t.path === activeTab.path ? { ...t, dirty: false } : t))
      } else {
        console.error('[editor] 保存失败', result.error?.message)
      }
    } catch (err) {
      console.error('[editor] 保存异常', err)
    }
  }, [activeTab, writeFile])

  // ⌘S keyboard shortcut for save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void saveActive()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [saveActive])

  // Sash drag (resource manager width).
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

  // The Monaco model for the active tab.
  const monacoFile = useMemo(() => {
    if (activeTab === null) return null
    return {
      path: activeTab.path,
      value: activeTab.content,
      language: activeTab.language,
    }
  }, [activeTab])

  return (
    <div className={css.column} data-code-editor-column="">
      <div className={css.editorMain}>
        {/* Editor Tabs */}
        <div className={css.tabs}>
          {tabs.map((tab) => (
            <div
              key={tab.path}
              className={`${css.tab}${tab.path === activePath ? ` ${css.tabActive}` : ''}`}
              data-tab-active={tab.path === activePath || undefined}
              onClick={() => setActivePath(tab.path)}
            >
              {tab.dirty && <span className={css.tabDirty} />}
              <span className={css.tabTitle}>{tab.title}</span>
              <button
                type="button"
                className={css.tabCloseBtn}
                title="关闭"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.path) }}
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          ))}
          <div className={css.spacer} />
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

        {/* crumb */}
        <div className={css.crumb}>
          {activeTab !== null ? activeTab.path.replace(/^\//, '').replace(/\//g, ' › ') : ''}
        </div>

        {/* Code */}
        <div className={css.code}>
          {monacoFile !== null
            ? (
              <MonacoEditor
                file={monacoFile}
                dark={dark}
                className="corum-code-editor"
                editable
                onContentChange={onContentChange}
                onCursorChange={setCursorPos}
              />
            )
            : (
              <div className={css.emptyCode}>选择或打开一个文件开始编辑</div>
            )}
        </div>
        {activeTab?.error !== undefined && activeTab.error !== null && (
          <div className={css.loadError}>加载失败：{activeTab.error}</div>
        )}

        {/* Editor Status */}
        <div className={css.status}>
          {activeTab !== null && (
            <>
              <span>行 {cursorPos.line}, 列 {cursorPos.column}</span>
              <span>UTF-8</span>
              <span>{activeTab.language}</span>
              <div className={css.statusSpacer} />
              {activeTab.dirty && (
                <>
                  <span className={css.dirtyDot} />
                  <span className={css.dirtyText}>未保存</span>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Sash + divider + explorer (hidden when collapsed). */}
      {!explorerCollapsed && (
        <>
          <div className={css.sash} onMouseDown={onSashMouseDown} data-explorer-sash="" />
          <div className={css.divider} />
          <div className={css.explorerPane} style={{ width: explorerWidth }}>
            <ExplorerPane
              listDir={explorer.listDir}
              generation={explorer.generation}
              closeRegion={closeRegion}
              onToggleCollapsed={onToggleExplorerCollapsed}
              onOpenFile={openFile}
            />
          </div>
        </>
      )}
    </div>
  )
}
