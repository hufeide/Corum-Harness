/**
 * ExplorerPane — the IDE resource manager, embedded as a sub-pane inside the
 * merged ③ 编辑器区 card (design.pen WJ4dP, 2026-09-03 改版：编辑器+资源管理器
 * 合一张玻璃卡，不再是独立区域/槽位). Structure follows the design frame:
 *
 *   explorer-titlebar (kKDmJ: 标题「资源管理器」13/600 + spacer +
 *     btn-toggle-explorer 20×20 panel-right-close 16 +
 *     tb-close 20×20 x 17) —— 两个按钮始终显示；
 *   tree-header (WbdhK: chevron-down 17 + 根名 16/700 + file-plus/folder-plus/
 *     rotate-cw/list-collapse 四个 20×20 工具钮；× 已上移到 titlebar)；
 *   tree-body (QdSbb: VS Code 风格树，chevron + folder/file 类型着色图标 +
 *     每级 14px 缩进 + 选中态 glass-2 加粗).
 *
 * Data comes from the host fs RPC (corumFs/list, rooted at the host project
 * cwd) via the official connection.rpc; the tree-header root name rides the
 * connection generation's host facts (host cwd basename, when published).
 *
 * 第十六轮（2026-09-04）：
 * - expandedPaths 受控（EditorColumn 持有 + 持久化）；tab 激活自动展开父级。
 * - activeFilePath → 树选中同步 + scrollIntoView；树选中清空 → 通知 EditorColumn。
 * - refreshGen bump → 局部刷新所有已展开目录（watch/新建/删除/重命名触发）。
 * - 右键菜单（自绘玻璃菜单，design 无稿按 corum 菜单语言）：文件（打开/重命名/
 *   删除）；目录（新建文件/新建文件夹/重命名/删除/刷新）。重命名行内 input；
 *   删除由 EditorColumn confirm。
 * - tree-header 新建文件/文件夹钮接通（在选中目录下创建，未选中在根）。
 *
 * 折叠态（design waRkJ）由 EditorColumn 处理：折叠时不渲染本组件（无 32px
 * 竖条），展开/关闭按钮移入 Editor Tabs 行尾。本组件只负责展开态渲染。
 * @module corum-desktop/client/editor/ExplorerPane
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import {
  Braces, ChevronDown, ChevronRight, FileCode, FileCog, FilePlus, FileText,
  Folder, FolderOpen, FolderPlus, ListCollapse, Lock, PanelRightClose,
  RotateCw, Search, X,
} from 'lucide-react'
import css from './ExplorerPane.module.css'

/** One directory entry returned by corumFs/list. */
export interface FsEntry {
  name: string
  type: 'dir' | 'file'
}

/** Injected actions (see corum-desktop/src/client/index.ts apply). */
export interface ExplorerPaneInjected {
  listDir: (path: string) => Promise<{ ok: boolean; error?: { message?: string }; value?: { entries: FsEntry[] } }>
  /** 连接 generation 源（每次连接握手后发布；host.cwd basename = 工作区根名）。 */
  generation: ConnectionGenerationState
  /** 关闭整个编辑器区域（直通 ctx.layout.closeRegion('corum.editor')）。 */
  closeRegion: () => void
  /** 收起资源管理器子面板（design waRkJ：折叠 = 子面板完全消失）。 */
  onToggleCollapsed: () => void
  /** 点击文件 → 编辑器打开 tab（核心联动）。preview=斜体临时 tab；pin=固定已有预览。 */
  onOpenFile: (path: string, opts?: { preview?: boolean; pin?: boolean }) => void
  /** 编辑器当前激活文件路径（树选中同步 + scrollIntoView）。 */
  activeFilePath: string | null
  /** 展开的目录路径（受控，EditorColumn 持久化）。 */
  expandedPaths: readonly string[]
  /** 展开态变化（用户 chevron 点击）。 */
  onExpandedChange: (paths: string[]) => void
  /** 刷新生成号（watch/新建/删除/重命名 bump → 局部重载已展开目录）。 */
  refreshGen: number
  /** 新建文件（父目录 + 文件名）。 */
  onCreateFile: (parentDir: string, name: string) => void
  /** 新建文件夹（父目录 + 文件夹名）。 */
  onCreateFolder: (parentDir: string, name: string) => void
  /** 删除路径（EditorColumn confirm + tab 联动）。 */
  onDeletePath: (path: string, isDir: boolean) => void
  /** 重命名路径（EditorColumn RPC + tab 路径同步）。 */
  onRenamePath: (from: string, newName: string) => void
  /** 移动路径（跨目录拖拽；to = 完整目标路径）。 */
  onMovePath: (from: string, to: string) => void
}

