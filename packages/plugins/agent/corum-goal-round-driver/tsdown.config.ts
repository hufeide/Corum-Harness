/**
 * @corum/corum-goal-round-driver build（host-only library）。
 *
 * fork 自官方 `@deepseek-ai/dsh-goal-round-driver`（fork #17，2026-09-27）：唯一增量是
 * 「**该 Agent 名下尚有在飞 subagent run 时不自动开新轮**」，并在 `subagent/end` 时重新评估
 * （见 src/index.ts 的 corum fork delta）。官方 dsh 包全部 external——host 从真实安装解析，
 * 与官方同版本共存。
 */
import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-goal-round-driver',
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-goal',
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
    ],
  },
])
