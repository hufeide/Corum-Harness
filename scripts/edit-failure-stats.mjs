#!/usr/bin/env node
/**
 * edit-failure-stats.mjs — 离线会话日志统计：edit/write 失败率 + bash 写文件绕道率。
 *
 * 背景：台账 `tool.edit.match-robustness`（2026-09-12 决定）要先测 1~2 天，看
 * 「策略类失败（file has not been read）」是否显著下降、而「匹配类失败
 * （old_string 未命中 / 多处命中）」占比是否上升，再决定是否做 B1-lite。
 * 本脚本就是那次「离线统计」的可复现实现（纯读日志，不改产品代码）。
 *
 * 用法：
 *   node scripts/edit-failure-stats.mjs [日志根目录 ...]
 *
 *   不带参数时扫描仓库内已知的 corum home（见 DEFAULT_ROOTS）。
 *   每个根目录会被递归查找 `session.v2.jsonl.zstd`。
 *
 * 输出：markdown 表格到 stdout（进度日志走 stderr）。
 *
 * 依赖：node（零第三方依赖）+ PATH 上的 `zstd` 命令（流式解压，绝不整文件读入内存）。
 *
 * 口径细节见产出报告 docs/analysis/edit-reliability-2026-09-13.md 的
 * 「方法学与口径说明」；脚本里每条判据都用注释标了出处。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'

/* ──────────────────────────── 配置 ──────────────────────────── */

/** 时间分档（按本机本地时区的日历日）。 */
const BUCKETS = [
  { name: '≤ 2026-09-10', max: '2026-09-10' },
  { name: '2026-09-11', dates: new Set(['2026-09-11']) },
  { name: '2026-09-12 ~ 09-13', dates: new Set(['2026-09-12', '2026-09-13']) },
  { name: '≥ 2026-09-14（预留）', min: '2026-09-14', hidden: true },
]

/**
 * 工具策略段 `corum:tool-policy` 的真正落地时刻：commit a0519453
 * `fix(corum): 指挥模式子 Agent 契约 + 工具策略段 + str_replace_editor 退场`
 * 2026-09-12 09:19:05 +0800。台账口头记的是「2026-09-11 上线」，git 事实是
 * 2026-09-11 用户定调、2026-09-12 上午才提交并重启生效——本脚本按 git 事实切。
 * 这一段写进系统提示，只对**之后新建的会话**生效，故这一对照按「会话开始时间」归属。
 */
const POLICY_LANDED_MS = Date.parse('2026-09-12T09:19:05+08:00')

const DEFAULT_ROOTS = [
  'packages/desktop/.corum-dev-home',
  'packages/desktop/.corum-dev-home-ide',
  'packages/desktop/.corum-verify-home',
  'packages/desktop/.corum-ide-home',
  '.corum-dev-home',
  '.corum-dev-home-ide',
  '.corum-ide-home',
]

const LOG_BASENAME = 'session.v2.jsonl.zstd'

/* ──────────────────────────── 小工具 ──────────────────────────── */

/** 本地日历日（YYYY-MM-DD）。日志的 `time` 是 epoch 毫秒。 */
function localDay(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function localStamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${localDay(ms)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function bucketOfDay(day) {
  for (const b of BUCKETS) {
    if (b.dates !== undefined && b.dates.has(day)) return b.name
    if (b.max !== undefined && day <= b.max) return b.name
    if (b.min !== undefined && day >= b.min) return b.name
  }
  return '(out of range)'
}

function findLogs(root, out) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      findLogs(full, out)
    } else if (e.isFile() && e.name === LOG_BASENAME) {
      out.push(full)
    }
  }
}

function pct(n, d) {
  if (d === 0) return '—'
  return `${((n / d) * 100).toFixed(1)}%`
}

function mdTable(headers, rows) {
  const out = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const r of rows) out.push(`| ${r.join(' | ')} |`)
  return out.join('\n')
}

/** 按「所有行都非零」过滤掉预留档，保持表格干净。 */
function visible(ordered, get) {
  return ordered.filter((n) => {
    const b = get(n)
    return b.edit.calls + b.write.calls + b.bash.calls + b.turns.size + b.sessions.size > 0
  })
}

/* ──────────────────── 错误文本 → 归类 ──────────────────── */

/**
 * 判据（全部取自 @deepseek-ai/dsh-fs-local / dsh-tool-fs 的错误文案与错误码）：
 *   FS_NOT_OBSERVED   → `cannot modify "<p>": file has not been read — read the file, then retry`
 *   FS_EDIT_NOT_FOUND → `cannot edit "<p>": old_string was not found` / `old_string must be non-empty`
 *   FS_AMBIGUOUS_EDIT → `cannot edit "<p>": old_string matched <n> times`
 *   FS_STALE_VERSION  → `cannot edit "<p>": file changed since it was read — re-read ...`
 * `str_replace_editor`（另一个工具，本次仅作对照）的文案是
 *   `edit requires reading "<p>" first` / `No replacement was performed, old_str ... did not appear verbatim ...`
 */
