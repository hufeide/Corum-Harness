/**
 * 轮末并集兜底的真机自检（真 git + 真文件系统 + 真探测函数）：
 *   1. 用**和 corum-review.ts 完全相同的 git 参数**读工作区实况；
 *   2. 过 `parsePorcelainPaths` + `selectUnionCandidates`（生产探测函数），断言
 *      「bash 风格的写入被并集收住、轮前的旧脏文件不被误收、删除的文件靠父目录 mtime 收住」；
 *   3. 验证并集 pre-image 依赖的 git 语义：bare 影子仓库 `cat-file blob refs/heads/main:<path>`。
 *
 * 用法（仓内固化版）：
 *   node scripts/check-review-bash-capture.mjs
 *
 * 由来：2026-09-13 实现「bash 写文件进影子仓库」时的一次性自检，验穿后固化进仓，
 * 避免只活在 /tmp（同 scripts/check-shipped-skills.mjs 的处置）。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  parsePorcelainPaths,
  selectUnionCandidates,
} from '../packages/desktop/src/host/corum-bash-writes.ts'

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// ── 1. 造一个真工作区（已提交 a.txt / stale.txt / b.txt）─────────────────────
const ws = mkdtempSync(join(tmpdir(), 'corum-union-ws-'))
git(ws, ['init', '--quiet'])
git(ws, ['config', 'user.email', 'corum@localhost'])
git(ws, ['config', 'user.name', 'corum'])
writeFileSync(join(ws, 'a.txt'), 'old a\n')
writeFileSync(join(ws, 'stale.txt'), 'old stale\n')
writeFileSync(join(ws, 'b.txt'), 'old b\n')
git(ws, ['add', '-A'])
git(ws, ['commit', '--quiet', '-m', 'init'])

// 轮**之前**就脏着的文件：mtime 回拨到一分钟前（等价于用户自己的未提交改动）
const before = (Date.now() - 60000) / 1000
writeFileSync(join(ws, 'stale.txt'), 'user dirty, not this round\n')
utimesSync(join(ws, 'stale.txt'), before, before)

const roundStart = Date.now()
// ── 2. 模拟「本轮 bash 写文件」：> f / 新文件 / 新目录 / rm 已跟踪文件 ────────
writeFileSync(join(ws, 'a.txt'), 'new a\n')                       // echo x > a.txt
writeFileSync(join(ws, 'newfile.txt'), 'brand new\n')             // echo x > newfile.txt
mkdirSync(join(ws, 'out'))
writeFileSync(join(ws, 'out', 'x.js'), 'built\n')                 // mkdir out && echo x > out/x.js
rmSync(join(ws, 'b.txt'))                                         // rm b.txt

// ── 3. 与 corum-review.ts 一模一样的读法 ────────────────────────────────────
const status = git(ws, ['--no-optional-locks', '-c', 'status.relativePaths=false', 'status', '--porcelain', '-z', '--no-renames'])
check('git status 退出 0', status.code === 0, status.stderr.trim())
const entries = parsePorcelainPaths(status.stdout)
console.log('   porcelain:', entries.map((e) => `${JSON.stringify(e.status)}=>${e.path}`).join('  '))

const root = statSync(ws).isDirectory() ? ws : ws
const selected = selectUnionCandidates(entries, {
  root,
  floor: roundStart - 1000,
  maxPaths: 200,
  maxDirDepth: 3,
  probe: {
    fileMtime: (abs) => {
      try { const s = statSync(abs); return s.isFile() || s.isDirectory() ? s.mtimeMs : null } catch { return null }
    },
    parentMtime: (abs) => {
      try { return statSync(dirname(abs)).mtimeMs } catch { return null }
    },
    children: (abs) => {
      try { return readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })) } catch { return [] }
    },
  },
}).map((abs) => abs.slice(ws.length + 1)).sort()
console.log('   并集候选:', JSON.stringify(selected))

check('收住 `> a.txt`（跟踪文件被覆盖）', selected.includes('a.txt'))
check('收住 `> newfile.txt`（本轮新建文件）', selected.includes('newfile.txt'))
check('收住 `mkdir out && > out/x.js`（折叠的新目录被有界展开）', selected.includes('out/x.js'))
check('收住 `rm b.txt`（文件已不在 → 父目录 mtime 判据）', selected.includes('b.txt'))
check('不收轮前就脏着的 stale.txt（mtime < 本轮开始）', !selected.includes('stale.txt'))
check('2>&1 / dev/null 之类的噪声不在候选里', !selected.some((p) => p.includes('null')))

// ── 4. 子目录 cwd 下 porcelain 仍是「仓库根相对」────────────────────────────
const subStatus = git(join(ws, 'out'), ['--no-optional-locks', '-c', 'status.relativePaths=false', 'status', '--porcelain', '-z', '--no-renames'])
const subEntries = parsePorcelainPaths(subStatus.stdout)
check(
  '子目录里跑也返回仓库根相对路径（工作区可能是仓库的子目录）',
  subEntries.some((e) => e.path === 'a.txt'),
  subEntries.map((e) => e.path).join(','),
)
const top = git(ws, ['--no-optional-locks', 'rev-parse', '--show-toplevel'])
check('rev-parse --show-toplevel 退出 0', top.code === 0, top.stdout.trim())

// ── 5. 非 git 工作区：静默降级（退出码非 0，调用方只记一次 warn）────────────
const plain = mkdtempSync(join(tmpdir(), 'corum-union-plain-'))
const plainStatus = git(plain, ['--no-optional-locks', 'status', '--porcelain', '-z'])
check('非 git 工作区 git status 退出非 0（调用方据此放弃本轮兜底）', plainStatus.code !== 0, `code=${plainStatus.code}`)

// ── 6. 影子仓库 pre-image：bare 仓库 main:<path> 的 git 语义 ────────────────
const shadow = mkdtempSync(join(tmpdir(), 'corum-union-shadow-'))
const gitDir = join(shadow, 'repo.git')
git(shadow, ['init', '--bare', '--quiet', gitDir])
const oldBlob = spawnSync('git', [`--git-dir=${gitDir}`, 'hash-object', '-w', '--stdin'], { input: 'old a\n', encoding: 'utf8' }).stdout.trim()
const indexFile = join(gitDir, 'index.probe')
const env = { ...process.env, GIT_INDEX_FILE: indexFile }
const run = (args, input) => spawnSync('git', [`--git-dir=${gitDir}`, ...args], { input, encoding: 'utf8', env })
run(['read-tree', '--empty'])
run(['update-index', '--index-info'], `100644 ${oldBlob}\ta.txt\n`)
const tree = run(['write-tree']).stdout.trim()
const commit = spawnSync('git', [
  `--git-dir=${gitDir}`, '-c', 'user.name=corum', '-c', 'user.email=corum@localhost',
  'commit-tree', tree, '-m', 'chore: accepted state',
], { encoding: 'utf8' }).stdout.trim()
spawnSync('git', [`--git-dir=${gitDir}`, 'update-ref', 'refs/heads/main', commit])

const found = spawnSync('git', [`--git-dir=${gitDir}`, 'cat-file', 'blob', 'refs/heads/main:a.txt'], { encoding: 'utf8' })
check('影子仓库能取回我们上次见到的内容（并集 pre-image）', found.status === 0 && found.stdout === 'old a\n', JSON.stringify(found.stdout))
const missing = spawnSync('git', [`--git-dir=${gitDir}`, 'cat-file', 'blob', 'refs/heads/main:never-tracked.txt'], { encoding: 'utf8' })
check('从没记录过的路径取不到 → 调用方记 unavailable（绝不猜 absent）', missing.status !== 0, `code=${missing.status}`)

for (const dir of [ws, plain, shadow]) rmSync(dir, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
