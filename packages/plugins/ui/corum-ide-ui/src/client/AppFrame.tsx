/**
 * IdeAppFrame —— IDE 壳，注册进内建 'root' 槽。
 *
 * 布局 = 自由二维网格（GridView）+ 壳层的 details 抽屉：
 *
 *   ┌ ── GridView（默认四列：sidebar │ conversation │ editor │ explorer）── ┐
 *   │   模块标题拖到另一模块四边拆分 / 中心交换；窗格间 sash 拖拽；            │
 *   │   布局树持久化 localStorage。                                          │
 *   └ bottom panel（终端/待办/队列，corum.panel 槽，已在网格内）─────────────┘
 *   └ details（官方 ui-conversation 抽屉，按需右侧覆盖）─────────────────────┘
 *
 * 纯组件：一切经框架三份 share（runtime / render-slot / store）到达，不 import
 * cordis 或框架。几何求解已迁到 GridView 的分割树（grid.ts）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls `useSessions` into GlobalStandardProps (0.1.2 起由 ui-session 声明)。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// SessionListState 的结构类型（与 dsh-api-session-controller/client 同名类型同构；
// 包未直接依赖该 controller——结构窄化避免新增运行时依赖，见 AGENTS.md 红线 3）。
interface SessionListState {
  current?: string | undefined
  byId: Record<string, { blank?: boolean; displayTitle?: string; projectionValues?: unknown } | undefined>
}
import type { createLayoutStore } from './stores.ts'
import type { GridActions } from './service.ts'
import { Blocks, Columns2, FolderPlus, MessageCirclePlus, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, Terminal } from 'lucide-react'
import { GridView } from '@corum/corum-ui-base/client'
import {
  loadGrid, saveGrid, dropLeaf, resizeBranch, findLeafBySlot,
  rescaleGrid, setLeafHidden, addSlotAt, hiddenSlots,
  FloatingLayer, useFloatingLayer,
  type GridNode, type GridSlot, type DropZone,
} from '@corum/corum-ui-base/client'
import { IDE_GRID_SLOTS, IDE_GRID_STORAGE_KEY, IDE_TRANSPARENT_SLOTS, ideDefaultGrid } from './ide-layout.ts'
// fork（corum）：开发者模式开关（同 bundle 设置域，localStorage + 同 bundle 事件）。
import { useDeveloperMode } from './settings/developer-mode.ts'
import css from './AppFrame.module.css'

/**
 * 标题栏让位（design.pen L1：主窗口边距=0、titlebar-row 与 col-nav 间距=0）：
 * root row 各格内容顶部下移让位窗口标题栏浮层。
 *
 * 2026-09-10「顶栏归会话」后的取值 = `[40, 0, 0]`：
 *   - sidebar 格 offset=40——窗口控制（红绿灯让位 + 图标按钮）仍是窗口级浮层，
 *     只压在侧栏正上方，侧栏内容必须让位（标题栏底 40 + 卡片间距 0）。
 *   - conversation 格 offset=**0**——会话段已迁进会话级槽，该列上方不再有浮层，
 *     卡片顶到窗口顶；标题栏行本身也已收窄到侧栏右缘（不再覆盖对话区），
 *     故这里必须同步去让位，否则对话区顶部会白白空出 40px。
 *   - right-col 格 offset=0——编辑器/资源管理器/终端上方本来就无标题栏。
 * 沿 root row 的格序（sidebar, conversation, right-col）。
 */
const TITLEBAR_CLEARANCE: readonly number[] = [40, 0, 0]

// ── FloatingLayer 单例桥 ──
// AppFrame 组件树里 <FloatingLayer /> 是标题栏触发器的 sibling（Provider 在
// AppFrame 内部，标题栏拿不到 context）。但 openFloating/closeFloating 是
// FloatingLayer 内稳定的 useCallback（空依赖），提升为模块级单例供 AppFrame
// 使用；FloatingLayer 挂载时回填。应用只有一个 FloatingLayer，单例安全。
import type { FloatingLayerApi } from '@corum/corum-ui-base/client'
let floatingApiSingleton: FloatingLayerApi | null = null

/** 主题偏好（三态）。 */
type ThemePreference = 'light' | 'dark' | 'system'

