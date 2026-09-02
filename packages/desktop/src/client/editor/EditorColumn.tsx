/**
 * EditorColumn — the resident right-hand code editor in IDE mode, the
 * MERGED ③ 编辑器区 card (design.pen cZcBX). Registered into the
 * `corum.editor` slot (a root-scope single slot declared ONLY by
 * @corum/corum-ide-ui, IDE mode only).
 *
 * 真实文件读写（2026-09-04）：EditorColumn 管理已打开文件 tab 列表 + 活跃 tab
 * 的 Monaco 编辑器。文件内容经 corumFs/read RPC 加载、⌘S 经 corumFs/write
 * 保存。状态栏显示真实行/列/编码/语言/dirty。
 *
 * P0 稳定性（2026-09-04 第十五轮）：dirty 以 savedContent 基线比对；Monaco
 * 模型按路径缓存；保存反馈（保存中/已保存/失败红字）；关闭 dirty tab 确认；
 * 空态隐藏 crumb/状态栏。
 *
 * 第十六轮（2026-09-04）：
 * - 编辑器状态持久化（localStorage `corum.ide.editor.v1`：tabs/activePath/
 *   explorerWidth/explorerCollapsed/expandedDirs，刷新恢复）。
 * - 文件树↔编辑器双向同步：激活 tab → 树选中 + 自动展开父级 + scrollIntoView；
 *   关闭 tab → 同步清树选中；树选中变化 → 通知 EditorColumn。
 * - fs watch：host @Remote watch + client 2s 轮询 pollChanges；变更 → 文件树
 *   局部刷新；已打开 tab 内容外部变更 → 未 dirty 自动重载 / 已 dirty 状态栏
 *   警告「磁盘已更改」。
 * - 新建文件/文件夹：tree-header 两钮 + 右键菜单接通（mkdirp/write 空文件 +
 *   自动刷新 + 新文件直接打开）。
 * - 右键菜单：文件（打开/重命名/删除）+ 目录（新建文件/新建文件夹/重命名/
 *   删除/刷新）。重命名行内 input；删除 window.confirm。
 * - write 自动建父目录（host 侧 mkdir recursive）。
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
import { ExplorerPane, type ExplorerPaneInjected } from './ExplorerPane.tsx'
import css from './EditorColumn.module.css'

/** One open file tab. */
interface EditorTab {
  /** Relative path under the project root (e.g. '/src/index.ts'). */
  readonly path: string
  /** Display title (basename). */
  readonly title: string
  /** Current in-editor content (may differ from savedContent while dirty). */
  content: string
  /** Baseline content as last loaded from / saved to disk. dirty = content !== savedContent. */
  savedContent: string
  /** Language id for Monaco. */
  language: string
  /** Load error (file not found / permission etc.). */
  error: string | null
  /** 磁盘上已被外部修改（watch 检测到）；仅在 dirty 时有意义（未 dirty 已自动重载）。 */
  externalChanged: boolean
}

/** 保存反馈（状态栏右侧短暂显示；失败常驻直到下次保存/编辑）。 */
type SaveFeedback =
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; message: string }
  | null

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
  /** 写文件内容（corumFs/write RPC，⌘S 保存；自动建父目录）。 */
  writeFile: (path: string, content: string) => Promise<{ ok: boolean; error?: { message?: string } }>
  /** 新建目录（corumFs/mkdir RPC，recursive）。 */
  mkdirp: (path: string) => Promise<{ ok: boolean; error?: { message?: string } }>
  /** 删除文件/目录（corumFs/delete RPC，目录递归）。 */
  deletePath: (path: string) => Promise<{ ok: boolean; error?: { message?: string } }>
  /** 重命名/移动（corumFs/rename RPC）。 */
  renamePath: (from: string, to: string) => Promise<{ ok: boolean; error?: { message?: string } }>
  /** 启动项目根递归 watch（幂等）。 */
  startWatch: () => Promise<{ ok: boolean; error?: { message?: string } }>
  /** 取走累积的变更事件（client 2s 轮询）。 */
  pollChanges: () => Promise<{ ok: boolean; error?: { message?: string }; value?: { changes: { path: string; kind: 'rename' | 'change' }[] } }>
}

