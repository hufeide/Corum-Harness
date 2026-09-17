import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-tools',
    entry: {
      index: 'lib/types/index.js',
      invariant: 'lib/types/invariant.js',
      types: 'lib/types/types.js',
      presentation: 'lib/types/presentation.js',
    },
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
      '@deepseek-ai/dsh-brand',
      '@deepseek-ai/dsh-code-runtime',
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-user-approval',
      '@deepseek-ai/dsh-util-values',
      '@deepseek-ai/schemastery',
    ],
  },
])
