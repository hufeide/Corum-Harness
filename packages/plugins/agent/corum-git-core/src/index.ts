/**
 * @corum/corum-git-core — cordis 服务面（host 装配点）。
 *
 * ## 服务面
 *
 * `gitCore`（cordis 服务，host 侧）：
 *   - `ensureRepo(path)` / `isRepo(path)` / `init(path)` —— 包装 git-primitives，
 *     供 host 创建入口（corum-agent / corumProject）作**强制前置**直调（同进程，
 *     不走 RPC）；也经 `@Remote` 暴露给 client（与旧 desktop corumGit RPC 同名兼容）。
 *   - `assertGitWorkspace(path)` —— 不变式①的机制门禁：创建工作区/任务/项目前的
 *     强制前置；失败（目录不可写/git 缺失）**抛错阻断创建**（fail-loud，不静默降级）。
 *
 * ## 不可卸载
 *
 * 本插件是 **corum 核心插件**（用户 2026-09-16 策略③）：cordis.patch.yml 的 insert
 * 段挂载行带 `# core: non-removable` 标记注释；插件管理器（corum-ide-plugin-manager-ui
 * / 设置·插件管理）按包名 `@corum/corum-git-core` 过滤，不显示启停/卸载入口。
 * cordis 本身无原生「不可卸载」行属性，故这是**约定 + UI 过滤 + 文档标记**三层。
 *
 * @module corum-git-core
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { ensureRepo, initRepo, isGitRepo, settleCommit, type SettleCommitFailure } from './git-primitives.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** git 管理核心机制（corum 核心插件，不可卸载）：工作区 git 侦测/初始化/创建前置门禁。 */
    gitCore: GitCoreService
  }
}

/**
 * git 管理核心服务（corum 核心插件，不可卸载）。
 *
 * host 侧 cordis 服务：既经 `@Remote` 暴露 RPC（service 名 `gitCore`，client 可调），
 * 也供 host 创建入口**同进程直调**（corum-agent/corumProject 经 `ctx.gitCore` inject
 * 后调 `assertGitWorkspace` 作创建前置——不变式①的机制保证落点）。
 */
export class GitCoreService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'gitCore')
  }

  /** 侦测目录是否是 git 仓库（含 worktree/子目录）。 */
  @Remote('status')
  async status(path: string): Promise<{ isRepo: boolean }> {
    return { isRepo: await isGitRepo(path) }
  }

  /** 初始化 git 仓库（`git init` + 空初始 commit；幂等）。 */
  @Remote('init')
  async init(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
    const result = await initRepo(path)
    if (result.initialized) this.ctx.logger.info(`git-core: initialized ${path}`)
    return result
  }

  /** 保证目录是 git 仓库（已是则原样返回，否则 init + 初始 commit）。 */
  @Remote('ensureRepo')
  async ensureRepoRemote(path: string): Promise<{ initialized: boolean; alreadyRepo: boolean }> {
    return await this.init(path)
  }

  /**
   * 不变式①的机制门禁（host 创建入口的强制前置）：
   * 创建工作区/任务/项目**之前**必须调用——保证目标目录是 git 仓库；
   * 失败（路径非法/不可写/git 缺失）**抛错阻断创建**（fail-loud，不静默降级）。
   *
   * 这是「工作区必须有 git 参考，机制一定要侦测」的**机制层**保证——不再依赖
   * UI 层自觉调用 ensureRepo（旧缺口的根因：新目录建任务/项目可绕过 UI 直命中
   * host 创建入口）。
   *
   * @param path - 任意绝对目录路径（待创建的工作区/任务/项目目录）。
   */
  async assertGitWorkspace(path: string): Promise<void> {
    await ensureRepo(path)
  }

  /**
   * 不变式②的机制面：**turn-end 收口强制提交**（host 钩子同进程直调）。
   *
   * 主 Agent（含单发前台写任务，它在父树直写）turn 结束时调用——把父树主工作区
   * 未提交的改动就地提交，让「每次工作结束必须提交」对**所有** Agent 生效（不只
   * 隔离 worktree）。`--no-verify` 防宿主钩子拦下。
   *
   * @param path - 父树主工作区目录。
   * @param scope - 溯源标签（进提交信息，如会话/任务标识）。
   * @returns 失败原因；`undefined` = 成功或无需提交（干净/非 git）。
   */
  settleCommitOnTurnEnd(path: string, scope: string): SettleCommitFailure | undefined {
    return settleCommit(path, `wip(${scope}): auto-commit on turn end`)
  }
}

/**
 * 插件 apply（cordis 装配点）：new 出 GitCoreService 挂到 host ctx。
 * cordis.patch.yml 的 insert 段挂载行使本 apply 运行（immediately）。
 * @param ctx - host cordis context。
 */
export function apply(ctx: Context): void {
  new GitCoreService(ctx)
}
