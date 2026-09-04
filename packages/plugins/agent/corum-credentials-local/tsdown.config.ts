import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-credentials-local',
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
      '@deepseek-ai/dsh-atomic-write',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-launch-environment',
      '@deepseek-ai/schemastery',
      'chokidar',
      'yaml',
    ],
  },
])