const POLICY_CLS = 'file-not-read（策略类）'
const MATCH_NOT_FOUND_CLS = 'old_string 未命中（匹配类）'
const MATCH_AMBIGUOUS_CLS = '多处命中 ambiguous（匹配类）'

function classifyError(text) {
  if (/file has not been read/.test(text)) return { cls: POLICY_CLS, code: 'FS_NOT_OBSERVED' }
  if (/edit requires reading .* first/.test(text)) return { cls: POLICY_CLS, code: 'SRE_requires_read' }
  if (/old_string was not found/.test(text) || /old_string must be non-empty/.test(text)) {
    return { cls: MATCH_NOT_FOUND_CLS, code: 'FS_EDIT_NOT_FOUND' }
  }
  if (/did not appear verbatim/.test(text)) return { cls: MATCH_NOT_FOUND_CLS, code: 'SRE_no_verbatim_match' }
  if (/old_string matched \d+ times/.test(text)) return { cls: MATCH_AMBIGUOUS_CLS, code: 'FS_AMBIGUOUS_EDIT' }
  const code = /\b(FS_[A-Z_]+)\b/.exec(text)
  if (code !== null) {
    const c = code[1]
    const cls = c === 'FS_EDIT_NOT_FOUND'
      ? MATCH_NOT_FOUND_CLS
      : c === 'FS_AMBIGUOUS_EDIT'
        ? MATCH_AMBIGUOUS_CLS
        : c === 'FS_NOT_OBSERVED'
          ? POLICY_CLS
          : '其它错误码'
    return { cls, code: c }
  }
  return { cls: '其它', code: null }
}

/** 其它类错误按「归一化首行」聚合，便于原样列出（不硬塞进已有类）。 */
function otherLabel(text) {
  const first = text.split('\n')[0].slice(0, 140)
  const trimmed = first.replace(/'\/[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"')
  return trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed
}

/* ──────────── BUG-28 与 B1-lite 相关的「锚点重试」判据 ──────────── */

/**
 * B1-lite 提议的三条能力里，两条（缩进空白容错 / CRLF 自动重试）可以离线反推：
 * 把 old_string 归一化（CRLF→LF、每行去尾随空白）后，看是否与**本会话之前成功过**
 * 的某个 old_string 相等。相等但原文不同 → 这一次失败本该被 B1-lite 的容错救回。
 */
function normalizeAnchor(s) {
  return s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
}

/* ──────────────── bash「写文件形态」判据 ──────────────── */

/**
 * 五种形态（台账口径）：
 *   redirect >      `> file`
 *   append >>       `>> file`
 *   tee             `tee [-a] file`
 *   sed -i          `sed -i` / `sed --in-place`
 *   python heredoc  `python3 - <<'EOF'` / `python3 <<'PY'`
 *
 * 三条判据，缺一不可（都是被数据逼出来的）：
 *  1) **先剥掉 heredoc 体**。否则 `cat > /tmp/x.mjs <<'EOF' … <div> … EOF`
 *     这种「用 heredoc 生成源码」的命令会把 JSX/HTML 里的 `>` 误判成重定向——
 *     实测这一条把「含重定向的 bash 调用」从 116 吹到 184。
 *  2) `>` 只认**命令位**：前面必须是行首 / 空白 / `;` `|` `&` `(` `)`。
 *     这样 `<span>`、`a->b` 里紧跟标识符的 `>` 全部出局。
 *  3) 目标不能以 `=` / `!` 开头（挡掉 `>=0` 这类比较式的残留）。
 *
 * 仍然**排除**（不算写文件）：fd 复制 `2>&1` / `>&2`（`>` 前是 `&`，不是命令位）。
 * 空设备 `/dev/null`、`/dev/stdout`、`/dev/stderr` 只在「真实目标」里排除
 * （「含写文件形态」仍算——它确实是重定向，只是不写文件）。
 *
 * 「真实目标」= 该调用的重定向/tee 目标里至少有一个不是空设备、不是纯 fd、
 * 不在 `/tmp`、`/var/tmp`、`/private/tmp`、`/var/folders` 下、不以 `.log` 结尾。
 */
const RE_HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
const RE_REDIRECT = /(^|[\s;|&()])(>>?)\s*('([^']*)'|"([^"]*)"|([^\s&|;<>()]+))/g
const RE_TEE = /(^|[\s;|&()])tee(?![\w-])((?:\s+-{1,2}[a-zA-Z-]+)*)\s+('([^']*)'|"([^"]*)"|([^\s&|;<>()]+))/
const RE_SED_INPLACE = /(^|[\s;|&()])sed(?![\w-])[^\n;&|]*?\s(-i|--in-place)(\s|$)/
const RE_PY_HEREDOC = /(^|[\s;|&()])python[0-9.]*\s+(-\s*)?-?\s*<</

const NULL_SINK = /^\/dev\/(null|stdout|stderr)$/

/** 把命令按行拆开，并丢弃 heredoc 体（判据 1）。 */
function shellLines(command) {
  const out = []
  const pending = []
  for (const line of command.split('\n')) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift()
      continue
    }
    out.push(line)
    RE_HEREDOC_START.lastIndex = 0
    let m
    while ((m = RE_HEREDOC_START.exec(line)) !== null) pending.push(m[2])
  }
  return out
}

