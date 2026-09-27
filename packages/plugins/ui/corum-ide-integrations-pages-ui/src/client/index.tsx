/**
 * @corum/corum-ide-integrations-pages-ui client half —— 集成中心内容页（PR6）。
 *
 * 交付物：**两个页面组件**——`McpPage`（MCP 服务器列表/详情/添加三视图）与
 * `SkillsPage`（技能列表 + 详情 + 版本/绑定 + 导入）。二者原为设置中心的
 * `SettingsMcpSection` / `SettingsSkillsSection`，PR6 按信息架构调整「移出设置中心、
 * 成为集成中心的内容页」。
 *
 * ## 挂载（**等 PR4**，当前注释）
 *
 * 集成中心的**骨架（子导航壳）是 PR4 的事**：槽位声明权归骨架，本包只作 occupant。
 * 骨架落地后把下面两行登记为 live 代码即可（`ctx.slots.inject` 保证「声明先于注册」
 * 的时序，槽未声明时本包不会误注册）：
 *
 * ```tsx
 * const connection = ctx.get('connection') as ConnectionHandle
 * const rpc = makeCorumRpcCall(connection)   // @corum/corum-rpc-client/client
 * ctx.effect(() => ctx.slots.inject('corum.integrations.mcp', () => ctx.slots.register(
 *   { name: 'corum.integrations.mcp', id: 'integrations-mcp' },
 *   () => <IntegrationsRpcContext.Provider value={rpc}><McpPage /></IntegrationsRpcContext.Provider>,
 * )), 'ide-integrations: MCP 页')
 * ctx.effect(() => ctx.slots.inject('corum.integrations.skills', () => ctx.slots.register(
 *   { name: 'corum.integrations.skills', id: 'integrations-skills' },
 *   () => <IntegrationsRpcContext.Provider value={rpc}><SkillsPage /></IntegrationsRpcContext.Provider>,
 * )), 'ide-integrations: 技能页')
 * ```
 *
 * 槽名常量见 `./slots.ts` 的 `INTEGRATIONS_PAGE_SLOTS`（PR4 骨架据此声明子槽）。
 * 登记位置：`packages/desktop/cordis.ide.patch.yml` 的 insert 段 + `packages/desktop/package.json`
 * 的 dependencies（**加载不挂载**：本包在组合里加载、apply 不注册任何东西）。
 *
 * ## 与设置中心的关系（PR6 收口）
 *
 * 两个 section 已从 `@corum/corum-ide-ui` **移出**（不是复制）：`SettingsSections.tsx`
 * 的 `mcp` / `skills` 两条 SECTION_DEFS、两个 import、`settings-locales.ts` 的
 * `nav.mcp` / `nav.skills` 文案、以及 `SettingsSections.module.css` 里仅供两页使用的
 * 样式一并删除；设置页的「插件管理」「AI 润色」不受影响。
 *
 * @module corum-ide-integrations-pages-ui/client
 */
import { type Context as ClientContext } from '@deepseek-ai/cordis'

export { McpPage } from './McpPage.tsx'
export { SkillsPage } from './SkillsPage.tsx'
export { IntegrationsRpcContext, useIntegrationsRpc, GlassButton } from './face.tsx'
export { INTEGRATIONS_PAGE_SLOTS } from './slots.ts'
export type { IntegrationsPageOwnerProps } from './slots.ts'

/**
 * Required services：PR6 阶段为空。
 *
 * 骨架（PR4）落地、本包开始注册两个内容页后，这里要加 `'slots'` 与
 * `'connection'`——`slots` 给 `ctx.slots.inject/register`，`connection` 给
 * `makeCorumRpcCall(connection)` 构造页面用的 RPC 调用函数。现在不加：声明即硬依赖，
 * 空 apply 没有任何服务需求。
 */
export const inject: string[] = []

/**
 * Client plugin body —— PR6 阶段**有意为空**。
 *
 * 为什么不在这里兜底注册：`corum.integrations.*` 两个槽的**声明者是 PR4 的集成中心
 * 骨架**（声明 = 排他渲染权）。本包若抢先声明，PR4 骨架落地时会撞「already declared」；
 * 而 `ctx.slots.inject` 只在槽已声明时才注册，骨架未落地时**什么都不做**正是期望形态。
 * 故本阶段唯一的交付是「包可加载 + 页面组件可被骨架消费」，注册代码见模块头注释。
 *
 * @param ctx - client root context（本阶段不使用）。
 */
export function apply(_ctx: ClientContext): void {
  // 集成中心骨架（PR4）落地后，把模块头注释里的两行注册搬到这里。
  // 不要在这里声明 `corum.integrations.*`：声明权归骨架。
}
