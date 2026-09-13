/**
 * corum-desktop/corum-review — Review（改动审查）的影子 git 仓库 Host 半
 * （Typert Remote，service 名 `corumReview`）。
 *
 * ## 为什么改成 git
 *
 * 旧的 Review 卡从**会话事件流**（tool/call 的 oldString/newString）反推「改动前」，
 * 有三个绕不过去的缺陷：整文件覆盖（`write`）的旧内容不可知；反推要求唯一匹配、
 * 会随外部改动漂移；增删行数只能靠自写 LCS 近似。改用 git 之后这三点全部消失 ——
 * 因为**手里有了真正的「改前内容」**。
 *
 * ## 存储模型：只存被改动的文件（用户 2026-09-11 要求）
 *
 * **绝不 `git add -A`**。全程只用 plumbing 精确操作「本轮被写过的那些路径」：
 *   `hash-object -w`（内容入库，内容寻址自动去重）
 *   → `read-tree` / `update-index --cacheinfo` / `write-tree`（拼 tree；不碰工作树、
 *     不扫全仓、不读 .gitignore）
 *   → `commit-tree` / `update-ref`（落历史）。
 * 磁盘增长正比于**变更量**，与项目大小无关：不变的文件在所有轮次共用同一个 blob。
 * 仓库是 **bare** 的（无工作树），所以它不会往用户目录里多放任何文件。
 *
 * ## pre-image 从哪来（正确性的关键）
 *
 * 「本轮首次被改的文件」在上一轮提交里不存在，必须在**写之前**拿到它的内容。已核实
 * `dsh-agent-loop` 的调度顺序为：
 *   `appendToolCall(session, …)`（写 `tool/call`，**同步**触发 `session/event` 监听器）
 *   → `await ctx.tools[…].prepare()` → `dispatch()`（真正落盘），
 * 且 `dsh-session` 的 `invokeContainedSessionObservers` 是**同步**调用回调。
 * 因此在本服务的 `session/event` 监听器里 `readFileSync` 目标文件，**必然早于写入**，
 * 无竞态、也不用去 hook 工具层。
 *
 * ## bash 绕道（台账 corum/review/capture-bash-writes）
 *
 * 只认**文件工具**（`write` / `edit` / `str_replace_editor`）会漏掉一半改动：Agent 大量
 * 用 shell 写文件（`cmd > f`、`>> f`、`tee f`、`sed -i s/a/b/ f`、`python - <<'EOF'` 里
 * `open(...,'w')`），这些调用原先**完全不进影子仓库** —— 审查卡里看不见、也撤销不了。
 * 现在两层接住：
 *   1. `corum-bash-writes.ts` 的纯解析器从命令串里解析出确定的写目标（解析不出的一律
 *      放弃并计数，见该模块头），仍在**命令执行前**（同一个同步 tool/call 路径）抓 pre-image；
 *   2. **轮末并集兜底**：`closeRound` 用工作区实况（`git status --porcelain`）求并集，把
 *      「本轮确实变了但没有任何工具捕获到」的路径补进本轮（`cp`/`mv`/`rm`/构建脚本等
 *      解析器故意不碰的形态靠它兜）。判据是**路径自身的 mtime ≥ 本轮开始时刻**
 *      （文件已不在时看父目录）—— 否则会把用户自己或历史遗留的脏文件当成本轮改动。
 *      这类路径的「改前」只能取影子仓库 `main` 里**我们上次见到**的版本；取不到就记
 *      `unavailable`（看得见、撤不了）—— **绝不猜 `absent`**，那会让一次撤销删掉用户的文件。
 *
 * 两层都在同一个 try/catch 里静默降级：审查捕获失败只留一行 warn，绝不影响工具执行
 * （2026-09-12 的教训：审查链路的异常打挂过主流程）。
 *
 * ## 轮次模型（Gerrit 风格 + 默认应用）
 *
 * 每轮产生**两个**提交，夹出该轮净变化：
 *   A(`round start`)：父 = 上一轮的 B；tree = 父 tree 的「本轮触达路径」→ 本轮开始时的内容。
 *   B(`round end`)  ：父 = A；tree = A 的「本轮触达路径」→ 写完之后的内容。
 * 于是 `git diff A B` 就是**精确**的本轮改动，首次触达的路径也有正确的「改前」。
 * `refs/heads/main` 每轮推进到 B —— 「用户不审核默认应用」就是这个自动前进本身；
 * `refs/corum/rounds/<session>/<n>` 保留每轮作为可审 changeset，按保留天数 prune。
 *
 * @module corum-desktop/host/corum-review
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-session'
import { parseBashWriteTargets, parsePorcelainPaths, selectUnionCandidates } from './corum-bash-writes.ts'

// ── corum-review settings namespace（保留天数）────────────────────────────────

/** settings.yaml 的 corum-review 段。 */
export const CORUM_REVIEW_SETTINGS_NAMESPACE = 'corum-review'

/** 保留设置形。 */
export interface CorumReviewSettings {
  /** 轮次历史保留天数（默认 1）。 */
  readonly retentionDays?: number
}

/** 默认保留天数（用户定调 2026-09-11）。 */
export const DEFAULT_RETENTION_DAYS = 1

const RETENTION_MIN = 0
const RETENTION_MAX = 365

export const CORUM_REVIEW_SETTINGS_SCHEMA: z<CorumReviewSettings> = z.object({
  retentionDays: z.number().default(DEFAULT_RETENTION_DAYS),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Review 影子 git 仓库服务（改动审查的数据源）。 */
    corumReview: CorumReviewService
  }
}

/** 空 tree 的 git 对象哈希（git 的「空目录树」固定值）。 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** 识别为「文件写操作」的工具名（与旧 review-changes.ts 同一名单）。 */
const FILE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['edit', 'write', 'str_replace_editor'])

/**
 * 识别为「shell」的工具名（dsh 注册的是 `bash`（tool-bash / tool-bash-persistent）与
 * `pwsh`（tool-pwsh）；其余是保守别名）。这类调用要额外解析命令串里的写文件目标。
 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'sh', 'shell', 'pwsh', 'powershell'])

/** 单轮 pre-image 的内存上限（超出则放弃保留 pre-image，只记「不可回滚」）。 */
const MAX_PREIMAGE_BYTES = 4 * 1024 * 1024

/** 轮末并集的 mtime 判据宽容度（文件系统 mtime 精度可能只有 1s）。 */
const UNION_MTIME_SLACK_MS = 1000

