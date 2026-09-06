/**
 * @corum/corum-api-remotes build: standalone tsdown config mirroring the
 * official `clientBundle('@deepseek-ai/dsh-api-remotes', ['lib/types/index.js',
 * 'lib/types/invariant.js'], { hostPhase: true })` shape without depending on
 * dsh's private `packages/client/tsdown.client.ts` helper.
 *
 * Node library half: `lib/types/index.js` + `lib/types/invariant.js` (tsc output),
 * production dependencies stay imports (the host runs from a real install).
 * Browser bundle half: closure-factory artifact — calls
 * `window.__ModuleLoader__.load({id, factory})` and resolves the loader module
 * table (react/cordis/slots/primitives/store); every other specifier inlines.
 */
import { defineConfig } from 'tsdown'

/** Module-table entries the loader seed answers: kept external in the browser bundle. */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
]

const PACKAGE_ID = '@corum/corum-api-remotes'

/** Host-half production dependencies: on disk at runtime, stay imports. */
const HOST_EXTERNALS: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-deque',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-util-values',
]

export default defineConfig(() => [
  // Node library entries (tsc-emitted from lib/types).
  {
    name: PACKAGE_ID,
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
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
  // Browser bundle: the fork's client half (Remote contribution mount).
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      inlineDynamicImports: true,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
