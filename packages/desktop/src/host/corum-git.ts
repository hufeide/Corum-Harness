/**
 * corum-desktop/corum-git — 工作区 git 侦测与初始化 Host 半（Typert Remote，
 * service 名 `corumGit`）。
 *
 * 背景（用户需求 2026-09-09）：新建工作区时自动侦测 git 仓库，没有则询问用户
 * 是否初始化——corum 的子 Agent 编排隔离（worktree）/ 声明式 verify / integrate
 * 全部依赖 git 仓库；非 git 工作区这些能力不可用（实测 `isolation: always` 在
 * 非 git 目录 `git worktree add` 直接报 `fatal: not a git repository`）。本服务
 * 提供 renderer 流程所需的两个原子能力：`status`（侦测）与 `init`（初始化）。
 *
 * 与 corumFs 的差异：corumFs 以「host 进程 cwd 为项目根」防穿越（文件树数据源）；
 * 本服务接受**任意绝对路径**——用户添加的工作区可在文件系统任意位置，不存在
 * 「项目根」概念，故不做根校验，仅 realpath 归一后在目标目录跑 git。
 *
 * 同时承载 `corum-workspace` settings namespace 的注册（「新工作区始终初始化 git」
 * 通用开关的持久化面）——与 ui-onboarding 在 boot.ts 的补注册同款原因：该 namespace
 * 无其它插件负责注册，host 半在此注册使 settings.describe / mutate 可用。
 *
 * @Remote 方法直接 return value（Typert Remote 信封自动包 `{ ok: true, value }`），
 * 失败 throw（包成 `{ ok: false, error }`）。
 * @module corum-desktop/corum-git
 */

import { realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'

// ── corum-workspace settings namespace（通用开关持久化面）─────────────────────

/** settings.yaml 的 corum-workspace 段。 */
export const CORUM_WORKSPACE_SETTINGS_NAMESPACE = 'corum-workspace'

/** 通用设置形（全键可选——omission 语义，未改的键不落 yaml）。 */
export interface CorumWorkspaceSettings {
  /** 新建工作区时是否自动初始化 git 仓库（默认 true）。 */
  readonly autoInitGit?: boolean
}

/** schemastery schema（omission 语义：default(undefined) 不物化未改的键）。 */
export const CORUM_WORKSPACE_SETTINGS_SCHEMA: z<CorumWorkspaceSettings> = z.object({
  autoInitGit: z.boolean().default(undefined as unknown as boolean),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 工作区 git 侦测/初始化服务（子 Agent 编排隔离等 git 依赖能力的前置）。 */
    corumGit: CorumGitService
  }
}

/** 在目录下跑一个 git 子命令；exit 0 resolve stdout，否则 reject 带 stderr。 */
function runGit(cwd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', rejectPromise)
    child.on('exit', (code) => {
      resolvePromise({ stdout: stdout.trim(), code: code ?? -1 })
      void stderr
    })
  })
}

export class CorumGitService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'corumGit')
    // corum-workspace namespace 注册（「新工作区始终初始化 git」开关的持久化面）。
    // settings 服务此时尚未挂载（host boot 早期），短轮询直到可用——与 boot.ts 的
    // ui-onboarding 补注册同款模式（根 ctx 上 inject 异步回调实测不触发）。
    const register = (): void => {
      const settings = ctx.get('settings') as {
        register: (ns: unknown, schema: unknown) => void
      } | undefined
      if (settings === undefined) return
      settings.register(CORUM_WORKSPACE_SETTINGS_NAMESPACE, CORUM_WORKSPACE_SETTINGS_SCHEMA)
      this.ctx.logger.info('corum-workspace namespace registered')
    }
    const poll = setInterval(() => {
      if (ctx.get('settings') !== undefined) {
        clearInterval(poll)
        try { register() } catch (error) {
          this.ctx.logger.warn(`corum-workspace register failed: ${String(error)}`)
        }
      }
    }, 100)
    setTimeout(() => clearInterval(poll), 15000)
  }

  /** realpath 归一目标目录（symlink/.. 解析），不存在则抛错。 */
  private async resolveDir(path: string): Promise<string> {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error('path must be a non-empty absolute directory path')
    }
    return realpath(path)
  }

  /**
   * 侦测目录是否是 git 仓库（含 worktree/子目录——`git rev-parse --git-dir` 在
   * 仓库任意子目录都成功）。
   * @param path - 任意绝对目录路径。
   */
  @Remote('status')
  async status(path: string): Promise<{ isRepo: boolean }> {
    const dir = await this.resolveDir(path)
    try {
      const { code } = await runGit(dir, ['rev-parse', '--git-dir'])
      return { isRepo: code === 0 }
    } catch {
      // git 未安装 / 目录不可读等——按非仓库处理（调用方走「询问初始化」分支）。
      return { isRepo: false }
    }
  }

  /**
   * 初始化 git 仓库：`git init` + 一个空初始 commit。
   *
   * 必须带初始 commit：worktree/分支需要至少一个 commit 才能创建（空仓库
   * `git worktree add <path> -b <branch>` 会失败，隔离仍不可用）。空 commit 不
   * 触碰用户的任何文件（`--allow-empty`），保持最小侵入。
   *
   * 幂等：已是仓库时直接返回 initialized:false（不重复 init/commit）。
   * @param path - 任意绝对目录路径。
   */
  @Remote('init')
  async init(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
    const dir = await this.resolveDir(path)
    const existing = await this.status(dir)
    if (existing.isRepo) return { initialized: false, alreadyRepo: true }

    const initResult = await runGit(dir, ['init'])
    if (initResult.code !== 0) {
      throw new Error(`git init failed (exit ${initResult.code})`)
    }
    // 空初始 commit：worktree/分支的前置。git 可能因缺 user.name/user.email 失败——
    // 用 -c 传入一次性身份（不写用户的 global/local config，最小侵入）。
    const commitResult = await runGit(dir, [
      '-c', 'user.name=corum',
      '-c', 'user.email=corum@localhost',
      'commit', '--allow-empty', '-m', 'chore: initial commit',
    ])
    if (commitResult.code !== 0) {
      throw new Error(`git initial commit failed (exit ${commitResult.code})`)
    }
    this.ctx.logger.info(`git initialized: ${dir}`)
    return { initialized: true, alreadyRepo: false }
  }
}
