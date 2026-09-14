#!/usr/bin/env node
/**
 * agent-behavior-audit.mjs —— 「**我们告诉 Agent 什么**」与「**Agent 实际做了什么**」的全量对照。
 *
 * 用途（监督工具，与具体任务无关）：把整个会话语料扫一遍，量化几个**能力已存在但可能没人用**的行为，
 * 例如 `run_in_background`、per-call `timeoutMs`、`workdir`（替代 `cd`）、只读研究工具的选择、
 * `orchestrate` 的任务级 `model`、`send_message` 插话等。用于发现「提示词缺口 / 能力闲置」，
 * 并作为后续整改轮的**前后对照基线**。
 *
 * 用法：
 *   node scripts/agent-behavior-audit.mjs [--home <dir>] [--since 2026-09-10] [--top 20]
 *
 * 判据说明（每条都能复算）：
 *   · 后台：bash 实参里 `run_in_background: true`；
 *   · per-call 超时：bash 实参里出现 `timeoutMs`；
 *   · workdir：bash 实参里出现 `workdir`（官方 description 明确要求用它替代 `cd`）；
 *   · 命令里 `cd `：命令串以 `cd ` 开头或含 ` && cd `（B 之后应逐步减少）；
 *   · `sleep N` 轮询：命令里出现 `sleep ` 且同一调用内没有后台标志（常被当成"等一等"的替代）；
 *   · 阻塞长调用：call→result 的墙钟 > 120s（含 ≥299s 的"疑似撞死线"分档）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSessions, loadSessionLog } from './session-log.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const HOME = resolve(REPO, String(flag('home', 'packages/desktop/.corum-dev-home')))
const SINCE = flag('since', false) ? Date.parse(String(flag('since'))) : 0
const TOP = Number(flag('top', 15))

/** 沙箱拒绝标记（工具结果里的**逐字**文本，与 `tool-bash` 描述里的写法一致）。 */
const DENIAL_MARKER = /\[sandbox: file access denied under [a-z-]+ mode\]/
/** 只读关键词启发式（判据边界见报告：可能假阳性，抽样人工核实）。 */
const READONLY_HINT = /read-only|do not modify|don't modify|不要修改|只读|research task|read only|调研|investigate|investigation|survey|scan the repo|explore/i

/** 取工具结果的可见文本（content 块数组，非 tool/call 的参数字符串）。 */
const textOfResult = (r) => {
  const content = r.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => (Array.isArray(block.content) ? block.content.map((x) => x.text ?? '') : []))
    .join('\n')
}

const stats = {
  sessions: 0,
  events: 0,
  calls: 0,
  tools: new Map(),
  bash: { total: 0, background: 0, timeoutMs: 0, workdir: 0, cdPrefix: 0, sleep: 0, long120: 0, long299: 0, byDay: new Map() },
  research: 0,
  workerSubagent: 0,
  orchestrate: 0,
  orchestrateTaskModel: 0,
  steer: 0,
  jobTools: 0,
  // 2026-09-14（委派正确性 + 效率合并轮）：沙箱拒绝/升级与只读错派三组统计。
  sandbox: { denialMarkers: 0, denialSessions: new Set(), escalationCalls: 0, escalationSessions: new Set(), approvalAsked: 0, escalationTools: new Map() },
  readonlyMisroute: { subagent: 0, keywordFlagged: 0, samples: [] },
  freshShell: { cdThenBareRelative: 0, sessions: new Set(), samples: [] },
}
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

