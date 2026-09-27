/**
 * @corum/corum-goal-round-driver test config。
 *
 * 官方 spec 原样照抄（回归网）+ 本 fork 自己的用例（tests/pending-delegation.spec.ts）。
 * 与 corum-subagent 同纪律：已知的上游 session.lock GC 噪音**按特征**过滤，真实缺陷照旧非零退出。
 */
import { defineConfig } from 'vitest/config'

function isKnownSessionLockGcNoise(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null | undefined
  if (e === null || typeof e !== 'object') return false
  if (e.code !== 'ERR_INVALID_STATE') return false
  const message = typeof e.message === 'string' ? e.message : ''
  return message.includes('FileHandle object was closed during garbage collection')
    && message.includes('session.lock')
}

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    onUnhandledError(error) {
      if (isKnownSessionLockGcNoise(error)) return false
      return true
    },
  },
})
