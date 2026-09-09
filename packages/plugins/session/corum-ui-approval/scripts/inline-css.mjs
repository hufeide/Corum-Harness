/**
 * Fold the extracted stylesheet into the client bundle (same mechanism as
 * the other corum forks): tsdown's css pipeline extracts stylesheets into
 * lib/style.css; the client bundle is CJS and ships through
 * window.__ModuleLoader__.load, so it cannot import a CSS file.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const clientJs = join(root, 'lib', 'client.js')
const styleCss = join(root, 'lib', 'style.css')

if (!existsSync(styleCss) || !existsSync(clientJs)) {
  console.log('[inline-css] no stylesheet or client bundle; skipping')
  process.exit(0)
}

const cssText = readFileSync(styleCss, 'utf8')
const inject = [
  `;(function(){if(typeof document!=='undefined'&&document.querySelector('style[data-plugin="@corum/corum-ui-approval"]')===null){`,
  `var s=document.createElement('style');`,
  `s.setAttribute('data-plugin','@corum/corum-ui-approval');`,
  `s.textContent=${JSON.stringify(cssText)};`,
  `document.head.appendChild(s);`,
  `}})();`,
].join('')

const client = readFileSync(clientJs, 'utf8')
// 幂等判定必须认**本插件专属标记**（不能认泛 'data-plugin'：业务源码里
// 可能出现该字符串——corum-ide-plugin-manager-ui 就因 data-plugin-manager-overlay
// 被误判「已注入」，样式长期不注入）。
if (!client.includes("s.setAttribute('data-plugin','@corum/corum-ui-approval')")) {
  writeFileSync(clientJs, inject + '\n' + client)
  console.log(`[inline-css] injected ${cssText.length} chars of CSS into client.js`)
} else {
  console.log('[inline-css] client.js already carries the stylesheet')
}
rmSync(styleCss, { force: true })
console.log('[inline-css] removed lib/style.css')
