/**
 * @corum/corum-subagent build: host-only library（无 client 半）。三入口：
 * lib/types/index.js（seam 服务本体 + cwd 透传）、lib/types/spawn/index.js
 * （corum-spawn provider）、lib/types/invariant.js（invariants 伴侣）。
 * 官方 dsh 包全部 external——host 从真实安装解析，与官方 seam 同版本共存。
 */
import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-subagent',
    entry: ['lib/types/index.js', 'lib/types/spawn/index.js', 'lib/types/invariant.js'],
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
      '@deepseek-ai/dsh-agent-presets',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-brand',
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-jobs',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-sandbox',
      '@deepseek-ai/dsh-sandbox-policy',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-persistence',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-session-projection-cache',
      '@deepseek-ai/dsh-session-query',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/dsh-user-approval',
      '@deepseek-ai/dsh-util-time',
      '@deepseek-ai/dsh-util-values',
      '@deepseek-ai/schemastery',
      'zod',
    ],
  },
])
