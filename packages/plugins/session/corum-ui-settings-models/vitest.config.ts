/**
 * @corum/corum-ui-settings-models test config。
 *
 * 只为纯函数单测（reasoning.ts 的档位字典推导等）—— 被测源码无装饰器语法，
 * 无需特殊预变换（与 corum-ui-chat 同款最小配置）。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
