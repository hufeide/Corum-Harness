/**
 * `corum-memory` settings namespace 的 **boot 注册行**（host 常驻）。
 *
 * ## 为什么需要这个入口
 *
 * 与 `corum-subagent-settings` 同源问题：settings namespace 若只在本插件的
 * `apply()` 里注册，则**冷启动（未打开过记忆页）时 `settings/describe` 里没有它**
 * ——后果是设置中心「记忆」页的三个参数读不到已存的值（settings.yaml 里明明有），
 * 写入报 `settings namespace "corum-memory" is not registered`，「恢复默认」也无从
 * 判断「哪些键被覆盖过」。
 *
 * 本行在 `cordis.patch.yml` 里紧邻 `corum-memory` 行放置（行序在服务 apply 之前），
 * 故正常情况下本行先注册；服务侧走 {@link acquireMemorySettingsScope}，容忍
 * 「已被注册」（官方 `settings.register` 对重复注册直接抛错）。
 *
 * ## 与 corum-agent / corum-subagent 的差别
 *
 * 那两个行的 ns 只被「读」；本 ns 被**策略**消费（服务的 `getConfig()` 每次策略调用
 * 都要拿 resolved 值）。故服务侧除了注册还挂了 watch——设置面一改，缓存立刻刷新，
 * 不需要重启。
 *
 * @module @corum/corum-memory/settings-registrar
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  CORUM_MEMORY_SETTINGS_NAMESPACE,
  acquireMemorySettingsScope,
  type MemorySettingsProviderFace,
} from './memory-config.ts'

/** cordis 行名（与 package.json exports 的子路径对应）。 */
export const name = 'corum-memory-settings'

/** settings 服务在 boot 早期可能尚未挂载——与官方同款短轮询。 */
const POLL_INTERVAL_MS = 100
/** 轮询上限；超时后放弃（不阻断启动——服务 apply 内的兜底注册仍然存在）。 */
const POLL_TIMEOUT_MS = 15000

/**
 * 在根上下文注册 `corum-memory` settings namespace。
 *
 * @param ctx - host 根上下文。
 */
export function apply(ctx: Context): void {
  let done = false
  const register = (): boolean => {
    const settings = ctx.get('settings') as MemorySettingsProviderFace | undefined
    if (settings === undefined) return false
    const scope = acquireMemorySettingsScope(settings)
    if (scope === undefined) return false
    done = true
    ctx.logger.info(`corum-memory: ${CORUM_MEMORY_SETTINGS_NAMESPACE} namespace registered (boot row)`)
    return true
  }

  if (register()) return
  const poll = setInterval(() => {
    try {
      if (register()) clearInterval(poll)
    } catch (error) {
      ctx.logger.warn(`corum-memory: boot settings register failed: ${String(error)}`)
    }
  }, POLL_INTERVAL_MS)
  setTimeout(() => {
    clearInterval(poll)
    if (!done) {
      ctx.logger.warn(
        `corum-memory: ${CORUM_MEMORY_SETTINGS_NAMESPACE} not registered by the boot row within `
        + `${POLL_TIMEOUT_MS}ms — falling back to the registration inside the service`,
      )
    }
  }, POLL_TIMEOUT_MS)
}