export type ExplorerPaneProps = ExplorerPaneInjected

/** 工作区根名：generation host facts 里 cwd 的 basename，取不到时回退设计默认。 */
function rootNameFromGeneration(generationState: ConnectionGenerationState): string {
  const generation = generationState.getSnapshot()
  const host = generation?.host as { home?: unknown; cwd?: unknown } | undefined
  const cwd = host?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    const base = cwd.split(/[\\/]/).filter(Boolean).pop()
    if (base !== undefined && base !== '') return base
  }
  return 'dsh'
}

/** Join a relative path under the root ('/' = root). */
function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

/** 文件扩展名 → 类型着色图标（design ④ 文件图标着色规则）。 */
function FileTypeIcon({ name }: { name: string }) {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const base = dot > 0 ? lower.slice(0, dot) : lower
  const ext = dot >= 0 ? lower.slice(dot) : ''
  const cls = css.fileIcon
  if (base === '.env' || ext === '.env' || lower.startsWith('.env')) {
    return <Lock size={18} strokeWidth={2} className={cls} data-tone="env" />
  }
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
      return <FileCode size={18} strokeWidth={2} className={cls} data-tone="code" />
    case '.md':
      return <FileText size={18} strokeWidth={2} className={cls} data-tone="md" />
    case '.json':
      return <Braces size={18} strokeWidth={2} className={cls} data-tone="json" />
    case '.yml':
    case '.yaml':
      return <FileCog size={18} strokeWidth={2} className={cls} data-tone="yml" />
    default:
      return <FileCode size={18} strokeWidth={2} className={cls} data-tone="code" />
  }
}

/** 右键菜单状态。 */
interface ContextMenuState {
  x: number
  y: number
  path: string
  isDir: boolean
}

/** 行内重命名状态。 */
interface RenamingState {
  path: string
  draft: string
}