/** Full composed props of the root-scope editor slot. */
export type EditorColumnProps = PropsRuntime<'corum.editor'> & EditorColumnInjected

/** 资源管理器子面板宽度边界（设计 210 默认；调宽区间 [160, 480]）。 */
const EXPLORER_DEFAULT_WIDTH = 210
const EXPLORER_MIN_WIDTH = 160
const EXPLORER_MAX_WIDTH = 480

/** localStorage 持久化键（编辑器视图状态，不含文件内容——内容启动时从磁盘重载）。 */
const STORAGE_KEY = 'corum.ide.editor.v1'

interface PersistedEditorState {
  /** 已打开 tab 路径（启动时 readFile 重载内容）。 */
  tabs: string[]
  /** 激活 tab 路径。 */
  activePath: string | null
  /** 资源管理器子面板宽度。 */
  explorerWidth: number
  /** 资源管理器折叠态。 */
  explorerCollapsed: boolean
  /** 文件树展开的目录路径。 */
  expandedDirs: string[]
}

function loadPersisted(): Partial<PersistedEditorState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    return JSON.parse(raw) as Partial<PersistedEditorState>
  } catch {
    return {}
  }
}

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
export function EditorColumn({ closeRegion, showEditor, explorer, readFile, writeFile, mkdirp, deletePath, renamePath, startWatch, pollChanges }: EditorColumnProps): React.ReactElement {
  const dark = useDarkTheme()
  const persisted = useMemo(loadPersisted, [])
  const [explorerWidth, setExplorerWidth] = useState(persisted.explorerWidth ?? EXPLORER_DEFAULT_WIDTH)
  const [explorerCollapsed, setExplorerCollapsed] = useState(persisted.explorerCollapsed ?? false)
  const onToggleExplorerCollapsed = useCallback(() => {
    setExplorerCollapsed((prev) => !prev)
  }, [])

  // ── Tab management ──
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(persisted.activePath ?? null)
  const activeTab = useMemo(() => tabs.find(t => t.path === activePath) ?? null, [tabs, activePath])
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 })
  /** Models of closed tabs to dispose (consumed once by MonacoEditor). */
  const [disposePaths, setDisposePaths] = useState<string[]>([])
  /** 保存反馈（每次保存动作重置；「已保存」1.6s 后自动消失）。 */
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback>(null)
  const saveFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashSaveFeedback = useCallback((next: SaveFeedback, autoClearMs?: number) => {
    if (saveFeedbackTimer.current !== null) {
      clearTimeout(saveFeedbackTimer.current)
      saveFeedbackTimer.current = null
    }
    setSaveFeedback(next)
    if (autoClearMs !== undefined) {
      saveFeedbackTimer.current = setTimeout(() => {
        setSaveFeedback(null)
        saveFeedbackTimer.current = null
      }, autoClearMs)
    }
  }, [])
  useEffect(() => () => {
    if (saveFeedbackTimer.current !== null) clearTimeout(saveFeedbackTimer.current)
  }, [])

  // 文件树展开的目录（持久化 + tab 激活自动展开）。
  const [expandedDirs, setExpandedDirs] = useState<string[]>(persisted.expandedDirs ?? [])
  // 文件树刷新生成号（watch / 新建 / 删除 / 重命名后 bump → ExplorerPane 重载受影响目录）。
  const [treeRefreshGen, setTreeRefreshGen] = useState(0)

  // ── 持久化（tabs/activePath/explorerWidth/explorerCollapsed/expandedDirs） ──
  useEffect(() => {
    const state: PersistedEditorState = {
      tabs: tabs.map(t => t.path),
      activePath,
      explorerWidth,
      explorerCollapsed,
      expandedDirs,
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // localStorage 写失败（隐私模式）不影响功能
    }
  }, [tabs, activePath, explorerWidth, explorerCollapsed, expandedDirs])

  // ── 启动时恢复持久化的 tabs（内容从磁盘重载） ──
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const paths = persisted.tabs ?? []
    if (paths.length === 0) return
    // 并发恢复所有 tab（内容 readFile 重载）
    for (const path of paths) {
      const title = path.split('/').pop() ?? path
      const placeholder: EditorTab = {
        path,
        title,
        content: '',
        savedContent: '',
        language: languageFromPath(path, 'plaintext'),
        error: null,
        externalChanged: false,
      }
      setTabs(prev => prev.some(t => t.path === path) ? prev : [...prev, placeholder])
      readFile(path).then((result) => {
        if (result.ok && result.value !== undefined) {
          setTabs(prev => prev.map(t => t.path === path
            ? { ...t, content: result.value!.content, savedContent: result.value!.content, language: result.value!.language || t.language }
            : t,
          ))
        } else {
          const msg = result.error?.message ?? '读取失败'
          setTabs(prev => prev.map(t => t.path === path ? { ...t, error: msg } : t))
        }
      }).catch((err) => {
        setTabs(prev => prev.map(t => t.path === path ? { ...t, error: String(err) } : t))
      })
    }
    // 有恢复的 tab → 点亮编辑器区域
    showEditor()
  }, [persisted.tabs, readFile, showEditor])

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
      savedContent: '',
      language: languageFromPath(path, 'plaintext'),
      error: null,
      externalChanged: false,
    }
    setTabs(prev => [...prev, newTab])
    setActivePath(path)
    try {
      const result = await readFile(path)
      if (result.ok && result.value !== undefined) {
        setTabs(prev => prev.map(t => t.path === path
          ? { ...t, content: result.value!.content, savedContent: result.value!.content, language: result.value!.language || t.language, externalChanged: false }
          : t,
        ))
      } else {
        const msg = result.error?.message ?? '读取失败'
        setTabs(prev => prev.map(t => t.path === path ? { ...t, error: msg } : t))
      }
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === path ? { ...t, error: String(err) } : t))
    }
  }, [tabs, readFile, showEditor])

  /** Close a tab. If dirty, confirm first (save / discard / cancel). */
  const closeTab = useCallback((path: string) => {
    const tab = tabs.find(t => t.path === path)
    if (tab === undefined) return
    if (tab.content !== tab.savedContent) {
      const ok = window.confirm(`「${tab.title}」有未保存的修改，关闭将丢弃这些修改。`)
      if (!ok) return
    }
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
    // Release the Monaco model for the closed tab (undo stack is dropped with it).
    setDisposePaths([path])
  }, [tabs, activePath])

  /** Update content when the user types in Monaco (dirty = differs from disk baseline). */
  const onContentChange = useCallback((newContent: string) => {
    if (activePath === null) return
    setTabs(prev => prev.map(t => {
      if (t.path !== activePath) return t
      if (t.content === newContent) return t
      return { ...t, content: newContent, externalChanged: false }
    }))
  }, [activePath])

  /** Save the active file (⌘S). */
  const saveActive = useCallback(async () => {
    if (activeTab === null) return
    if (activeTab.content === activeTab.savedContent) {
      flashSaveFeedback({ kind: 'saved' }, 1600)
      return
    }
    flashSaveFeedback({ kind: 'saving' })
    try {
      const result = await writeFile(activeTab.path, activeTab.content)
      if (result.ok) {
        setTabs(prev => prev.map(t => t.path === activeTab.path ? { ...t, savedContent: t.content, externalChanged: false } : t))
        flashSaveFeedback({ kind: 'saved' }, 1600)
      } else {
        const msg = result.error?.message ?? '未知错误'
        console.error('[editor] 保存失败', activeTab.path, msg)
        flashSaveFeedback({ kind: 'failed', message: msg })
      }
    } catch (err) {
      console.error('[editor] 保存异常', activeTab.path, err)
      flashSaveFeedback({ kind: 'failed', message: String(err) })
    }
  }, [activeTab, writeFile, flashSaveFeedback])

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

  // ── fs watch：启动 + 2s 轮询；变更 → 树刷新 + tab 外部变更检测 ──
  // tabsRef 避免 setInterval 闭包捕获陈旧 tabs
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  useEffect(() => {
    void startWatch()
    const timer = setInterval(async () => {
      try {
        const result = await pollChanges()
        if (!result.ok || result.value === undefined) return
        const changes = result.value.changes
        if (changes.length === 0) return
        setTreeRefreshGen(g => g + 1)
        // 已打开 tab 的外部变更检测
        for (const change of changes) {
          const p = change.path
          const tab = tabsRef.current.find(t => t.path === p)
          if (tab === undefined) continue
          if (tab.content === tab.savedContent) {
            // 未 dirty → 自动重载磁盘内容
            readFile(p).then((r) => {
              if (r.ok && r.value !== undefined) {
                setTabs(prev => prev.map(t => t.path === p
                  ? { ...t, content: r.value!.content, savedContent: r.value!.content, language: r.value!.language || t.language, externalChanged: false }
                  : t,
                ))
              }
            }).catch(() => { /* 文件可能已被删除，忽略 */ })
          } else {
            // dirty → 标记外部变更（状态栏警告，不覆盖用户编辑）
            setTabs(prev => prev.map(t => t.path === p ? { ...t, externalChanged: true } : t))
          }
        }
      } catch {
        // 轮询失败静默（下轮重试）
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [startWatch, pollChanges, readFile])

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

  const activeDirty = activeTab !== null && activeTab.content !== activeTab.savedContent

  // ── 文件树联动回调 ──
  /** 新建文件（tree-header 钮 / 右键菜单）：父目录下创建空文件并打开。 */
  const onCreateFile = useCallback(async (parentDir: string, name: string) => {
    const path = parentDir === '/' ? `/${name}` : `${parentDir}/${name}`
    const result = await writeFile(path, '')
    if (result.ok) {
      setTreeRefreshGen(g => g + 1)
      // 新文件直接打开
      void openFile(path)
    } else {
      console.error('[explorer] 新建文件失败', path, result.error?.message)
      window.alert(`新建文件失败：${result.error?.message ?? '未知错误'}`)
    }
  }, [writeFile, openFile])

  /** 新建文件夹。 */
  const onCreateFolder = useCallback(async (parentDir: string, name: string) => {
    const path = parentDir === '/' ? `/${name}` : `${parentDir}/${name}`
    const result = await mkdirp(path)
    if (result.ok) {
      setTreeRefreshGen(g => g + 1)
    } else {
      console.error('[explorer] 新建文件夹失败', path, result.error?.message)
      window.alert(`新建文件夹失败：${result.error?.message ?? '未知错误'}`)
    }
  }, [mkdirp])

  /** 删除文件/文件夹。若文件已打开，关闭其 tab。 */
  const onDeletePath = useCallback(async (path: string, isDir: boolean) => {
    const name = path.split('/').pop() ?? path
    const ok = window.confirm(`确定删除${isDir ? '文件夹' : '文件'}「${name}」？${isDir ? '目录内所有内容将被删除。' : ''}`)
    if (!ok) return
    const result = await deletePath(path)
    if (result.ok) {
      setTreeRefreshGen(g => g + 1)
      // 已打开的 tab（含目录下所有文件）关闭
      setTabs(prev => {
        const toClose = prev.filter(t => t.path === path || t.path.startsWith(`${path}/`))
        if (toClose.length > 0) {
          setDisposePaths(toClose.map(t => t.path))
          const remaining = prev.filter(t => !(t.path === path || t.path.startsWith(`${path}/`)))
          if (activePath !== null && !remaining.some(t => t.path === activePath)) {
            setActivePath(remaining[remaining.length - 1]?.path ?? null)
          }
          return remaining
        }
        return prev
      })
    } else {
      console.error('[explorer] 删除失败', path, result.error?.message)
      window.alert(`删除失败：${result.error?.message ?? '未知错误'}`)
    }
  }, [deletePath, activePath])

  /** 重命名文件/文件夹。已打开 tab 路径同步更新。 */
  const onRenamePath = useCallback(async (from: string, newName: string) => {
    const parent = from.slice(0, from.lastIndexOf('/'))
    const to = parent === '' ? `/${newName}` : `${parent}/${newName}`
    if (to === from) return
    const result = await renamePath(from, to)
    if (result.ok) {
      setTreeRefreshGen(g => g + 1)
      // 已打开 tab 路径同步（含目录下所有文件）
      setTabs(prev => prev.map(t => {
        if (t.path === from) {
          return { ...t, path: to, title: newName }
        }
        if (t.path.startsWith(`${from}/`)) {
          const newPath = to + t.path.slice(from.length)
          return { ...t, path: newPath, title: newPath.split('/').pop() ?? t.title }
        }
        return t
      }))
      setActivePath(prev => {
        if (prev === from) return to
        if (prev !== null && prev.startsWith(`${from}/`)) return to + prev.slice(from.length)
        return prev
      })
    } else {
      console.error('[explorer] 重命名失败', from, result.error?.message)
      window.alert(`重命名失败：${result.error?.message ?? '未知错误'}`)
    }
  }, [renamePath])

  /** tab 激活 → 文件树自动展开父级目录。 */
  useEffect(() => {
    if (activePath === null) return
    // 自动展开所有父级目录
    const parts = activePath.split('/').filter(Boolean)
    const parents: string[] = []
    for (let i = 1; i < parts.length; i++) {
      parents.push('/' + parts.slice(0, i).join('/'))
    }
    setExpandedDirs(prev => {
      const missing = parents.filter(p => !prev.includes(p))
      return missing.length > 0 ? [...prev, ...missing] : prev
    })
  }, [activePath])

  return (
    <div className={css.column} data-code-editor-column="">
      <div className={css.editorMain}>
        {/* Editor Tabs */}
        <div className={css.tabs}>
          {tabs.map((tab) => {
            const dirty = tab.content !== tab.savedContent
            return (
              <div
                key={tab.path}
                className={`${css.tab}${tab.path === activePath ? ` ${css.tabActive}` : ''}`}
                data-tab-active={tab.path === activePath || undefined}
                onClick={() => setActivePath(tab.path)}
                onAuxClick={(e) => {
                  // Middle-click closes the tab (VS Code semantics).
                  if (e.button === 1) {
                    e.preventDefault()
                    closeTab(tab.path)
                  }
                }}
              >
                {dirty && <span className={css.tabDirty} />}
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
            )
          })}
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

        {/* crumb（空态隐藏，不留占位） */}
        {activeTab !== null && (
          <div className={css.crumb}>
            {activeTab.path.replace(/^\//, '').replace(/\//g, ' › ')}
          </div>
        )}

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
                disposePaths={disposePaths}
              />
            )
            : (
              <div className={css.emptyCode}>选择或打开一个文件开始编辑</div>
            )}
        </div>
        {activeTab?.error !== undefined && activeTab.error !== null && (
          <div className={css.loadError}>加载失败：{activeTab.error}</div>
        )}

        {/* Editor Status（空态隐藏） */}
        {activeTab !== null && (
          <div className={css.status}>
            <span>行 {cursorPos.line}, 列 {cursorPos.column}</span>
            <span>UTF-8</span>
            <span>{activeTab.language}</span>
            {activeTab.externalChanged && activeDirty && (
              <span className={css.externalChangedText} title="磁盘上的文件已被外部修改；保存将覆盖磁盘版本">⚠ 磁盘已更改</span>
            )}
            <div className={css.statusSpacer} />
            {saveFeedback?.kind === 'saving' && <span className={css.savingText}>保存中…</span>}
            {saveFeedback?.kind === 'saved' && !activeDirty && <span className={css.savedText}>已保存</span>}
            {saveFeedback?.kind === 'failed' && (
              <span className={css.saveFailedText} title={saveFeedback.message}>保存失败：{saveFeedback.message}</span>
            )}
            {activeDirty && (
              <>
                <span className={css.dirtyDot} />
                <span className={css.dirtyText}>未保存</span>
              </>
            )}
          </div>
        )}
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
              activeFilePath={activePath}
              expandedPaths={expandedDirs}
              onExpandedChange={setExpandedDirs}
              refreshGen={treeRefreshGen}
              onCreateFile={onCreateFile}
              onCreateFolder={onCreateFolder}
              onDeletePath={onDeletePath}
              onRenamePath={onRenamePath}
            />
          </div>
        </>
      )}
    </div>
  )
}
