/**
 * fork（corum）：workspace 的 **VCS 元数据可写根**——隔离 worktree 里能否提交的关键。
 *
 * @module @corum/corum-sandbox-local/git-write-roots
 *
 * 为什么需要它（2026-09-09 用户实机复现，docs/TODO.md）：
 * 官方 `writableRoots(policy)` 只给「session workspace（= 会话 cwd）+ /tmp + tmpdir」。
 * 隔离子 Agent 的 cwd 是 worktree（`<repo>/.corum-worktrees/wt-xxxx`），而 git 的
 * 可写状态全在**主仓的 .git 里**：
 *   - `<repo>/.git/worktrees/wt-xxxx/index.lock`（`git add` 的第一件事）
 *   - `<repo>/.git/objects/**`（新对象）
 *   - `<repo>/.git/refs/heads/<branch>`、`<repo>/.git/logs/**`（分支与 reflog）
 * 于是 `git add` 直接 `index.lock: Operation not permitted`（Seatbelt EPERM）——
 * 子 Agent 永远无法在自己的分支上提交，「子 Agent 提交 → 集成者合并」的隔离
 * 语义整条断裂。本模块把这两个 git 目录（worktree 私有 gitdir + 公共 common dir）
 * 并集进可写根，让隔离只收窄**工作区**，不再误伤版本控制。
 *
 * 边界（有意为之，不是安全边界）：授予的是整个 common dir（含 config/hooks），
 * 因为一次 `git commit` 会触碰 objects/refs/logs 多处，逐文件白名单既脆又慢。
 * DSH 的沙箱定位是「containment，不是安全边界」（官方 fs-sandbox 模块注释），
 * 子 Agent 本来就能跑任意 git 命令；这里解决的是「能不能正常用 git」，不是
 * 「防止子 Agent 用 git 搞破坏」。
 *
 * 平台差异：Seatbelt（macOS）/ bwrap、Landlock（Linux）共用本函数；Windows 的
 * windows-acl runner 目前只接受单个 `--workspace` 根（runner 侧协议），本函数
 * 对它无效——Windows 上隔离子 Agent 的 git 提交仍不可用（已在 docs/TODO.md 登记）。
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** `git rev-parse` 探测超时（ms）：沙箱 confine 是同步路径，绝不能被 git 卡住。 */
const GIT_PROBE_TIMEOUT_MS = 2000

/** workspaceRoot → git 元数据根（探测一次，进程内缓存；confine 在热路径上）。 */
const gitRootsCache = new Map<string, readonly string[]>()

/**
 * 探测一个 workspace 的 git 元数据可写根。
 *
 * 单次 `git rev-parse --git-dir --git-common-dir` 输出两行（worktree 下都是绝对
 * 路径；主仓里可能是相对的 `.git`，按 workspaceRoot 解析）。非 git 目录、git
 * 未安装、命令超时都返回空数组——能力自动关闭，绝不因此让 confine 失败。
 *
 * @param workspaceRoot - 策略的 workspace 根（= 会话 cwd）。
 * @returns 规范化去重后的 git 目录绝对路径（可能为空）。
 */
function detectGitMetadataRoots(workspaceRoot: string): readonly string[] {
  let output: string
  try {
    output = execFileSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_PROBE_TIMEOUT_MS,
    })
  } catch {
    return []
  }
  const roots = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => path.resolve(workspaceRoot, line))
  return [...new Set(roots)]
}

/**
 * 一个 workspace 的 git 元数据根（带进程内缓存）。
 * @param workspaceRoot - 策略的 workspace 根。
 * @returns 缓存的根列表（探测失败时为空数组，同样被缓存）。
 */
function gitMetadataRoots(workspaceRoot: string): readonly string[] {
  const cached = gitRootsCache.get(workspaceRoot)
  if (cached !== undefined) return cached
  const roots = detectGitMetadataRoots(workspaceRoot)
  gitRootsCache.set(workspaceRoot, roots)
  return roots
}

/**
 * 追加到官方可写根之后的本仓 git 元数据根。
 *
 * 只在 `workspace-write` 下返回（`read-only` 一个字节都不该写；`danger-full-access`
 * 不经过 profile 构建），与官方 {@link writableRoots} 的语义面保持一致。
 *
 * @param policy - 本次执行的文件效果策略。
 * @returns 需要额外授予写权限的 git 目录（已 canonical 化）。
 */
export function corumGitWriteRoots(policy: SandboxPolicy): readonly string[] {
  if (policy.mode !== 'workspace-write') return []
  return gitMetadataRoots(policy.workspaceRoot).map(canonicalPath)
}

/**
 * 单测钩子：清空探测缓存（同一临时目录在测试里反复重建时用）。
 */
export function corumResetGitRootsCache(): void {
  gitRootsCache.clear()
}
