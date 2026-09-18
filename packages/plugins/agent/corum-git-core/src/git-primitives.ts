/**
 * @corum/corum-git-core — git 管理的核心机制（corum 核心插件，**不可卸载**）。
 *
 * ## 定位（用户 2026-09-16 策略）
 *
 * ① 将所有 git 管理的机制收进**一个独立插件**（git-core）；
 * ② 四条机制级不变式（invariant.workspace-git-required / commit-after-modification /
 *    background-parallel-isolated / merge-strategy）均**基于本插件提供的能力**完成；
 * ③ 本插件为 **corum 核心插件，不可卸载**。
 *
 * ## 本模块（git-primitives）——cordis-free 的 git 原语（纯函数，无 cordis import）
 *
 * 与 desktop host 的 `corum-git.ts` 同源（其能力迁入本插件，desktop 不再手动 new），
 * 但抽成纯函数层以便：① 被 cordis 服务包装（host RPC + 同进程直调两用）；
 * ② 被 host 创建入口（createAgentForTask / openProject）作**强制前置**直调——
 * 不变式①「工作区必须有 git 参考」要求创建入口**机制保证**「探测，没有就初始化」，
 * 而不是靠 UI 层自觉调用（旧缺口的根因，见 invariant.workspace-git-required）。
 *
 * 纪律：本文件保持 cordis-free（纯库），cordis 服务面由 index.ts 声明。
 * @module corum-git-core/git-primitives
 */

import { realpathSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

/** 在目录下跑一个 git 子命令；exit code / stdout / stderr 全回（不抛）。 */
function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', rejectPromise)
    child.on('exit', (code) => {
      resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 })
    })
  })
}

/** realpath 归一目标目录（symlink/.. 解析），不存在则抛错。 */
function resolveDir(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('path must be a non-empty absolute directory path')
  }
  return realpathSync(path)
}

/**
 * 侦测目录是否是 git 仓库（含 worktree/子目录——`git rev-parse --git-dir` 在
 * 仓库任意子目录都成功）。git 未安装/目录不可读等按非仓库处理（返回 false）。
 * @param path - 任意绝对目录路径。
 */
export async function isGitRepo(path: string): Promise<boolean> {
  const dir = resolveDir(path)
  try {
    const { code } = await runGit(dir, ['rev-parse', '--git-dir'])
    return code === 0
  } catch {
    return false
  }
}

/**
 * 保证 `.gitignore` 含 `.corum-worktrees/`（机制运行时产物的 ignore）。
 *
 * 为什么机制必须自己写（2026-09-16 用户定调）：orchestrate 的隔离 worktree 建在
 * `<cwd>/.corum-worktrees/` 下，若该目录未被 ignore，第二个并行任务的
 * `corumDirtyParentRefusal` 会把 `?? .corum-worktrees/`（任务 1 刚建的 worktree）
 * 当成「父树未提交改动」而**拒绝隔离**——导致「第二个并行任务从未 spawn」（Bug A）。
 * 靠 LLM 每次手动 ignore（e2e-a 的 `5580492`）不可持续 ⇒ 机制在 init 时**默认写好**。
 *
 * 幂等：.gitignore 已含该行（任意位置，含无尾换行的文件末尾）则不动；
 * 不存在则新建、存在但缺该行则**追加**（不覆盖用户既有内容）。
 *
 * **导出原因**（2026-09-16 不变式⑤配套）：本函数原先只在 {@link initRepo} 调用，
 * 于是只对「corum 自己 init 的仓库」生效。用户**既有**仓库（手动 init / clone）若没有
 * 这一行，第一个 worktree 建好后 `.corum-worktrees/` 会以 `?? .corum-worktrees/` 出现在
 * `porcelain` 里 ⇒ **下一个**委派的 `corumDirtyParentRefusal` 必被拒（实测复现）。
 * 隔离改为「写委派恒隔离」后每次委派都过那道门，这个缺口会被放大成「第二次起必被拒」，
 * 故 `createWorktreeChild` 建目录前也调用本函数（而不是只在 init 时写）。
 *
 * @param dir - 已 realpath 归一的目录（主树根）。
 * @returns `true` = 本次写入了 ignore 行（调用方通常随即把它提交掉）；`false` = 已存在，无需改。
 */
