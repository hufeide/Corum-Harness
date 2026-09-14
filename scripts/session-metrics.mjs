#!/usr/bin/env node
// corum 会话效率复盘：时间都去哪了？
//
// 用途：一轮委派跑完之后，用事件时间戳回答「模型慢还是工具慢、有没有卡死的命令、
// 有没有反复改同一个文件、有没有重跑整份守卫」。用于评估子 Agent 的执行效率，
// 与具体任务无关。
//
// 用法：
//   node scripts/session-metrics.mjs                    # 最近 5 个会话
//   node scripts/session-metrics.mjs 5348decc decfe34a  # 指定会话（id 前缀，可多个）
//   node scripts/session-metrics.mjs --home packages/desktop/.corum-verify-home
//   node scripts/session-metrics.mjs --limit 20
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSessions, loadSessionLog } from './session-log.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const home = resolve(repoRoot, String(flag('home', 'packages/desktop/.corum-dev-home')))
const limit = Number(flag('limit', 5))
const want = argv.filter((a) => !a.startsWith('--') && a !== String(flag('home', '')) && a !== String(flag('limit', '')))

let found
try {
  found = collectSessions(home)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
if (want.length) found = found.filter((s) => want.some((w) => s.sid.startsWith(w)))

const fmt = (ms) =>
  `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

for (const t of found.slice(0, want.length ? found.length : limit)) {
  let rows
  try {
    rows = loadSessionLog(t.fp).rows
  } catch (e) {
    console.log(`\n══════ ${t.sid.slice(0, 24)}  解码失败: ${e.message}`)
    continue
  }
  if (rows.length === 0) continue

  const session = rows.find((r) => r.type === 'session')
  const times = rows.map((r) => r.time).filter((x) => typeof x === 'number')
  const t0 = Math.min(...times, session?.createdAt ?? Infinity)
  const t1 = Math.max(...times)
  const calls = rows.filter((r) => r.type === 'tool/call')
  const results = rows.filter((r) => r.type === 'tool/result')
  const hist = {}
  for (const c of calls) hist[c.data?.name ?? '?'] = (hist[c.data?.name ?? '?'] ?? 0) + 1
  const errs = results.filter((r) => JSON.stringify(r.data).includes('"isError":true')).length

  const steps = []
  let cur = null
  for (const r of rows) {
    if (r.type === 'step/start') cur = { start: r.time, n: r.data?.step }
    else if (r.type === 'step/end' && cur) {
      steps.push({ ...cur, end: r.time, ms: r.time - cur.start })
      cur = null
    }
  }

  const rt = []
  for (const c of calls) {
    const res = results.find((r) => r.data?.message?.source?.callId === c.data?.callId)
    if (res && typeof c.time === 'number' && typeof res.time === 'number') rt.push({ name: c.data?.name, ms: res.time - c.time })
  }
  const sum = (a) => a.reduce((x, y) => x + y, 0)
  const byTool = {}
  for (const x of rt) {
    const k = byTool[x.name] ?? (byTool[x.name] = { n: 0, ms: 0, max: 0 })
    k.n++
    k.ms += x.ms
    k.max = Math.max(k.max, x.ms)
  }

  const stepMs = sum(steps.map((s) => s.ms))
  const rtMs = sum(rt.map((x) => x.ms))
  console.log(`\n══════ ${t.sid.slice(0, 24)}  preset=${session?.agentPreset} depth=${session?.delegationDepth ?? 0}`)
  console.log(
    `  跨度 ${fmt(t1 - t0)}（${new Date(t0).toLocaleTimeString()} → ${new Date(t1).toLocaleTimeString()}）｜事件 ${rows.length}｜工具调用 ${calls.length}｜失败结果 ${errs}`,
  )
  console.log(
    `  工具直方图: ${Object.entries(hist)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`)
      .join('  ')}`,
  )
  console.log(
    `  step 总耗时 ${fmt(stepMs)}（${steps.length} 步，均值 ${steps.length ? Math.round(stepMs / steps.length / 1000) : 0}s）｜工具往返 ${fmt(rtMs)}（均值 ${rt.length ? Math.round(rtMs / rt.length / 1000) : 0}s）｜模型侧占比 ${stepMs ? Math.round(((stepMs - rtMs) / stepMs) * 100) : 0}%`,
  )
  const slow = Object.entries(byTool)
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 6)
  console.log('  最耗时的工具（累计/次数/单次最大）:')
  for (const [k, v] of slow) console.log(`    ${String(k).padEnd(12)} ${fmt(v.ms)}  ${String(v.n).padStart(3)} 次  最大 ${(v.max / 1000).toFixed(1)}s`)

  const edits = calls.filter((c) => ['edit', 'write'].includes(c.data?.name))
  const perFile = {}
  for (const e of edits) {
    let a = {}
    try {
      a = JSON.parse(e.data?.arguments ?? '{}')
    } catch {}
    const p = a.file_path ?? a.path ?? '?'
    perFile[p] = (perFile[p] ?? 0) + 1
  }
  const hot = Object.entries(perFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  if (hot.length) console.log(`  写入热点: ${hot.map(([p, n]) => `${p.split('/').pop()}×${n}`).join('  ')}`)

  const guardRuns = calls.filter(
    (c) => /verify-fork-drift\.sh/.test(String(c.data?.arguments ?? '')) && !/grep|sed -n|head|cat /.test(String(c.data?.arguments ?? '').slice(0, 40)),
  )
  console.log(`  疑似「跑整份守卫」次数: ${guardRuns.length}`)
  const hung = rt.filter((x) => x.ms > 120000)
  if (hung.length) console.log(`  ⚠ 单次 >120s 的工具调用 ${hung.length} 次: ${hung.map((x) => `${x.name}(${Math.round(x.ms / 1000)}s)`).join(' ')}`)
}
if (!found.length) console.error(`没有匹配的会话（home=${home}${want.length ? `, 前缀=${want.join(',')}` : ''}）`)
