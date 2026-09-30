/**
 * @corum/corum-ui-titlebar client half —— 窗口顶部 40px 带子的**唯一 owner**。
 *
 * 占壳声明的根级槽 `corum.titlebar`：**声明权在 @corum/corum-ide-ui** 的 root 条目
 * children 表（声明 = 排他渲染权），本包只 `register` 同名条目并自带 inject 面。
 * owner props（variant / bandWidth / controlsWidth）由壳的 `renderSlot` 下发；
 * 本包经 inject 工厂补上 `ctx.layout` 的 chrome 源与写面。
 *
 * 为什么 inject 而不是把写面做成 owner props：写路径必须唯一（红线 1 / 本仓
 * 「服务收敛」纪律）——侧栏折叠与集成中心都收在 `ctx.layout` 的 chrome 状态里，
 * 活动栏便利入口与标题栏按钮写的是同一份；插件直接 inject 服务即可，不必再开
 * 一条 props 转发面（先例：corum-ide-sidebar-ui 的 `inject` 里已有 'layout'）。
 */
import { type Context as ClientContext } from '@deepseek-ai/cordis'
// type-only：把渲染器对 Context 的增强（ctx.slots / ctx.renderSlot 面）拉进本单元。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// type-only：把壳的 SlotMap 行（corum.titlebar 的 owner 契约）拉进本编译单元。
import type {} from '@corum/corum-ide-ui/client'
import { TitleBar, type TitleBarInjected } from './TitleBar.tsx'

/** Required services: the slots registry + the layout face (chrome 状态与区域显隐写面). */
export const inject = ['slots', 'layout']

/**
 * 占位注册：`ctx.slots.inject('corum.titlebar', …)` 保证「壳先声明、本包后注册」
 * 的时序（槽未声明时先挂起，声明后自动补注册）。
 * @param ctx - Client context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('corum.titlebar', () => ctx.slots.register(
      {
        name: 'corum.titlebar',
        inject: (): TitleBarInjected => ({
          hooks: { chrome: ctx.layout.chromeSnapshot() },
          toggleSidebarCollapsed: () => { ctx.layout.toggleSidebarCollapsed() },
          toggleRegion: (slot) => { ctx.layout.toggleRegion(slot) },
        }),
      },
      TitleBar,
    )),
    'ide-titlebar: corum.titlebar band',
  )
}