/** The resource manager sub-pane (see module doc). */
export function ExplorerPane({ listDir, generation, closeRegion, onToggleCollapsed, onOpenFile, activeFilePath, expandedPaths, onExpandedChange, refreshGen, onCreateFile, onCreateFolder, onDeletePath, onRenamePath, onMovePath }: ExplorerPaneProps) {
  const [rootEntries, setRootEntries] = useState<FsEntry[] | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  useSyncExternalStore(generation.subscribe, generation.getSnapshot)
  const rootName = rootNameFromGeneration(generation)
  /** Path → children entries cache (lazy; undefined key = not loaded). */
  const [dirCache, setDirCache] = useState<Record<string, FsEntry[] | undefined>>({})
  /** 展开集合（受控 prop 的本地 Set 镜像，便于 O(1) 查询）。 */
  const expanded = new Set(expandedPaths)
  /** Paths with an in-flight load (avoid duplicate fetches). */
  const [loading, setLoading] = useState<Set<string>>(() => new Set())
  /** 右键菜单。 */
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  /** 行内重命名。 */
  const [renaming, setRenaming] = useState<RenamingState | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  /** 树容器（scrollIntoView 作用域 + 键盘导航 focus）。 */
  const treeBodyRef = useRef<HTMLDivElement | null>(null)
  /** 多选集合（⌘Click 切换 / ⇧Click 范围选；键盘导航的「焦点」= 最后选中项）。 */
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  /** 范围选锚点（⇧Click 的起点）。 */
  const anchorRef = useRef<string | null>(null)
  /** 拖拽移动中的路径。 */
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const loadDir = useCallback((path: string): void => {
    setLoading((prev) => new Set(prev).add(path))
    listDir(path).then((result) => {
      setDirCache((c) => ({ ...c, [path]: result.ok ? result.value?.entries : undefined }))
      if (path === '/') {
        if (result.ok && result.value !== undefined) {
          setRootEntries(result.value.entries)
          setRootError(null)
        } else {
          setRootError(result.error?.message ?? '无法读取项目根目录')
        }
      }
    }).catch(() => {
      setDirCache((c) => ({ ...c, [path]: undefined }))
    }).finally(() => {
      setLoading((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    })
  }, [listDir])

  const loadRoot = useCallback((): void => {
    loadDir('/')
  }, [loadDir])

  // Load the project root once.
  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  // refreshGen bump → 重载根 + 所有已展开目录（局部刷新）。
  const refreshGenRef = useRef(refreshGen)
  useEffect(() => {
    if (refreshGen === refreshGenRef.current) return
    refreshGenRef.current = refreshGen
    loadDir('/')
    for (const p of expandedPaths) {
      loadDir(p)
    }
  }, [refreshGen, expandedPaths, loadDir])

  const toggle = useCallback((path: string): void => {
    const next = new Set(expandedPaths)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      // 未缓存才加载
      if (dirCache[path] === undefined) {
        loadDir(path)
      }
    }
    onExpandedChange(Array.from(next))
  }, [expandedPaths, dirCache, loadDir, onExpandedChange])

  const collapseAll = useCallback((): void => {
    onExpandedChange([])
  }, [onExpandedChange])

  // tab 激活 → 树选中 scrollIntoView（选中态由 activeFilePath 直接驱动渲染）。
  useEffect(() => {
    if (activeFilePath === null || treeBodyRef.current === null) return
    const el = treeBodyRef.current.querySelector(`[data-tree-path="${CSS.escape(activeFilePath)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeFilePath])

  // 右键菜单：全局点击/Escape 关闭。
  useEffect(() => {
    if (contextMenu === null) return
    const onDown = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onDown)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onDown)
    }
  }, [contextMenu])

  // 重命名 input 自动 focus + 选中主名（不含扩展名）。
  useEffect(() => {
    if (renaming === null || renameInputRef.current === null) return
    const input = renameInputRef.current
    input.focus()
    const dot = renaming.draft.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : renaming.draft.length)
  }, [renaming])

  const commitRename = useCallback(() => {
    if (renaming === null) return
    const name = renaming.draft.trim()
    if (name !== '' && name !== renaming.path.split('/').pop()) {
      onRenamePath(renaming.path, name)
    }
    setRenaming(null)
  }, [renaming, onRenamePath])

  /** tree-header 新建钮：在选中目录（或根）下创建。 */
  const selectedDirForCreate = useCallback((): string => {
    if (activeFilePath !== null) {
      // 激活文件的父目录
      const idx = activeFilePath.lastIndexOf('/')
      return idx <= 0 ? '/' : activeFilePath.slice(0, idx)
    }
    return '/'
  }, [activeFilePath])

  // ── 新建行内输入（VS Code 语义：在目标目录下插一个 input 行；window.prompt
  // 在 Electron renderer 被禁用「prompt() is not supported」，不可用）。 ──
  const [creating, setCreating] = useState<{ parentDir: string; kind: 'file' | 'dir'; draft: string } | null>(null)
  const createInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (creating === null || createInputRef.current === null) return
    createInputRef.current.focus()
  }, [creating])
  const startCreate = useCallback((kind: 'file' | 'dir', parentDir: string) => {
    // 确保父目录展开（新建行要显示在其子级首位）
    if (parentDir !== '/' && !expanded.has(parentDir)) {
      onExpandedChange([...expandedPaths, parentDir])
    }
    setCreating({ parentDir, kind, draft: '' })
  }, [expanded, expandedPaths, onExpandedChange])
  const commitCreate = useCallback(() => {
    if (creating === null) return
    const name = creating.draft.trim()
    if (name !== '') {
      if (creating.kind === 'file') onCreateFile(creating.parentDir, name)
      else onCreateFolder(creating.parentDir, name)
    }
    setCreating(null)
  }, [creating, onCreateFile, onCreateFolder])

  // ── 树内搜索（VS Code filter：tree-header 下方搜索框，匹配名过滤可见节点）。 ──
  const [filterText, setFilterText] = useState('')
  const [showFilter, setShowFilter] = useState(false)
  const filterInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (showFilter && filterInputRef.current !== null) filterInputRef.current.focus()
  }, [showFilter])
  /** 过滤：空串 = 全显；非空 = 名称含子串（大小写不敏感）的节点 + 其所有祖先。 */
  const filterMatch = useCallback((name: string): boolean => {
    if (filterText === '') return true
    return name.toLowerCase().includes(filterText.toLowerCase())
  }, [filterText])
  /** 收集过滤态下的可见节点（匹配节点 + 其祖先目录全展开）。 */
  const filteredVisible = useCallback((): Set<string> | null => {
    if (filterText === '') return null
    const visible = new Set<string>()
    const walk = (parentPath: string, entries: FsEntry[]): boolean => {
      let anyChildMatch = false
      for (const e of entries) {
        const p = joinPath(parentPath, e.name)
        const selfMatch = filterMatch(e.name)
        let childMatch = false
        if (e.type === 'dir') {
          const children = dirCache[p]
          if (children !== undefined) childMatch = walk(p, children)
        }
        if (selfMatch || childMatch) {
          visible.add(p)
          anyChildMatch = true
        }
      }
      return anyChildMatch
    }
    if (rootEntries !== null) walk('/', rootEntries)
    return visible
  }, [filterText, rootEntries, dirCache, filterMatch])

  /** 可见节点扁平化（键盘导航 ↑↓ 用；按渲染序）。 */
  const flattenVisible = useCallback((): { path: string; isDir: boolean }[] => {
    const out: { path: string; isDir: boolean }[] = []
    const walk = (parentPath: string, entries: FsEntry[]) => {
      for (const e of entries) {
        const p = joinPath(parentPath, e.name)
        out.push({ path: p, isDir: e.type === 'dir' })
        if (e.type === 'dir' && expanded.has(p)) {
          const children = dirCache[p]
          if (children !== undefined) walk(p, children)
        }
      }
    }
    if (rootEntries !== null) walk('/', rootEntries)
    return out
  }, [rootEntries, dirCache, expanded])

  /** 键盘导航（↑↓ 移动 / → 展开或进子 / ← 折叠或回父 / Enter 打开 / F2 重命名 / Delete 删除）。 */
  const onTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const visible = flattenVisible()
    if (visible.length === 0) return
    // 焦点 = 多选集合的最后一项；无焦点 → 第一个
    const focusPath = selection.size > 0 ? Array.from(selection)[selection.size - 1] : visible[0].path
    const idx = visible.findIndex(v => v.path === focusPath)
    const cur = idx >= 0 ? visible[idx] : visible[0]
    const curIdx = idx >= 0 ? idx : 0
    const moveFocus = (next: string) => {
      setSelection(new Set([next]))
      anchorRef.current = next
      treeBodyRef.current?.querySelector(`[data-tree-path="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = visible[Math.min(curIdx + 1, visible.length - 1)]
        moveFocus(next.path)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const next = visible[Math.max(curIdx - 1, 0)]
        moveFocus(next.path)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        if (cur.isDir && !expanded.has(cur.path)) {
          toggle(cur.path)
        } else if (cur.isDir) {
          // 已展开 → 进第一个子
          const next = visible[curIdx + 1]
          if (next !== undefined && next.path.startsWith(`${cur.path}/`)) moveFocus(next.path)
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (cur.isDir && expanded.has(cur.path)) {
          toggle(cur.path)
        } else {
          // 回父目录
          const parent = cur.path.slice(0, cur.path.lastIndexOf('/'))
          if (parent !== '' && parent !== cur.path) moveFocus(parent === '' ? '/' : parent)
        }
        break
      }
      case 'Enter': {
        e.preventDefault()
        if (cur.isDir) toggle(cur.path)
        else onOpenFile(cur.path, { preview: false, pin: true })
        break
      }
      case 'F2': {
        e.preventDefault()
        setRenaming({ path: cur.path, draft: cur.path.split('/').pop() ?? '' })
        break
      }
      case 'Delete':
      case 'Backspace': {
        e.preventDefault()
        onDeletePath(cur.path, cur.isDir)
        break
      }
    }
  }, [flattenVisible, selection, expanded, toggle, onOpenFile, onDeletePath])

  /** 多选点击（⌘ 切换 / ⇧ 范围 / 普通单选）。 */
  const onNodeClick = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    if (e.metaKey || e.ctrlKey) {
      // ⌘Click 切换选中
      setSelection(prev => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
      anchorRef.current = path
      return
    }
    if (e.shiftKey && anchorRef.current !== null) {
      // ⇧Click 范围选（按可见序）
      const visible = flattenVisible()
      const a = visible.findIndex(v => v.path === anchorRef.current)
      const b = visible.findIndex(v => v.path === path)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelection(new Set(visible.slice(lo, hi + 1).map(v => v.path)))
        return
      }
    }
    // 普通单击：单选 + 行为（目录 toggle / 文件预览）
    setSelection(new Set([path]))
    anchorRef.current = path
    if (isDir) {
      toggle(path)
    } else {
      onOpenFile(path, { preview: true })
    }
  }, [flattenVisible, toggle, onOpenFile])

  /** 拖拽移动（拖到目录上 = 移入；拖到文件上 = 移到文件所在目录）。 */
  const onNodeDrop = useCallback((e: React.DragEvent, targetPath: string, targetIsDir: boolean) => {
    e.preventDefault()
    setDropTarget(null)
    if (dragPath === null || dragPath === targetPath) return
    // 不能拖到自己的子孙里
    if (targetPath.startsWith(`${dragPath}/`)) return
    const destDir = targetIsDir ? targetPath : targetPath.slice(0, targetPath.lastIndexOf('/'))
    const name = dragPath.split('/').pop() ?? ''
    const destPath = (destDir === '' || destDir === '/') ? `/${name}` : `${destDir}/${name}`
    if (destPath === dragPath) return
    onMovePath(dragPath, destPath)
    setDragPath(null)
  }, [dragPath, onMovePath])

  const filtered = filteredVisible()
  const renderNode = (path: string, entry: FsEntry, depth: number) => {
    // 过滤态：不在 filtered 集合内的节点不渲染
    if (filtered !== null && !filtered.has(path)) return null
    const isDir = entry.type === 'dir'
    // 过滤态强制展开（匹配项的祖先链全显）
    const isExpanded = filtered !== null ? true : expanded.has(path)
    const isSelected = activeFilePath === path || selection.has(path)
    const children = isDir ? dirCache[path] : undefined
    const isLoading = loading.has(path)
    const isRenaming = renaming?.path === path
    const isDropTarget = dropTarget === path
    return (
      <div key={path}>
        {isRenaming ? (
          <div className={css.renameRow} style={{ paddingLeft: 6 + depth * 14 }}>
            <span className={css.caretSpacer} />
            {isDir
              ? <Folder size={18} strokeWidth={2} className={css.dirIcon} />
              : <FileTypeIcon name={entry.name} />}
            <input
              ref={renameInputRef}
              className={css.renameInput}
              value={renaming.draft}
              onChange={(e) => setRenaming({ path: renaming.path, draft: e.target.value })}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setRenaming(null)
                // IME composition（中文输入 Enter 确认候选不误提交）
                if (e.key === 'Enter' && e.nativeEvent.isComposing) return
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ) : (
          <button
            type="button"
            className={`${css.node}${isSelected ? ` ${css.nodeSelected}` : ''}${isDropTarget ? ` ${css.nodeDropTarget}` : ''}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            data-tree-path={path}
            draggable
            onDragStart={(e) => {
              setDragPath(path)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', path)
            }}
            onDragEnd={() => { setDragPath(null); setDropTarget(null) }}
            onDragOver={(e) => {
              if (dragPath !== null && dragPath !== path && !path.startsWith(`${dragPath}/`)) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropTarget(path)
              }
            }}
            onDragLeave={() => { if (dropTarget === path) setDropTarget(null) }}
            onDrop={(e) => onNodeDrop(e, path, isDir)}
            onClick={(e) => onNodeClick(e, path, isDir)}
            onDoubleClick={() => {
              if (!isDir) {
                // 文件双击 → 固定 tab（取消预览态）
                onOpenFile(path, { preview: false, pin: true })
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setContextMenu({ x: e.clientX, y: e.clientY, path, isDir })
            }}
            title={entry.name}
          >
            {isDir
              ? (
                <span className={css.caret}>
                  {isExpanded ? <ChevronDown size={16} strokeWidth={2} /> : <ChevronRight size={16} strokeWidth={2} />}
                </span>
              )
              : <span className={css.caretSpacer} />}
            {isDir
              ? (isExpanded
                ? <FolderOpen size={18} strokeWidth={2} className={css.dirIcon} />
                : <Folder size={18} strokeWidth={2} className={css.dirIcon} />)
              : <FileTypeIcon name={entry.name} />}
            <span className={`${css.name}${isSelected ? ` ${css.nameSelected}` : ''}`}>{entry.name}</span>
            {isLoading && <span className={css.loading}>…</span>}
          </button>
        )}
        {isDir && isExpanded && children !== undefined && (
          <div>
            {/* 新建行（在本目录下创建时插入子级首位） */}
            {creating !== null && creating.parentDir === path && (
              <div className={css.renameRow} style={{ paddingLeft: 6 + (depth + 1) * 14 }}>
                <span className={css.caretSpacer} />
                {creating.kind === 'dir'
                  ? <Folder size={18} strokeWidth={2} className={css.dirIcon} />
                  : <FileCode size={18} strokeWidth={2} className={css.fileIcon} data-tone="code" />}
                <input
                  ref={createInputRef}
                  className={css.renameInput}
                  placeholder={creating.kind === 'dir' ? '文件夹名' : '文件名'}
                  value={creating.draft}
                  onChange={(e) => setCreating({ ...creating, draft: e.target.value })}
                  onBlur={commitCreate}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitCreate()
                    if (e.key === 'Escape') setCreating(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            )}
            {children.map(child => renderNode(joinPath(path, child.name), child, depth + 1))}
            {children.length === 0 && creating?.parentDir !== path && <div className={css.emptyDir}>空目录</div>}
          </div>
        )}
        {isDir && isExpanded && children === undefined && !isLoading && (
          <div className={css.emptyDir}>加载失败</div>
        )}
      </div>
    )
  }

  return (
    <div className={css.explorer}>
      {/* kKDmJ — explorer-titlebar（标题 + panel-right-close + ×）。 */}
      <div className={css.explorerTitlebar}>
        <span className={css.titlebarTitle}>资源管理器</span>
        <div className={css.titlebarSpacer} />
        <button
          type="button"
          className={css.tb}
          title="收起资源管理器"
          onClick={onToggleCollapsed}
        >
          <PanelRightClose size={16} strokeWidth={2} className={css.tbIconToggle} />
        </button>
        <button
          type="button"
          className={css.tb}
          title="关闭此区域（可在插件中心「视图管理」恢复）"
          onClick={closeRegion}
        >
          <X size={17} strokeWidth={2} className={css.tbIconClose} />
        </button>
      </div>
      {/* WbdhK — tree-header（chevron + 根名 + 4 个 20×20 工具钮）。 */}
      <div className={css.treeHeader}>
        <ChevronDown size={17} strokeWidth={2} className={css.headerChev} />
        <span className={css.headerRoot}>{rootName}</span>
        <button type="button" className={css.tb} title="新建文件" onClick={() => startCreate('file', selectedDirForCreate())}>
          <FilePlus size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="新建文件夹" onClick={() => startCreate('dir', selectedDirForCreate())}>
          <FolderPlus size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={`${css.tb}${showFilter ? ` ${css.tbActive}` : ''}`} title="搜索文件" onClick={() => { setShowFilter(v => !v); if (showFilter) setFilterText('') }}>
          <Search size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="刷新" onClick={loadRoot}>
          <RotateCw size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="折叠全部" onClick={collapseAll}>
          <ListCollapse size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
      </div>
      {/* 树内搜索框（VS Code filter：点击搜索钮展开/收起；Escape 清空并收起）。 */}
      {showFilter && (
        <div className={css.filterRow}>
          <input
            ref={filterInputRef}
            className={css.filterInput}
            placeholder="搜索文件名…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilterText('')
                setShowFilter(false)
              }
            }}
          />
        </div>
      )}
      {/* QdSbb — tree-body。 */}
      <div
        className={css.treeBody}
        ref={treeBodyRef}
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        data-tree-body=""
      >
        {rootError !== null && <div className={css.error}>{rootError}</div>}
        {rootEntries === null && rootError === null && <div className={css.emptyDir}>加载中…</div>}
        {/* 根目录新建行（在根下创建时插入首位） */}
        {creating !== null && creating.parentDir === '/' && (
          <div className={css.renameRow} style={{ paddingLeft: 6 }}>
            <span className={css.caretSpacer} />
            {creating.kind === 'dir'
              ? <Folder size={18} strokeWidth={2} className={css.dirIcon} />
              : <FileCode size={18} strokeWidth={2} className={css.fileIcon} data-tone="code" />}
            <input
              ref={createInputRef}
              className={css.renameInput}
              placeholder={creating.kind === 'dir' ? '文件夹名' : '文件名'}
              value={creating.draft}
              onChange={(e) => setCreating({ ...creating, draft: e.target.value })}
              onBlur={commitCreate}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitCreate()
                if (e.key === 'Escape') setCreating(null)
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
        {rootEntries?.map(entry => renderNode(joinPath('/', entry.name), entry, 0))}
      </div>
      {/* 右键菜单（自绘玻璃菜单，fixed 定位，挂在组件根；边缘翻转——
          靠近右/下边缘时菜单向左/上开，VS Code 语义）。 */}
      {contextMenu !== null && (
        <ContextMenuView state={contextMenu} onClose={() => setContextMenu(null)}>
          {contextMenu.isDir ? (
            <>
              <button type="button" className={css.contextMenuItem} onClick={() => { startCreate('file', contextMenu.path); setContextMenu(null) }}>新建文件</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { startCreate('dir', contextMenu.path); setContextMenu(null) }}>新建文件夹</button>
              <div className={css.contextMenuDivider} />
              <button type="button" className={css.contextMenuItem} onClick={() => { setRenaming({ path: contextMenu.path, draft: contextMenu.path.split('/').pop() ?? '' }); setContextMenu(null) }}>重命名</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { loadDir(contextMenu.path); setContextMenu(null) }}>刷新</button>
              <div className={css.contextMenuDivider} />
              <button type="button" className={`${css.contextMenuItem} ${css.contextMenuDanger}`} onClick={() => { onDeletePath(contextMenu.path, true); setContextMenu(null) }}>删除</button>
            </>
          ) : (
            <>
              <button type="button" className={css.contextMenuItem} onClick={() => { onOpenFile(contextMenu.path); setContextMenu(null) }}>打开</button>
              <div className={css.contextMenuDivider} />
              <button type="button" className={css.contextMenuItem} onClick={() => { setRenaming({ path: contextMenu.path, draft: contextMenu.path.split('/').pop() ?? '' }); setContextMenu(null) }}>重命名</button>
              <button type="button" className={`${css.contextMenuItem} ${css.contextMenuDanger}`} onClick={() => { onDeletePath(contextMenu.path, false); setContextMenu(null) }}>删除</button>
            </>
          )}
        </ContextMenuView>
      )}
    </div>
  )
}

/** 右键菜单容器（边缘翻转：靠近右/下边缘时向左/上开，VS Code 语义）。
 *  挂载后测实际宽高再定位（避免首次渲染飞屏）。 */
function ContextMenuView({ state, onClose, children }: { state: ContextMenuState; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 右边缘溢出 → 向左开；下边缘溢出 → 向上开；钳制在视口内（8px 边距）。
    let left = state.x
    let top = state.y
    if (left + rect.width > vw - 8) left = Math.max(8, state.x - rect.width)
    if (top + rect.height > vh - 8) top = Math.max(8, state.y - rect.height)
    setPos({ left, top })
  }, [state])
  return (
    <div
      ref={ref}
      className={css.contextMenu}
      style={pos !== null ? { left: pos.left, top: pos.top } : { left: state.x, top: state.y, visibility: 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}
