#!/usr/bin/env node
// corum 会话日志监督器：把 zstd 压缩的 session jsonl 压成可读时间线。
//
// 用途：派活给 corum 之后，不开 UI / 不打断它，也能看清「这一轮在干什么、模型是谁、
// 每一步调了什么工具、最后停在哪」。监督与复盘的通用工具，与具体任务无关。
//
// 用法：
//   node scripts/session-watch.mjs                      # 最近活跃会话的时间线
//   node scripts/session-watch.mjs --session 5348decc   # 指定会话（id 前缀）
//   node scripts/session-watch.mjs --list               # 最近 10 个会话概览（含实际模型）
//   node scripts/session-watch.mjs --models             # 额外打印模型路由（主/子 Agent 实际生效值）
//   node scripts/session-watch.mjs --full               # 附带未归类事件
//   node scripts/session-watch.mjs --time               # 每行带时间戳（识别卡顿/长跑）
//   node scripts/session-watch.mjs --session X --follow # 持续观察：新增事件实时打印，
//                                                       # turn/end、静默 600s 或 60 分钟上限即退出
//   node scripts/session-watch.mjs --home packages/desktop/.corum-verify-home
//
// 日志布局：<home>/sessions/<project-slug>/<sessionId>/session.v2.jsonl.zstd
// 读取必须走 ./session-log.mjs（多 frame zstd，Node 内置解压只解第一帧）。
import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSessions, loadSessionLog } from './session-log.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const home = resolve(repoRoot, String(flag('home', 'packages/desktop/.corum-dev-home')))
const want = String(flag('session', ''))
const full = argv.includes('--full')
const listMode = argv.includes('--list')
const modelsMode = argv.includes('--models')
const timeMode = argv.includes('--time')
const followMode = argv.includes('--follow')
const listLimit = Number(flag('limit', 10))