/** 轮末并集一轮最多补多少条路径（工作区再脏也不能把一轮拖住）。 */
const MAX_UNION_PATHS = 200

/** 轮末并集里未跟踪目录展开的最大深度。 */
const UNION_DIR_MAX_DEPTH = 3

/** `git status` / `git rev-parse` 的超时（工作区可能很大；超时只放弃本轮兜底）。 */
const WORKTREE_GIT_TIMEOUT_MS = 20000

/** 快照路径上并集扫描的最小间隔（卡片刷新很密，工作区实况不必每次都读）。 */
const UNION_SCAN_MIN_INTERVAL_MS = 2000

/**
 * 一个文件「改动前」的状态。
 *
 * 三态显式区分，**不要**用 `string | undefined` 含糊表达：`absent`（当时不存在，
 * 撤销 = 删除）与 `unavailable`（内容取不到：过大/二进制/权限，撤销 = **做不到**）
 * 在回滚时的动作完全相反，混在一起会把「取不到内容」误当成「新建」而删掉用户的文件。
 */
type Preimage =
  | { kind: 'content'; text: string }
  /** 已落进对象库的形态：重启后从 journal 恢复出来的轮次用它（正文走 cat-file）。 */
  | { kind: 'blob'; hash: string }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

/**
 * 一轮的活状态。
 *
 * pre-image 放内存而不是立刻写 git：捕获发生在会话 append 的**同步**路径上，
 * 不能 await git。一轮生命周期很短（到下一个 `turn/start` 就结束）随后立刻释放。
 */
interface LiveRound {
  sessionId: string
  workspace: string
  /** 轮次序号（用于 ref 名与展示）。 */
  index: number
  /** 本轮开始时刻（轮末并集兜底的 mtime 判据）。 */
  startedAt: number
  /** 轮次已收尾（closeRound 已接手）：快照路径上排队的并集扫描要放弃。 */
  closed?: boolean
  /** 上一次快照触发的并集扫描时刻（节流）。 */
  lastUnionScanAt?: number
  /** 并集扫描在飞（同时只允许一次）。 */
  unionScanInFlight?: boolean
  /** 相对路径 → 改动前状态。 */
  touched: Map<string, Preimage>
}

/** 一个影子仓库的运行时状态。 */
interface RepoState {
  gitDir: string
  /** 串行化队列：git 的 index 是仓库级共享资源，拼 tree 必须串行。 */
  chain: Promise<unknown>
}

/**
 * 轮次 journal 的一行（append-only JSONL，放在影子仓库根目录）。
 *
 * 为什么需要它（C6）：捕获发生在会话 append 的**同步**路径上，只能先记内存。
 * 若应用在「一轮进行中」被重启/崩溃，那一轮已抓到的 pre-image 就没了 —— 用户看不到、
 * 也回滚不了那批改动。所以每次捕获都**立刻**把内容落成 blob 并追加一行 journal；
 * 服务启动时回放 journal，把未结束的轮次恢复出来。
 */
type JournalLine =
  | { t: 'capture'; session: string; round: number; workspace: string; path: string; blob: string }
  | { t: 'capture-absent'; session: string; round: number; workspace: string; path: string }
  | { t: 'capture-unavailable'; session: string; round: number; workspace: string; path: string }
  | { t: 'end'; session: string; round: number }

/** journal 文件名（每个工作区一份，与影子仓库同级）。 */
const JOURNAL_FILE = 'round-journal.jsonl'

/** 客户端要的文件条目（相对路径 + 真实增删行数 + 当前内容指纹）。 */
export interface ReviewFileEntry {
  path: string
  added: number
  removed: number
  /**
   * 当前内容的 blob 哈希。客户端的「已看过」标记靠它做**内容级**判定：
   * 同一文件被再次改动后哈希会变，标记随之失效、条目重新出现。
   * 只按 path 记标记是不够的（文件改了却一直被隐藏）。
   */
  hash: string
}

/** 跑一个 git 子命令（bare 仓库，故显式 --git-dir）。 */
function runGit(
  gitDir: string,
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', [`--git-dir=${gitDir}`, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', rejectPromise)
    child.on('exit', (code) => { resolvePromise({ stdout, stderr, code: code ?? -1 }) })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

/** 相对路径 → git 形态（正斜杠）。 */
function toGitPath(rel: string): string {
  return rel.split(sep).join('/')
}

/**
 * 在**工作区**（而非影子仓库）里跑一个 git 子命令 —— 轮末并集兜底读工作区实况用。
 *
 * `--no-optional-locks`：观察者不该顺手改写用户的 `.git/index`（git status 默认会刷新
 * 索引缓存）。超时/失败一律由调用方静默降级。
 */
function runGitIn(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ stdout, stderr, code })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
      finish(-1)
    }, WORKTREE_GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => { stderr += String(error); finish(-1) })
    child.on('exit', (code) => finish(code ?? -1))
  })
}

export class CorumReviewService extends TypertRemoteService {
  private readonly repos = new Map<string, RepoState>()
  private readonly rounds = new Map<string, LiveRound>()
  /** 已经 warn 过的 key（`warnOnce`）：非 git 工作区之类的稳态失败不刷日志。 */
  private readonly warnedOnce = new Set<string>()
  private retentionDays = DEFAULT_RETENTION_DAYS

  constructor(ctx: Context) {
    super(ctx, 'corumReview')

    // settings namespace 注册（保留天数）。settings 服务在 boot 早期可能尚未挂载，
    // 短轮询直到可用 —— 与 corum-git 曾经的做法同款。
    const register = (): void => {
      const settings = ctx.get('settings') as
        | { register: (ns: unknown, schema: unknown) => void }
        | undefined
      if (settings === undefined) return
      settings.register(CORUM_REVIEW_SETTINGS_NAMESPACE, CORUM_REVIEW_SETTINGS_SCHEMA)
      ctx.logger.info('corum-review namespace registered')
    }
    const poll = setInterval(() => {
      if (ctx.get('settings') !== undefined) {
        clearInterval(poll)
        try { register() } catch (error) {
          ctx.logger.warn(`corum-review register failed: ${String(error)}`)
        }
      }
    }, 100)
    setTimeout(() => clearInterval(poll), 15000)

    // 恢复上一次运行里「未结束」的轮次（C6：应用在一轮进行中被重启/崩溃时，
    // 已抓到的 pre-image 靠 journal + 对象库还原，用户仍能看/能回滚）。
    void this.restoreRounds().catch((error: unknown) => {
      ctx.logger.warn(`corum-review restoreRounds failed: ${String(error)}`)
    })

    // pre-image 捕获：**同步**读文件，必须早于工具落盘（见文件头）。
    // 框架已把监听器包在 try/catch 里，这里再兜一层是为了不留半截状态。
    ctx.on('session/event', ((session: unknown, event: unknown) => {
      try {
        this.onSessionEvent(session as { id?: unknown; header?: { cwd?: unknown } }, event as { type?: unknown; data?: unknown })
      } catch (error) {
        ctx.logger.warn(`corum-review capture failed: ${String(error)}`)
      }
    }) as never)
  }

