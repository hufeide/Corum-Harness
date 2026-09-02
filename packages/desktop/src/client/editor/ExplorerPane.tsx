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
  RotateCw, X,
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
  /** 点击文件 → 编辑器打开 tab（核心联动）。 */
  onOpenFile: (path: string) => void
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
export function ExplorerPane({ listDir, generation, closeRegion, onToggleCollapsed, onOpenFile, activeFilePath, expandedPaths, onExpandedChange, refreshGen, onCreateFile, onCreateFolder, onDeletePath, onRenamePath }: ExplorerPaneProps) {
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
  /** 树容器（scrollIntoView 作用域）。 */
  const treeBodyRef = useRef<HTMLDivElement | null>(null)

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

  const promptCreateFile = useCallback((parentDir: string) => {
    const name = window.prompt(`在 ${parentDir === '/' ? '根目录' : parentDir} 下新建文件：`, 'untitled.ts')
    if (name !== null && name.trim() !== '') onCreateFile(parentDir, name.trim())
  }, [onCreateFile])

  const promptCreateFolder = useCallback((parentDir: string) => {
    const name = window.prompt(`在 ${parentDir === '/' ? '根目录' : parentDir} 下新建文件夹：`, 'new-folder')
    if (name !== null && name.trim() !== '') onCreateFolder(parentDir, name.trim())
  }, [onCreateFolder])

  const renderNode = (path: string, entry: FsEntry, depth: number) => {
    const isDir = entry.type === 'dir'
    const isExpanded = expanded.has(path)
    const isSelected = activeFilePath === path
    const children = isDir ? dirCache[path] : undefined
    const isLoading = loading.has(path)
    const isRenaming = renaming?.path === path
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
            className={`${css.node}${isSelected ? ` ${css.nodeSelected}` : ''}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            data-tree-path={path}
            onClick={() => {
              if (isDir) {
                toggle(path)
              } else {
                // 文件 → 编辑器打开 tab
                onOpenFile(path)
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
            {children.map(child => renderNode(joinPath(path, child.name), child, depth + 1))}
            {children.length === 0 && <div className={css.emptyDir}>空目录</div>}
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
        <button type="button" className={css.tb} title="新建文件" onClick={() => promptCreateFile(selectedDirForCreate())}>
          <FilePlus size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="新建文件夹" onClick={() => promptCreateFolder(selectedDirForCreate())}>
          <FolderPlus size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="刷新" onClick={loadRoot}>
          <RotateCw size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="折叠全部" onClick={collapseAll}>
          <ListCollapse size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
      </div>
      {/* QdSbb — tree-body。 */}
      <div className={css.treeBody} ref={treeBodyRef}>
        {rootError !== null && <div className={css.error}>{rootError}</div>}
        {rootEntries === null && rootError === null && <div className={css.emptyDir}>加载中…</div>}
        {rootEntries?.map(entry => renderNode(joinPath('/', entry.name), entry, 0))}
      </div>
      {/* 右键菜单（自绘玻璃菜单，fixed 定位，挂在组件根）。 */}
      {contextMenu !== null && (
        <div
          className={css.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {contextMenu.isDir ? (
            <>
              <button type="button" className={css.contextMenuItem} onClick={() => { promptCreateFile(contextMenu.path); setContextMenu(null) }}>新建文件</button>
              <button type="button" className={css.contextMenuItem} onClick={() => { promptCreateFolder(contextMenu.path); setContextMenu(null) }}>新建文件夹</button>
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
        </div>
      )}
    </div>
  )
}
