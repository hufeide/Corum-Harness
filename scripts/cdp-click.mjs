/**
 * cdp-click.mjs —— 在页面坐标上发一次**可信**点击（CDP `Input.dispatchMouseEvent`）。
 *
 * 由来（2026-09-13 实测）：corum 界面上**部分按钮会被 React 忽略合成事件** ——
 * `el.click()` 与手写 PointerEvent/MouseEvent 序列都点不动（实测「新建任务」卡片的
 * 「开始」按钮、主界面的「新会话」按钮），而 CDP Input 域的真实事件可以。表现极具
 * 迷惑性：按钮在 `elementFromPoint` 上命中、`disabled === false`、点击不报错、界面毫无
 * 反应（业务侧错误只出现在 console，例如建会话失败时的
 * `gateway/internal: cannot create effect on inactive context`）。
 *
 * 用法: node scripts/cdp-click.mjs <port> <x> <y> [verifyExpr]
 *   坐标取自页面内 `el.getBoundingClientRect()` 的中心（CSS 像素，与视口同尺度）。
 *   `verifyExpr` 可选：点击后 800ms 求值一次，用于断言点击确实生效
 *   （例：`JSON.stringify({dialog: !!document.querySelector('form')})`）。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(REPO_ROOT, 'packages', 'desktop', 'package.json'))
const WebSocket = require('ws')

const [port, x, y, verifyExpr] = process.argv.slice(2)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find(t => t.type === 'page')
if (!page) { console.log(JSON.stringify({ error: 'no page' })); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl, { handshakeTimeout: 8000 })
let id = 0
const pending = new Map()
const send = (method, params) => new Promise((resolve) => {
  const myId = ++id
  pending.set(myId, resolve)
  ws.send(JSON.stringify({ id: myId, method, params }))
})

ws.on('message', (m) => {
  const msg = JSON.parse(String(m))
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg.error); pending.delete(msg.id) }
})

await new Promise(r => ws.on('open', r))
const px = Number(x), py = Number(y)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', clickCount: 0 })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 })
await new Promise(r => setTimeout(r, 60))
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 })
await new Promise(r => setTimeout(r, 800))
let verified
if (verifyExpr) {
  const res = await send('Runtime.evaluate', { expression: verifyExpr, returnByValue: true })
  verified = res?.result?.value
}
console.log(JSON.stringify({ port, clicked: { x: px, y: py }, verified }))
ws.close()