  // ── 事件捕获（同步路径，禁止 await）──────────────────────────────────────

  private onSessionEvent(
    session: { id?: unknown; header?: { cwd?: unknown } },
    event: { type?: unknown; data?: unknown },
  ): void {
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    const sessionId = String(session.id ?? '')
    if (sessionId === '') return

    if (event.type === 'turn/start') {
      const previous = this.rounds.get(sessionId)
      if (previous !== undefined) this.closeRound(previous)
      this.rounds.set(sessionId, {
        sessionId,
        workspace: cwd,
        index: (previous?.index ?? 0) + 1,
        startedAt: Date.now(),
        touched: new Map(),
      })
      return
    }
    if (event.type !== 'tool/call') return

    const data = event.data as { name?: unknown; arguments?: unknown } | undefined
    const name = typeof data?.name === 'string' ? data.name : ''
    const isFileTool = FILE_WRITE_TOOL_NAMES.has(name)
    const isShellTool = SHELL_TOOL_NAMES.has(name)
    if (!isFileTool && !isShellTool) return
    const rawArgs = data?.arguments
    if (typeof rawArgs !== 'string') return
    let parsed: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(rawArgs)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return
      parsed = value as Record<string, unknown>
    } catch { return }

    // 目标路径 + 解析基准：文件工具是单路径；shell 是命令串里解析出的写目标，
    // 基准 = bash 的 `workdir`（默认会话工作区）+ 命令里字面量 `cd` 链。
    let targets: string[]
    let base = cwd
    if (isFileTool) {
      const filePath = typeof parsed.file_path === 'string'
        ? parsed.file_path
        : (typeof parsed.path === 'string' ? parsed.path : undefined)
      if (filePath === undefined || filePath === '') return
      targets = [filePath]
    } else {
      const command = typeof parsed.command === 'string' ? parsed.command : ''
      if (command === '') return
      if (typeof parsed.workdir === 'string' && parsed.workdir !== '') base = resolve(cwd, parsed.workdir)
      targets = this.shellWriteTargets(command, base)
    }
    if (targets.length === 0) return