export function ensureWorktreeGitignore(dir: string): boolean {
  const file = join(dir, '.gitignore')
  const line = '.corum-worktrees/'
  if (existsSync(file)) {
    const content = readFileSync(file, 'utf8')
    // 已含该行（精确匹配整行，避免误配 `.corum-worktrees-foo/` 之类）。
    if (content.split('\n').some(l => l.trim() === line)) return false
    // 追加（保证前一行有换行；空文件/无尾换行都安全）。
    const prefix = content === '' || content.endsWith('\n') ? '' : '\n'
    writeFileSync(file, `${content}${prefix}${line}\n`)
    return true
  }
  writeFileSync(file, `# corum 编排隔离 worktree 的运行时产物（机制自动写入，勿入库）\n${line}\n`)
  return true
}

/**
 * 初始化 git 仓库：`git init` + 一个空初始 commit。
 *
 * 必须带初始 commit：worktree/分支需要至少一个 commit 才能创建（空仓库
 * `git worktree add <path> -b <branch>` 会失败，隔离仍不可用）。空 commit 不
 * 触碰用户的任何文件（`--allow-empty`），保持最小侵入；`-c user.name/email`
 * 一次性身份不写用户的 global/local config。
 *
 * 幂等：已是仓库时直接返回 alreadyRepo:true（不重复 init/commit）。
 * @param path - 任意绝对目录路径。
 */
export async function initRepo(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
  const dir = resolveDir(path)
  if (await isGitRepo(dir)) return { initialized: false, alreadyRepo: true }

  const initResult = await runGit(dir, ['init'])
  if (initResult.code !== 0) {
    throw new Error(`git init failed (exit ${initResult.code}): ${initResult.stderr || 'no stderr'}`)
  }
  // 机制默认写 .gitignore（.corum-worktrees/）——否则第二个并行任务会被判脏拒掉（Bug A）。
  // 在初始 commit **之前**写，让 ignore 进首个 commit（自身不会成为未提交改动）。
  ensureWorktreeGitignore(dir)
  // 初始 commit 顺带把 .gitignore 收进去（`--allow-empty` 是空 commit，不会自动 add；
  // 先 add .gitignore 再 commit，让 worktree 产物从第一个 commit 起就被 ignore）。
  const addResult = await runGit(dir, ['add', '.gitignore'])
  if (addResult.code !== 0) {
    throw new Error(`git add .gitignore failed (exit ${addResult.code}): ${addResult.stderr || 'no stderr'}`)
  }
  const commitResult = await runGit(dir, [
    '-c', 'user.name=corum',
    '-c', 'user.email=corum@localhost',
    'commit', '--allow-empty', '-m', 'chore: initial commit',
  ])
  if (commitResult.code !== 0) {
    throw new Error(`git initial commit failed (exit ${commitResult.code}): ${commitResult.stderr || 'no stderr'}`)
  }
  return { initialized: true, alreadyRepo: false }
}

/**
 * 保证目录是一个 git 仓库：已是仓库则原样返回，否则 `git init` + 初始 commit。
 *
 * 这是**产品策略的唯一落点**（2026-09-11 用户定调 + 2026-09-16 不变式①）：
 * corum 不提供「是否初始化 git」开关——工作区/任务/项目的创建**机制保证**
 * 「探测，没有就初始化」。host 创建入口一律调本函数作强制前置（不靠 UI 自觉）。
 *
 * @param path - 任意绝对目录路径。
 * @returns `initialized` 表示本次是否真的创建了仓库。
 */
export async function ensureRepo(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
  return await initRepo(path)
}

/* ── 不变式②原语：收口强制提交（commit-after-modification）────────────── */

/** 同步跑一个 git 子命令（execFileSync；exit 0 回 stdout，否则带 stderr/code）。 */
function runGitSync(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
    return { code: 0, stdout: stdout.trim(), stderr: '' }
  } catch (error: unknown) {
    const stderr = (error as { stderr?: Buffer | string }).stderr
    return { code: 1, stdout: '', stderr: stderr === undefined ? String(error) : String(stderr) }
  }
}

/** 目录是否有未提交改动（`git status --porcelain` 非空；非 git/目录不存在返回 false）。 */
export function hasUncommittedChanges(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    return runGitSync(path, ['status', '--porcelain']).stdout !== ''
  } catch {
    return false
  }
}

/** 强制提交失败的结构化原因（供上层注入通知/阻断）。 */
export interface SettleCommitFailure {
  path: string
  reason: string
}