function isScratchTarget(target) {
  if (NULL_SINK.test(target)) return true
  if (/^\d*$/.test(target)) return true
  if (/^(\/tmp\/|\/var\/tmp\/|\/private\/tmp\/|\/var\/folders\/)/.test(target)) return true
  if (/\.log$/.test(target)) return true
  return false
}

/** @returns {{forms: string[], realTargets: string[]}} */
function bashWriteForms(command) {
  const forms = []
  const targets = []
  let hasRedirect = false
  let hasAppend = false

  for (const line of shellLines(command)) {
    RE_REDIRECT.lastIndex = 0
    let m
    while ((m = RE_REDIRECT.exec(line)) !== null) {
      const target = m[4] ?? m[5] ?? m[6] ?? ''
      if (target.startsWith('=') || target.startsWith('!')) continue
      targets.push(target)
      if (m[2] === '>>') hasAppend = true
      else hasRedirect = true
    }

    const tee = RE_TEE.exec(line)
    if (tee !== null) {
      const target = tee[4] ?? tee[5] ?? tee[6] ?? ''
      if (!target.startsWith('=') && !target.startsWith('!')) {
        forms.push('tee')
        targets.push(target)
      }
    }
    if (RE_SED_INPLACE.test(line)) forms.push('sed -i')
    if (RE_PY_HEREDOC.test(line)) forms.push('python heredoc')
  }

  if (hasRedirect) forms.push('redirect >')
  if (hasAppend) forms.push('append >>')

  return { forms: [...new Set(forms)], realTargets: targets.filter((t) => !isScratchTarget(t)) }
}

/* ──────────────────────── 统计容器 ──────────────────────── */

function newAcc() {
  return {
    sessions: new Set(),
    turns: new Set(),
    days: new Set(),
    toolCalls: 0,
    edit: { calls: 0, fails: 0, errs: new Map() },
    write: { calls: 0, fails: 0, errs: new Map() },
    bash: { calls: 0, writeAny: 0, writeReal: 0, forms: new Map() },
    sre: { calls: 0, fails: 0 },
  }
}

function newDayRow() {
  return { sessions: new Set(), turns: new Set(), edit: 0, editFail: 0, write: 0, writeFail: 0, bash: 0, bw: 0 }
}

function note(acc, day, sessionId) {
  acc.days.add(day)
  acc.sessions.add(sessionId)
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by)
}

function tallyCall(acc, name, command) {
  acc.toolCalls++
  if (name === 'edit') acc.edit.calls++
  else if (name === 'write') acc.write.calls++
  else if (name === 'str_replace_editor') acc.sre.calls++
  else if (name === 'bash') {
    acc.bash.calls++
    const { forms, realTargets } = bashWriteForms(command)
    if (forms.length > 0) {
      acc.bash.writeAny++
      for (const f of forms) bump(acc.bash.forms, f)
      if (realTargets.length > 0) acc.bash.writeReal++
    }
  }
}

function tallyResult(acc, toolName, ok, errText) {
  if (toolName === 'edit' || toolName === 'write') {
    const t = toolName === 'edit' ? acc.edit : acc.write
    if (!ok) {
      t.fails++
      const { cls } = classifyError(errText)
      bump(t.errs, cls === '其它' || cls === '其它错误码' ? `${cls}｜${otherLabel(errText)}` : cls)
    }
  } else if (toolName === 'str_replace_editor' && !ok) {
    acc.sre.fails++
  }
}

/* ──────────────────────── 单文件分析 ──────────────────────── */

