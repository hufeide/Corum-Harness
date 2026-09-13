#!/usr/bin/env node
/**
 * tasklog-open.mjs —— 从 `docs/tasks/log.jsonl` **渲染**「未关闭清单」与「同 key 异值冲突」。
 *
 * 由来（台账 `docs.status-lists`，2026-09-13 用户拍板「排期」前的最低成本一半）：
 * 交接文档里那份「待办队列」是**手维护**的，于是它必然过期——2026-09-13 实测：
 * 文档 §0 写「领先 origin 6 个提交」而实况是 9；§3-B 漏了两条「待用户定」的条目。
 * 纪律是「状态清单由 tasklog 渲染」，本脚本就是那个渲染器：**清单是派生视图，
 * JSONL 才是事实**。
 *
 * 口径（与 tasklog 的设计一致）：
 * - **同 key 最后一条说了算**（append-only 日志 + 后写覆盖前写）；
 * - `decision` 是唯一能「赢」的 kind（它改状态也改值）；
 * - **同 key 不同 value = 冲突**（要么是追记时写错了 value，要么真有两套说法）——
 *   冲突单独列出，供 curation 处理；`--check` 模式下有冲突即退出码 1（可当守卫用）。
 *
 * 用法：
 *   node scripts/tasklog-open.mjs            # 渲染 markdown 到 stdout
 *   node scripts/tasklog-open.mjs --check    # 只报冲突/异常，退出码 0/1
 *   node scripts/tasklog-open.mjs --json     # 机器可读
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOG = join(ROOT, 'docs/tasks/log.jsonl')

/** 未关闭 = 最后一条不是 done/dropped。 */
const CLOSED = new Set(['done', 'dropped'])

function loadEntries(path) {
  const rows = []
  const bad = []
  const lines = readFileSync(path, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const text = line.trim()
    if (text === '') return
    try {
      rows.push(JSON.parse(text))
    } catch {
      bad.push({ line: index + 1, text: text.slice(0, 120) })
    }
  })
  return { rows, bad }
}

function build(rows) {
  const byKey = new Map()
  for (const row of rows) {
    const key = row.key ?? row.id
    if (key === undefined) continue
    const list = byKey.get(key) ?? []
    list.push(row)
    byKey.set(key, list)
  }
  const open = []
  const conflicts = []
  for (const [key, list] of byKey) {
    // `supersedes`：显式裁决——后继决定声明它取代了哪个旧 value，被取代的不再算冲突
    // （与设计里的字段同义：decision 是唯一能「赢」的条目）。
    const supersededValues = new Set()
    for (const row of list) {
      const s = row.supersedes
      if (typeof s === 'string' && s !== '') supersededValues.add(s)
      else if (Array.isArray(s)) for (const v of s) if (typeof v === 'string') supersededValues.add(v)
    }
    const values = new Set(
      list.filter(row => row.kind === 'decision' && typeof row.value === 'string' && row.value !== '')
        .map(row => row.value)
        .filter(value => !supersededValues.has(value)),
    )
    if (values.size > 1) conflicts.push({ key, values: [...values] })
    const last = list[list.length - 1]
    if (!CLOSED.has(last.status)) {
      open.push({
        key,
        status: last.status ?? 'open',
        kind: last.kind ?? 'todo',
        id: last.id ?? key,
        scope: Array.isArray(last.scope) ? last.scope : [],
        created: last.created ?? '',
        author: last.author ?? '',
        summary: String(last.text ?? '').replace(/\s+/g, ' ').slice(0, 160),
      })
    }
  }
  open.sort((a, b) => (a.scope[0] ?? '').localeCompare(b.scope[0] ?? '') || a.key.localeCompare(b.key))
  return { open, conflicts }
}

function render(open, conflicts) {
  const out = []
  out.push(`### 未关闭 ${open.length} 条（由 \`scripts/tasklog-open.mjs\` 从 \`docs/tasks/log.jsonl\` 渲染，勿手改）`)
  out.push('')
  let scope = null
  for (const row of open) {
    const group = row.scope[0] ?? '(no scope)'
    if (group !== scope) {
      scope = group
      out.push(`**${group}**`)
    }
    const who = row.author === 'user' ? '用户' : 'Agent'
    out.push(`- \`${row.status}\` **${row.key}**（${row.created}，${who}）— ${row.summary}`)
  }
  out.push('')
  if (conflicts.length > 0) {
    out.push(`### 同 key 异值冲突 ${conflicts.length} 组（curation 待办）`)
    out.push('')
    for (const c of conflicts) out.push(`- \`${c.key}\`：${c.values.map(v => `\`${v}\``).join(' vs ')}`)
  } else {
    out.push('### 同 key 异值冲突 0 组')
  }
  return out.join('\n')
}

const { rows, bad } = loadEntries(LOG)
const { open, conflicts } = build(rows)
const mode = process.argv[2]

if (mode === '--json') {
  process.stdout.write(`${JSON.stringify({ open, conflicts, malformed: bad }, null, 2)}\n`)
} else if (mode === '--check') {
  if (bad.length > 0) {
    for (const b of bad) console.error(`log.jsonl:${b.line} 不是合法 JSON：${b.text}`)
  }
  for (const c of conflicts) console.error(`同 key 异值：${c.key} → ${c.values.join(' | ')}`)
  console.log(`未关闭 ${open.length} 条；冲突 ${conflicts.length} 组；坏行 ${bad.length} 条`)
  process.exit(bad.length > 0 || conflicts.length > 0 ? 1 : 0)
} else {
  process.stdout.write(`${render(open, conflicts)}\n`)
}