/**
 * 不变式②的核心原语：**收口强制提交**——把目录里未提交的改动就地提交
 * （`git add -A` + `git commit --no-verify`）。
 *
 * 与 orchestration 的 `corumCommitWorktreeOnSettle`（隔离 worktree 专用）同源，但
 * **不绑定 worktree**——任意 git 目录可用：主 Agent 在父树直接改 / 单发前台写任务
 * 在父树写，turn-end 收口时同样强制提交（用户 2026-09-15 裁定「每次工作结束必须
 * 提交，机制保证而非 Agent 自觉」对所有 Agent 生效，不只隔离 worktree）。
 *
 * 提交用 `-c user.name/email` 一次性身份（不写用户的 global/local config）；
 * `--no-verify` 防宿主钩子拦下（钩子失败会让「必须提交」失效）。
 *
 * @param path - 目标 git 目录（父树主工作区）。
 * @param subject - 提交信息首行（含溯源，如 `wip(<scope>): auto-commit on settle`）。
 * @returns `undefined` = 成功或无需提交（干净/目录不存在/非 git）；否则为失败原因。
 */
export function settleCommit(path: string, subject: string): SettleCommitFailure | undefined {
  if (!existsSync(path)) return undefined
  if (!hasUncommittedChanges(path)) return undefined
  const added = runGitSync(path, ['add', '-A'])
  if (added.code !== 0) return { path, reason: `git add failed: ${added.stderr.trim()}` }
  const committed = runGitSync(path, [
    '-c', 'user.name=corum',
    '-c', 'user.email=corum@localhost',
    'commit', '--no-verify', '-m', subject,
  ])
  if (committed.code === 0) return undefined
  return { path, reason: `git commit failed: ${committed.stderr.trim()}` }
}

/**
 * 目录是否处于**未结清的合并/重放中**（`MERGE_HEAD` 存在）。
 *
 * 由来（2026-09-16 实机）：集成门禁把 persona 改成「先 `git merge --no-commit` 合、验完再提交」
 * 以后，verify 失败被拒时主树会**停在一个未结清的合并现场**——`fatal: You have not concluded
 * your merge (MERGE_HEAD exists)` 会让后续**每一次** merge/commit 失败，包括下一轮 orchestrate
 * 的集成者与 turn-end 收口。这既毒化后续判定，也让「保留现场」变成「卡死工作区」。
 *
 * 判据只用 git 自己的状态文件语义（`git rev-parse --verify -q MERGE_HEAD`），不猜、不看输出文案；
 * 非 git / 目录不存在 / 无合并 → false。
 * @param path - 目标 git 目录（主树）。
 */
export function mergeInProgress(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    return runGitSync(path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).code === 0
  } catch {
    return false
  }
}

/**
 * **放弃未结清的合并**（`git merge --abort`）——把工作区从「合并中」态解出来。
 *
 * ## 为什么这是**安全**的（与 persona 那条破坏性 git 禁令不冲突）
 *
 * persona 明禁 `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash`：那些会
 * **丢掉主树里与本轮无关的在制品**。`git merge --abort` 的语义不同——它只回退**本次合并**
 * 引入的暂存/工作区改动，把它们还原到合并前状态；合并前的未提交在制品不被丢弃。
 *
 * ## 何时调用（调用方纪律）
 *
 * 只在**集成已被机制拒绝**时调用，且**必须**在「本轮的改动已经不可能靠这次合并落地」之后：
 * 被拒的分支提交仍在分支上（唯一副本，分支从未删除），所以放弃这次未结清的合并**不会丢工作**
 * ——它只是把「半合进去但没提交」的暂存态还原，让工作区回到可继续操作的状态。反之，把
 * `MERGE_HEAD` 留着会让后续每一条 merge/commit 都失败（实测）。
 *
 * @param path - 目标 git 目录（主树）。
 * @returns `undefined` = 成功或本就无合并；否则为失败原因。
 */
export function abortMerge(path: string): SettleCommitFailure | undefined {
  if (!existsSync(path)) return undefined
  if (!mergeInProgress(path)) return undefined
  const aborted = runGitSync(path, ['merge', '--abort'])
  if (aborted.code === 0) return undefined
  return { path, reason: `git merge --abort failed: ${aborted.stderr.trim()}` }
}
