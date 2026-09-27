/**
 * 集成中心内容页的**注入面**（PR6）。
 *
 * 这两个页面原先住在设置中心：`SettingsMcpSection` / `SettingsSkillsSection`
 * 经设置壳的 `shared.tsx` 取 `useCorumRpc()`（`CorumRpcContext`）与
 * `GlassButton`。PR6 把两个 section 从设置中心迁出为**集成中心内容页**，
 * 新包不能反向依赖设置壳的那个 Context（它会随壳一起被内联进每个 bundle），
 * 故这里自持一份**同形、更窄**的注入面：
 *
 * - `IntegrationsRpcContext`：与设置壳 `CorumRpcContext` 同形（`CorumRpcCall | null`），
 *   由本包 client 半（或 PR4 的集成中心壳）在挂载时 provide。
 * - `useIntegrationsRpc()`：取值；未 provide 时返回 null，页面降级为静态占位提示
 *   ——与迁出前 `rpc === null` 的既有行为逐字一致。
 *
 * **RPC 调用面不变**：仍是 `mcpManager/{listServers,getServer,saveServer,deleteServer,
 * testConnection,getServerReferences}` 与 `skillManager/*` + `corumAgent/listProfiles`
 * （见两个页面文件顶部的数据链路注释），只是调用函数的来源换成了本 Context。
 *
 * @module corum-ide-integrations-pages-ui/client/face
 */
import { createContext, useContext, type ReactNode } from 'react'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import css from './IntegrationsPages.module.css'

/** 全局 RPC 调用函数上下文（与设置壳 `CorumRpcContext` 同形同义）。 */
export const IntegrationsRpcContext = createContext<CorumRpcCall | null>(null)

/** 取出 RPC 调用函数；未 provide 时返回 null（页面降级为静态占位）。 */
export function useIntegrationsRpc(): CorumRpcCall | null {
  return useContext(IntegrationsRpcContext)
}

/* ── 通用玻璃按钮（迁出时自设置壳 shared.tsx 一并带入；设计稿 btn: glass-2）── */

/**
 * 渲染玻璃按钮。
 * @param props - variant/onClick/disabled 与子节点。
 * @returns 按钮元素。
 */
export function GlassButton({ children, variant = 'default', onClick, disabled }: {
  children: ReactNode
  variant?: 'default' | 'primary' | 'danger'
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={variant === 'primary' ? css.btnPrimary : variant === 'danger' ? css.btnDanger : css.btnDefault}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}
