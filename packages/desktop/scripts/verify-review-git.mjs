/**
 * 影子 git 仓库（`corumReview`）的**离线**集成验证 —— 一条命令跑完，不需要 LLM。
 *
 * 为什么要有它：真实链路要跑一轮 Agent 才会产生 `tool/call` 事件，而模型额度可能不可用
 * （实测遇到 `429 RATE_LIMIT`，整条链路就没法验）。本脚本用**合成事件**直接驱动服务的
 * 同一个人口（它注册在 `ctx.on('session/event')` 上的处理器），把机制本身验穿：
 *
 *   捕获（pre-image） → 统计/内容哈希 → 查改前内容 → 撤销单文件 → 轮次提交（A/B 提交、
 *   main 推进、round ref） → journal 落盘与压缩 → **跨重启恢复** → 保留策略 prune
 *
 * 用法（在 packages/desktop 下）：
 *   node scripts/verify-review-git.mjs
 *
 * 实现注意：`@Remote` 是 **TC39 stage-3 装饰器**（不是 legacy），所以编译时**不能**加
 * `--experimentalDecorators`（加了会 emit `__decorate` 旧签名，protocol 直接抛
 * "Remote decorators require a public instance method"）。另外全程在**临时目录**里跑
 * （DSH_HOME 也重定向），不碰真实数据。
 *
 * @module corum-desktop/scripts/verify-review-git
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const BUILD = join(DESKTOP, '.verify-review-git')
const ROOT = join(DESKTOP, '.verify-review-git-data')
const WS = join(ROOT, 'ws')
const HOME = join(ROOT, 'home')
const SESSION = 'sess-verify-1'

let pass = 0
let fail = 0
const check = (label, ok, extra) => {
  if (ok) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}`, extra ?? '') }
}

/** 编译服务源码（stage-3 装饰器）到临时目录，供本脚本 import。 */
function compileService() {
  rmSync(BUILD, { recursive: true, force: true })
  mkdirSync(BUILD, { recursive: true })
  const result = spawnSync('npx', [
    'tsc', join('src', 'host', 'corum-review.ts'),
    '--ignoreConfig', '--outDir', BUILD,
    '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--skipLibCheck', '--noEmitOnError', 'false',
  ], { cwd: DESKTOP, encoding: 'utf8' })
  const emitted = join(BUILD, 'corum-review.js')
  if (!existsSync(emitted)) {
    console.error('编译失败（未产出 corum-review.js）：\n', result.stdout, result.stderr)
    process.exit(2)
  }
}

const writeTool = (path, content) => ({
  type: 'tool/call',
  data: { name: 'write', arguments: JSON.stringify({ file_path: path, content }) },
})
const editTool = (path, oldS, newS) => ({
  type: 'tool/call',
  data: { name: 'edit', arguments: JSON.stringify({ old_string: oldS, new_string: newS, file_path: path }) },
})
const say = (ms) => new Promise(r => setTimeout(r, ms))
const git = (args) => spawnSync('git', args, { encoding: 'utf8' })

