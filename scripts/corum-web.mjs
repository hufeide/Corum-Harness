#!/usr/bin/env node
/**
 * corum-web.mjs — 纯网页方式启动 Corum（不依赖 Electron）。
 *
 * 桌面版的本质：Electron 主进程 spawn 一个 Node 后端 `lib/host/bridge.js`
 * （跑 dsh webserver 并把前端以 web 形式托管），再用 BrowserWindow 打开
 * `http://127.0.0.1:PORT/?token=...`。本脚本跳过 Electron，直接起这个 Node
 * 后端，再把 URL 交给你自己的浏览器。
 *
 * 用法：
 *   node scripts/corum-web.mjs            # 构建(若缺失) + 起服务 + 打印 URL
 *   CORUM_WEB_NO_OPEN=1 node scripts/corum-web.mjs   # 不自动打开浏览器
 *   CORUM_HOME=/path/to/home node scripts/corum-web.mjs  # 指定数据目录
 *
 * 退出：Ctrl-C / SIGTERM 会转发给后端子进程，会话日志会在退出前 flush。
 *
 * 注意：这不是纯静态前端——浏览器里的界面仍依赖本机 Node 进程作后端
 * （agent loop / 文件系统 / 终端 / LLM 网关 / 会话存储）。webserver 默认只绑
 * 127.0.0.1（本地访问设计）。
 * @module corum/scripts/corum-web
 */

import { spawn, execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const desktopDir = join(root, 'packages', 'desktop')
const bridgePath = join(desktopDir, 'lib', 'bridge.js')

// 1) 构建（仅当构建产物缺失时）。
//    注意：desktop 的 `npm run build`（tsc -b）在 Node 24 下会因 Electron 壳代码的
//    类型错误而退出非零，但 tsc 仍会照常 emit JS（noEmitOnError 默认 false），运行时
//    通过 node_modules 软链解析 @corum/*，不受影响。这里用 `build:lib || true` 容忍
//    类型错误，再跑 `bundle`（tsdown，esbuild 转译不依赖类型检查）即可产出 lib/bridge.js。
//    插件包需先构建（pnpm --filter './packages/plugins/**' run build），已由调用方完成。
if (!existsSync(bridgePath)) {
  console.error('[corum-web] 未找到构建产物，先执行构建（pnpm install + 插件构建需已完成）…')
  execSync('npm run build:lib || true && npm run bundle', { cwd: desktopDir, stdio: 'inherit' })
}

// 2) 环境：复用调用方环境，注入桌面所需的变量。
//    - CORUM_DESKTOP_PROFILE 默认 'web'（boot.ts 同默认值）
//    - CORUM_DESKTOP_MODE=ide 给出完整编程工作台（默认 minimal 只是官方三栏聊天壳）
//    - CORUM_PARENT_PID 指向本启动器：看门狗在启动器存活期间不会自杀；
//      本进程退出后子进程被 reparent 到 init，看门狗随后收掉它（也可被下面的
//      信号处理显式 kill）。
//    - CORUM_CREDENTIALS_MASTER_KEY：凭证加密主密钥。桌面版由 Electron 的
//      safeStorage 生成并注入；纯 Node 后端没有 safeStorage，凭据层会整体降级
//      （表现为「暂时无法保存确认状态」无法点掉内测声明）。直接注入一个 32 字节
//      随机密钥（base64）即可启用加密；为跨重启稳定，保存到 $CORUM_HOME 下自有文件。
const homeDir = process.env.CORUM_HOME ?? join(homedir(), '.corum')
const masterKeyFile = join(homeDir, '.corum-web-master-key')
let masterKey = process.env.CORUM_CREDENTIALS_MASTER_KEY
if (masterKey === undefined || masterKey === '') {
  try {
    if (existsSync(masterKeyFile)) {
      masterKey = readFileSync(masterKeyFile, 'utf8').trim()
    }
  } catch { /* 忽略，重新生成 */ }
  if (masterKey === undefined || masterKey === '') {
    masterKey = randomBytes(32).toString('base64')
    try {
      writeFileSync(masterKeyFile, masterKey, { mode: 0o600 })
    } catch { /* 写失败不影响本次运行 */ }
  }
}

const env = {
  ...process.env,
  CORUM_DESKTOP_PROFILE: process.env.CORUM_DESKTOP_PROFILE ?? 'web',
  CORUM_DESKTOP_MODE: process.env.CORUM_DESKTOP_MODE ?? 'ide',
  CORUM_PARENT_PID: String(process.pid),
  CORUM_CREDENTIALS_MASTER_KEY: masterKey,
}

const child = spawn(process.execPath, [bridgePath], {
  env,
  // 注意：stdin 必须是保持打开的 'pipe'（不要 'ignore'，否则子进程立即收到
  // EOF，dsh 的父进程看门狗会把 EOF 误判为「Electron 主进程已退出」而自杀）。
  // 我们从不向 child.stdin 写入也不 end 它，写端一直由本进程持有，故不会 EOF。
  stdio: ['pipe', 'pipe', 'inherit'],
})

let url = null
const rl = createInterface({ input: child.stdout })
rl.on('line', (line) => {
  const t = line.trim()
  if (t === '') return
  let msg
  try {
    msg = JSON.parse(t)
  } catch {
    return
  }
  if (msg.type === 'ready' && typeof msg.authenticatedUrl === 'string') {
    url = msg.authenticatedUrl
    console.log('\n✅ Corum 已就绪。在浏览器中打开以下地址：\n')
    console.log('   ' + url + '\n')
    maybeOpen(url)
  }
})

// 尝试用系统默认浏览器打开（失败时静默，用户仍可手动点击上面的 URL）。
function maybeOpen(u) {
  if (process.env.CORUM_WEB_NO_OPEN === '1') return
  for (const cmd of ['xdg-open', 'gnome-open', 'kde-open', 'open']) {
    try {
      spawn(cmd, [u], { stdio: 'ignore', detached: true }).unref()
      return
    } catch {
      // 尝试下一个
    }
  }
}

// 3) 优雅退出：转发信号给后端子进程。
function shutdown(sig) {
  try {
    child.kill(sig)
  } catch {
    // 已退出
  }
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
child.on('exit', (code) => process.exit(code ?? 0))
