import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-mcp-manager',
    // 第二入口 lib/types/proxy.js → lib/proxy.js：preset 行的子路径导出（`./proxy`）。
    // preset 组合里的行按**包名 + 子路径**解析（cordis-plugin-loader 对裸名走 Node 解析，
    // 不做清单校验），于是代理行不必新开一个包、也就不必跑本仓的雷区 pnpm install。
    entry: ['lib/types/index.js', 'lib/types/proxy.js'],
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
      '@deepseek-ai/dsh-home-paths',
      '@modelcontextprotocol/sdk',
    ],
  },
])
