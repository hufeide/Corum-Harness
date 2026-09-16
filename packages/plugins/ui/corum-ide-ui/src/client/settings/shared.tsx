/**
 * Settings sections — 共享面（重构 2：从 SettingsSections.tsx 拆出的跨 section 共享层）。
 *
 * 承载 19 个 section 组件共同依赖的：
 * - corum RPC 调用上下文（CorumRpcContext / useCorumRpc）
 * - 「子 Agent」等业务 section 的 settings 面（CorumSettingsContext / useCorumSettings）
 * - section 操作上下文（SectionNavContext / useSectionNav）
 * - 通用玻璃按钮 GlassButton / 通用卡片 InfoCard
 *
 * 各 section 独立文件经本模块复用，消除 SubagentSection 原先的模板重复
 * （docs/plan/PLAN-refactor-orchestration-package-and-settings-center.md 重构 2）。
 */
import { createContext, useContext, type ReactNode } from 'react'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import css from './SettingsSections.module.css'

/* ── corum RPC 调用上下文（由 index.tsx 在注册 sections 时 provide）────────── */

/** 全局 RPC 调用函数上下文：SkillsSection 等业务 section 经此调 host 服务。 */
export const CorumRpcContext = createContext<CorumRpcCall | null>(null)

/** 「子 Agent」section 的 settings 面（describe 镜像读 + mutate 写）。 */
export interface CorumSettingsFace {
  /** settings 命名空间镜像（uSES 源：getSnapshot/subscribe/ensure）。 */
  readonly describe: {
    getSnapshot(): { status: string; view?: { namespaces: readonly { ns: string; value: unknown; user?: unknown; revision: number }[]; writable: boolean } | undefined; error: string | null }
    subscribe(listener: () => void): () => void
    ensure(): Promise<void>
    acceptView(view: unknown): void
  }
  /** remote.settings.mutate 直通（namespace, ops, expectedRevision）。 */
  readonly mutate: (ns: string, ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[], revision?: number) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>
}

/** settings 面 Context（与 CorumRpcContext 同构下发；仅「子 Agent」section 消费）。 */
export const CorumSettingsContext = createContext<CorumSettingsFace | null>(null)

export function useCorumSettings(): CorumSettingsFace | null {
  return useContext(CorumSettingsContext)
}

/** 取出 RPC 调用函数；未 provide 时返回 null（组件降级为静态占位）。 */
export function useCorumRpc(): CorumRpcCall | null {
  return useContext(CorumRpcContext)
}

/* ── 通知偏好面（PRD v2 §4.4；由 index.tsx 从 ctx.notifications 裁剪下发）────── */

/**
 * 通知偏好的本地能力接口（dev-conventions §2.4 红线 3：跨 bundle 窄化，不耦合
 * desktop 实现包的 NotificationStore 全面）。值与 desktop `NotificationPrefs` 同形，
 * 此处独立声明避免跨包 import 类型。
 */
export interface NotificationPrefsFace {
  enabled: boolean
  sound: boolean
  dnd: boolean
}

/** 设置页消费的通知偏好写/读面。 */
export interface NotificationPrefsService {
  getPrefs(): NotificationPrefsFace
  setPrefs(patch: Partial<NotificationPrefsFace>): void
  subscribePrefs(listener: () => void): () => void
}

/** 通知偏好 Context（与 CorumSettingsContext 同构下发；仅通知 section 消费）。 */
export const NotificationPrefsContext = createContext<NotificationPrefsService | null>(null)

/** 取出通知偏好面；未 provide 时返回 null（控件降级为禁用 + 未上线）。 */
export function useNotificationPrefs(): NotificationPrefsService | null {
  return useContext(NotificationPrefsContext)
}

/* ── section 操作上下文（SettingsShell 经 owner props → Host 下发 openSection/close）── */

/** 设置壳的 section 操作面：openSection 切换 section、close 关闭设置面板。 */
export interface SectionActions {
  openSection: (id: string) => void
  close: () => void
  /**
   * 打开插件中心市场浮层（「发现更多插件」入口）：经 LayoutController → grid
   * actions 订阅面通知 corum-ide-plugin-manager-ui 插件（统一事件中心三-2
   * 服务化，原 OPEN_PLUGIN_MANAGER_EVENT CustomEvent 广播已退役——同 bundle
   * 内由 SettingsShell 经 inject 面下发，编译期联动）。
   */
  openPluginManager: () => void
}

/** 设置壳的 section 操作上下文（如 Agent 预设 footer「记忆管理」→ memory；插件管理「发现更多插件」→ 关面板+开市场）。 */
export const SectionNavContext = createContext<SectionActions | null>(null)

/** 取出 section 操作面；未 provide 时返回 null（跳转按钮降级隐藏）。 */
export function useSectionNav(): SectionActions | null {
  return useContext(SectionNavContext)
}

/* ── 通用玻璃按钮（设计稿 btn: glass-2, radius 13, padding [9,16]）────── */

export function GlassButton({ children, variant = 'default', onClick, disabled }: { children: ReactNode; variant?: 'default' | 'primary' | 'danger'; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={variant === 'primary' ? css.btnPrimary : variant === 'danger' ? css.btnDanger : css.btnDefault} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

/* ── 通用卡片（设计稿 card: glass-1, radius 16, padding 14）────────────── */

export function InfoCard({ title, desc, chips, actions, isDefault, onClick }: {
  title: string; desc: string; chips?: string[]; actions?: ReactNode; isDefault?: boolean; onClick?: () => void
}) {
  return (
    <div className={css.card} onClick={onClick} role={onClick ? 'button' : undefined}>
      <div className={css.cardInfo}>
        <div className={css.cardTitleRow}>
          <span className={css.cardTitle}>{title}</span>
          {isDefault && <span className={css.defaultBadge}>默认</span>}
        </div>
        <span className={css.cardDesc}>{desc}</span>
        {chips && (
          <div className={css.cardChips}>
            {chips.map(c => <span key={c} className={css.cardChip}>{c}</span>)}
          </div>
        )}
      </div>
      {actions && <div className={css.cardActions} onClick={e => e.stopPropagation()}>{actions}</div>}
    </div>
  )
}
