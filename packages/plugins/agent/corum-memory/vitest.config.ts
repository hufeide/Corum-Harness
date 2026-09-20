/**
 * @corum/corum-memory test config.
 *
 * `src/memory-service.ts` carries standard TypeScript decorators
 * (`@Remote('putFact')` …) that Vite's default esbuild parser rejects with
 * "Invalid or unexpected token" before Vitest can load the source-mode imports.
 * Mirrors the corum-agent `standardDecoratorPlugin` pre-transform (itself
 * mirroring the official dsh `standardDecoratorPlugin`): transpile `.ts` files
 * containing decorator syntax with the TypeScript compiler before Vite parses
 * them.
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
  },
})
