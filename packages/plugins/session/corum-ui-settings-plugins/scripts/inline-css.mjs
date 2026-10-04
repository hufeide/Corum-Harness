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
 * **为什么这个包必须有它**（2026-10-03 用户报障「插件中心的字体大小并不能跟随
 * 系统的设定改变」）：本包此前 `build` 脚本只有 `tsc -b && tsdown`，样式被抽到
 * `lib/style.css` 后**没有任何步骤把它内联进 client.js**，而桌面加载器又不提供
 * 独立的 CSS 资源 ⇒ 页面里完全没有本包的样式规则。表现是：类名映射在（TSX 编译
 * 出的 `_xxxx_name` 类名照旧），但**规则一条都不命中**，元素于是落回 `<button>`
 * 的 UA 默认字号 `13.3333px` —— 那个值不跟随 `--corum-ui-font-scale`，所以无论
 * 用户怎么调「界面字号」，插件中心的卡片文字都不变。
 * 本包是全仓 20 个含 `*.module.css` 的包里**唯一**漏了这一步的（其余 19 个都有）。
 *
 * Idempotent: if the CSS file is absent it exits 0 without touching anything.
 * @module corum-ui-settings-plugins/scripts/inline-css
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PLUGIN_ID = '@corum/corum-ui-settings-plugins'

const root = resolve(import.meta.dirname, '..')
const clientJs = join(root, 'lib', 'client.js')
const styleCss = join(root, 'lib', 'style.css')

if (!existsSync(styleCss) || !existsSync(clientJs)) {
  console.log('[inline-css] no stylesheet or client bundle; skipping')
  process.exit(0)
}

const cssText = readFileSync(styleCss, 'utf8')
const marker = `s.setAttribute('data-plugin','${PLUGIN_ID}')`
const inject = [
  `;(function(){if(typeof document!=='undefined'&&document.querySelector('style[data-plugin="${PLUGIN_ID}"]')===null){`,
  `var s=document.createElement('style');`,
  `s.setAttribute('data-plugin','${PLUGIN_ID}');`,
  `s.textContent=${JSON.stringify(cssText)};`,
  `document.head.appendChild(s);`,
  `}})();`,
].join('')

const client = readFileSync(clientJs, 'utf8')
// 幂等判定必须认**本插件专属标记**（不能认泛 'data-plugin'：业务源码里可能出现该
// 字符串，corum-ide-plugin-manager-ui 就曾因 data-plugin-manager-overlay 被误判
// 「已注入」，样式长期不注入）。
if (!client.includes(marker)) {
  writeFileSync(clientJs, inject + '\n' + client)
  console.log(`[inline-css] injected ${cssText.length} chars of CSS into client.js`)
} else {
  console.log('[inline-css] client.js already carries the stylesheet')
}
rmSync(styleCss, { force: true })
console.log('[inline-css] removed lib/style.css')
