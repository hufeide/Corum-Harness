/**
 * Fold the extracted stylesheet into the client bundle (same mechanism as the
 * other corum forks): tsdown's css pipeline extracts stylesheets into
 * lib/style.css; the client bundle is CJS and ships through
 * window.__ModuleLoader__.load, so it cannot import a CSS file.
 *
 * 插件 id 从 package.json 读取——不要像初版（从 corum-ui-chat 直接拷贝）那样写死
 * 某个包的 id：样式会被注入到错误的 `data-plugin` 标签下，静默不生效
 * （2026-09-09 实机：轨迹区域样式全无，内容被卡片 overflow:hidden 裁掉）。
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const { name: pluginId } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const clientJs = join(root, 'lib', 'client.js')
const styleCss = join(root, 'lib', 'style.css')

if (!existsSync(styleCss) || !existsSync(clientJs)) {
  console.log('[inline-css] no stylesheet or client bundle; skipping')
  process.exit(0)
}

const cssText = readFileSync(styleCss, 'utf8')
const marker = `style[data-plugin="${pluginId}"]`
const inject = [
  `;(function(){if(typeof document!=='undefined'&&document.querySelector('${marker}')===null){`,
  `var s=document.createElement('style');`,
  `s.setAttribute('data-plugin',${JSON.stringify(pluginId)});`,
  `s.textContent=${JSON.stringify(cssText)};`,
  `document.head.appendChild(s);`,
  `}})();`,
].join('')

const client = readFileSync(clientJs, 'utf8')
if (!client.includes(marker)) {
  writeFileSync(clientJs, inject + '\n' + client)
  console.log(`[inline-css] injected ${cssText.length} chars of CSS into client.js for ${pluginId}`)
} else {
  console.log('[inline-css] client.js already carries the stylesheet')
}
rmSync(styleCss, { force: true })
console.log('[inline-css] removed lib/style.css')