for (const s of collectSessions(HOME)) {
  if (s.mtime < SINCE) continue
  let rows
  try {
    rows = loadSessionLog(s.fp).rows
  } catch {
    continue
  }
  const calls = rows.filter((r) => r.type === 'tool/call')
  if (calls.length === 0) continue
  stats.sessions++
  stats.events += rows.length
  const results = rows.filter((r) => r.type === 'tool/result')
  const sessionId = s.fp.split('/').slice(-2)[0]
  // 沙箱拒绝标记（工具的**结果文本**里逐字出现，不是被拒的命令本身）。
  for (const r of results) {
    const text = String(r.data?.message?.content ?? '').length > 0 ? textOfResult(r) : ''
    if (DENIAL_MARKER.test(text)) {
      stats.sandbox.denialMarkers++
      stats.sandbox.denialSessions.add(sessionId)
    }
  }
  // 审批弹窗（`approval/asked` 是会话事件，不是工具调用）。
  for (const r of rows) if (r.type === 'approval/asked') stats.sandbox.approvalAsked++
  // 「上一条含 cd、本条不含 cd/workdir 且以相对路径开头」——B 之后的新失效形态候选。
  let prevHadCd = false
  for (const c of calls) {
    stats.calls++
    const name = String(c.data?.name ?? '?')
    bump(stats.tools, name)
    const args = String(c.data?.arguments ?? '')
    if (/"sandbox_permissions"\s*:/.test(args)) {
      stats.sandbox.escalationCalls++
      stats.sandbox.escalationSessions.add(sessionId)
      bump(stats.sandbox.escalationTools, name)
    }
    if (name === 'bash') {
      stats.bash.total++
      const day = new Date(c.time).toISOString().slice(0, 10)
      if (!stats.bash.byDay.has(day)) stats.bash.byDay.set(day, { n: 0, bg: 0 })
      stats.bash.byDay.get(day).n++
      if (/"run_in_background"\s*:\s*true/.test(args)) {
        stats.bash.background++
        stats.bash.byDay.get(day).bg++
      }
      if (/"timeoutMs"\s*:/.test(args)) stats.bash.timeoutMs++
      if (/"workdir"\s*:/.test(args)) stats.bash.workdir++
      let cmd = ''
      let hasWorkdir = false
      try {
        const parsed = JSON.parse(args)
        cmd = String(parsed.command ?? '')
        hasWorkdir = parsed.workdir !== undefined
      } catch {}
      const hasCd = /(^|&&|;|\|\|)\s*cd\s+\S/.test(cmd)
      if (/^\s*cd\s|&&\s*cd\s/.test(cmd)) stats.bash.cdPrefix++
      if (/\bsleep\s+\d/.test(cmd)) stats.bash.sleep++
      // 只在「上一条真的换过目录」且「本条没换、没 workdir、又用相对路径」时才计入。
      if (prevHadCd && !hasCd && !hasWorkdir && /^\s*(\.\/|\.\.\/|[\w.-]+\/)/.test(cmd)) {
        stats.freshShell.cdThenBareRelative++
        stats.freshShell.sessions.add(sessionId)
        if (stats.freshShell.samples.length < 8) {
          stats.freshShell.samples.push({ sessionId, command: cmd.slice(0, 120) })
        }
      }
      prevHadCd = hasCd
      const res = results.find((r) => r.data?.message?.source?.callId === c.data?.callId)
      if (res && typeof res.time === 'number' && typeof c.time === 'number') {
        const ms = res.time - c.time
        if (ms > 120_000) stats.bash.long120++
        if (ms >= 299_000) stats.bash.long299++
      }
    } else {
      prevHadCd = false
    }
    if (name === 'subagent_research') stats.research++
    if (name === 'subagent') {
      stats.workerSubagent++
      // 只读调研错派到写能力工具：关键词启发式（read-only / 不要修改 / 调研 / investigate …）。
      stats.readonlyMisroute.subagent++
      let prompt = ''
      let label = ''
      try {
        const parsed = JSON.parse(args)
        prompt = String(parsed.prompt ?? '')
        label = String(parsed.description ?? '')
      } catch {}
      if (READONLY_HINT.test(prompt)) {
        stats.readonlyMisroute.keywordFlagged++
        if (stats.readonlyMisroute.samples.length < 5) {
          stats.readonlyMisroute.samples.push({ sessionId, label, snippet: prompt.replace(/\s+/g, ' ').slice(0, 140) })
        }
      }
    }
    if (name === 'orchestrate') {
      stats.orchestrate++
      if (/"model"\s*:\s*\{/.test(args)) stats.orchestrateTaskModel++
    }
    if (['send_message', 'interrupt_agent'].includes(name)) stats.steer++
    if (['job_output', 'job_kill', 'job_list'].includes(name)) stats.jobTools++
  }
}

const pct = (a, b) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`)
console.log(`\n=== corum Agent 行为对照（home=${HOME}${SINCE ? ` since=${new Date(SINCE).toISOString().slice(0, 10)}` : ''}）===`)
console.log(`会话 ${stats.sessions}｜事件 ${stats.events}｜工具调用 ${stats.calls}`)
console.log(`\n工具 TOP ${TOP}:`)
for (const [k, v] of [...stats.tools].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`  ${String(v).padStart(5)}  ${k}`)
const b = stats.bash
console.log(`\nbash 调用 ${b.total}：`)
console.log(`  run_in_background  ${String(b.background).padStart(4)}  (${pct(b.background, b.total)})   ← 能力已存在，是否被用`)
console.log(`  per-call timeoutMs ${String(b.timeoutMs).padStart(4)}  (${pct(b.timeoutMs, b.total)})   ← 长命令应显式给`)
console.log(`  workdir            ${String(b.workdir).padStart(4)}  (${pct(b.workdir, b.total)})   ← 官方要求用它替代 cd`)
console.log(`  命令含 cd          ${String(b.cdPrefix).padStart(4)}  (${pct(b.cdPrefix, b.total)})`)
console.log(`  命令含 sleep N     ${String(b.sleep).padStart(4)}  (${pct(b.sleep, b.total)})   ← 有 job_output 就别睡`)
console.log(`  >120s 阻塞         ${String(b.long120).padStart(4)}  (${pct(b.long120, b.total)})`)
console.log(`  ≥299s 疑似撞死线   ${String(b.long299).padStart(4)}`)
console.log(`\n委派形态：subagent ${stats.workerSubagent}｜subagent_research ${stats.research}｜orchestrate ${stats.orchestrate}（其中带任务级 model ${stats.orchestrateTaskModel}）`)
console.log(`插话/终止：send_message+interrupt_agent ${stats.steer}｜job_* 工具 ${stats.jobTools}`)

// ── 2026-09-14 新增三组（委派正确性 + 效率合并轮的前后对照面）───────────────
const sd = stats.sandbox
console.log(`\n沙箱与升级：`)
console.log(`  拒绝标记（结果文本逐字）  ${String(sd.denialMarkers).padStart(4)}  （涉及 ${sd.denialSessions.size} 个会话）`)
console.log(`  带 sandbox_permissions 的调用 ${String(sd.escalationCalls).padStart(4)}  （${sd.escalationSessions.size} 个会话${sd.escalationTools.size === 0 ? '' : `；工具：${[...sd.escalationTools].map(([k, v]) => `${k}×${v}`).join(', ')}`}）`)
console.log(`  审批弹窗 approval/asked   ${String(sd.approvalAsked).padStart(4)}`)
const rm = stats.readonlyMisroute
console.log(`\n只读错派（关键词启发式，可能假阳性）：`)
console.log(`  subagent 调用 ${rm.subagent}｜其中 prompt 含只读关键词 ${rm.keywordFlagged}  (${pct(rm.keywordFlagged, rm.subagent)})`)
for (const sample of rm.samples) console.log(`    · ${sample.label || '(no label)'} :: ${sample.snippet}`)
const fs2 = stats.freshShell
console.log(`\n新失效形态（B 后每条命令新 shell）：`)
console.log(`  上一条 cd 过、本条相对路径且未给 workdir  ${fs2.cdThenBareRelative}  （涉及 ${fs2.sessions.size} 个会话）`)
for (const sample of fs2.samples) console.log(`    · ${sample.sessionId} :: ${sample.command}`)

console.log(`\n按日（bash 总数 / 其中后台）：`)
for (const [day, v] of [...b.byDay].sort()) console.log(`  ${day}  ${String(v.n).padStart(4)} / ${v.bg}`)
