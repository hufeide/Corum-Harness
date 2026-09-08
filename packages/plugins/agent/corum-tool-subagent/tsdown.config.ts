/**
 * @corum/corum-tool-subagent build: host-only library（无 client 半）。两入口：
 * lib/types/index.js（召唤工具本体 + 隔离层）、lib/types/invariant.js
 * （invariants 伴侣）。model-selection-settings 是 host 内部 import（由
 * index.js 经相对路径带进产物），不单独设入口。官方 dsh 包全部 external——
 * host 从真实安装解析，与官方 seam 同版本共存。
 */
import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-tool-subagent',
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
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-jobs',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-storage-domain',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-util-values',
      '@deepseek-ai/schemastery',
      'zod',
    ],
  },
])
