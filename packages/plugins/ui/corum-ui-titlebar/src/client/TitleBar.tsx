/**
 * TitleBar — 窗口顶部 40px 带子的**唯一 owner**（拖拽不变式见 TitleBar.module.css）。
 *
 * 按界面状态组合（「接收不同的界面事件来展示」）：
 *   - `variant='main'`：`[红绿灯让位 76][窗口控制按钮][填充拖拽带]`；
 *   - `variant='floating'`（浮窗自带顶栏）：让位收成 66（浮窗红绿灯位更靠左）。
 * 侧栏折叠（chrome.sidebarCollapsed）时只留「展开」按钮，其余按钮随侧栏一起隐藏
 * ——与 design.pen 状态③ 一致。
 *
 * 写法纪律：折叠/区域显隐都经 `ctx.layout`（跨 bundle 单例），本组件不持状态。
 */
import type { ReactNode } from 'react'
import { Columns2, PanelLeftClose, PanelLeftOpen, Terminal } from 'lucide-react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChromeState } from '@corum/corum-ide-ui/client'
import css from './TitleBar.module.css'

/** 本插件 client 半在 register 的 inject 工厂里下发的注入面。 */
export interface TitleBarInjected {
  /** 窗口 chrome 源（`ctx.layout.chromeSnapshot()` 投影，uSES 契约）。 */
  hooks: {
    chrome: {
      getSnapshot: () => ChromeState
      subscribe: (fn: () => void) => () => void
    }
  }
  /** 折叠 ⟷ 展开侧栏（直通 `ctx.layout.toggleSidebarCollapsed`）。 */
  toggleSidebarCollapsed: () => void
  /** 区域显隐切换（直通 `ctx.layout.toggleRegion`；面板=corum.editor、终端=corum.panel）。 */
  toggleRegion: (slot: string) => void
}

/** Composed props: 壳 renderSlot 下发的 owner 面 + 本插件注入面。 */
export type TitleBarProps = PropsRuntime<'corum.titlebar'> & InjectFace<TitleBarInjected>

/** 标题栏小图标按钮（design.pen titlebar-icon-btn CXMkA）：28×28 圆角 8、icon 18。 */
function IconButton({ icon, label, onClick }: {
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={css.iconBtn}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

/** The unified titlebar band (see module doc). */
export function TitleBar({ variant, useChrome, toggleSidebarCollapsed, toggleRegion }: TitleBarProps) {
  const sidebarCollapsed = useChrome(c => c.sidebarCollapsed)
  // 红绿灯让位宽：主窗 76 = 活动栏宽（两列上下对齐）；浮窗自带顶栏 66。
  const insetWidth = variant === 'floating' ? 66 : 76
  return (
    <div className={css.band} data-variant={variant}>
      {/* 左拖拽带（红绿灯让位区）：纯命中区，不放控件——见 CSS 的不变式。 */}
      <div
        className={css.dragInset}
        style={{ width: insetWidth }}
        data-drag-band={`${variant}:left-inset`}
        aria-hidden="true"
      />
      {/* 控件层：夹在两条拖拽带之间，显式 no-drag。 */}
      <div className={css.controls}>
        <IconButton
          icon={sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
          onClick={toggleSidebarCollapsed}
        />
        {!sidebarCollapsed && (
          <div className={css.actions}>
            <IconButton
              icon={<Columns2 size={18} />}
              label="显示/隐藏 编辑器+资源管理器"
              onClick={() => { toggleRegion('corum.editor') }}
            />
            <IconButton
              icon={<Terminal size={18} />}
              label="显示/隐藏 终端"
              onClick={() => { toggleRegion('corum.panel') }}
            />
          </div>
        )}
      </div>
      {/* 右填充拖拽带：吃掉剩余宽度（折叠态为 0）。 */}
      <div className={css.dragFill} data-drag-band={`${variant}:filler-right`} aria-hidden="true" />
    </div>
  )
}