    // 懒开轮：某些路径下（恢复的会话）可能先见到 tool/call 而没见到 turn/start。
    let round = this.rounds.get(sessionId)
    if (round === undefined) {
      round = { sessionId, workspace: cwd, index: 1, startedAt: Date.now(), touched: new Map() }
      this.rounds.set(sessionId, round)
    }
    if (round.workspace !== cwd) return // 会话换了工作区：本轮不追（下一轮重建）
    for (const target of targets) {
      const abs = isAbsolute(target) ? target : resolve(base, target)
      const rel = this.relativePath(round.workspace, abs)
      if (rel === null) continue // 工作区之外：影子仓库/回滚都只按工作区相对路径表达
      if (round.touched.has(rel)) continue // 本轮已抓过：pre-image 取「本轮开始时」的内容
      // ★ 关键：此刻工具尚未执行，读到的就是「改动前」。
      const pre = this.capturePreimage(resolve(round.workspace, rel))
      round.touched.set(rel, pre)
      // 立刻落库（异步，不阻塞会话）：内容进对象库 + 追加 journal 一行。
      // 这样应用在「一轮进行中」被重启/崩溃后，这一轮的 pre-image 仍然可恢复（C6）。
      void this.persistCapture(round, rel, pre)
    }
  }

  /**
   * 从一条 shell 命令里解析出「写文件」的绝对目标路径。
   *
   * 解析器对不确定的路径一律放弃（变量/通配/算不出的 cd），只用计数 —— 这里把它落成
   * 一行 warn 作为可观测性：漏掉的路径由轮末的工作区实况并集兜底（见 `closeRound`）。
   * 任何失败都只返回空数组，绝不影响工具执行。
   */
  private shellWriteTargets(command: string, base: string): string[] {
    try {
      const scan = parseBashWriteTargets(command)
      if (scan.unresolved > 0) {
        const { variable, glob, cd, other } = scan.reasons
        this.ctx.logger.warn(
          `corum-review bash capture: ${scan.unresolved} write target(s) unresolved`
          + ` (variable=${variable} glob=${glob} cd=${cd} other=${other})`,
        )
      }
      if (scan.targets.length === 0) return []
      // 字面量 `cd` 链：从 shell 的初始 cwd（bash 的 workdir）依次 resolve。
      const origin = scan.cwdSteps === null
        ? base
        : scan.cwdSteps.reduce((acc, step) => resolve(acc, step), base)
      return scan.targets.map((target) => (isAbsolute(target) ? target : resolve(origin, target)))
    } catch (error) {
      this.ctx.logger.warn(`corum-review bash capture failed: ${String(error)}`)
      return []
    }
  }

  /**
   * 把一次捕获落成「对象库里的 blob + journal 一行」。失败只记日志：内存里那份仍然
   * 可用，只是失去跨重启的持久性。
   */
  private async persistCapture(round: LiveRound, rel: string, pre: Preimage): Promise<void> {
    try {
      const repo = await this.ensureRepo(round.workspace)
      const base = { session: round.sessionId, round: round.index, workspace: round.workspace, path: rel }
      let line: JournalLine
      if (pre.kind === 'content') {
        const hash = await this.hashObject(repo, pre.text)
        line = { t: 'capture', ...base, blob: hash }
      } else if (pre.kind === 'absent') {
        line = { t: 'capture-absent', ...base }
      } else {
        line = { t: 'capture-unavailable', ...base }
      }
      await this.appendJournal(round.workspace, line)
    } catch (error) {
      this.ctx.logger.warn(`corum-review persistCapture failed: ${String(error)}`)
    }
  }

  /** 追加一行 journal（append-only；目录不存在则建）。 */
  private async appendJournal(workspace: string, line: JournalLine): Promise<void> {
    const file = join(this.repoRoot(workspace), JOURNAL_FILE)
    await appendFile(file, JSON.stringify(line) + '\n', 'utf8')
  }

  /**
   * 服务启动时回放 journal，把**未结束**的轮次恢复成活轮次（C6）。
   *
   * 只恢复「有 capture 但没有对应 end」的最后一个轮次；已结束的轮次其内容已在
   * 轮次提交里，不需要恢复。恢复出来的 pre-image 是 blob 形态（正文走 cat-file）。
   */
  private async restoreRounds(): Promise<void> {
    const home = process.env.DSH_HOME ?? resolveDshHome('~/.corum')
    const base = join(home, 'review')
    if (!existsSync(base)) return
    for (const key of readdirSync(base)) {
      const file = join(base, key, JOURNAL_FILE)
      if (!existsSync(file)) continue
      try {
        // eslint-disable-next-line no-await-in-loop -- 工作区数量有限
        const text = await readFile(file, 'utf8')
        const open = new Map<string, LiveRound>()
        for (const raw of text.split('\n')) {
          if (raw.trim() === '') continue
          let line: JournalLine
          try { line = JSON.parse(raw) as JournalLine } catch { continue }
          if (line.t === 'end') { open.delete(line.session); continue }
          const roundKey = `${line.session}#${line.round}`
          let round = open.get(roundKey)
          if (round === undefined) {
            // 恢复出来的轮次：startedAt 只能取「恢复时刻」——用 0 会让轮末并集把上一轮
            // 之前就脏着的文件全当成这一轮的改动（宁可少补，不可误报）。
            round = { sessionId: line.session, workspace: line.workspace, index: line.round, startedAt: Date.now(), touched: new Map() }
            open.set(roundKey, round)
          }
          if (line.t === 'capture') round.touched.set(line.path, { kind: 'blob', hash: line.blob })
          else if (line.t === 'capture-absent') round.touched.set(line.path, { kind: 'absent' })
          else round.touched.set(line.path, { kind: 'unavailable' })
        }
        // 每个会话只保留**最后**一个未结束的轮次（更早的未结束轮次已被下一轮取代）。
        const latest = new Map<string, LiveRound>()
        for (const round of open.values()) {
          const prev = latest.get(round.sessionId)
          if (prev === undefined || round.index > prev.index) latest.set(round.sessionId, round)
        }
        for (const round of latest.values()) {
          if (round.touched.size > 0) this.rounds.set(round.sessionId, round)
        }
      } catch (error) {
        this.ctx.logger.warn(`corum-review journal replay failed (${key}): ${String(error)}`)
      }
    }
  }

  /** 丢弃某会话在 journal 里的记录（轮次结束后调用，避免 journal 无限增长）。 */
  private async compactJournal(workspace: string, sessionId: string): Promise<void> {
    const file = join(this.repoRoot(workspace), JOURNAL_FILE)
    if (!existsSync(file)) return
    try {
      const text = await readFile(file, 'utf8')
      const kept = text.split('\n').filter((raw) => {
        if (raw.trim() === '') return false
        try { return (JSON.parse(raw) as JournalLine).session !== sessionId } catch { return false }
      })
      // 原子替换：先写临时文件再 rename，避免崩溃时留下半截 journal。
      const tmp = `${file}.tmp`
      await writeFile(tmp, kept.length === 0 ? '' : kept.join('\n') + '\n', 'utf8')
      await rename(tmp, file)
    } catch (error) {
      this.ctx.logger.warn(`corum-review compactJournal failed: ${String(error)}`)
    }
  }

  /**
   * 读「改动前」状态（不存在 / 内容 / 取不到，三态显式）。
   *
   * ⚠️ 二进制（含 NUL）在这里判 `unavailable`：`readFileSync(…, 'utf8')` 对非法 UTF-8
   * **不抛错**，而是替换成 U+FFFD —— 那份「内容」是有损的，拿去撤销会把文件写坏。
   * 本函数是**回滚用** pre-image 的唯一入口，所以在这里拒绝；读「当前内容」（提交进影子
   * 仓库用）走 `readCurrent`，它不拒绝（库里存一份有损拷贝无害，只有回滚会毁文件）。
   * 这条路由 bash 写文件放大：Agent 会用 `python -c "open(p,'wb')"` 之类直接写图片/产物
   * （真机语料里就有 `test-pixel.png` 这类目标）。
   */
  private capturePreimage(abs: string): Preimage {
    const pre = this.readCurrent(abs)
    if (pre.kind !== 'content') return pre
    return pre.text.includes('\0') ? { kind: 'unavailable' } : pre
  }

  /** 读某路径**当前**内容：不存在 / 内容 / 取不到（供 closeRound 与 snapshot 用）。 */
  private readCurrent(abs: string): Preimage {
    try {
      if (!existsSync(abs)) return { kind: 'absent' }
      if (statSync(abs).size > MAX_PREIMAGE_BYTES) return { kind: 'unavailable' }
      return { kind: 'content', text: readFileSync(abs, 'utf8') }
    } catch {
      return { kind: 'unavailable' } // 二进制/权限/目录
    }
  }

  /** 取 pre-image 的正文（内存里的直接用；blob 形态走 git cat-file）。 */
  private async preimageText(repo: RepoState, pre: Preimage): Promise<string | null> {
    if (pre.kind === 'content') return pre.text
    if (pre.kind !== 'blob') return null
    const result = await runGit(repo.gitDir, ['cat-file', 'blob', pre.hash])
    return result.code === 0 ? result.stdout : null
  }

  /** 文件在工作区内的相对（git 形态）路径；不在工作区内返回 null。 */
  private relativePath(workspace: string, filePath: string): string | null {
    const abs = isAbsolute(filePath) ? filePath : resolve(workspace, filePath)
    const rel = relative(workspace, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
    return toGitPath(rel)
  }

  // ── 仓库与串行化 ─────────────────────────────────────────────────────────

  /** 影子仓库根：`$CORUM_HOME/review/<workspace 哈希>`。 */
  private repoRoot(workspace: string): string {
    const home = process.env.DSH_HOME ?? resolveDshHome('~/.corum')
    const hash = createHash('sha1').update(workspace).digest('hex').slice(0, 16)
    return join(home, 'review', hash)
  }

  /** 取（必要时创建）某工作区的影子仓库（bare：只用 plumbing，永不 checkout）。 */
  private async ensureRepo(workspace: string): Promise<RepoState> {
    const existing = this.repos.get(workspace)
    if (existing !== undefined) return existing
    const root = this.repoRoot(workspace)
    const gitDir = join(root, 'repo.git')
    if (!existsSync(gitDir)) {
      mkdirSync(root, { recursive: true })
      const init = await runGit(gitDir, ['init', '--bare', '--quiet'])
      if (init.code !== 0) throw new Error(`shadow repo init failed: ${init.stderr || init.code}`)
    }
    const state: RepoState = { gitDir, chain: Promise.resolve() }
    this.repos.set(workspace, state)
    return state
  }

  /** 排进该仓库的串行队列（index 共享，必须串行）。 */
  private enqueue<T>(repo: RepoState, task: () => Promise<T>): Promise<T> {
    const next = repo.chain.then(task, task)
    repo.chain = next.then(() => undefined, () => undefined)
    return next
  }

  private async revParse(repo: RepoState, ref: string): Promise<string | null> {
    const result = await runGit(repo.gitDir, ['rev-parse', '--verify', '--quiet', ref])
    return result.code === 0 ? result.stdout.trim() : null
  }

  /** 保证有基线提交（空 tree），返回其哈希。 */
  private async ensureBaseline(repo: RepoState): Promise<string> {
    const existing = await this.revParse(repo, 'refs/heads/main')
    if (existing !== null) return existing
    const created = await runGit(repo.gitDir, [
      '-c', 'user.name=corum', '-c', 'user.email=corum@localhost',
      'commit-tree', EMPTY_TREE, '-m', 'chore: corum review baseline',
    ])
    if (created.code !== 0) throw new Error(`baseline commit failed: ${created.stderr || created.code}`)
    const commit = created.stdout.trim()
    await runGit(repo.gitDir, ['update-ref', 'refs/heads/main', commit])
    return commit
  }

  /** 内容 → blob 哈希（入库，自动去重）。 */
  private async hashObject(repo: RepoState, content: string): Promise<string> {
    const result = await runGit(repo.gitDir, ['hash-object', '-w', '--stdin'], { input: content })
    if (result.code !== 0) throw new Error(`hash-object failed: ${result.stderr || result.code}`)
    return result.stdout.trim()
  }

  /**
   * 用「父 tree + {路径 → blob}」拼 tree 并提交。
   *
   * **两次子进程**搞定整轮：`read-tree` 载入父 tree，一次 `update-index --index-info`
   * 批量落地全部增删，再 `write-tree` + `commit-tree`。
   *
   * 为什么删除用 `--index-info` 而不是 `update-index --force-remove`：**后者在 bare
   * 仓库里直接失败**（实测 `fatal: this operation must be run in a work tree`，exit 128）。
   * 早期版本写的就是 `--force-remove` 且「容忍失败」，结果是**删除被静默丢掉** ——
   * 被 Agent 删掉的文件会永远留在轮次提交里。`--index-info` 的 `0 <40个0>` 行是
   * 不需要工作树的正式删除形式（已实测 exit 0 且 tree 里确实没了该路径）。
   *
   * @param changes - 路径 → blob；`null` = 从 tree 删除该路径。
   */
  private async commitWith(
    repo: RepoState,
    parent: string,
    changes: ReadonlyMap<string, string | null>,
    message: string,
  ): Promise<string> {
    // 专用 index：不与其它操作共用 $GIT_DIR/index。
    const indexFile = join(repo.gitDir, `index.${process.pid}.${Date.now()}`)
    const env = { GIT_INDEX_FILE: indexFile }
    try {
      const read = await runGit(repo.gitDir, ['read-tree', parent], { env })
      if (read.code !== 0) throw new Error(`read-tree failed: ${read.stderr || read.code}`)
      if (changes.size > 0) {
        const lines: string[] = []
        for (const [path, blob] of changes) {
          lines.push(blob === null
            ? `0 ${'0'.repeat(40)}\t${path}`
            : `100644 ${blob}\t${path}`)
        }
        const updated = await runGit(repo.gitDir, ['update-index', '--index-info'], {
          env,
          input: lines.join('\n') + '\n',
        })
        if (updated.code !== 0) throw new Error(`update-index --index-info failed: ${updated.stderr || updated.code}`)
      }
      const tree = await runGit(repo.gitDir, ['write-tree'], { env })
      if (tree.code !== 0) throw new Error(`write-tree failed: ${tree.stderr || tree.code}`)
      const commit = await runGit(repo.gitDir, [
        '-c', 'user.name=corum', '-c', 'user.email=corum@localhost',
        'commit-tree', tree.stdout.trim(), '-p', parent, '-m', message,
      ])
      if (commit.code !== 0) throw new Error(`commit-tree failed: ${commit.stderr || commit.code}`)
      return commit.stdout.trim()
    } finally {
      try { rmSync(indexFile, { force: true }) } catch { /* 清理失败无害 */ }
    }
  }

  // ── 轮次收尾 ─────────────────────────────────────────────────────────────

  /**
   * 结束一轮：提交 A（轮次起点）与 B（轮次终点），把 `main` 推进到 B，打 round ref，
   * 再按保留策略 prune。**异步**（不阻塞会话）；失败只记日志（下一轮仍可继续）。
   */
  private closeRound(round: LiveRound): void {
    this.rounds.delete(round.sessionId)
    round.closed = true
    const touched = round.touched
    round.touched = new Map() // 立刻释放内存中的 pre-image
    void (async () => {
      try {
        // ★ 轮末并集兜底：先只读工作区实况，真有候选才建影子仓库，
        // 所以「没有任何改动的轮次」不会在用户目录里留下任何影子仓库目录。
        const added = await this.applyWorktreeChanges(round, touched)
        if (touched.size === 0) return // 本轮真没写文件：不留提交
        if (added > 0) {
          this.ctx.logger.info(`corum-review round ${round.index}: +${added} path(s) via worktree union`)
        }
        const repo = await this.ensureRepo(round.workspace)
        await this.enqueue(repo, async () => {
          const base = await this.ensureBaseline(repo)
          // A：本轮开始时（触达路径换成 pre-image）
          const before = new Map<string, string | null>()
          for (const [path, pre] of touched) {
            // unavailable 与 absent 在这里都记成「父 tree 里没有该路径」：
            // 提交只需表达「改前不存在/未知」，内容真伪由 Preimage 负责。
            if (pre.kind === 'blob') { before.set(path, pre.hash); continue }
            // eslint-disable-next-line no-await-in-loop -- 量级 = 本轮改动文件数
            before.set(path, pre.kind === 'content' ? await this.hashObject(repo, pre.text) : null)
          }
          const commitA = await this.commitWith(repo, base, before, `round ${round.index} start`)
          // B：本轮结束时（触达路径换成写完之后的内容）
          const after = new Map<string, string | null>()
          for (const path of touched.keys()) {
            const current = this.readCurrent(resolve(round.workspace, path))
            // eslint-disable-next-line no-await-in-loop -- 同上
            after.set(path, current.kind === 'content' ? await this.hashObject(repo, current.text) : null)
          }
          const commitB = await this.commitWith(repo, commitA, after, `round ${round.index} end`)
          // round ref：可审的 changeset（寿命由保留天数决定）。
          await runGit(repo.gitDir, ['update-ref', `refs/corum/rounds/${round.sessionId}/${round.index}`, commitB])
          // main 换成**无父的快照提交**，只表达「已接受的当前状态」。
          //
          // ⚠️ 不能让 main 直接指向 B：那样每轮的 A（含 pre-image blob）会永远留在 main 的
          // 祖先链上，**prune 掉轮次 ref 也回收不掉** —— 磁盘随「历史总编辑量」无界增长，
          // 保留天数就形同虚设（实测：prune(0) 后 main 仍有 3 个提交、占用几乎不变）。
          // 改成无父快照后，可达性只由「保留窗口内的 round ref」+「当前状态」决定，
          // 超出窗口的对象在下一次 gc 时真正释放。
          const tree = await runGit(repo.gitDir, ['rev-parse', `${commitB}^{tree}`])
          if (tree.code !== 0) throw new Error(`rev-parse tree failed: ${tree.stderr || tree.code}`)
          const state = await runGit(repo.gitDir, [
            '-c', 'user.name=corum', '-c', 'user.email=corum@localhost',
            'commit-tree', tree.stdout.trim(), '-m', 'chore: accepted state',
          ])
          if (state.code !== 0) throw new Error(`state commit failed: ${state.stderr || state.code}`)
          await runGit(repo.gitDir, ['update-ref', 'refs/heads/main', state.stdout.trim()])
          // 轮次已进提交：journal 里这个会话的记录可以丢掉了（否则会无限增长）。
          await this.appendJournal(round.workspace, { t: 'end', session: round.sessionId, round: round.index })
          await this.compactJournal(round.workspace, round.sessionId)
          await this.pruneRepo(repo)
        })
      } catch (error) {
        this.ctx.logger.warn(`corum-review closeRound failed: ${String(error)}`)
      }
    })()
  }

  // ── 轮末并集兜底（bash 绕道的安全网）──────────────────────────────────────

  /**
   * 快照路径上的并集扫描（节流 + 不阻塞 + 同时只跑一次）。
   *
   * 为什么需要它：并集兜底若只在 `closeRound` 里做，那次扫描发生在**下一轮 turn/start**
   * （那时本轮已从 `rounds` 摘掉），审查卡再也读不到它 —— 用户依然「看不见」。
   * 卡片每次会话事件都会拉一次 `snapshot`，所以在快照路径上挂一个节流扫描，扫到的路径
   * 会在**下一次**刷新出现在卡片里（本次调用立即返回手头的数据，绝不 await git）。
   */
  private scheduleUnionScan(round: LiveRound): void {
    if (round.closed === true || round.unionScanInFlight === true) return
    const now = Date.now()
    if (now - (round.lastUnionScanAt ?? 0) < UNION_SCAN_MIN_INTERVAL_MS) return
    round.lastUnionScanAt = now
    round.unionScanInFlight = true
    void (async () => {
      try {
        // 排队期间轮次可能已经收尾（closeRound 会自己再兜一次）：那就别写这张残表。
        if (round.closed === true) return
        const added = await this.applyWorktreeChanges(round, round.touched)
        if (added > 0) {
          this.ctx.logger.info(`corum-review round ${round.index}: +${added} path(s) via worktree union`)
        }
      } catch (error) {
        this.ctx.logger.warn(`corum-review worktree union failed: ${String(error)}`)
      } finally {
        round.unionScanInFlight = false
      }
    })()
  }

  /**
   * 求并在：把「本轮确实变了、但没有任何工具捕获到」的路径补进 `touched`。
   *
   * @param touched - 要写入的表（closeRound 传的是已经脱离 `rounds` 的那份）。
   * @returns 补进来的条数。
   */
  private async applyWorktreeChanges(round: LiveRound, touched: Map<string, Preimage>): Promise<number> {
    const candidates = await this.scanWorktreeChanges(round, touched)
    if (candidates.length === 0) return 0
    const repo = await this.ensureRepo(round.workspace)
    let added = 0
    for (const rel of candidates) {
      // eslint-disable-next-line no-await-in-loop -- 量级 = 兜底路径条数（上限 200）
      const pre = await this.unionPreimage(repo, round.workspace, rel)
      if (pre === null) continue // 与我们上次见到的内容完全一致：本轮无关
      if (touched.has(rel)) continue
      touched.set(rel, pre)
      added += 1
      // 与文件工具同一条持久化路径：崩在一轮中间也能恢复（C6）。
      // eslint-disable-next-line no-await-in-loop -- 同上
      await this.persistCapture(round, rel, pre)
    }
    return added
  }

  /**
   * 读工作区实况（`git status --porcelain -z`）挑出本轮兜底候选（工作区相对路径）。
   *
   * 三道筛子，顺序即「宁可漏，不可猜」：
   *   1. 路径必须在工作区内（porcelain 的路径是**仓库根**相对，仓库根可能在工作区之上）；
   *   2. 本轮没被任何工具捕获过；
   *   3. **mtime ≥ 本轮开始时刻**（文件已不在时看父目录的 mtime）—— 否则用户自己或历史
   *      遗留的脏文件会被当成本轮改动，审查卡变成噪音（这比漏报更糟：它误导审核）。
   *
   * 非 git 工作区（`git status` 退出非 0）只记一次 warn 后放弃本轮兜底 —— 命令捕获那条路
   * 仍然有效。
   */
  private async scanWorktreeChanges(round: LiveRound, touched: ReadonlyMap<string, Preimage>): Promise<string[]> {
    try {
      const status = await runGitIn(round.workspace, [
        '--no-optional-locks',
        '-c', 'status.relativePaths=false',
        'status', '--porcelain', '-z', '--no-renames',
      ])
      if (status.code !== 0) {
        this.warnOnce(
          `worktree:${round.workspace}`,
          `corum-review worktree union skipped (git status ${status.code}): ${status.stderr.trim().split('\n')[0] ?? ''}`,
        )
        return []
      }
      const entries = parsePorcelainPaths(status.stdout)
      if (entries.length === 0) return []
      const top = await runGitIn(round.workspace, ['--no-optional-locks', 'rev-parse', '--show-toplevel'])
      if (top.code !== 0) return []
      // 两边都 realpath：porcelain 的路径挂在仓库根上，而会话 cwd 可能是软链接路径
      // （macOS 的 /tmp → /private/tmp），不归一化就会把工作区内的路径判成「在外面」。
      const root = this.realpathOr(top.stdout.trim())
      const workspace = this.realpathOr(round.workspace)
      const absList = selectUnionCandidates(entries, {
        root,
        floor: round.startedAt - UNION_MTIME_SLACK_MS,
        maxPaths: MAX_UNION_PATHS,
        maxDirDepth: UNION_DIR_MAX_DEPTH,
        probe: {
          fileMtime: (abs) => {
            try {
              const stat = statSync(abs)
              return stat.isFile() || stat.isDirectory() ? stat.mtimeMs : null
            } catch { return null }
          },
          parentMtime: (abs) => {
            try { return statSync(dirname(abs)).mtimeMs } catch { return null }
          },
          children: (abs) => {
            try {
              return readdirSync(abs, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
            } catch { return [] }
          },
        },
      })
      const out: string[] = []
      for (const abs of absList) {
        const rel = this.relativePath(workspace, abs)
        if (rel === null || touched.has(rel) || out.includes(rel)) continue
        out.push(rel)
      }
      return out
    } catch (error) {
      this.ctx.logger.warn(`corum-review scanWorktreeChanges failed: ${String(error)}`)
      return []
    }
  }

  /**
   * 兜底路径的「改动前」内容：影子仓库 `main` 树里**我们上次见到**的那个版本。
   *
   * 为什么是 main：main 是本服务记录的「已接受状态」，某路径最后一次被本轮之前的某轮触碰
   * 时的内容就在那里 —— 语义正是「自我们上次看到它以来的变化」。
   *
   * 取不到（从没被记录过）就如实记 `unavailable`：卡片里**看得见**这个文件变了，但撤销会
   * 明确拒绝。**绝不猜 `absent`** —— 那会让一次撤销删掉用户的文件（见 Preimage 三态说明）。
   *
   * @returns `null` = 与当前内容一致（本轮无关，不必进卡片）。
   */
  private async unionPreimage(repo: RepoState, workspace: string, rel: string): Promise<Preimage | null> {
    const current = this.readCurrent(resolve(workspace, rel))
    const blob = await runGit(repo.gitDir, ['cat-file', 'blob', `refs/heads/main:${rel}`])
    if (blob.code !== 0) return { kind: 'unavailable' }
    // 二进制（含 NUL）：utf8 解码是有损的，回滚会把文件写坏 → 如实记「取不到」。
    if (blob.stdout.includes('\0') || blob.stdout.length > MAX_PREIMAGE_BYTES) return { kind: 'unavailable' }
    if (current.kind === 'content' && current.text === blob.stdout) return null
    return { kind: 'content', text: blob.stdout }
  }

  /** realpath（失败时原样返回）—— porcelain 的路径与 cwd 可能一个软链一个不是。 */
  private realpathOr(path: string): string {
    try { return realpathSync(path) } catch { return path }
  }

  /** 同一个 key 只 warn 一次（非 git 工作区每轮都会走到这里，别刷日志）。 */
  private warnOnce(key: string, message: string): void {
    if (this.warnedOnce.has(key)) return
    this.warnedOnce.add(key)
    this.ctx.logger.warn(message)
  }

  // ── 保留策略 ─────────────────────────────────────────────────────────────

  /**
   * 按 `retentionDays` 删除过期轮次 ref，然后 gc。
   *
   * 为什么 prune 而不是永久保留：语义是「未审核的轮次默认保留」，旧轮次不需要永久
   * 可回滚，所以用天数把磁盘钉一个硬上限（用户定调默认 **1 天**）。
   * `retentionDays = 0` = 不保留轮次历史（只留 main 指向的已接受状态）。
   */
  private async pruneRepo(repo: RepoState): Promise<void> {
    const listed = await runGit(repo.gitDir, [
      'for-each-ref', '--format=%(refname) %(committerdate:unix)', 'refs/corum/rounds/',
    ])
    if (listed.code !== 0) return
    const cutoff = Math.floor(Date.now() / 1000) - this.retentionDays * 86400
    const expired: string[] = []
    for (const line of listed.stdout.split('\n')) {
      const [ref, when] = line.trim().split(' ')
      if (ref === undefined || ref === '' || when === undefined) continue
      if (this.retentionDays <= 0 || Number(when) < cutoff) expired.push(ref)
    }
    if (expired.length === 0) return
    for (const ref of expired) {
      // eslint-disable-next-line no-await-in-loop -- 过期 ref 数量有限
      await runGit(repo.gitDir, ['update-ref', '-d', ref])
    }
    // 真正回收磁盘的一步：不可达对象清掉。
    await runGit(repo.gitDir, ['gc', '--prune=now', '--quiet'])
  }

  /** 更新保留天数（客户端设置页写入后经 RPC 调）。 */
  setRetentionDays(days: number): void {
    if (!Number.isFinite(days)) return
    this.retentionDays = Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, Math.floor(days)))
  }

  // ── 对外 RPC ─────────────────────────────────────────────────────────────

  /**
   * 当前活轮次的改动快照（Review 卡的数据源）。
   * 行数交给 git 自己算（pre-image blob ↔ 当前内容 blob），不自己实现 LCS。
   */
  @Remote('snapshot')
  async snapshot(sessionId: string): Promise<{ workspace: string | null; roundIndex: number; files: ReviewFileEntry[] }> {
    const round = this.rounds.get(sessionId)
    if (round === undefined) return { workspace: null, roundIndex: 0, files: [] }
    // 顺手排一次（节流过的）工作区并集扫描：bash 绕道改的文件要在这里被补进来，用户才
    // 真的看得见（见 scheduleUnionScan）。不 await：卡片拿手头数据先渲染。
    this.scheduleUnionScan(round)
    if (round.touched.size === 0) return { workspace: round.workspace, roundIndex: round.index, files: [] }
    const repo = await this.ensureRepo(round.workspace)
    const files: ReviewFileEntry[] = []
    for (const [path, pre] of round.touched) {
      const after = this.readCurrent(resolve(round.workspace, path))
      // eslint-disable-next-line no-await-in-loop -- 量级 = 本轮改动文件数
      const beforeText = await this.preimageText(repo, pre)
      const afterText = after.kind === 'content' ? after.text : null
      // eslint-disable-next-line no-await-in-loop -- 量级 = 本轮改动文件数
      const stats = await this.diffStat(repo, beforeText, afterText)
      if (stats.added === 0 && stats.removed === 0) continue // 净变化 0：不算「更改」
      // eslint-disable-next-line no-await-in-loop -- 同上
      const hash = await this.hashObject(repo, afterText ?? '')
      files.push({ path, added: stats.added, removed: stats.removed, hash })
    }
    return { workspace: round.workspace, roundIndex: round.index, files }
  }

  /** 两段内容之间的行级增删，交给 git diff。 */
  private async diffStat(repo: RepoState, before: string | null, after: string | null): Promise<{ added: number; removed: number }> {
    if (before === null && after === null) return { added: 0, removed: 0 }
    if (before === after) return { added: 0, removed: 0 }
    const blobA = await this.hashObject(repo, before ?? '')
    const blobB = await this.hashObject(repo, after ?? '')
    if (blobA === blobB) return { added: 0, removed: 0 }
    const result = await runGit(repo.gitDir, ['diff', '--numstat', blobA, blobB])
    if (result.code !== 0) return { added: 0, removed: 0 }
    const line = result.stdout.trim().split('\n')[0]
    if (line === undefined || line === '') return { added: 0, removed: 0 }
    const [addRaw, delRaw] = line.split('\t')
    const added = Number(addRaw)
    const removed = Number(delRaw)
    return {
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
    }
  }

  /** 某文件「本轮改动前」的内容（diff 视图左侧）。 */
  @Remote('fileBefore')
  async fileBefore(sessionId: string, path: string): Promise<{ exists: boolean; content: string; created: boolean }> {
    const round = this.rounds.get(sessionId)
    if (round === undefined) return { exists: false, content: '', created: false }
    const pre = round.touched.get(path)
    if (pre === undefined) return { exists: false, content: '', created: false }
    if (pre.kind === 'content') return { exists: true, content: pre.text, created: false }
    if (pre.kind === 'blob') {
      const repo = await this.ensureRepo(round.workspace)
      return { exists: true, content: (await this.preimageText(repo, pre)) ?? '', created: false }
    }
    // absent = 本轮新建（左侧应为空）；unavailable = 取不到改前内容（左侧空 + 调用方提示）
    return { exists: true, content: '', created: pre.kind === 'absent' }
  }

  /**
   * 撤销：把给定路径恢复到「本轮改动前」；`path` 省略 = 撤销整轮。
   * pre-image 为 undefined 且文件当时不存在 ⇒ 删除该文件。
   */
  @Remote('rollback')
  async rollback(sessionId: string, path?: string): Promise<{ ok: boolean; restored: number; failed: number; message?: string }> {
    const round = this.rounds.get(sessionId)
    if (round === undefined) return { ok: false, restored: 0, failed: 0, message: '当前没有进行中的轮次' }
    const targets = path === undefined
      ? [...round.touched.keys()]
      : (round.touched.has(path) ? [path] : [])
    if (targets.length === 0) return { ok: false, restored: 0, failed: 0, message: '该文件不在本轮改动里' }

    let restored = 0
    let failed = 0
    const problems: string[] = []
    for (const rel of targets) {
      try {
        const abs = resolve(round.workspace, rel)
        const pre = round.touched.get(rel)
        if (pre === undefined) { failed++; problems.push(`${rel}: 不在本轮改动里`); continue }
        if (pre.kind === 'unavailable') {
          // 取不到改前内容 ⇒ **绝不能删文件**（那会把用户的文件毁掉），如实报告失败。
          failed++
          problems.push(`${rel}: 没有保留改动前的内容（文件过大或非文本），无法撤销`)
          continue
        }
        if (pre.kind === 'absent') rmSync(abs, { force: true })
        else {
          // content 直接用；blob 形态（重启后恢复的轮次）从对象库取回。
          const text = pre.kind === 'content' ? pre.text : await this.preimageText(await this.ensureRepo(round.workspace), pre)
          if (text === null) { failed++; problems.push(`${rel}: 取不回改动前内容`); continue }
          mkdirSync(resolve(abs, '..'), { recursive: true })
          writeFileSync(abs, text, 'utf8')
        }
        // 撤销后该文件已回到「改前」，从本轮触达里摘掉 —— 否则卡片会一直显示一个
        // 已经回退干净的条目。
        round.touched.delete(rel)
        restored++
      } catch (error) {
        failed++
        problems.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      ok: failed === 0,
      restored,
      failed,
      ...problems.length > 0 ? { message: problems.join('; ') } : {},
    }
  }

  /** 保留天数当前值。 */
  @Remote('retention')
  async retention(): Promise<{ days: number }> {
    return { days: this.retentionDays }
  }

  /** 设置保留天数（写入后立即对已有仓库生效，不必等下一轮）。 */
  @Remote('setRetention')
  async setRetention(days: number): Promise<{ days: number }> {
    this.setRetentionDays(days)
    for (const workspace of [...this.repos.keys()]) {
      const repo = this.repos.get(workspace)
      if (repo === undefined) continue
      try {
        // eslint-disable-next-line no-await-in-loop -- 仓库数量有限
        await this.enqueue(repo, () => this.pruneRepo(repo))
      } catch (error) {
        this.ctx.logger.warn(`corum-review prune failed: ${String(error)}`)
      }
    }
    return { days: this.retentionDays }
  }

  /** 影子仓库磁盘占用（诊断/展示）。 */
  @Remote('usage')
  async usage(): Promise<{ total: number; repos: { key: string; bytes: number }[] }> {
    const home = process.env.DSH_HOME ?? resolveDshHome('~/.corum')
    const base = join(home, 'review')
    const repos: { key: string; bytes: number }[] = []
    let total = 0
    if (!existsSync(base)) return { total, repos }
    for (const name of readdirSync(base)) {
      const dir = join(base, name, 'repo.git')
      if (!existsSync(dir)) continue
      const bytes = this.dirSize(dir)
      repos.push({ key: name, bytes })
      total += bytes
    }
    return { total, repos }
  }

  private dirSize(dir: string): number {
    let total = 0
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) total += this.dirSize(full)
        else total += statSync(full).size
      }
    } catch { /* 忽略不可读项 */ }
    return total
  }
}
