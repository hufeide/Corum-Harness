/**
 * @corum/corum-memory build: host library + browser client bundle.
 *
 * Host 两个入口：
 *   · `lib/types/index.js` —— 服务本体（MemoryService）。
 *   · `lib/types/settings-registrar.js` —— `corum-memory` settings ns 的 **boot
 *     常驻注册行**（该 ns 不在 boot 注册则冷启动读不到已存参数，见该文件头注释）。
 * Browser 入口：`src/client/index.tsx`（设置中心两个 section 的产品页）。
 */
import { defineConfig } from 'tsdown'

const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-connection',
]

const CLIENT_ID = '@corum/corum-memory'

export default defineConfig(() => [
  // Node library entries (tsc-emitted from lib/types).
  {
    name: CLIENT_ID,
    entry: ['lib/types/index.js', 'lib/types/settings-registrar.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-storage',
      '@deepseek-ai/dsh-storage-domain',
      '@deepseek-ai/schemastery',
      'zod',
    ],
  },
  // Browser bundle: the settings-section client half.
  {
    name: `${CLIENT_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
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
    css: { splitting: false },
    outputOptions: {
      entryFileNames: 'client.js',
      inlineDynamicImports: true,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
