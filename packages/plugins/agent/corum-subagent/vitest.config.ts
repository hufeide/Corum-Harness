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

/**
 * 已知的上游测试基建噪音：`session.lock` 的 FileHandle 泄漏到 GC 才关闭。
 *
 * 成因（读码确认，非推测）：官方 spec `list-children.spec.ts` 的 `afterEach` 只
 * `rmSync` 临时目录、**不 dispose cordis context**，于是 `JsonlSessionPersistence`
 * 的写租约（`session-persistence-jsonl/src/lease.ts` 的 `SessionWriteLease`，
 * POSIX 用 `open(path,'w')` + `flock`）持有的 FileHandle 只在 GC 时才关闭。
 * Node 26 把「GC 时才关闭 FileHandle」从 deprecation warning 升级为
 * `ERR_INVALID_STATE` uncaught exception（官方 CI 跑 Node 24 无此报错）。
 *
 * ⚠️ 这是**官方 spec / 官方 lease 的瑕疵**，不是 corum 的缺陷：fork 的
 * `tests/list-children.spec.ts` 与官方**逐字节相同**（已 diff 确认），故保持与
 * 官方一致以便未来 rebase 零冲突，只在此处按**特征**过滤这一条。
 *
 * 判据精确到「错误来源文件是 session.lock 的 FileHandle GC」——其余任何
 * unhandled error（含真实缺陷）**照旧让 vitest 非零退出**。
 */
function isKnownSessionLockGcNoise(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null | undefined
  if (e === null || typeof e !== 'object') return false
  if (e.code !== 'ERR_INVALID_STATE') return false
  const message = typeof e.message === 'string' ? e.message : ''
  return message.includes('FileHandle object was closed during garbage collection')
    && message.includes('session.lock')
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    // fork（corum）：**按特征**过滤上述已知噪音，而不是用
    // `dangerouslyIgnoreUnhandledErrors: true` 一刀切。
    //
    // 为什么不用那个开关（2026-09-15 实测）：开它之后，我注入一个**真实的**
    // unhandled rejection，vitest 仍会**打印**该错误，但**退出码变成 0**
    // ⇒ CI 绿着放过真实缺陷。改用 `onUnhandledError` 返回 `false` 精确忽略这一条，
    // 真实的 unhandled error 仍会让运行**非零退出**（已用注入探针双向验证）。
    onUnhandledError(error) {
      if (isKnownSessionLockGcNoise(error)) return false
      return true
    },
  },
})