async function analyzeFile(file, ctx) {
  const child = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] })
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })

  const dirSessionId = path.basename(path.dirname(file))
  const callNames = new Map() // 本文件内出现过的 callId（用于 fork 前缀去重）
  const pending = new Map() // callId -> { name, args, turn }
  const succeededEditKeys = new Map() // BUG-28：本会话内成功过的 (file_path 归一化, old_string 精确)
  const succeededEditNorm = new Map() // B1-lite：同上，但 old_string 先归一化（CRLF/尾随空白）
  const failedEditKeys = new Map() // 同一 (file, old_string) 在本会话失败过几次
  const fileDangerous = []
  const fileNormRescued = []
  const fileDuplicateFail = []

  let sessionCreatedAt = null
  let sessionOrigin = null
  let sessionId = dirSessionId
  let sessionCwd = null

  const accsFor = (day) => {
    const out = []
    const b = ctx.buckets.get(bucketOfDay(day))
    if (b !== undefined) out.push(b)
    const p = ctx.policy.get(sessionCreatedAt !== null && sessionCreatedAt >= POLICY_LANDED_MS ? 'after' : 'before')
    if (p !== undefined) out.push(p)
    return out
  }

  for await (const line of rl) {
    if (line.length === 0) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      ctx.badLines++
      continue
    }
    ctx.events++
    if (typeof ev.time === 'number') {
      if (ctx.minTime === null || ev.time < ctx.minTime) ctx.minTime = ev.time
      if (ctx.maxTime === null || ev.time > ctx.maxTime) ctx.maxTime = ev.time
    }

    if (ev.type === 'session') {
      sessionId = typeof ev.id === 'string' ? ev.id : dirSessionId
      sessionOrigin = typeof ev.origin === 'string' ? ev.origin : 'root'
      sessionCreatedAt = typeof ev.createdAt === 'number' ? ev.createdAt : null
      sessionCwd = typeof ev.cwd === 'string' ? ev.cwd : null
      bump(ctx.origins, sessionOrigin)
      continue
    }

    if (typeof ev.time !== 'number') continue
    const day = localDay(ev.time)

    if (ev.type === 'turn/start') {
      for (const a of accsFor(day)) {
        note(a, day, sessionId)
        a.turns.add(`${sessionId}#${ev.time}#${ev.data?.turn}`)
      }
      const dr = ctx.daily.get(day) ?? newDayRow()
      ctx.daily.set(day, dr)
      dr.sessions.add(sessionId)
      dr.turns.add(`${sessionId}#${ev.time}#${ev.data?.turn}`)
      continue
    }

    if (ev.type === 'tool/call') {
      const d = ev.data ?? {}
      if (callNames.has(d.callId)) continue // fork 子会话复制父前缀：callId 文件内去重
      callNames.set(d.callId, d.name)
      pending.set(d.callId, { name: d.name, arguments: d.arguments, turn: d.turn })

      let command = ''
      if (d.name === 'bash') {
        try {
          command = JSON.parse(d.arguments)?.command ?? ''
        } catch {
          command = ''
        }
      }
      const acc = ctx.bySession.get(sessionId) ?? { edit: 0, editFail: 0 }
      ctx.bySession.set(sessionId, acc)
      if (d.name === 'edit') acc.edit++
      // 「edit 失败之后有没有改用 bash 写文件」：记首末失败时间 + 其后的 bash 写文件形态调用
      if (d.name === 'bash' && bashWriteForms(command).forms.length > 0) {
        acc.bashWrites = (acc.bashWrites ?? 0) + 1
        if (acc.firstEditFailTime !== undefined && ev.time > acc.firstEditFailTime) {
          acc.bashWritesAfterEditFail = (acc.bashWritesAfterEditFail ?? 0) + 1
          if (acc.firstBashWriteAfterEditFail === undefined) acc.firstBashWriteAfterEditFail = ev.time
        }
      }
      if (acc.firstTime === undefined) {
        acc.firstTime = sessionCreatedAt ?? ev.time
        acc.origin = sessionOrigin
      }
      for (const a of accsFor(day)) {
        note(a, day, sessionId)
        tallyCall(a, d.name, command)
      }

      const dr = ctx.daily.get(day) ?? newDayRow()
      ctx.daily.set(day, dr)
      dr.sessions.add(sessionId)
      if (d.name === 'edit') dr.edit++
      else if (d.name === 'write') dr.write++
      else if (d.name === 'bash') {
        dr.bash++
        if (bashWriteForms(command).forms.length > 0) dr.bw++
      }
      continue
    }

    if (ev.type !== 'tool/result') continue

    const cid = ev.data?.message?.source?.callId
    const call = pending.get(cid)
    if (call === undefined) continue
    pending.delete(cid)

    const errTexts = []
    for (const c of ev.data?.message?.content ?? []) {
      if (c.isError !== true) continue
      for (const t of c.content ?? []) if (t.type === 'text') errTexts.push(t.text)
    }
    const ok = errTexts.length === 0
    const errText = errTexts.join('\n')

    for (const a of accsFor(day)) tallyResult(a, call.name, ok, errText)

    if (!ok) {
      const dr = ctx.daily.get(day)
      if (dr !== undefined) {
        if (call.name === 'edit') dr.editFail++
        else if (call.name === 'write') dr.writeFail++
      }
    }

    if (call.name === 'edit') {
      let argv = {}
      try {
        argv = JSON.parse(call.arguments)
      } catch {
        argv = {}
      }
      const rawPath = typeof argv.file_path === 'string' ? argv.file_path : ''
      // 用会话 cwd 归一化路径，避免同一次会话里相对/绝对路径混用导致漏判
      const fp = rawPath === '' ? '' : path.resolve(sessionCwd ?? process.cwd(), rawPath)
      const os = typeof argv.old_string === 'string' ? argv.old_string : ''
      if (fp !== '' && os !== '') {
        const key = `${fp}\u0000${createHash('sha1').update(os).digest('hex')}`
        const normKey = `${fp}\u0000${createHash('sha1').update(normalizeAnchor(os)).digest('hex')}`
        const prev = succeededEditKeys.get(key)
        const prevNorm = succeededEditNorm.get(normKey)

        if (!ok) {
          if (prev !== undefined) {
            fileDangerous.push({
              sessionId, origin: sessionOrigin, filePath: fp, rawPath,
              firstOkAt: prev, retryFailAt: ev.time,
              failText: errText.split('\n')[0].slice(0, 200),
            })
          }
          // B1-lite 的空白/CRLF 容错本该救回：归一化后与之前成功过的锚点相同，但原文不同
          if (prev === undefined && prevNorm !== undefined && prevNorm.rawOldString !== os) {
            fileNormRescued.push({
              sessionId, filePath: fp, rawPath, firstOkAt: prevNorm.time, retryFailAt: ev.time,
              rawLen: os.length, normLen: normalizeAnchor(os).length,
            })
          }
          const dup = (failedEditKeys.get(key) ?? 0) + 1
          failedEditKeys.set(key, dup)
          if (dup === 2) {
            fileDuplicateFail.push({ sessionId, origin: sessionOrigin, filePath: fp, rawPath, secondFailAt: ev.time, count: dup })
          }
        } else {
          succeededEditKeys.set(key, ev.time)
          succeededEditNorm.set(normKey, { time: ev.time, rawOldString: os })
        }
      }
      if (!ok) {
        const acc = ctx.bySession.get(sessionId)
        if (acc !== undefined) {
          acc.editFail++
          if (acc.firstEditFailTime === undefined) acc.firstEditFailTime = ev.time
        }
        ctx.editFailures.push({
          sessionId,
          origin: sessionOrigin,
          day,
          time: ev.time,
          cls: classifyError(errText).cls,
          text: errText.split('\n')[0].slice(0, 200),
          filePath: fp === '' ? rawPath : fp,
        })
      }
    }
  }

  await new Promise((resolve) => {
    child.on('close', resolve)
    child.on('error', resolve)
  })
  for (const r of fileDangerous) ctx.dangerousRetries.push(r)
  for (const r of fileNormRescued) ctx.normRescued.push(r)
  for (const r of fileDuplicateFail) ctx.duplicateFailAnchors.push(r)
}

