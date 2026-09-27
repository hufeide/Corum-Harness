/**
 * 集成中心槽位契约（PR6）。
 *
 * 集成中心的内容页（MCP / 技能）由本包交付；**槽位声明权归 PR4 的集成中心骨架**
 * ——骨架在它自己的 `ctx.slots.register({ name: 'root', children: {...} })`
 * 里声明这两个洞，本包只作为 occupant 注册内容（`ctx.slots.inject` 保证时序）。
 *
 * 类型为什么住在这里：`corum-ui-settings-models` 同法——扩展槽的类型随
 * 「首先引入该槽的那个包」走。PR4 落地骨架时**不需要**再声明一次类型；若它也写了
 * 同一批键，只要类型逐字相同，TS 的接口合并是合法的（不同则报「Subsequent
 * property declarations must have the same type」——以本文件为准）。
 *
 * @module corum-ide-integrations-pages-ui/slots
 */
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 集成中心 · MCP 页（内容区；owner 面为空标记——页面自带全部数据面）。 */
    'corum.integrations.mcp': { kind: 'single'; scope: 'root'; owner: IntegrationsPageOwnerProps }
    /** 集成中心 · 技能页（内容区；owner 面为空标记）。 */
    'corum.integrations.skills': { kind: 'single'; scope: 'root'; owner: IntegrationsPageOwnerProps }
  }
}

/**
 * 集成中心内容页的 owner 面：**空标记**。
 *
 * 页面所需的 RPC 面经 `IntegrationsRpcContext` 下发（本包 `client/face.tsx`），
 * 不从 owner props 走——owner 面留给骨架将来要下发的壳级状态（如当前工作面），
 * 现在不预设任何字段，避免先占位再删。
 */
export interface IntegrationsPageOwnerProps {
  /** 标记字段：owner 面当前刻意为空。 */
  children?: never
}

/** 集成中心内容页的槽名（骨架声明、本包占用；单一事实源）。 */
export const INTEGRATIONS_PAGE_SLOTS = {
  mcp: 'corum.integrations.mcp',
  skills: 'corum.integrations.skills',
} as const satisfies Record<string, keyof SlotMap>