async function main() {
  compileService()
  const { Context } = await import('@deepseek-ai/cordis')
  const { CorumReviewService } = await import(join(BUILD, 'corum-review.js'))

  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(WS, 'src'), { recursive: true })
  mkdirSync(HOME, { recursive: true })
  process.env.DSH_HOME = HOME

  /** 真 cordis Context：TypertRemoteService extends Service，构造函数要 context.provide。 */
  const makeService = () => {
    const ctx = new Context()
    return { svc: new CorumReviewService(ctx), emit: (s, e) => { ctx.emit('session/event', s, e) } }
  }

  console.log('\n=== 1) 捕获：全新文件（tool/call 先到 → 改前=不存在）===')
  const A = join(WS, 'src', 'new.txt')
  const { svc, emit } = makeService()
  const session = { id: SESSION, header: { cwd: WS } }
  emit(session, { type: 'turn/start', data: { turn: 1 } })
  emit(session, writeTool('src/new.txt', 'a\nb\nc\n'))
  writeFileSync(A, 'a\nb\nc\n', 'utf8') // 工具真正落盘发生在这之后
  await say(300)
  let snap = await svc.snapshot(SESSION)
  check('snapshot 报出 1 个文件', snap.files.length === 1, JSON.stringify(snap))
  check('+3 −0', snap.files[0]?.added === 3 && snap.files[0]?.removed === 0, JSON.stringify(snap.files[0]))
  check('带回内容哈希', typeof snap.files[0]?.hash === 'string' && snap.files[0].hash.length === 40)
  let before = await svc.fileBefore(SESSION, 'src/new.txt')
  check('fileBefore：新建（左侧空 created=true）', before.exists && before.content === '' && before.created === true, JSON.stringify(before))

  console.log('\n=== 2) 捕获：已存在文件（pre-image 必须是旧内容）===')
  const B = join(WS, 'src', 'edit.txt')
  writeFileSync(B, 'one\ntwo\nthree\n', 'utf8')
  emit(session, editTool('src/edit.txt', 'two', 'TWO'))
  writeFileSync(B, 'one\nTWO\nthree\n', 'utf8')
  await say(300)
  snap = await svc.snapshot(SESSION)
  const entry = snap.files.find(f => f.path === 'src/edit.txt')
  check('第二处改动被聚合', entry !== undefined, JSON.stringify(snap.files.map(f => f.path)))
  check('+1 −1', entry?.added === 1 && entry?.removed === 1, JSON.stringify(entry))
  before = await svc.fileBefore(SESSION, 'src/edit.txt')
  check('fileBefore 精确等于旧内容', before.content === 'one\ntwo\nthree\n', JSON.stringify(before.content))

  console.log('\n=== 3) journal 落盘（跨重启恢复的前提，C6）===')
  const reviewRoot = join(HOME, 'review')
  check('review 目录已建', existsSync(reviewRoot))
  const repoKey = readdirSync(reviewRoot)[0]
  const jf = join(reviewRoot, repoKey, 'round-journal.jsonl')
  const parsed = (existsSync(jf) ? readFileSync(jf, 'utf8').trim().split('\n') : []).filter(Boolean).map(l => JSON.parse(l))
  check('journal 有 2 条 capture', parsed.length === 2, JSON.stringify(parsed))
  check('已存在文件那条带 blob', parsed.some(l => l.t === 'capture' && l.blob?.length === 40), JSON.stringify(parsed))
  check('新建文件那条是 capture-absent（当时不存在，无内容可存）',
    parsed.some(l => l.t === 'capture-absent' && l.blob === undefined), JSON.stringify(parsed))

  console.log('\n=== 4) 撤销单文件 ===')
  const rb = await svc.rollback(SESSION, 'src/edit.txt')
  check('撤销成功', rb.ok && rb.restored === 1, JSON.stringify(rb))
  check('磁盘内容已回退', readFileSync(B, 'utf8') === 'one\ntwo\nthree\n')
  snap = await svc.snapshot(SESSION)
  check('该文件从本轮消失', !snap.files.some(f => f.path === 'src/edit.txt'), JSON.stringify(snap.files.map(f => f.path)))

  console.log('\n=== 5) 轮次边界：A/B 提交 + main 推进 + round ref + journal 压缩 ===')
  emit(session, { type: 'turn/start', data: { turn: 2 } })
  await say(1200)
  const gitDir = join(reviewRoot, repoKey, 'repo.git')
  const mainLog = git([`--git-dir=${gitDir}`, 'log', '--oneline', 'refs/heads/main']).stdout.trim().split('\n').filter(Boolean)
  // main 是**无父快照**（只表达已接受的当前状态）——不是线性历史，否则每轮的 pre-image
  // blob 会永远挂在祖先链上、prune 也回收不掉（磁盘随总编辑量无界增长）。
  check('main 是无父快照（仅 1 个提交）', mainLog.length === 1, JSON.stringify(mainLog))
  const allAfterClose = Number(git([`--git-dir=${gitDir}`, 'rev-list', '--all', '--count']).stdout.trim())
  check('round ref 让 A/B 可达（含 pre-image）', allAfterClose >= 3, String(allAfterClose))
  const netStat = git([`--git-dir=${gitDir}`, 'diff', '--numstat', 'refs/corum/rounds/' + SESSION + '/1~1', `refs/corum/rounds/${SESSION}/1`])
  check('本轮净变化 = 3 行新增（round ref 的 A..B 可审）', netStat.stdout.trim().startsWith('3\t0'), JSON.stringify(netStat.stdout))
  const refs = git([`--git-dir=${gitDir}`, 'for-each-ref', '--format=%(refname)', 'refs/corum/rounds/'])
  check('round ref 已打', refs.stdout.includes(`refs/corum/rounds/${SESSION}/1`), refs.stdout)
  check('journal 已压缩为空', !existsSync(jf) || readFileSync(jf, 'utf8').trim() === '')
  check('usage 报出非零占用', (await svc.usage()).total > 0)

  console.log('\n=== 6) 跨重启恢复：新实例仍能撤销上一进程抓到的 pre-image ===')
  const C = join(WS, 'src', 'restart.txt')
  writeFileSync(C, 'v1\n', 'utf8')
  emit(session, editTool('src/restart.txt', 'v1', 'v2'))
  writeFileSync(C, 'v2\n', 'utf8')
  await say(400)
  const second = makeService() // 模拟重启
  await say(400)
  const rb2 = await second.svc.rollback(SESSION, 'src/restart.txt')
  check('重启后仍能撤销', rb2.ok && rb2.restored === 1, JSON.stringify(rb2))
  check('重启后内容恢复到 v1', readFileSync(C, 'utf8') === 'v1\n', JSON.stringify(readFileSync(C, 'utf8')))

  console.log('\n=== 7) 保留策略：retention=0 → 轮次 ref 全清 ===')
  check('retention 置 0', (await svc.setRetention(0)).days === 0)
  await say(800)
  const refs2 = git([`--git-dir=${gitDir}`, 'for-each-ref', '--format=%(refname)', 'refs/corum/rounds/'])
  check('轮次 ref 已被 prune', refs2.stdout.trim() === '', JSON.stringify(refs2.stdout))
  // 关键：prune 必须**真的释放磁盘** —— 只留下 main 那一个快照提交。
  const allAfterPrune = Number(git([`--git-dir=${gitDir}`, 'rev-list', '--all', '--count']).stdout.trim())
  check('prune+gc 后可达提交只剩 main 快照（磁盘有界）', allAfterPrune === 1, String(allAfterPrune))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(BUILD, { recursive: true, force: true })
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((error) => { console.error('HARNESS THREW:', error); process.exit(2) })
