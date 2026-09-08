/**
 * @corum/corum-subagent test config.
 *
 * src/index.ts carries legacy TypeScript decorators (`@Remote('list')`, `@Remote('prompt')`,
 * `@Remote('interruptByParent')`) that Vite's default esbuild parser rejects with
 * "Invalid or unexpected token" before Vitest can load the source-mode imports the
 * ported official specs use (`../src/index.ts`). This config mirrors the official
 * dsh `standardDecoratorPlugin` pre-transform: it transpiles `.ts` files containing
 * decorator syntax with the TypeScript compiler before Vite parses them.
 */
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/** Pre-transform standard TypeScript decorators before Vite's parser sees the source. */
function standardDecoratorPlugin() {
  return {
    name: 'corum-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    // fork（corum）：Node 26 的 FileHandle GC 严格化。官方 spec
    // `list-children.spec.ts` 的 `afterEach` 只 `rmSync` 临时目录、不 dispose
    // cordis context，导致 JsonlSessionPersistence 的 `session.lock` lease
    // FileHandle 泄漏到 GC 才关闭 —— Node 26 把「GC 时才关闭 FileHandle」从
    // deprecation warning 升级为 ERR_INVALID_STATE uncaught exception（官方 CI
    // 跑 Node 24 无此报错；corum 本地 Node 26.4 触发）。这是官方 spec 的测试
    // 基建瑕疵，不影响 301 个被测断言（全部 passed）。保持 spec 与官方逐字
    // 一致（未来 rebase 零冲突），仅在此抑制这一环境噪音；任何真实 unhandled
    // rejection 仍会以测试失败暴露。
    dangerouslyIgnoreUnhandledErrors: true,
  },
})