let all
try {
  all = collectSessions(home)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

if (listMode) {
  console.log(`会话日志 ${all.length} 条（home=${home}），最近 ${Math.min(listLimit, all.length)} 条：\n`)
  for (const t of all.slice(0, listLimit)) {
    const rows = loadSessionLog(t.fp).rows
    const session = rows.find((r) => r.type === 'session')
    const models = new Set()
    for (const r of rows) for (const m of JSON.stringify(r).matchAll(/"model":"([^"]+)"/g)) models.add(m[1])
    const calls = rows.filter((r) => r.type === 'tool/call').length
    const hdr = rows.find((r) => r.type === 'session') ?? {}
    console.log(
      `▶ ${t.sid.slice(0, 8)}  ${new Date(t.mtime).toLocaleString()}  preset=${session?.agentPreset ?? hdr.agentPreset ?? '?'}` +
        `  depth=${hdr.delegationDepth ?? '?'}  事件=${rows.length}  调用=${calls}  末事件=${rows.at(-1)?.type ?? '-'}`,
    )
    console.log(`   ${t.proj}`)
    console.log(`   模型: ${[...models].join(', ') || '(无)'}`)
  }
  process.exit(0)
}

const target = want ? all.find((x) => x.sid.startsWith(want)) : all[0]
if (!target) {
  console.error(want ? `找不到会话前缀 ${want}` : '没有任何会话日志')
  process.exit(1)
}

let rows = loadSessionLog(target.fp).rows
console.log(`会话 ${target.sid}  (${target.proj})`)
console.log(
  `事件 ${rows.length} 条｜最后写入 ${new Date(target.mtime).toLocaleString()}（${Math.round((Date.now() - target.mtime) / 1000)}s 前）`,
)
console.log()

if (modelsMode) {
  const session = rows.find((r) => r.type === 'session')
  console.log(`[路由] preset=${session?.agentPreset ?? '?'} depth=${session?.delegationDepth ?? 0} cwd=${session?.cwd ?? '?'}`)
  for (const r of rows) {
    const d = r.data ?? {}
    if (r.type === 'model/selection') console.log(`[路由] 主 Agent → ${d.provider}/${d.model} effort=${d.reasoningEffort ?? '-'}`)
    else if (r.type === 'subagent/descriptor')
      console.log(
        `[路由] 子 Agent ${d.label ?? ''} → ${d.agentProvider}/${d.agentModel} effort=${d.agentReasoningEffort ?? '-'} mode=${d.mode ?? '-'} provider=${d.provider ?? '-'}`,
      )
  }
  const distinct = new Set()
  for (const r of rows) for (const m of JSON.stringify(r).matchAll(/"model":"([^"]+)"/g)) distinct.add(m[1])
  console.log(`[路由] 日志中出现过的模型: ${[...distinct].join(', ') || '(无)'}`)
  console.log()
}

const stamp = (r) => (timeMode && typeof r.time === 'number' ? `[${new Date(r.time).toLocaleTimeString()}] ` : '')
const clip = (s, n) => {
  const x = String(s ?? '').replace(/\s+/g, ' ')
  return x.length > n ? x.slice(0, n) + '…' : x
}

/** 渲染 rows[from..]；渲染过的进度由调用方用 cursor 记录。 */
function renderRows(from) {
  for (const r of rows.slice(from)) {
    const d = r.data ?? {}
    switch (r.type) {
      case 'session':
        console.log(`${stamp(r)}[session] preset=${d.agentPreset} cwd=${d.cwd}`)
        break
      case 'user/message':
        if (d.source?.kind === 'user') console.log(`\n${stamp(r)}[用户] ${clip(d.content?.[0]?.text, 200)}`)
        else if (full) console.log(`${stamp(r)}[注入] ${clip(d.content?.[0]?.text, 140)}`)
        break
      // 注意字段路径（2026-09-14 踩过）：assistant/message 的正文在
      // `data.message.content[]`（段类型 text / reasoning / tool-call），
      // 不是 `data.content`；tool/call 的实参在 `data.arguments`（JSON 字符串）；
      // tool/result 的文本在 `data.message.content[0].content[].text`。
      // 读错路径会把「只有思考没有正文」误判成「消息全空」。
      case 'assistant/message': {
        const parts = d.message?.content ?? d.content ?? []
        const text = parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join(' ')
        const reasoning = parts
          .filter((p) => p.type === 'reasoning')
          .map((p) => p.text ?? '')
          .join('')
        const toolCalls = parts.filter((p) => p.type === 'tool-call').length
        const suffix = toolCalls ? ` （+${toolCalls} 个工具调用）` : ''
        if (text.trim()) console.log(`${stamp(r)}[助手] ${clip(text, 240)}${suffix}`)
        else if (reasoning) console.log(`${stamp(r)}[思考 ${reasoning.length} 字]${suffix}`)
        break
      }
      case 'tool/call':
      case 'tool/call/start':
      case 'tool/start': {
        const raw = d.arguments ?? d.args ?? d.input
        let brief = raw
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
          brief = parsed?.command ?? parsed?.file_path ?? parsed?.pattern ?? parsed
        } catch {}
        console.log(`${stamp(r)}  → ${d.name ?? d.tool ?? '?'} ${clip(typeof brief === 'string' ? brief : JSON.stringify(brief ?? {}), 170)}`)
        break
      }
      case 'tool/result':
      case 'tool/end':
      case 'tool/result/end': {
        const block = Array.isArray(d.message?.content) ? d.message.content[0] : undefined
        const inner = Array.isArray(block?.content) ? block.content.map((p) => p.text ?? '').join('') : undefined
        const isErr = block?.isError === true || d.isError === true || d.error !== undefined
        const body = clip(inner ?? (typeof d.content === 'string' ? d.content : JSON.stringify(d.result ?? d.content ?? d)), 280)
        console.log(`${stamp(r)}  ${isErr ? '✗' : '✓'} ${d.name ?? ''} ${body}`)
        break
      }
      case 'stop':
      case 'turn/end':
        console.log(`${stamp(r)}[turn] ${r.type} reason=${d.reason ?? d.stopReason ?? '-'}`)
        break
      default:
        if (full) console.log(`${stamp(r)}[${r.type}] ${clip(JSON.stringify(d), 160)}`)
    }
  }
}

