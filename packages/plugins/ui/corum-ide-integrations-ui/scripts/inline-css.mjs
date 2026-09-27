/**
 * Fold the extracted stylesheet into the client bundle. Idempotent.
 *
 * 用法：
 *   node scripts/inline-css.mjs           注入（build 的一步，紧跟 tsdown）
 *   node scripts/inline-css.mjs --check   只校验 client.js 已含本插件样式（CI/门禁）
 *
 * 两条红线（本仓踩过，2026-09-09 CDP 实测才发现，照抄 plugin-manager 包）：
 * ① 改样式/代码后**必须跑完整 `pnpm build`**（含本脚本），不能只跑 `tsdown`——
 *    tsdown 会重建干净的 client.js + 独立 lib/style.css，把已注入的样式冲掉。
 * ② 插件 id **从 package.json 读**，不要写死；幂等判定要认**本插件专属标记**
 *    （`s.setAttribute('data-plugin','<id>')`），不能认泛 `'data-plugin'`。
 *    初版是从 corum-ide-explorer-ui 拷贝的：id 写死成 `@corum/corum-ide-explorer-ui`
 *    且判定用 `client.includes('data-plugin')`——而源码里有 `data-plugin-manager-overlay`
 *    属性，于是每次构建都误判「已注入」并删掉 lib/style.css，插件中心面板长期
 *    **无样式**（position:static、无圆角无底色）。
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const clientJs = join(root, 'lib', 'client.js')
const styleCss = join(root, 'lib', 'style.css')
const checkOnly = process.argv.includes('--check')
const PLUGIN_ID = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

if (!existsSync(clientJs)) {
  console.error('[inline-css] lib/client.js missing — run tsdown first')
  process.exit(1)
}

const client = readFileSync(clientJs, 'utf8')
const marker = `s.setAttribute('data-plugin','${PLUGIN_ID}')`
const alreadyInjected = client.includes(marker)

if (checkOnly) {
  if (alreadyInjected) {
    console.log(`[inline-css] OK: client.js carries ${PLUGIN_ID} stylesheet`)
    process.exit(0)
  }
  console.error('[inline-css] FAIL: client.js has NO inlined stylesheet — run `pnpm build` (tsdown alone is not enough)')
  process.exit(1)
}

if (!existsSync(styleCss)) {
  if (alreadyInjected) {
    console.log('[inline-css] no stylesheet; client.js already carries the stylesheet')
    process.exit(0)
  }
  console.log('[inline-css] no stylesheet or client bundle; skipping')
  process.exit(0)
}

if (alreadyInjected) {
  rmSync(styleCss, { force: true })
  console.log('[inline-css] client.js already carries the stylesheet; removed lib/style.css')
  process.exit(0)
}

const cssText = readFileSync(styleCss, 'utf8')
const inject = [
  `;(function(){if(typeof document!=='undefined'&&document.querySelector('style[data-plugin="${PLUGIN_ID}"]')===null){`,
  `var s=document.createElement('style');`,
  marker + ';',
  `s.textContent=${JSON.stringify(cssText)};`,
  `document.head.appendChild(s);`,
  `}})();`,
].join('')

writeFileSync(clientJs, inject + '\n' + client)
console.log(`[inline-css] injected ${cssText.length} chars of CSS into client.js`)
rmSync(styleCss, { force: true })
console.log('[inline-css] removed lib/style.css')
