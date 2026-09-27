/**
 * Fold the extracted stylesheet into the client bundle.
 *
 * tsdown's CSS pipeline (via @tsdown/css) extracts every stylesheet this
 * plugin's components import into `lib/style.css`. The client bundle is CJS
 * and ships through `window.__ModuleLoader__.load`, so it cannot `import` a
 * CSS file and the desktop loader serves no separate CSS asset. This
 * post-build step reads that stylesheet and prepends a <style> inject to
 * `lib/client.js`, then removes the now-redundant CSS file.
 *
 * Idempotent: if the CSS file is absent it exits 0 without touching anything.
 * @module corum-ide-integrations-pages-ui/scripts/inline-css
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const clientJs = join(root, 'lib', 'client.js')
const styleCss = join(root, 'lib', 'style.css')

/** 本插件专属的 <style> 标记（幂等判定与 DOM 去重都用它）——从 package.json 读，不写死。 */
const PLUGIN_ID = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

if (!existsSync(styleCss) || !existsSync(clientJs)) {
  console.log('[inline-css] no stylesheet or client bundle; skipping')
  process.exit(0)
}

const cssText = readFileSync(styleCss, 'utf8')
const inject = [
  `;(function(){if(typeof document!=='undefined'&&document.querySelector('style[data-plugin="${PLUGIN_ID}"]')===null){`,
  `var s=document.createElement('style');`,
  `s.setAttribute('data-plugin','${PLUGIN_ID}');`,
  `s.textContent=${JSON.stringify(cssText)};`,
  `document.head.appendChild(s);`,
  `}})();`,
].join('')

const client = readFileSync(clientJs, 'utf8')
// 幂等判定必须认**本插件专属标记**（不能认泛 'data-plugin'：业务源码里可能出现
// 该字符串，corum-ide-plugin-manager-ui 就因 data-plugin-manager-overlay 被误判
// 「已注入」，样式长期不注入 —— 见 scripts/verify-fork-drift.sh §7 的同款断言）。
if (!client.includes(`s.setAttribute('data-plugin','${PLUGIN_ID}')`)) {
  writeFileSync(clientJs, inject + '\n' + client)
  console.log(`[inline-css] injected ${cssText.length} chars of CSS into client.js`)
} else {
  console.log('[inline-css] client.js already carries the stylesheet')
}
rmSync(styleCss, { force: true })
console.log('[inline-css] removed lib/style.css')
