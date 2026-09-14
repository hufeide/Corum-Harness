/**
 * cdp-reload.mjs —— 只重载页面：救活 hung/已死的**渲染器**，不动宿主。
 *
 * 由来（2026-09-13 实机事故）：两个实例（:9222 打包态 / :9333 dev 态）进程都在、CDP 端口
 * 仍应答，但**渲染器被挂死**（MCP/求值 180s 无响应、`pgrep type=renderer` 为空）——
 * 窗口是死的，而宿主与正在跑的 Agent 会话都还活着。此时**不要重启实例**（会杀掉在跑的委派，
 * 2026-09-13 已经踩过一次），只要给该页发一帧 `Page.reload`：Chromium 重建渲染器，
 * 窗口恢复，宿主与 Agent 全程不受影响。
 *
 * 用法: node scripts/cdp-reload.mjs <port> [port...]   # 例：node scripts/cdp-reload.mjs 9333 9222
 * 输出: 每端口一行 JSON（reload 投递结果 + 重载后活性探针结果）。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 从仓库根解析 ws（本脚本位于 <repo>/scripts/）
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(REPO_ROOT, 'packages', 'desktop', 'package.json'))
const WebSocket = require('ws')

const ports = process.argv.slice(2).map(Number)
const results = []

async function reload(port) {
  const out = { port }
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find(t => t.type === 'page')
    if (!page) { out.error = 'no page target'; return out }
    out.url = page.url
    out.title = page.title
    out.wsOk = Boolean(page.webSocketDebuggerUrl)
    if (!page.webSocketDebuggerUrl) return out
    await new Promise((resolve) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl, { handshakeTimeout: 8000 })
      const done = (why) => { out.reload = why; try { ws.close() } catch {} ; resolve() }
      const timer = setTimeout(() => done('timeout'), 12000)
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: false } }))
        // Chromium 不总是回 ack，发完等 1.5s 就认为已投递
        setTimeout(() => { clearTimeout(timer); done('sent') }, 1500)
      })
      ws.on('error', (e) => { clearTimeout(timer); done('ws-error: ' + String(e.message).slice(0, 60)) })
    })
    // 重载后再探一次活性
    await new Promise(r => setTimeout(r, 6000))
    const probe = await new Promise((resolve) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl, { handshakeTimeout: 8000 })
      const timer = setTimeout(() => { try { ws.close() } catch {} ; resolve('renderer-unresponsive') }, 10000)
      ws.on('open', () => ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } })))
      ws.on('message', (m) => { const s = String(m); if (s.includes('"id":2')) { clearTimeout(timer); out.alive = s.includes('"value":2') ? 'yes' : 'answered'; try { ws.close() } catch {} ; resolve('ok') } })
      ws.on('error', (e) => { clearTimeout(timer); resolve('ws-error: ' + String(e.message).slice(0, 50)) })
    })
    out.probe = probe
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 120)
  }
  return out
}

for (const p of ports) results.push(await reload(p))
for (const r of results) console.log(JSON.stringify(r))