/* ──────────────────────────── main ──────────────────────────── */

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const roots = (args.length > 0 ? args : DEFAULT_ROOTS)
    .map((r) => path.resolve(r))
    .filter((r) => existsSync(r) && statSync(r).isDirectory())

  const files = []
  for (const r of roots) findLogs(r, files)
  files.sort()

  const buckets = new Map()
  for (const b of BUCKETS) buckets.set(b.name, newAcc())
  buckets.set('(out of range)', newAcc())

  const ctx = {
    buckets,
    policy: new Map([['before', newAcc()], ['after', newAcc()]]),
    bySession: new Map(),
    origins: new Map(),
    daily: new Map(),
    editFailures: [],
    dangerousRetries: [],
    normRescued: [],
    duplicateFailAnchors: [],
    events: 0,
    badLines: 0,
    minTime: null,
    maxTime: null,
  }

  let done = 0
  for (const f of files) {
    try {
      await analyzeFile(f, ctx)
    } catch (e) {
      process.stderr.write(`[warn] ${f}: ${e instanceof Error ? e.message : String(e)}\n`)
    }
    done++
    if (done % 50 === 0) process.stderr.write(`[progress] ${done}/${files.length}\n`)
  }

  /* ── 输出 ── */
  const L = []
  const ordered = BUCKETS.map((b) => b.name)
  const get = (n) => buckets.get(n)
  const shown = visible(ordered, get)
  const sum = (fn) => shown.reduce((a, n) => a + fn(get(n)), 0)

  L.push('# edit 失败率 / bash 写文件绕道 —— 离线会话日志统计')
  L.push('')
  L.push(`生成时间（本机）：${localStamp(Date.now())}`)
  L.push('')
  L.push('## 0. 数据源')
  L.push('')
  L.push(`- 扫描根目录：${roots.length === 0 ? '（无）' : roots.map((r) => `\`${r}\``).join('、')}`)
  L.push(`- 命中日志文件：**${files.length}** 个 \`${LOG_BASENAME}\``)
  L.push(`- 解析事件：${ctx.events} 行，JSON 解析失败 ${ctx.badLines} 行`)
  if (ctx.minTime !== null && ctx.maxTime !== null) {
    L.push(`- 事件时间范围（本机时区）：${localStamp(ctx.minTime)} ~ ${localStamp(ctx.maxTime)}`)
  }
  const originTotal = [...ctx.origins.values()].reduce((a, c) => a + c, 0)
  L.push(`- 会话 origin 分布：${[...ctx.origins.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}（${pct(v, originTotal)}）`).join('、')}`)
  L.push('')
  L.push('> 分档按**本机本地时区**的日历日切（事件时间）；策略段对照按**会话开始时间**切。')
  L.push('> 「失败」= `tool/result` 里存在 `isError: true` 的内容块；归类见脚本头部与报告「方法学」一节。')
  L.push('')

  /* ── 1. 分档总览 ── */
  L.push('## 1. 分档总览（按事件时间）')
  L.push('')
  L.push(mdTable(
    ['档', '会话数', 'turn 数', 'edit 调用', 'edit 失败', 'edit 失败率', 'write 调用', 'write 失败', 'write 失败率', 'bash 调用'],
    [
      ...shown.map((n) => {
        const b = get(n)
        return [n, b.sessions.size, b.turns.size, b.edit.calls, b.edit.fails, pct(b.edit.fails, b.edit.calls),
          b.write.calls, b.write.fails, pct(b.write.fails, b.write.calls), b.bash.calls].map(String)
      }),
      ['**合计**', new Set(shown.flatMap((n) => [...get(n).sessions])).size, sum((b) => b.turns.size),
        sum((b) => b.edit.calls), sum((b) => b.edit.fails), pct(sum((b) => b.edit.fails), sum((b) => b.edit.calls)),
        sum((b) => b.write.calls), sum((b) => b.write.fails), pct(sum((b) => b.write.fails), sum((b) => b.write.calls)),
        sum((b) => b.bash.calls)].map(String),
    ],
  ))
  L.push('')

  /* ── 2. 归一化 ── */
  L.push('## 2. 归一化：每百 turn 的 `edit` 失败数')
  L.push('')
  L.push(mdTable(
    ['档', 'turn 数', 'edit 调用', 'edit 失败', 'edit 失败/100 turn', 'edit 调用/turn'],
    shown.map((n) => {
      const b = get(n)
      const t = b.turns.size
      return [n, t, b.edit.calls, b.edit.fails, t === 0 ? '—' : ((b.edit.fails / t) * 100).toFixed(2), t === 0 ? '—' : (b.edit.calls / t).toFixed(2)].map(String)
    }),
  ))
  L.push('')

  /* ── 3. 策略段落地前后（按会话开始时间） ── */
  L.push('## 3. 策略段落地前后对照（按**会话开始时间**切）')
  L.push('')
  L.push(`切点：commit \`a0519453\` 的提交时刻 **2026-09-12 09:19:05 +0800**（工具策略段 \`corum:tool-policy\` 落地）。`)
  L.push('一段会话的系统提示在会话创建时固定，故按会话开始时间归属比按事件时间更贴近实际生效面。')
  L.push('')
  const pb = ctx.policy.get('before')
  const pa = ctx.policy.get('after')
  L.push(mdTable(
    ['组', '会话数', 'turn 数', 'edit 调用', 'edit 失败', 'edit 失败率', '策略类失败', '匹配类失败', 'write 调用', 'write 失败', 'bash 调用', '含写文件形态', '占比'],
    [
      ['策略段前', pb.sessions.size, pb.turns.size, pb.edit.calls, pb.edit.fails, pct(pb.edit.fails, pb.edit.calls),
        pb.edit.errs.get(POLICY_CLS) ?? 0,
        (pb.edit.errs.get(MATCH_NOT_FOUND_CLS) ?? 0) + (pb.edit.errs.get(MATCH_AMBIGUOUS_CLS) ?? 0),
        pb.write.calls, pb.write.fails, pb.bash.calls, pb.bash.writeAny, pct(pb.bash.writeAny, pb.bash.calls)].map(String),
      ['策略段后', pa.sessions.size, pa.turns.size, pa.edit.calls, pa.edit.fails, pct(pa.edit.fails, pa.edit.calls),
        pa.edit.errs.get(POLICY_CLS) ?? 0,
        (pa.edit.errs.get(MATCH_NOT_FOUND_CLS) ?? 0) + (pa.edit.errs.get(MATCH_AMBIGUOUS_CLS) ?? 0),
        pa.write.calls, pa.write.fails, pa.bash.calls, pa.bash.writeAny, pct(pa.bash.writeAny, pa.bash.calls)].map(String),
    ],
  ))
  L.push('')
  L.push(mdTable(
    ['组', 'turn 数', 'edit 失败/100 turn', 'bash 写文件形态/100 turn'],
    [
      ['策略段前', pb.turns.size,
        pb.turns.size === 0 ? '—' : ((pb.edit.fails / pb.turns.size) * 100).toFixed(2),
        pb.turns.size === 0 ? '—' : ((pb.bash.writeAny / pb.turns.size) * 100).toFixed(2)].map(String),
      ['策略段后', pa.turns.size,
        pa.turns.size === 0 ? '—' : ((pa.edit.fails / pa.turns.size) * 100).toFixed(2),
        pa.turns.size === 0 ? '—' : ((pa.bash.writeAny / pa.turns.size) * 100).toFixed(2)].map(String),
    ],
  ))
  L.push('')

  /* ── 4. edit 失败类型 ── */
  L.push('## 4. `edit` 失败类型分布（按事件时间分档）')
  L.push('')
  const allEditErr = new Map()
  for (const n of shown) for (const [k, v] of get(n).edit.errs) bump(allEditErr, k, v)
  if (allEditErr.size === 0) L.push('_（本区间内 `edit` 无失败）_')
  else {
    L.push(mdTable(['失败类型', ...shown, '合计'], [...allEditErr.keys()].sort().map((k) => [k.replace(/\|/g, '\\|'), ...shown.map((n) => String(get(n).edit.errs.get(k) ?? 0)), String(allEditErr.get(k))])))
    L.push('')
    L.push(mdTable(
      ['档', '策略类（file-not-read）', '匹配类（未命中 + ambiguous）', '匹配类 / 全部 edit 失败', '匹配类 / edit 调用'],
      shown.map((n) => {
        const e = get(n).edit.errs
        const policy = e.get(POLICY_CLS) ?? 0
        const match = (e.get(MATCH_NOT_FOUND_CLS) ?? 0) + (e.get(MATCH_AMBIGUOUS_CLS) ?? 0)
        const all = [...e.values()].reduce((a, c) => a + c, 0)
        return [n, policy, match, all === 0 ? '—' : pct(match, all), pct(match, get(n).edit.calls)].map(String)
      }),
    ))
  }
  L.push('')

  /* ── 5. write 失败类型 ── */
  L.push('## 5. `write` 失败类型分布')
  L.push('')
  const allWriteErr = new Map()
  for (const n of shown) for (const [k, v] of get(n).write.errs) bump(allWriteErr, k, v)
  if (allWriteErr.size === 0) L.push('_（本区间内 `write` 无失败）_')
  else L.push(mdTable(['失败类型', ...shown, '合计'], [...allWriteErr.keys()].sort().map((k) => [k.replace(/\|/g, '\\|'), ...shown.map((n) => String(get(n).write.errs.get(k) ?? 0)), String(allWriteErr.get(k))])))
  L.push('')

  /* ── 6. bash 写文件绕道 ── */
  L.push('## 6. bash 写文件绕道指标')
  L.push('')
  L.push(mdTable(
    ['档', 'bash 调用', '含写文件形态', '占比', '其中目标非临时/日志路径', '占比', 'bash 调用/turn'],
    shown.map((n) => {
      const b = get(n)
      const t = b.turns.size
      return [n, b.bash.calls, b.bash.writeAny, pct(b.bash.writeAny, b.bash.calls), b.bash.writeReal, pct(b.bash.writeReal, b.bash.calls), t === 0 ? '—' : (b.bash.calls / t).toFixed(2)].map(String)
    }),
  ))
  L.push('')
  const formNames = ['redirect >', 'append >>', 'tee', 'sed -i', 'python heredoc']
  L.push(mdTable(['形态', ...shown, '合计'], formNames.map((f) => [f, ...shown.map((n) => String(get(n).bash.forms.get(f) ?? 0)), String(sum((b) => b.bash.forms.get(f) ?? 0))])))
  L.push('')
  L.push('> 「含写文件形态」= 命中任一形态的 bash 调用数（一个调用命中多形态只计一次）；')
  L.push('> 「目标非临时/日志路径」= 该调用至少有一个重定向/tee 目标不属于 `/dev/null`、`/tmp/**`、`/var/tmp/**`、`/private/tmp/**`、`/var/folders/**` 或 `*.log`。')
  L.push('')

  /* ── 7. 逐日 ── */
  L.push('## 7. 逐日明细（按事件时间）')
  L.push('')
  L.push(mdTable(
    ['日期', '会话数', 'turn 数', 'edit 调用', 'edit 失败', 'edit 失败率', 'write 调用', 'write 失败', 'bash 调用', '含写文件形态', '占比'],
    [...ctx.daily.keys()].sort().map((d) => {
      const r = ctx.daily.get(d)
      return [d, r.sessions.size, r.turns.size, r.edit, r.editFail, pct(r.editFail, r.edit), r.write, r.writeFail, r.bash, r.bw, pct(r.bw, r.bash)].map(String)
    }),
  ))
  L.push('')

  /* ── 8. 会话集中度 ── */
  L.push('## 8. 样本集中度：按会话看 `edit` 调用 / 失败')
  L.push('')
  const sessRows = [...ctx.bySession.entries()]
    .filter(([, v]) => v.edit > 0)
    .sort((a, b) => b[1].edit - a[1].edit)
  L.push(`有 \`edit\` 调用的会话共 **${sessRows.length}** 个（全部日志里的会话总数 ${ctx.origins.size === 0 ? 0 : [...ctx.origins.values()].reduce((a, c) => a + c, 0)} 个）。按调用数排序 TOP 10：`)
  L.push('')
  L.push(mdTable(
    ['会话 id', 'origin', '会话开始时间', 'edit 调用', 'edit 失败', '失败率'],
    sessRows.slice(0, 10).map(([sid, v]) => [sid, v.origin ?? '—', v.firstTime === undefined ? '—' : localStamp(v.firstTime), v.edit, v.editFail, pct(v.editFail, v.edit)].map(String)),
  ))
  L.push('')
  const top1 = sessRows[0]
  if (top1 !== undefined) {
    L.push(`- 单会话最大 \`edit\` 调用量：${top1[1].edit} 次（\`${top1[0]}\`），占全部 \`edit\` 调用的 ${pct(top1[1].edit, sum((b) => b.edit.calls))}。`)
  }
  const failSess = sessRows.filter(([, v]) => v.editFail > 0)
  L.push(`- 出现过 \`edit\` 失败的会话：**${failSess.length}** 个；其中失败数 ≥2 的有 ${failSess.filter(([, v]) => v.editFail >= 2).length} 个。`)
  L.push('')

  /* ── 9. BUG-28 ── */
  L.push('## 9. BUG-28 形态：同一 (file_path, old_string) 先成功、后重试失败')
  L.push('')
  L.push('> 判据：**同一会话内**，某个 `edit` 成功（结果 `isError=false`）后，再用**完全相同的**')
  L.push('> `file_path` + `old_string`（SHA-1 相同，路径按会话 cwd 归一化）调用 `edit` 并**失败**。')
  L.push('')
  L.push(`- 命中次数：**${ctx.dangerousRetries.length}**`)
  L.push('')
  if (ctx.dangerousRetries.length > 0) {
    L.push(mdTable(
      ['#', '会话 id', '文件', '首次成功时间', '重试失败时间', '失败文案（首行）'],
      ctx.dangerousRetries.map((r, i) => [i + 1, r.sessionId, `\`${r.filePath}\``, localStamp(r.firstOkAt), localStamp(r.retryFailAt), `\`${r.failText.replace(/\|/g, '\\|')}\``].map(String)),
    ))
    L.push('')
  }

  /* ── 9b. 其它两种「锚点重试」形态 ── */
  L.push('### 9b. 另两种「锚点重试」形态')
  L.push('')
  L.push('1. **同一锚点原地重试**：同一会话内，同一 `(file_path, old_string)` 的 `edit` 失败 ≥2 次')
  L.push('   （模型第一次没改对、第二次拿同一条锚点再撞一次 = 白烧步骤）。')
  L.push(`   命中：**${ctx.duplicateFailAnchors.length}** 组。`)
  L.push('')
  if (ctx.duplicateFailAnchors.length > 0) {
    L.push(mdTable(
      ['#', '会话 id', 'origin', '文件', '第 2 次失败时间'],
      ctx.duplicateFailAnchors.map((r, i) => [i + 1, r.sessionId, r.origin ?? '—', `\`${r.filePath}\``, localStamp(r.secondFailAt)].map(String)),
    ))
    L.push('')
  }
  L.push('2. **B1-lite 容错本该救回**：失败锚点与原锚点只在 CRLF / 行尾空白上不同，而原锚点本会话曾成功过。')
  L.push(`   命中：**${ctx.normRescued.length}**。`)
  L.push('')
  if (ctx.normRescued.length > 0) {
    L.push(mdTable(
      ['#', '会话 id', '文件', '原锚点成功时间', '失败时间', '原文长度', '归一化后长度'],
      ctx.normRescued.map((r, i) => [i + 1, r.sessionId, `\`${r.filePath}\``, localStamp(r.firstOkAt), localStamp(r.retryFailAt), r.rawLen, r.normLen].map(String)),
    ))
    L.push('')
  }
  L.push('3. **`edit` 失败之后的 bash 写文件绕道**：同一会话在首次 `edit` 失败**之后**，')
  L.push('   又出现了几次「含写文件形态」的 bash 调用（衡量失败是否把模型推回 bash）。')
  L.push('')
  const failSessRows = sessRows.filter(([, v]) => v.editFail > 0)
  if (failSessRows.length === 0) L.push('_（无会话出现过 `edit` 失败）_')
  else {
    L.push(mdTable(
      ['会话 id', 'origin', 'edit 失败', '首次失败时间', '该会话 bash 写文件形态总数', '其中在首次失败之后', '之后第一次的时间'],
      failSessRows.map(([sid, v]) => [sid, v.origin ?? '—', v.editFail, v.firstEditFailTime === undefined ? '—' : localStamp(v.firstEditFailTime),
        v.bashWrites ?? 0, v.bashWritesAfterEditFail ?? 0,
        v.firstBashWriteAfterEditFail === undefined ? '—' : localStamp(v.firstBashWriteAfterEditFail)].map(String)),
    ))
    const after = failSessRows.reduce((a, [, v]) => a + (v.bashWritesAfterEditFail ?? 0), 0)
    const allBashWrites = sum((b) => b.bash.writeAny)
    L.push('')
    L.push(`- 这些会话里「首次 edit 失败之后」的 bash 写文件形态调用合计 **${after}** 次（全部 bash 写文件形态调用 ${allBashWrites} 次）。`)
  }
  L.push('')

  /* ── 10. 全部 edit 失败逐条 ── */
  L.push('## 10. `edit` 失败逐条（便于人工复核）')
  L.push('')
  L.push(`共 ${ctx.editFailures.length} 条。`)
  L.push('')
  L.push(mdTable(
    ['时间', '会话 id', 'origin', '归类', '文件', '文案（首行）'],
    ctx.editFailures.sort((a, b) => a.time - b.time).map((r) => [localStamp(r.time), r.sessionId, r.origin ?? '—', r.cls, `\`${r.filePath}\``, `\`${r.text.replace(/\|/g, '\\|')}\``].map(String)),
  ))
  L.push('')

  /* ── 11. 其它 ── */
  L.push('## 11. 附注')
  L.push('')
  L.push(mdTable(['档', '`str_replace_editor` 调用', '失败'], shown.map((n) => [n, String(get(n).sre.calls), String(get(n).sre.fails)])))
  L.push('')
  const oor = get('(out of range)')
  if (oor !== undefined && oor.toolCalls > 0) {
    L.push(`- 落在三档之外的调用：${oor.toolCalls} 次（日期 ${[...oor.days].sort().join('、')}）`)
  }
  L.push(`- 三档内工具调用合计：${sum((b) => b.toolCalls)} 次`)
  L.push('')

  process.stdout.write(`${L.join('\n')}\n`)
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`)
  process.exit(1)
})