/** 标题栏小图标按钮（design.pen titlebar-icon-btn CXMkA）：28×28 圆角 8，icon 13。 */
function NavIconButton({ icon, label, onClick, active }: {
  icon: ReactNode
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      className={css.navIconBtn}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-active={active || undefined}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

/**
 * 左列导航标题栏（design.pen「窗口标题栏」d8STsd，40px）：窗口不再有通栏
 * 标题栏，本栏放进左列 nav 顶部——左侧 84px 给 macOS 红绿灯让位（整行
 * app-region:drag），右侧一排图标按钮（no-drag）：折叠侧栏 / 切换编辑器+
 * 资源管理器 / 切换终端 / 插件中心 / 主题（浅↔深）/ 设置。设置触发器渲染
 * sidebar.settings 槽（SettingsShell 触发器+面板一体，面板 portal 到 body）。
 */
function NavTitleBar({ themePreference, onToggleTheme, onToggleSidebar, onTogglePanels, onToggleTerminal, onOpenPlugins, sidebarCollapsed, settingsSlot }: {
  themePreference: ThemePreference
  onToggleTheme: () => void
  onToggleSidebar: () => void
  onTogglePanels: () => void
  onToggleTerminal: () => void
  onOpenPlugins: () => void
  sidebarCollapsed: boolean
  settingsSlot: ReactNode
}) {
  const isDark = themePreference === 'dark'
  return (
    <div className={css.navTitleBar}>
      {/* 红绿灯让位 76px（系统圆点由 titleBarStyle:hiddenInset 保留，不自绘）。
          折叠态（design J0PbdL）：窗口标题栏缩 66 只留红绿灯，actions 全隐藏
          （各功能移到 56px 折叠轨）。 */}
      <span className={css.navTitleBarInset} />
      {!sidebarCollapsed && (
      <div className={css.navTitleBarActions}>
        {/* design.pen titlebar-actions 顺序：侧栏 / 面板 / 终端 / 主题 / 设置 / 插件。
            图标 18×18（design 2026-08-28 统一放大）、按钮 padding 5（28×28）；插件中心是带文字按钮（最后）。 */}
        <NavIconButton
          icon={<PanelLeftClose size={18} />}
          label="折叠侧栏"
          onClick={onToggleSidebar}
        />
        <NavIconButton icon={<Columns2 size={18} />} label="显示/隐藏 编辑器+资源管理器" onClick={onTogglePanels} />
        <NavIconButton icon={<Terminal size={18} />} label="显示/隐藏 终端" onClick={onToggleTerminal} />
        <NavIconButton
          icon={isDark ? <Moon size={18} /> : <Sun size={18} />}
          label={isDark ? '切换到浅色主题' : '切换到深色主题'}
          onClick={onToggleTheme}
          active={isDark}
        />
        {/* 设置触发器（sidebar.settings 槽）：覆盖宽按钮样式为小图标按钮。 */}
        <span className={css.navSettingsSeat}>{settingsSlot}</span>
        {/* 插件中心（design.pen action-插件中心 jyVpw）：blocks 18 + 「插件」文字 14px。 */}
        <button type="button" className={css.navPluginBtn} onClick={onOpenPlugins} title="插件中心" aria-label="插件中心">
          <Blocks size={18} />
          <span className={css.navPluginLabel}>插件</span>
        </button>
      </div>
      )}
    </div>
  )
}

/**
 * 侧栏折叠轨（design.pen L1 侧栏折叠态 J0PbdL 的 col-nav，56px 竖排图标栏）：
 * 侧栏被 GridView 收成 collapsedWidth=56 时 leaf 内渲染此轨，替代完整会话
 * 列表。按钮自上而下（design col-nav 9 钮）：
 *   展开侧栏 / 新会话 / 添加工作区 / 搜索 / 编辑器+资源管理器 / 终端 /
 *   插件 / 主题 / 设置。
 * 语义：前三个（新会话/添加工作区/搜索）是侧栏功能——折叠态点击 = 先展开
 * 侧栏（展开后对应功能在会话列表可用）；后五个直通 AppFrame 层动作。
 */
function SidebarRail({ onExpand, onTogglePanels, onToggleTerminal, onOpenPlugins, themePreference, onToggleTheme, settingsSlot }: {
  onExpand: () => void
  onTogglePanels: () => void
  onToggleTerminal: () => void
  onOpenPlugins: () => void
  themePreference: ThemePreference
  onToggleTheme: () => void
  settingsSlot: ReactNode
}) {
  const isDark = themePreference === 'dark'
  return (
    <div className={css.sidebarRail} role="toolbar" aria-label="侧栏（已折叠）" aria-orientation="vertical">
      {/* design y2rO2 btn-toggle：展开侧栏。 */}
      <button type="button" className={css.railBtn} title="展开侧栏" aria-label="展开侧栏" onClick={onExpand}>
        <PanelLeftOpen size={18} strokeWidth={2} />
      </button>
      {/* design YQ7Gd btn-new-session：新会话（折叠态 = 展开侧栏后新建）。 */}
      <button type="button" className={css.railBtn} title="新会话" aria-label="新会话" onClick={onExpand}>
        <MessageCirclePlus size={18} strokeWidth={2} />
      </button>
      {/* design DLZas btn-add-workspace：添加工作区（折叠态 = 展开侧栏）。 */}
      <button type="button" className={css.railBtn} title="添加工作区" aria-label="添加工作区" onClick={onExpand}>
        <FolderPlus size={18} strokeWidth={2} />
      </button>
      {/* design TMy4U btn-search：搜索（折叠态 = 展开侧栏）。 */}
      <button type="button" className={css.railBtn} title="搜索会话" aria-label="搜索会话" onClick={onExpand}>
        <Search size={18} strokeWidth={2} />
      </button>
      {/* design esTr5 btn-panels：显示/隐藏 编辑器+资源管理器。 */}
      <button type="button" className={css.railBtn} title="显示/隐藏 编辑器+资源管理器" aria-label="显示/隐藏 编辑器+资源管理器" onClick={onTogglePanels}>
        <Columns2 size={18} strokeWidth={2} />
      </button>
      {/* design iGETA btn-terminal：显示/隐藏 终端。 */}
      <button type="button" className={css.railBtn} title="显示/隐藏 终端" aria-label="显示/隐藏 终端" onClick={onToggleTerminal}>
        <Terminal size={18} strokeWidth={2} />
      </button>
      {/* design hNNOS btn-plugin：插件中心。 */}
      <button type="button" className={css.railBtn} title="插件中心" aria-label="插件中心" onClick={onOpenPlugins}>
        <Blocks size={18} strokeWidth={2} />
      </button>
      {/* design e4enT btn-theme：主题切换。 */}
      <button type="button" className={css.railBtn} title={isDark ? '切换到浅色主题' : '切换到深色主题'} aria-label="切换主题" aria-pressed={isDark} onClick={onToggleTheme}>
        {isDark ? <Moon size={18} strokeWidth={2} /> : <Sun size={18} strokeWidth={2} />}
      </button>
      {/* design ADqDw btn-settings：设置（sidebar.settings 槽触发器座位）。 */}
      <span className={css.railSettingsSeat}>{settingsSlot}</span>
    </div>
  )
}

/** IDE 布局持久化：绑定 IDE 存储 key 与默认布局（base 的 loadGrid/saveGrid 包装）。 */
const loadIdeGrid = (): GridNode => loadGrid(ideDefaultGrid, IDE_GRID_STORAGE_KEY)
const saveIdeGrid = (node: GridNode): void => saveGrid(node, IDE_GRID_STORAGE_KEY)

/**
 * The floating-window target: the slot key this window should mount alone,
 * read once from `?floating=<slotKey>`. Null in the main window.
 */
function floatingSlotKey(): string | null {
  if (typeof window === 'undefined') return null
  const key = new URLSearchParams(window.location.search).get('floating')
  return key === null || key === '' ? null : key
}

/** The slots a floating window may mount（= IDE_GRID_SLOTS 单一事实源，B2）。 */
const FLOATABLE_SLOTS: ReadonlySet<string> = new Set<string>(IDE_GRID_SLOTS)

/**
 * 运行时动态网格槽 → 官方 SlotMap renderSlot 的边界 helper（B2）。
 *
 * 网格 leaf 的 slot 是运行时宽 string（用户可拖入任意已注册槽、含本壳内建槽
 * 之外的动态插件槽），不在 renderSlot 的静态声明域（PropsRenderSlots 收窄的
 * SlotMap key 联合）内——官方签名不接 string，需在此边界做一次显式收窄。
 *
 * 这是全局唯一的 renderSlot 强转点（替代原散落 708/780 两处的内联强转）：强转
 * 收进 helper 内部，调用点零强转。收窄的安全性由两端兜底——① 内建槽名
 * （IDE_GRID_SLOTS）经 ide-layout.ts 的 `satisfies IdeGridSlot` 编译期校验，拼错/
 * 与 SlotMap 不对齐即编译错；② 动态插件槽未在 SlotMap 注册 occupant 时
 * renderSlot 返回 null，由调用方渲染「此区域暂无内容」空态（运行时兜底，不白屏）。
 *
 * @param renderSlot - AppFrame props 里 SlotMap 收窄版的 renderSlot（静态域）。
 * @param slot - 运行时宽 string 槽 key（网格 leaf / 浮动窗目标）。
 */
function renderDynamicSlot(
  renderSlot: AppFrameProps['renderSlot'],
  slot: string,
): ReactNode {
  // 边界收窄：宽 string → SlotMap key（唯一 as，理由见上注释）。
  const narrow = renderSlot as (key: string, owner: Record<string, never>) => ReactNode
  return narrow(slot, {})
}

/** The desktop preload bridge face this frame uses for floating windows. */
interface FloatingBridge {
  openFloating?: (slotKey: string) => Promise<unknown>
  onFloatingChange?: (cb: (slotKey: string, detached: boolean) => void) => () => void
}

/** 浮动窗的 Window Chrome 顶栏（系统拖拽区，app-region:drag）。 */
function FloatingChrome({ slotKey }: { slotKey: string }) {
  return (
    <div className={css.windowChrome}>
      {/* 系统红黄绿圆点由 titleBarStyle:'hidden' 保留在左上角，这里给它让位，
          不自绘（否则重叠）。标题/提示右移避开。 */}
      <span className={css.chromeTitle}>{slotKey}</span>
      <span className={css.chromeHint}>浮动窗 · 关闭即回到主窗口</span>
    </div>
  )
}

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'conversation' | 'details' | 'shell.overlay' | 'sidebar.settings' | 'corum.sidebar' | 'corum.editor' | 'corum.trajectory' | 'corum.tabStrip' | 'corum.panel'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & {
    /** 主题偏好选择器 hook（inject hooks.theme 绑定而来，selector 形式）。 */
    useTheme: <S>(sel: (p: ThemePreference) => S, eq?: (a: S, b: S) => boolean) => S
    /**
     * 主题偏好写入（直通 theme 服务）。
     *
     * 注：`remote` / `openSession` 两个注入面**已不再由本组件消费**——它们随会话段
     * 迁往 session-bar.tsx（会话顶栏槽 occupant 的注入面），改由 index.tsx 的
     * `ctx.slots.register` inject 工厂提供。本组件保留的是纯壳层（网格/侧栏/
     * 窗口控制）所需的面。
     */
    setTheme: (p: ThemePreference) => void
    /**
     * 插件中心触发（壳不持面板——业务 chrome 已拆出为
     * corum-ide-plugin-manager-ui 插件）：经 LayoutController.openPluginManager
     * → grid actions 订阅面通知，该插件认领并打开自己的 modal 面板（三-2
     * 服务化，原 CustomEvent 广播已退役）。
     */
    openPluginManager: () => void
    /**
     * 壳内部桥：根注册 inject 面下发的 attach 函数，把 AppFrame 的区域操作面
     * 经 attachGrid 挂进 LayoutController（AppFrame 是纯组件拿不到 cordis
     * 服务，靠这个 props 面反向连接；与 setTheme 同一注入模式）。
     */
    attachGridActions: (actions: GridActions) => void
  }

/** The IDE frame (see module doc). */
export function IdeAppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  useTheme,
  setTheme,
  openPluginManager: onOpenPluginManager,
  attachGridActions,
}: AppFrameProps) {
  const panels = useStore(s => s)
  // 当前会话 id（非 blank）——details 抽屉的会话切换复位用。
  const detailsSession = useSessions((s: SessionListState) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const themePreference = useTheme((p: ThemePreference) => p)
  // 会话标题/空态判定（isHero）已随会话段迁往 session-bar.tsx：那里由槽 occupant
  // 直接读 `useSessions` 投影（槽是会话作用域，自带 sessionId），本组件不再需要。
  const frameRef = useRef<HTMLDivElement | null>(null)
  // 网格变更订阅：插件中心面板的区域显隐列经 useSyncExternalStore 读
  // gridRef 投影；任何隐藏相关变更后调 notifyGridListeners() 刷新。
  const notifyGridListeners = useRef<() => void>(() => {})

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (grid rescale source).
  useEffect(() => {
    const el = frameRef.current
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const rect = el.getBoundingClientRect()
        frameBox.current = { width: Math.round(rect.width), height: Math.round(rect.height) }
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])
  const frameBox = useRef({ width: 0, height: 0 })

  // ── 自由二维网格（GridView）──
  // 工作台布局由 localStorage 持久化管理（combo 的插件集 / 启动参数由壳层
  // 进程级管理，不进入工作台 UI；combo 选择页在壳层）。
  const [grid, setGrid] = useState<GridNode>(() => loadIdeGrid())
  // 最新 grid 的镜像（事件桥等需要读最新树的回调用，避免闭包捕获过期值）。
  const gridRef = useRef<GridNode>(grid)
  gridRef.current = grid
  // 折叠槽位集的镜像（P2-2）：grid 数学（rescaleGrid/resizeBranch）与 GridView
  // 都要读折叠态，而折叠 state 声明在下方——用 ref 镜像让上方回调读到最新值。
  const collapsedRef = useRef<ReadonlySet<string>>(new Set())
  // saveGrid（JSON.stringify + setItem 同步阻塞主线程）在 sash 拖动/窗口
  // resize 的高频回调里会每帧跑——用 trailing debounce 落盘，UI 仍实时更新。
  const saveTimer = useRef<number | null>(null)
  const saveGridDebounced = useCallback((next: GridNode) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      saveIdeGrid(next)
    }, 300)
  }, [])
  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
  }, [])
  const onGridResize = useCallback((branchId: string, sashIndex: number, deltaFraction: number) => {
    setGrid((g) => {
      const next = resizeBranch(g, branchId, sashIndex, deltaFraction, undefined, collapsedRef.current)
      saveGridDebounced(next)
      return next
    })
  }, [saveGridDebounced])
  const onGridDrop = useCallback((sourceId: string, targetId: string, zone: DropZone) => {
    setGrid((g) => {
      // drop 可能包壳新分支（weights 暂为占位值）——drop 后立即按当前 frame
      // 尺寸重标定，让所有 weights 归一到合法像素，避免新格塌陷成 1px。
      const dropped = dropLeaf(g, sourceId, targetId, zone)
      const { width, height } = frameBox.current
      const next = width > 0 && height > 0 ? rescaleGrid(dropped, width, height, collapsedRef.current) : dropped
      saveIdeGrid(next)
      return next
    })
    notifyGridListeners.current()
  }, [])
  // 关闭某区域（hidden，树保留，持久化）。
  const onCloseSlot = useCallback((slot: GridSlot) => {
    setGrid((g) => {
      const next = setLeafHidden(g, slot, true)
      saveIdeGrid(next)
      return next
    })
    notifyGridListeners.current()
  }, [])

  // 区域显隐（插件中心「显示/隐藏区域」、ctx.layout.setRegionHidden 到达）：
  // 统一走 setLeafHidden（树保留、持久化）。网格中尚无该 slot 的 leaf 时告警。
  const setRegionHidden = useCallback((slot: string, hidden: boolean) => {
    if (findLeafBySlot(gridRef.current, slot) === null) {
      console.warn(`[ide-shell] set-region-hidden: no grid leaf for slot "${slot}" (typo or already detached)`)
      return
    }
    setGrid((g) => {
      const next = setLeafHidden(g, slot, hidden)
      saveIdeGrid(next)
      return next
    })
    notifyGridListeners.current()
  }, [])

  // 侧栏 leaf 显隐切换（ctx.layout.toggleSidebar 到达；折叠 ⟷ 展开）。
  const toggleSidebarLeaf = useCallback(() => {
    setGrid((g) => {
      const leaf = findLeafBySlot(g, 'corum.sidebar')
      const next = setLeafHidden(g, 'corum.sidebar', !(leaf?.hidden === true))
      saveIdeGrid(next)
      return next
    })
  }, [])

  // 布局重置（ctx.layout.resetLayout 到达）：按当前 frame 尺寸重算默认布局
  // 并持久化（等价初次启动的几何）。
  const resetLayout = useCallback(() => {
    const { width, height } = frameBox.current
    const next = width > 0 && height > 0 ? rescaleGrid(ideDefaultGrid(), width, height, collapsedRef.current) : ideDefaultGrid()
    setGrid(next)
    saveIdeGrid(next)
    notifyGridListeners.current()
  }, [])

  // 区域显隐切换（供左列标题栏图标按钮）：toggle 一组 slot 的 hidden。
  // 整组「任一可见 → 全隐藏；全隐藏 → 全显示」，保证编辑器+资源管理器成组、
  // 终端/侧栏单独切换的语义统一。
  // 侧栏折叠（2026-08-28 重实现，design L1 侧栏折叠态 J0PbdL）：GridView 把
  // sidebar leaf 收成 56px 图标轨（collapsedWidth），leaf 内容换成竖排图标栏
  // （含展开按钮）。P2-2：折叠态只存本组件 state，经 COLLAPSED_SIDEBAR 显式传给
  // GridView 与 grid 数学（rescaleGrid/resizeBranch）——grid.ts 不再持模块级
  // 折叠 Set（ui-base 被各 bundle 内联，模块状态会按 bundle 分裂）。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const onToggleSidebar = useCallback(() => {
    setSidebarCollapsed(c => !c)
  }, [])
  // 传给 GridView 的折叠槽位集（useMemo 稳引用，折叠时才含 sidebar）。
  const COLLAPSED_SIDEBAR = useMemo<ReadonlySet<string>>(
    () => (sidebarCollapsed ? new Set(['corum.sidebar']) : new Set()),
    [sidebarCollapsed],
  )
  // 同步给上方 grid 数学用的 ref 镜像（渲染期赋值，与 gridRef 同款）。
  collapsedRef.current = COLLAPSED_SIDEBAR
  // 右侧两区域默认隐藏（2026-08-30 用户定调：编辑器/终端默认
  // 不展示——不只空态，进入项目/会话后也不显示；**只有点左上角快捷按钮
  // （面板/终端切换）才显示**，后续显示规则再定义）。userShown 记录用户
  // 手动点亮的区域（显示态），默认空 = 两区域全隐藏。
  // 2026-09-03 设计改版：资源管理器并入编辑器卡（子面板），不再是独立区域。
  // 2026-09-04 用户确认：启动后编辑器+资源管理器区域默认**不显示**（回到
  // 2026-08-30 定调）——DEFAULT_HIDDEN 含 corum.editor + corum.panel；
  // 点左上角「面板切换」快捷按钮（onTogglePanels → toggleRegionVisibility）
  // 点亮编辑器，「终端」钮点亮终端。
  const DEFAULT_HIDDEN = ['corum.editor', 'corum.trajectory', 'corum.panel'] as const
  const [userShown, setUserShown] = useState<ReadonlySet<string>>(new Set())
  // 开发者模式（同 bundle 设置域；与 AgentTitleBar 各自订阅，互不影响）。
  const developerMode = useDeveloperMode()
  // 快捷按钮显示某区域：移出 userShown 隐藏集（显示）+ 保证树里 hidden=false。
  const showRegion = useCallback((slots: readonly GridSlot[]) => {
    setUserShown((prev) => {
      const next = new Set(prev)
      for (const s of slots) next.add(s)
      return next
    })
    setGrid((g) => {
      let next = g
      for (const s of slots) next = setLeafHidden(next, s, false)
      saveIdeGrid(next)
      return next
    })
    notifyGridListeners.current()
  }, [saveIdeGrid])
  // 面板/终端切换：userShown 的开关——隐藏 → 点亮（showRegion）；显示 → 隐藏
  // （移出 userShown + 树 hidden=true 持久化）。
  const toggleRegionVisibility = useCallback((slots: readonly GridSlot[]) => {
    const anyShown = slots.some((s) => userShown.has(s))
    if (anyShown) {
      // 显示 → 隐藏：移出 userShown（回默认隐藏）+ 树 hidden=true 持久化。
      setUserShown((prev) => {
        const next = new Set(prev)
        for (const s of slots) next.delete(s)
        return next
      })
      setGrid((g) => {
        let next = g
        for (const s of slots) next = setLeafHidden(next, s, true)
        saveIdeGrid(next)
        return next
      })
      notifyGridListeners.current()
    } else {
      // 隐藏 → 显示。
      showRegion(slots)
    }
  }, [userShown, showRegion, saveIdeGrid])
  // fork（corum）：开发者模式关闭时收起轨迹区域——按钮是唯一开关，按钮消失后
  // 区域必须一起收起（否则用户无法关闭它）。
  useEffect(() => {
    if (!developerMode) onCloseSlot('corum.trajectory' as GridSlot)
  }, [developerMode, onCloseSlot])
  const onTogglePanels = useCallback(() => { toggleRegionVisibility(['corum.editor']) }, [toggleRegionVisibility])
  // 注：轨迹按钮的显隐开关（原 onOpenTrajectory）已随会话段迁往会话级槽——
  // 现经 GridActions.toggleRegion 暴露给 session-bar 的 occupant（见下方
  // gridActions 的 toggleRegion 与 service.ts 的 ILayout.toggleRegion）。
  const onToggleTerminal = useCallback(() => { toggleRegionVisibility(['corum.panel']) }, [toggleRegionVisibility])
  // 主题两态切换（浅↔深；system 态下按深处理，点击回浅色）。
  const onToggleTheme = useCallback(() => {
    setTheme(themePreference === 'dark' ? 'light' : 'dark')
  }, [setTheme, themePreference])

  // 插件中心面板的区域显隐投影：hidden 槽位集合（读最新 gridRef，供
  // PluginManagerPanel 的 useSyncExternalStore）。setGrid 后通知订阅者。
  const gridListeners = useRef(new Set<() => void>())
  const gridSubscribe = useCallback((listener: () => void) => {
    gridListeners.current.add(listener)
    return () => { gridListeners.current.delete(listener) }
  }, [])
  // uSES 快照缓存：hiddenSlots 每次新建数组会导致 getSnapshot 引用不稳
  // （React #185 无限重渲染）。按 gridRef 引用缓存，同一网格树复用同一快照。
  const hiddenCache = useRef<{ grid: GridNode | null; snap: readonly string[] }>({ grid: null, snap: Object.freeze([]) })
  const getHiddenSnapshot = useCallback((): readonly string[] => {
    const g = gridRef.current
    if (hiddenCache.current.grid !== g) {
      hiddenCache.current = { grid: g, snap: Object.freeze(hiddenSlots(g)) }
    }
    return hiddenCache.current.snap
  }, [])


  // ── ctx.layout 区域操作面（attachGrid）──
  // 「新建任务表单」信号：已挂载的空态监听者直推；未挂载（在会话视图）时
  // pending 标记留给 EmptyStateHero 挂载时认领（替代原 CustomEvent +
  // sessionStorage 桥，纯内存、单窗口语义不变）。
  const newTaskListeners = useRef(new Set<() => void>())
  const pendingNewTaskForm = useRef(false)
  const openNewTaskForm = useCallback(() => {
    if (newTaskListeners.current.size === 0) {
      pendingNewTaskForm.current = true
      return
    }
    for (const fn of newTaskListeners.current) fn()
  }, [])
  // 「打开插件中心」信号（统一事件中心三-2：原 corum:open-plugin-manager 跨
  // bundle CustomEvent + 双份字面量镜像服务化）：与 openNewTaskForm 同一
  // pending 模式——corum-ide-plugin-manager-ui 插件 apply 订阅时挂载认领，
  // 未挂载（插件禁用/尚未激活）时置 pending 不丢信号。
  const pluginManagerListeners = useRef(new Set<() => void>())
  const pendingPluginManager = useRef(false)
  const openPluginManagerSignal = useCallback(() => {
    if (pluginManagerListeners.current.size === 0) {
      pendingPluginManager.current = true
      return
    }
    for (const fn of pluginManagerListeners.current) fn()
  }, [])
  const gridActions = useMemo<GridActions>(() => ({
    setRegionHidden,
    closeRegion: onCloseSlot,
    // 点亮区域的单槽包装（LayoutController.showRegion → 本面）：清 userShown
    // 运行时隐藏 + 树 hidden 持久化，供「corum:open-in-editor」等可编程入口。
    showRegion: (slot) => { showRegion([slot as GridSlot]) },
    // 切换区域显隐的单槽包装（会话顶栏的轨迹按钮经本面回调；见 service.ts 注释）。
    toggleRegion: (slot) => { toggleRegionVisibility([slot as GridSlot]) },
    resetLayout,
    toggleSidebar: toggleSidebarLeaf,
    openNewTaskForm,
    onOpenNewTaskForm: (listener) => {
      newTaskListeners.current.add(listener)
      return () => { newTaskListeners.current.delete(listener) }
    },
    consumePendingNewTaskForm: () => {
      const pending = pendingNewTaskForm.current
      pendingNewTaskForm.current = false
      return pending
    },
    openPluginManager: openPluginManagerSignal,
    onOpenPluginManager: (listener) => {
      pluginManagerListeners.current.add(listener)
      // 挂载认领（与 EmptyStateHero consumePendingNewTaskForm 同语义，认领点
      // 收敛进订阅本身——消费端一个调用点，不会忘认领）。
      if (pendingPluginManager.current) {
        pendingPluginManager.current = false
        queueMicrotask(listener)
      }
      return () => { pluginManagerListeners.current.delete(listener) }
    },
    isInGrid: (slot) => findLeafBySlot(gridRef.current, slot) !== null,
    hiddenSlotsSnapshot: getHiddenSnapshot,
    onGridChange: gridSubscribe,
  }), [setRegionHidden, onCloseSlot, showRegion, toggleRegionVisibility, resetLayout, toggleSidebarLeaf, openNewTaskForm, openPluginManagerSignal, getHiddenSnapshot, gridSubscribe])
  // AppFrame 是纯组件拿不到 ctx.layout 服务实例——经根注册 inject 面下发的
  // attachGridActions 反向把操作面挂进 LayoutController，服务方法即可直连
  // 本组件的 grid actions（原 CustomEvent 事件桥全部退役）。
  useEffect(() => {
    attachGridActions(gridActions)
  }, [attachGridActions, gridActions])

  // 标题栏行（窗口控制）只覆盖侧栏正上方：宽度须跟随侧栏右缘（侧栏列宽随
  // GridView 动态变化——sash 拖拽/折叠/窗口 resize），这里测量实际几何驱动对齐。
  // 2026-09-10「顶栏归会话」后本行不再覆盖对话区，故只需侧栏右缘一个锚点
  // （会话段的锚点测量已随 session-bar 迁走，改为量自身宿主 <header>）。
  const [sidebarRight, setSidebarRight] = useState(296)
  useEffect(() => {
    let raf: number | null = null
    const measure = () => {
      raf = null
      // 量 GridView 的格（branchCell，宽度=列宽），不量 leaf（leaf 已被
      // leafTopOffset 下移让位标题栏，其 getBoundingClientRect 的 top 不是列顶）。
      // branchCell 是 .leaf 的父格——用 leaf 上溯一层命中。
      const sidebarLeaf = document.querySelector('[data-slot="corum.sidebar"]')
      const sidebar = sidebarLeaf?.parentElement ?? null
      if (sidebar !== null) setSidebarRight(Math.round(sidebar.getBoundingClientRect().right))
    }
    const schedule = () => { raf ??= requestAnimationFrame(measure) }
    // leaf 可能尚未挂载/布局变化——监听窗口 resize + 定期兜底测量。
    window.addEventListener('resize', schedule)
    schedule()
    const interval = window.setInterval(schedule, 400)
    return () => {
      window.removeEventListener('resize', schedule)
      window.clearInterval(interval)
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // 从面板拖入新区域到网格中某 leaf 的某侧。
  const onDropNewSlot = useCallback((slot: GridSlot, targetId: string, zone: DropZone) => {
    setGrid((g) => {
      const dropped = addSlotAt(g, slot, targetId, zone)
      const { width, height } = frameBox.current
      const next = width > 0 && height > 0 ? rescaleGrid(dropped, width, height) : dropped
      saveIdeGrid(next)
      return next
    })
  }, [])

  // 窗口尺寸变化时按比例重标定网格（自适应，不截断）。等比缩放各列。
  // 直接测 mainRow（网格的真实容器）——它已扣掉 frame padding 与纵向
  // gap；测 frame 再手扣会把 frame padding 算进网格高度，上下 split
  // （column 分支）时下方窗格会被 frame 的 overflow 裁掉。
  const mainRowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = mainRowRef.current
    if (el === null) return
    let raf: number | null = null
    let lastW = 0
    let lastH = 0
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const rect = el.getBoundingClientRect()
        const w = Math.round(rect.width)
        const h = Math.round(rect.height)
        if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) {
          lastW = w
          lastH = h
          frameBox.current = { width: w, height: h }
          setGrid((g) => {
            const next = rescaleGrid(g, w, h, collapsedRef.current)
            saveGridDebounced(next)
            return next
          })
        }
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [saveGridDebounced])

  // 插件中心面板已拆出壳（corum-ide-plugin-manager-ui 插件）：触发经 props
  // 的 openPluginManager（→ LayoutController → grid actions 订阅面 → 该插件
  // 开自己的 modal）。本组件不再 import/渲染 PluginManagerPanel。
  const openPluginManager = onOpenPluginManager

  const renderGridSlot = useCallback((slot: GridSlot): ReactNode => {
    if (slot === 'corum.sidebar') {
      // 侧栏（design.pen col-nav）：left-body 内的圆角 18 玻璃卡片（项目/任务双
      // 模式）。顶部贯通标题栏行（窗口标题栏 + Agent 标题栏）在 AppFrame 主 JSX
      // 渲染，不在此 leaf 内。折叠态（design J0PbdL）：leaf 被 GridView 收成
      // 56px，渲染竖排图标轨（含展开按钮），替代完整会话列表。
      if (sidebarCollapsed) {
        return (
          <SidebarRail
            onExpand={onToggleSidebar}
            onTogglePanels={onTogglePanels}
            onToggleTerminal={onToggleTerminal}
            onOpenPlugins={openPluginManager}
            themePreference={themePreference}
            onToggleTheme={onToggleTheme}
            settingsSlot={renderSlot('sidebar.settings', { wide: false })}
          />
        )
      }
      return (
        <div className={css.sidebarPane}>
          <div className={css.sidebarPaneBody}>
            {renderSlot('corum.sidebar', { wide: true, width: 280, expandSidebar: () => { /* grid mode: rail fold N/A */ } })}
          </div>
        </div>
      )
    }
    // 通用渲染：交给框架的 slot 系统（B2：经 renderDynamicSlot 边界 helper
    // 收窄动态槽 → SlotMap，见该 helper 注释）。未注册的 slot 返回 null → 空态。
    const content = renderDynamicSlot(renderSlot, slot)
    if (content === null || content === false) {
      return (
        <div className={css.emptySlot}>
          <span className={css.emptySlotText}>{slot}</span>
          <span className={css.emptySlotHint}>此区域暂无内容</span>
        </div>
      )
    }
    return content
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderSlot, themePreference, onToggleTheme, onToggleSidebar, onTogglePanels, onToggleTerminal, openPluginManager, sidebarCollapsed])
  const popOutSlot = useCallback((slot: GridSlot) => {
    const bridge = (window as unknown as { corumDesktop?: FloatingBridge }).corumDesktop
    void bridge?.openFloating?.(slot)
  }, [])

  // Detached slots（脱出到浮动窗）。**关键：脱出只是运行时状态，不动网格树、
  // 不写持久化**——树始终保持完整（所有槽位都在），下次启动布局原样恢复。
  const [detached, setDetached] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const bridge = (window as unknown as { corumDesktop?: FloatingBridge }).corumDesktop
    if (bridge?.onFloatingChange === undefined) return
    return bridge.onFloatingChange((slotKey, isDetached) => {
      setDetached((prev) => {
        const next = new Set(prev)
        if (isDetached) next.add(slotKey)
        else next.delete(slotKey)
        return next
      })
      // dock back（关闭浮动窗）时若该 leaf 曾被 hidden（detached 期间点了 ×），
      // 一并恢复显示——避免「detached + hidden」双隐藏导致区域彻底消失。
      if (!isDetached) {
        setGrid((g) => {
          const next = setLeafHidden(g, slotKey, false)
          saveIdeGrid(next)
          return next
        })
        notifyGridListeners.current()
      }
    })
  }, [])

  // 默认隐藏的三区域（detachedSlots 消费：运行时隐藏、不动树、不持久化）。
  // DEFAULT_HIDDEN/userShown 在上方 onTogglePanels 前声明；这里只算有效集合。
  const hiddenByDefault = useMemo<ReadonlySet<string>>(
    () => new Set(DEFAULT_HIDDEN.filter((s) => !userShown.has(s))),
    [userShown],
  )
  // 合并浮动窗 detached 与默认隐藏。
  const effectiveDetached = useMemo<ReadonlySet<string>>(
    () => new Set([...detached, ...hiddenByDefault]),
    [detached, hiddenByDefault],
  )
  // 右侧全隐藏时侧栏锁 300（2026-08-30 用户定调 A）：root row 只剩
  // sidebar+conversation 可见时，侧栏固定 300（不按 300:509 占比被拉宽），
  // 会话区占满剩余。lockedSlots 运行时锁定宽（不动 collapsedWidth 折叠轨）。
  // 折叠守卫（2026-08-31 PROGRESS 修复落地）：GridView 里 lockedSlots 优先于
  // collapsedSlots——用户主动折叠时必须从 lockedSlots 移除 sidebar，否则
  // collapsedWidth=56 永远被 300 压制（折叠失效，宽度仍 300）。
  const rightAllHidden = hiddenByDefault.size === DEFAULT_HIDDEN.length
  const lockedSlots = useMemo<ReadonlyMap<string, number>>(
    () => (rightAllHidden && !sidebarCollapsed ? new Map([['corum.sidebar', 300]]) : new Map()),
    [rightAllHidden, sidebarCollapsed],
  )

  // ── Floating-window mode ──
  const floatKey = floatingSlotKey()
  // 浮窗也必须接 grid actions——slot occupant（EditorColumn 等）挂载时经
  // ctx.layout 调 closeRegion/setRegionHidden，LayoutController.#requireGrid
  // 未接线会抛「grid actions not wired」把整个 slot entry 打崩（浮窗纯黑）。
  // 浮窗语义：closeRegion = 关浮窗回主窗（窗口自身关闭即 notifyFloating(false)
  // 恢复主窗列）；其余区域操作在浮窗无意义，no-op 兜底。
  //
  // **同步接线（渲染期，非 useEffect）**：slot occupant 的 effect（EditorColumn
  // 的 showEditor/restore tabs）与 AppFrame 的 effect 同批 flush，子组件 effect
  // 先于父组件跑——useEffect 接线太晚，occupant 的 #requireGrid 已在子 effect
  // 里抛错。渲染期同步 attach 保证 occupant 任何 effect 到达前已就位。
  // attachGridActions 是 LayoutController 的纯赋值（非 React setState），渲染期
  // 调用无副作用；useMemo 保证 floatingGridActions 引用稳定，幂等。
  const floatingGridActions = useMemo<GridActions>(() => ({
    setRegionHidden: (_slot: string, _hidden: boolean) => {},
    closeRegion: (_slot: string) => { window.close() },
    // 浮窗无 userShown/树 hidden 语义——点亮区域在浮窗无意义，no-op 兜底。
    // （会话顶栏的轨迹按钮在浮窗里也走这里：浮窗没有网格，点击静默无效。）
    showRegion: (_slot: string) => {},
    toggleRegion: (_slot: string) => {},
    resetLayout: () => {},
    toggleSidebar: () => {},
    openNewTaskForm: () => {},
    onOpenNewTaskForm: (_listener: () => void) => () => {},
    consumePendingNewTaskForm: () => false,
    // 浮窗无插件中心触发语义（主窗标题栏才有入口）——no-op 兜底（防 #requireGrid 抛错）。
    openPluginManager: () => {},
    onOpenPluginManager: (_listener: () => void) => () => {},
    isInGrid: (_slot: string) => false,
    hiddenSlotsSnapshot: () => [],
    onGridChange: (_listener: () => void) => () => {},
  }), [])
  if (floatKey !== null) {
    attachGridActions(floatingGridActions)
  }
  if (floatKey !== null) {
    const mountable = FLOATABLE_SLOTS.has(floatKey)
    return (
      <div className={css.floatingRoot} data-floating={floatKey}>
        <FloatingChrome slotKey={floatKey} />
        <div className={css.floatingBody}>
          {mountable
            ? renderDynamicSlot(renderSlot, floatKey)
            : <div className={css.floatingEmpty}>未知槽位：<code>{floatKey}</code>（可在 {[...FLOATABLE_SLOTS].join(' / ')} 中选择）</div>}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={frameRef}
      className={css.frame}
    >
      {/* 顶部标题栏行（design.pen titlebar-row，40px，整行 app-region:drag
          解决窗口拖拽余量）：absolute 浮层只覆盖左列（侧栏+对话区）上方——
          左段「窗口标题栏」（红绿灯让位 + 图标按钮，宽度跟随侧栏右缘）+ 右段
          「Agent 标题栏」（会话标题 + 状态胶囊 + 轨迹，b4p03B，假数据占位，
          覆盖对话区正上方）。right-col（编辑器/资源管理器/终端）顶到窗口顶，
          其上方无标题栏（下方 mainRow 占满 frame 全高，由 GridView 的
          leafTopOffset 给 sidebar/conversation 格让位本行）。 */}
      <div
        className={css.titlebarRow}
        /* 浮层宽度 = 侧栏右缘（2026-09-10 用户定调：会话段搬进
           conversation.session.header，本行只剩主窗口的窗口控制）。
           右侧（对话区/编辑器/终端上方）无浮层——纯内容区。 */
        style={{ right: 'auto', width: sidebarRight }}
      >
        {/* 窗口标题栏宽度跟随侧栏右缘（设计稿：覆盖侧栏正上方，侧栏拖拽时一起变）。
            该段整段 app-region:drag（窗口拖拽），内层按钮 no-drag。 */}
        <div className={css.titlebarDrag} style={{ width: sidebarRight, flex: 'none', display: 'flex' }}>
          <NavTitleBar
            themePreference={themePreference}
            onToggleTheme={onToggleTheme}
            onToggleSidebar={onToggleSidebar}
            onTogglePanels={onTogglePanels}
            onToggleTerminal={onToggleTerminal}
            onOpenPlugins={openPluginManager}
            sidebarCollapsed={sidebarCollapsed}
            settingsSlot={renderSlot('sidebar.settings', { wide: false })}
          />
        </div>
        {/* 会话段（会话标题 + 状态胶囊 + 常驻 Agent 胶囊 + 轨迹）已迁出本行
            （2026-09-10「顶栏归会话」）：现由 corum-ide-ui 的 session-bar 注册进
            会话级槽 `conversation.session.header.actions|utilities`，宿主是会话插件
            ConversationSessionHeader 的 titleRow——该行随会话视图渲染，会话拖出为
            独立窗口时自带顶栏（实测浮窗会恢复当前会话）。
            本行从此只剩**窗口控制**（红绿灯让位 + 全局图标按钮），宽度收到侧栏右缘。 */}
      </div>

      {/* Main Row —— 自由二维网格（GridView），顶到窗口顶（占满 frame 全高）。
          终端 corum.panel 已纳入网格（默认底部行），可调宽、可与其他区域自由
          组合。leafTopOffset 给 root row 的 sidebar/conversation 格内容下移
          54px（40 标题栏 + 14 间距）让位上方标题栏浮层；right-col 格 offset=0
          顶到容器顶（设计稿 left-col vs right-col 的顶部差异）。 */}
      <div className={css.mainRow} data-gridview ref={mainRowRef}>
        <GridView
          root={grid}
          renderSlot={renderGridSlot}
          onResize={onGridResize}
          onDrop={onGridDrop}
          onPopOut={popOutSlot}
          onDropNewSlot={onDropNewSlot}
          detachedSlots={effectiveDetached}
          transparentSlots={IDE_TRANSPARENT_SLOTS}
          leafTopOffset={TITLEBAR_CLEARANCE}
          collapsedSlots={COLLAPSED_SIDEBAR}
          lockedSlots={lockedSlots}
        />
      </div>

      {/* 次侧栏: official ui-conversation DetailsPanel (on-demand drawer). */}
      {panels.details > 0
        ? (
          <>
            <div className={css.detailsBackdrop} onClick={() => actions.closeDetails()} />
            <div className={css.detailsCol} style={{ width: panels.details }} data-details>
              {renderSlot('details', {})}
            </div>
          </>
        )
        : null}

      {/* Frame-wide floating layer (shell.overlay, 帧内浮层). */}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>

      {/* 全应用级悬浮层：未来的应用内通知 / 对话框（注册式）。portal 到
          document.body，脱离网格/卡片的 transform 与裁剪。设置面板已改由
          SettingsShell 自带 createPortal，不再经此层。 */}
      <FloatingLayer>
        {/* 回填模块级单例：AppFrame 在 Provider 外拿不到 useFloatingLayer，
            经桥接子组件（Provider 内）把稳定 API 写入单例供菜单用。 */}
        <FloatingApiBridge />
      </FloatingLayer>
    </div>
  )
}

/** Provider 内的桥接子组件：把 FloatingLayer API 回填到模块级单例。 */
function FloatingApiBridge() {
  const api = useFloatingLayer()
  useEffect(() => {
    floatingApiSingleton = api
    return () => { floatingApiSingleton = null }
  }, [api])
  return null
}
