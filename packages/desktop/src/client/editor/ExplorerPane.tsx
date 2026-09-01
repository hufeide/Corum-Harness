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
 * 折叠态（design waRkJ）由 EditorColumn 处理：折叠时不渲染本组件（无 32px
 * 竖条），展开/关闭按钮移入 Editor Tabs 行尾。本组件只负责展开态渲染。
 * @module corum-desktop/client/editor/ExplorerPane
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
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
}

export type ExplorerPaneProps = ExplorerPaneInjected

/** 工作区根名：generation host facts 里 cwd 的 basename，取不到时回退设计默认。 */
function rootNameFromGeneration(generationState: ConnectionGenerationState): string {
  // 0.1.2 的 ConnectionHostInfo 只稳定携带 {home}（host 账户 home，供路径缩写
  // 显示），不再携带旧 hostDescription 的 cwd。仍按未知 shape 防御式读取：
  // 若未来 host facts 重新带上 cwd 即取之 basename；否则回退设计默认 'dsh'
  // （不用 home 的 basename——它不是项目根名，显示有误导性）。
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

/** The resource manager sub-pane (see module doc). */
export function ExplorerPane({ listDir, generation, closeRegion, onToggleCollapsed }: ExplorerPaneProps) {
  const [rootEntries, setRootEntries] = useState<FsEntry[] | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  // 订阅 generation 源（连接建立/替换/丢失时触发重算根名）。
  useSyncExternalStore(generation.subscribe, generation.getSnapshot)
  // 根名 = host facts 里 cwd 的 basename；连接前回退设计默认。
  const rootName = rootNameFromGeneration(generation)
  /** Path → children entries cache (lazy; undefined key = not loaded). */
  const [dirCache, setDirCache] = useState<Record<string, FsEntry[] | undefined>>({})
  /** Currently expanded directory paths. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  /** Paths with an in-flight load (avoid duplicate fetches). */
  const [loading, setLoading] = useState<Set<string>>(() => new Set())
  /** The selected node path (VS Code single-selection; '' = none). */
  const [selected, setSelected] = useState<string>('')

  const loadRoot = useCallback((): void => {
    listDir('/').then((result) => {
      if (result.ok && result.value !== undefined) {
        setRootEntries(result.value.entries)
        setRootError(null)
      } else {
        setRootError(result.error?.message ?? '无法读取项目根目录')
        setRootEntries(null)
      }
    }).catch((error: unknown) => {
      setRootError(String(error))
    })
  }, [listDir])

  // Load the project root once.
  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  const toggle = useCallback((path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        setDirCache((cache) => {
          if (cache[path] !== undefined) return cache
          setLoading((loadingSet) => new Set(loadingSet).add(path))
          listDir(path).then((result) => {
            setDirCache((c) => ({ ...c, [path]: result.ok ? result.value?.entries : undefined }))
          }).catch(() => {
            setDirCache((c) => ({ ...c, [path]: undefined }))
          }).finally(() => {
            setLoading((loadingSet) => {
              const nextLoading = new Set(loadingSet)
              nextLoading.delete(path)
              return nextLoading
            })
          })
          return cache
        })
      }
      return next
    })
  }, [listDir])

  const collapseAll = useCallback((): void => {
    setExpanded(new Set())
  }, [])

  const renderNode = (path: string, entry: FsEntry, depth: number) => {
    const isDir = entry.type === 'dir'
    const isExpanded = expanded.has(path)
    const isSelected = selected === path
    const children = isDir ? dirCache[path] : undefined
    const isLoading = loading.has(path)
    return (
      <div key={path}>
        <button
          type="button"
          className={`${css.node}${isSelected ? ` ${css.nodeSelected}` : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => {
            setSelected(path)
            if (isDir) toggle(path)
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
        <button type="button" className={css.tb} title="新建文件">
          <FilePlus size={17} strokeWidth={2} className={css.tbIcon} />
        </button>
        <button type="button" className={css.tb} title="新建文件夹">
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
      <div className={css.treeBody}>
        {rootError !== null && <div className={css.error}>{rootError}</div>}
        {rootEntries === null && rootError === null && <div className={css.emptyDir}>加载中…</div>}
        {rootEntries?.map(entry => renderNode(joinPath('/', entry.name), entry, 0))}
      </div>
    </div>
  )
}
