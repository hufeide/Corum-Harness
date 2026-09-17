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

import { realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'

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
