/**
 * `corum-subagent` settings namespace 的 **boot 注册行**（host 常驻）。
 *
 * ## 为什么需要这个入口（2026-09-18，bug 复现驱动）
 *
 * 本 ns 原本只在 `@corum/corum-tool-subagent` 的 `apply()` 里注册，而该包**按会话挂载**
 * （工具实例由 corum preset 的 delegation 组生成，见 corum-agent/compile.ts）。于是：
 *
 *   **冷启动（不建任何 corum 会话）时该 ns 不存在**——实测 `settings/describe` 返回
 *   16 个 ns 而没有 `corum-subagent`，后果三条：
 *     ① 设置→智能体 那两个「子 Agent 默认模型」显示为**空**（settings.yaml 里明明有值）；
 *     ② 写入该 ns 报 `settings namespace "corum-subagent" is not registered`；
 *     ③ **新建预设的模板预填读不到值**（该功能的全部意义就是读这个模板）。
 *
 * 对照先例：同类全局设置 ns `subagent-model-selection-settings` 在官方 web-app bundle 里
 * **有 host 行**，故冷启动即在册。本入口就是给 `corum-subagent` 补上同样的时机。
 *
 * ## 与 apply() 内的注册如何共存
 *
 * 官方 `settings.register` 对**重复注册直接抛错**（`settings namespace "…" is already
 * registered`）。故两侧都用 {@link acquireCorumSubagentSettingsScope}：谁先到谁注册，
 * 后到的走「已注册 ⇒ 只读直读」分支。行序上本行在 tool-subagent 的 preset apply **之前**
 * （见 cordis.patch.yml 该行注释），所以正常情况下本行先注册。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  CORUM_SUBAGENT_SETTINGS_NAMESPACE,
  acquireCorumSubagentSettingsScope,
  type CorumSettingsProviderFace,
} from './settings-namespace.ts'

/** cordis 行名（与 package.json exports 的子路径对应）。 */
export const name = 'corum-subagent-settings'

/** settings 服务在 boot 早期可能尚未挂载——与官方同款短轮询（见 corum-agent/index.ts）。 */
const POLL_INTERVAL_MS = 100
/** 轮询上限；超时后放弃（不阻断启动——apply() 内的兜底注册仍然存在）。 */
const POLL_TIMEOUT_MS = 15000

/**
 * 在根上下文注册 `corum-subagent` settings namespace。
 *
 * @param ctx - host 根上下文。
 */
export function apply(ctx: Context): void {
  let done = false
  const register = (): boolean => {
    const settings = ctx.get('settings') as CorumSettingsProviderFace | undefined
    if (settings === undefined) return false
    const scope = acquireCorumSubagentSettingsScope(settings)
    if (scope === undefined) return false
    done = true
    ctx.logger.info(`corum-tool-subagent: ${CORUM_SUBAGENT_SETTINGS_NAMESPACE} namespace registered (boot row)`)
    return true
  }

  // settings 服务可能在 boot 早期尚未就绪（官方 ui-onboarding / corum-agent 同款处理）。
  if (register()) return
  const poll = setInterval(() => {
    try {
      if (register()) clearInterval(poll)
    } catch (error) {
      ctx.logger.warn(`corum-tool-subagent: boot settings register failed: ${String(error)}`)
    }
  }, POLL_INTERVAL_MS)
  setTimeout(() => {
    clearInterval(poll)
    if (!done) {
      ctx.logger.warn(
        `corum-tool-subagent: ${CORUM_SUBAGENT_SETTINGS_NAMESPACE} not registered by the boot row within `
        + `${POLL_TIMEOUT_MS}ms — falling back to the per-session registration in the tool plugin`,
      )
    }
  }, POLL_TIMEOUT_MS)
}
