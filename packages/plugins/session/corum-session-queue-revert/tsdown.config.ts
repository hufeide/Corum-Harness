/**
 * @corum/corum-session-queue-revert build: host-only patch plugin (no client
 * half). tsc emits lib/types/index.js; tsdown bundles it into lib/index.js
 * with runtime-installed @deepseek-ai/* packages kept as imports.
 */
import { defineConfig } from 'tsdown'

const PACKAGE_ID = '@corum/corum-session-queue-revert'

/** Host-half production dependencies: on disk at runtime, stay imports. */
const HOST_EXTERNALS: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-typert-protocol',
]

export default defineConfig(() => [
  {
    name: PACKAGE_ID,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: (specifier: string) =>
        HOST_EXTERNALS.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
      alwaysBundle: (specifier: string) =>
        !HOST_EXTERNALS.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
    },
  },
])
