import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-sandbox-local',
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-sandbox',
      '@deepseek-ai/dsh-sandbox-windows-acl',
      '@deepseek-ai/dsh-util-values',
      '@deepseek-ai/node-addon-system',
      '@deepseek-ai/schemastery',
    ],
  },
])