renderRows(0)
let cursor = rows.length

if (followMode) {
  const capMs = Number(flag('cap', 60)) * 60_000
  const quietMs = Number(flag('quiet', 600)) * 1000
  const started = Date.now()
  const treeSince = started - 10 * 60_000
  console.log(`\n[follow] 观察中：新增事件实时打印；turn/end、静默 ${quietMs / 1000}s 或 ${capMs / 60_000} 分钟上限即退出`)
  for (;;) {
    await new Promise((r) => setTimeout(r, 15_000))
    const before = cursor
    rows = loadSessionLog(target.fp).rows
    const fresh = rows.slice(before)
    if (fresh.length) renderRows(before)
    cursor = rows.length
    // 静默判据取**整棵树**的最近写入（2026-09-14 教训：父 Agent 在等前台子 Agent 时
    // 自己不写事件，只看被盯那份日志会把「子 Agent 正在狂跑」误判成「整棵树卡死」，
    // 于是 watcher 提前退出、监督方整夜无人唤醒）。退出时打印最后在写的是谁。
    const recent = collectSessions(home).filter((x) => x.mtime > started - 30 * 60_000)
    const newest = recent.reduce((a, b) => (b.mtime > (a?.mtime ?? 0) ? b : a), null)
    const quietFor = Date.now() - (newest?.mtime ?? statSync(target.fp).mtimeMs)
    const quietWho = newest ? `${newest.sid.slice(0, 8)} @${new Date(newest.mtime).toLocaleTimeString()}` : '(未知)'
    if (fresh.some((r) => r.type === 'turn/end' || r.type === 'session/end-seed')) {
      const calls = rows.filter((r) => r.type === 'tool/call').length
      console.log(`\n[follow] ✅ 本轮结束｜本会话共 ${rows.length} 事件 / ${calls} 次工具调用`)
      console.log('[follow] 各 turn 的产出（正文/思考/工具调用）:')
      const byTurn = {}
      for (const r of rows.filter((x) => x.type === 'assistant/message')) {
        const parts = r.data?.message?.content ?? r.data?.content ?? []
        const t = r.data?.turn ?? '?'
        byTurn[t] ??= { text: 0, reasoning: 0, tool: 0 }
        for (const p of parts) {
          if (p.type === 'text') byTurn[t].text += (p.text ?? '').length
          else if (p.type === 'reasoning') byTurn[t].reasoning += (p.text ?? '').length
          else if (p.type === 'tool-call') byTurn[t].tool += 1
        }
      }
      for (const [t, s] of Object.entries(byTurn)) {
        console.log(`  turn ${t}: 正文 ${s.text} 字 / 思考 ${s.reasoning} 字 / 工具调用 ${s.tool}`)
      }
      break
    }
    if (quietFor > quietMs) {
      console.log(`\n[follow] ⏸ 整棵树静默 ${Math.round(quietFor / 1000)}s（最后写入：${quietWho}），退出观察`)
      break
    }
    if (Date.now() - started > capMs) {
      console.log(`\n[follow] ⌛ 到达 ${capMs / 60_000} 分钟观察上限（最后写入：${quietWho}）`)
      break
    }
  }
  console.log('\n[follow] 退出时的树状态（近 10 分钟有写入的会话）：')
  for (const s of collectSessions(home).filter((x) => x.mtime > treeSince).slice(0, 8)) {
    const r2 = loadSessionLog(s.fp).rows
    const hdr = r2.find((r) => r.type === 'session') ?? {}
    console.log(
      `  ${s.sid.slice(0, 16).padEnd(17)} depth=${hdr.delegationDepth ?? '?'} 事件=${String(r2.length).padStart(4)}` +
        ` 调用=${String(r2.filter((r) => r.type === 'tool/call').length).padStart(4)} 末事件=${r2.at(-1)?.type ?? '-'} @${new Date(s.mtime).toLocaleTimeString()}`,
    )
  }
}
