/**
 * fork #14（`@corum/corum-fs-local`）的常驻守卫。
 *
 * 为什么需要它：桌面 base 组装里 `ctx.fs` 由**官方** `@deepseek-ai/dsh-fs-sandbox` 提供，
 * 而它是 `dsh-fs-local` 的**子类**（`SandboxedFileSystem extends LocalFileSystem`，见
 * `fs-sandbox/src/index.ts:30`）——所以 fork 要生效，必须让官方包名 `@deepseek-ai/dsh-fs-local`
 * **解析到 corum fork**（`pnpm-workspace.yaml` overrides 里那条 `link:`）。
 * 这三层任意一层断了，edit 失败的定位提示就静默消失（编译与构建都不会报）：
 *   ① 解析面：从挂载方 `@deepseek-ai/dsh-base` 出发，`dsh-fs-local` 是否指到 fork；
 *   ② 继承面：官方 `SandboxedFileSystem` 的基类是否 **===** fork 导出的 LocalFileSystem；
 *   ③ 行为面：真实 `editText` 失败时，错误信息里是否带「最相近候选 + 行号」。
 *
 * 用法（必须在 packages/desktop 下跑，解析面才对）：
 *   cd packages/desktop && node scripts/check-fork-fs-local.mjs
 *
 * 退出码：0 = 三层全通；1 = 有断言失败（打印实际值，便于判断是配置漂了还是断言写错）。
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopPkg = join(here, '..')
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

// ── ① 解析面：从挂载方 dsh-base 的解析上下文看 dsh-fs-local 落在哪 ──
// realpath 必需：pnpm 的 store 布局里，dsh-base 的依赖是它的**同层兄弟**（
// <.pnpm>/@deepseek-ai+dsh-base@.../node_modules/@deepseek-ai/*），走软链路径解析看不到它们。
const baseRequire = createRequire(realpathSync(join(desktopPkg, 'node_modules/@deepseek-ai/dsh-base/package.json')))
let sandboxEntry
let localEntry
try {
  sandboxEntry = baseRequire.resolve('@deepseek-ai/dsh-fs-sandbox')
  localEntry = baseRequire.resolve('@deepseek-ai/dsh-fs-local')
} catch (error) {
  console.error(`无法从 dsh-base 解析依赖（环境不完整？）：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
check('dsh-fs-local 从挂载方解析到 corum fork', localEntry.includes('corum-fs-local'), localEntry)
check('dsh-fs-sandbox 可解析（挂载方在）', sandboxEntry.includes('dsh-fs-sandbox'), sandboxEntry)

const { Context } = await import('@deepseek-ai/cordis')
const fork = await import(pathToFileURL(localEntry).href)
const sandbox = await import(pathToFileURL(sandboxEntry).href)

// ── ② 继承面：官方 provider 的基类必须是 fork 的类（同一份，不是同名两份） ──
check(
  'SandboxedFileSystem 的基类 === fork 的 LocalFileSystem',
  Object.getPrototypeOf(sandbox.SandboxedFileSystem) === fork.LocalFileSystem,
)

// ── ③ 行为面：真实 editText 失败文案 ──
const workspace = mkdtempSync(join(tmpdir(), 'corum-fork-fs-'))
try {
  // 直接构造（绕过插件加载器的 schemastery 默认值）时必须显式给 diffBasisMaxBytes；
  // 这是官方 Config 的形状，不是 fork 的增量。
  const fs = new fork.LocalFileSystem(new Context(), { cwd: workspace, diffBasisMaxBytes: 10 * 1024 * 1024 })
  const file = join(workspace, 'sample.ts')
  writeFileSync(file, [
    'export function total(items) {',
    '  const sum = items.reduce((a, b) => a + b.price, 0)',
    '  return sum',
    '}',
    '',
  ].join('\n'))
  const target = await fs.resolve(file)
  const info = await fs.stat(target)
  check('resolve + stat 可用（provider 正常装配）', info !== undefined)

  let error
  try {
    // 锚点：与文件中第 2 行文本相同、只是缩进不同（4 空格 vs 2 空格）。
    await fs.editText(target, { oldString: '    const sum = items.reduce((a, b) => a + b.price, 0)', newString: '    const sum = 0', replaceAll: false }, { version: info.version })
  } catch (caught) {
    error = caught
  }
  const message = error instanceof Error ? error.message : ''
  check('失败仍抛 FS_EDIT_NOT_FOUND（语义未变）', error?.code === 'FS_EDIT_NOT_FOUND', String(error?.code))
  check('错误信息含「最相近候选」段', message.includes('Closest places in the file'))
  check('错误信息含命中行号 line 2:', message.includes('line 2:'))
  check('错误信息标明「只是缩进不同」', message.includes('different indentation'))
  check('错误信息声明没有任何改动', message.includes('nothing has been changed'))
  console.log('\n--- 模型将看到的错误信息 ---\n' + message + '\n--------------------------')
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(' | ')}`)
process.exit(failures.length === 0 ? 0 : 1)
