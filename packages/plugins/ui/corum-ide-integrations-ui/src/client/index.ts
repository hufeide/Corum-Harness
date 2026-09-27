/**
 * @corum/corum-ide-integrations-ui client half —— 集成中心 ·「插件」内容页
 * （design.pen yXkOK F1；PR5）。
 *
 * 交付物 = 一个**可注册的 React 页面组件** `PluginsPage`（GPT 式插件市场 +
 * 已装管理），本文件只负责把它挂到集成中心的父槽上。
 *
 * ## 边界（PR4 / PR5 分工）
 * 集成中心的**骨架**——活动栏「插件」图标点亮、全屏独占工作面、面板头（标题
 * 「集成中心」+ × 关闭）、左侧子导航（插件 / MCP 服务器 / 技能）、以及**父槽
 * 的声明**——全部属 PR4，不在本包范围内。本包只交付内容页 + 包骨架。
 *
 * ## 为什么挂载是注释掉的
 * 父槽名 `corum.integrations.plugins` 目前**在本仓还不存在**（PR4 尚未合入：
 * 全仓 grep 无任何 `corum.integrations` 声明者）。官方 `ctx.slots.inject(parent, …)`
 * 在父槽未声明时不会挂载，页面会静默不出现——这正是本 PR 期望的终态
 * （**包已加载、UI 不挂载**）。故 apply 里那段注入代码**先写好、整体注释掉**；
 * PR4 把父槽注册进 SlotMap 之后，把那几行的行注释标记去掉即可生效，本文件
 * 其它地方一行都不用改。
 *
 * ## 不在此声明 SlotMap 的原因（有意为之）
 * 槽契约（`declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }`）
 * 应由**声明方**（PR4 的骨架插件）登记：SlotMap 的同一个键在两处声明且
 * `owner` 类型不同是编译错（declaration merging 要求同名键同类型），本包抢先
 * 登记会让 PR4 合入时撞键。PR4 落地后应在本文件加一行 type-only 消费
 * （`import type {} from '<PR4 的骨架包>/client'`）把 holder 面拉进作用域。
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { registerSlot } from '@corum/corum-ui-base/client'
import { PluginsPage } from './PluginsPage.tsx'

// 页面本体的对外出口：挂载点（PR4 的骨架，或后续直接渲染本页的组合）从
// `@corum/corum-ide-integrations-ui/client` 取组件与它的 props 类型。
export { PluginsPage }
export type { PluginsPageProps, InstalledEntry, SearchResult } from './PluginsPage.tsx'

/**
 * 集成中心「插件」内容页的槽 key（占位名，PR4 的骨架声明同名父槽后生效）。
 *
 * 命名空间 `corum.integrations.*` 是集成中心的内容页槽域：`plugins`（本页）/
 * `mcp` / `skills`（后两页由各自 PR 交付）。
 */
export const INTEGRATIONS_PLUGINS_SLOT = 'corum.integrations.plugins'

/** 本页的注入面（父槽 occupant 注册时随 register 的 `inject` 面下发）。 */
export interface PluginsPageInjected {
  /** `pluginManager` 命名空间的 RPC caller（见 makePluginManagerCaller）。 */
  callRemote: <T>(method: string, args: Record<string, unknown>) => Promise<T>
}

/** Required services: the slots registry + the official connection rpc face. */
export const inject = ['slots', 'connection']

/**
 * 构造 `pluginManager` 命名空间的 RPC caller。
 *
 * 走官方 `connection.rpc.call('/api', 'pluginManager/<method>', { args })`
 * （0.1.2 起取代旧 host-apiproxy 桥），与 host 侧实现
 * （packages/desktop/src/host/plugin-manager.ts 的 `@Remote('方法名')`）一一对应：
 * `list` / `detail` / `setEnabled` / `install` / `uninstall` / `update` / `search`。
 *
 * 本函数是**活代码**（导出给 PR4 的挂载点或后续集成中心的页面直接复用），
 * 当前没有调用方——UI 挂载被注释掉，故 caller 也还投不出去。
 * @param connection - 官方 connection 服务句柄（client index 的 apply 取）。
 */
export function makePluginManagerCaller(connection: ConnectionHandle) {
  return async function callRemote<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const result = await connection.rpc.call('/api', `pluginManager/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}

/**
 * Client plugin body：自声明页面槽（C1），并在父槽就绪后把 PluginsPage 挂上去。
 *
 * 当前 apply 只做 C1 自声明（声明不影响任何清单——`visibility:'hidden'`），
 * 注入段有意注释（见模块注释「为什么挂载是注释掉的」）。
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // ── C1 插件自声明槽 ────────────────────────────────────────────────────
  // 本页不是网格区域（集成中心是全屏独占工作面，父槽由 PR4 的骨架持），故
  // visibility 'hidden'：注册表只记录，不进「添加区域」/视图管理清单。
  registerSlot(INTEGRATIONS_PLUGINS_SLOT, {
    label: '插件',
    defaultWeight: 400,
    visibility: 'hidden',
  })

  // ── 槽注入：PR4 注册父槽 `corum.integrations.plugins` 之后启用 ──────────
  //
  // 官方标准写法（同 @corum/corum-ide-panel-bottom-ui 挂 corum.panel）：
  //   父槽声明就绪 → slots.inject 回调触发 → slots.register 把页面组件 +
  //   注入面（callRemote）塞进父槽 occupant 位。
  //
  // ⚠️ PR4 合入后：删掉下面两行的注释标记（`// /*` 与 `// */` 去掉 `// `），
  //    并把 `PluginsPageInjected` 的 `callRemote` 接到本文件构造的 caller 上。
  //    ctx.effect 返回 disposer，插件卸载时自动摘除 occupant。
  //
  // const connection = ctx.get('connection') as ConnectionHandle
  // const callRemote = makePluginManagerCaller(connection)
  // ctx.effect(() => ctx.slots.inject(INTEGRATIONS_PLUGINS_SLOT, () => ctx.slots.register(
  //   {
  //     name: INTEGRATIONS_PLUGINS_SLOT,
  //     inject: (): PluginsPageInjected => ({ callRemote }),
  //   },
  //   PluginsPage,
  // )), 'ide-integrations: 集成中心「插件」页')
}
