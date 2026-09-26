/**
 * fork（corum）：**隔离子会话的写边界**——把「改动只能落在自己的 worktree 里」从
 * 「一句提示词」变成机制。
 *
 * ## 为什么有这个文件（2026-09-22 用户实测，隔离第 2 层被整档旁路）
 *
 * `docs/plan/PLAN-subagent-isolation.md` §1.3 把隔离写成「**四层硬隔离（全部机制，
 * 无 prompt 纪律）**」，其中第 2 层是「fs 写沙箱：以 `session.header.cwd` 为
 * workspace-write 边界」。但沙箱模式是**按档位**开关的：
 *
 * | 层 | `workspace-write` | `danger-full-access` |
 * |---|---|---|
 * | ② fs 写沙箱 | ✅ 生效（子会话 cwd=worktree） | ❌ **整档旁路** |
 * | ③ shell/构建 | ✅ 以 header.cwd 起 | ⚠️ cwd 仍在 worktree，但可自由 `cd` / `git -C` |
 *
 * 而子会话的沙箱模式此前**整体继承父档位**（`captureDelegatedPolicyOverrides` 只
 * 在 `pinReadOnly` 时钉死）⇒ 用户在指挥模式切「完全权限」后，隔离的物理基础当场
 * 消失。实测（会话 `corum-task-ef3f751e`）：同一个 brief 结构，`workspace-write`
 * 派出的 worker 对主树写报 EPERM（硬隔离生效），`danger-full-access` 派出的 worker
 * 则成功删掉 19 个 worktree、并对主树执行 `git -C <主树> merge --no-ff`。
 *
 * ## 两层修法（用户 2026-09-22 拍板 1+2）
 *
 * ① **正交轴**（`corum-subagent` 的 `confinedSandbox`）：隔离期把子会话沙箱钉成
 *    `workspace-write`（**不继承**父档位，与 research 的 `readonlySandbox` 同一手法），
 *    于是第 2 层永远生效。边界 = 子会话 `header.cwd` = worktree。
 * ② **纵深防御**（本文件的 {@link confinementGuard}）：即便沙箱被旁路（未装配 /
 *    平台差异 / 未来改动），也拒绝对 worktree 之外路径的**写形态**调用。
 *
 * ## 为什么本文件在 corum-orchestration（而不是 corum-agent / corum-subagent）
 *
 * 依赖方向：`corum-agent` 与 `corum-subagent` **都**依赖 `corum-orchestration`
 * （反向不成立）。写形态判定（{@link detectBashWrite}）与写工具名单的单一事实源
 * 因此只能是这一层——否则两个消费方各存一份，正是规范禁止的「两处实现」。
 * `corum-agent/permission-policy.ts` 改为从本模块 import 并 re-export（保持其单测
 * 的 import 路径不变）。
 *
 * @module @corum/corum-orchestration/confinement
 */

import path from 'node:path'
import { tmpdir } from 'node:os'

/**
 * fork（corum）：**变异工具 → 它的路径参数名**（写边界门禁的判定面）。
 *
 * 与 {@link CORUM_MUTATION_TOOLS}（`orchestration.ts` 的写工具名单）**同源对账**：
 * 名单里每出现一个直接改文件的工具，这里必须能说出它的路径参数；`bash`/`pwsh`
 * 不在此表（它们走 {@link detectBashWrite} 的文本判定）。
 *
 * `str_replace_editor` 的路径参数是 `path`（官方 tool-str-replace-editor），
 * `write`/`edit` 的是 `file_path`（官方 tool-fs）。
 */
export const MUTATION_TOOL_PATH_ARGS: Readonly<Record<string, readonly string[]>> = {
  write: ['file_path'],
  edit: ['file_path'],
  str_replace_editor: ['path'],
}

/** 直接改文件的命令（命令名精确匹配）。 */
const WRITE_COMMANDS = new Set([
  'touch', 'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'ln', 'truncate', 'dd', 'tee',
  'chmod', 'chown', 'chgrp', 'install', 'mktemp', 'mkfifo', 'unlink', 'shred',
  'rsync', 'tar', 'unzip', 'gunzip', 'sed', 'perl', 'patch',
])

/** 只在这些子命令下才构成「改仓库」的 `git` 子命令。 */
const GIT_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'revert', 'merge',
  'rebase', 'cherry-pick', 'apply', 'am', 'clean', 'stash', 'rm', 'mv', 'push',
  'fetch', 'pull', 'init', 'clone', 'tag', 'update-ref', 'gc', 'prune',
])

/**
 * 「选项 + 取值」形态的选项名（子命令定位必须连带跳过取值）。
 *
 * 刻意**只登记有把握的那几个**（不带取值的短开关一律不进本表，避免把值当选项跳过而
 * 误判）：`git -C <dir>` / `git -c <k=v>` / `git --git-dir <path>` 等，以及 `pnpm -C`。
 * 漏登记的后果是「这个子命令判不出来」（回到改动前的**漏判**，安全侧），**不会**误伤
 * 只读命令——故按「够用即止」维护，不做通用 shell 解析。
 */
const OPTIONS_TAKING_A_VALUE = new Set([
  '-C', '-c', '--git-dir', '--git-common-dir', '--work-tree', '--namespace', '--exec-path',
])

/** 会写盘的包管理器。 */
const PACKAGE_COMMANDS = new Set(['pnpm', 'npm', 'yarn', 'bun'])

/** 包管理器里才构成写入的子命令。 */
const PACKAGE_WRITE_SUBCOMMANDS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'link', 'publish', 'deploy',
])

/** 会把内联代码写进文件的解释器（按内容特征判定，避免误伤纯计算）。 */
const INLINE_WRITE_PATTERNS: readonly RegExp[] = [
  /open\s*\([^)]*['"][wa]/,              // python: open('f','w')
  /writeFileSync|appendFileSync|createWriteStream/,  // node
  /Path\([^)]*\)\.write_text|\.write_bytes/,         // python pathlib
  />\s*['"]?[\w./-]+/,                   // shell 重定向写在 -c 字符串里
]

/**
 * 去掉单/双引号包裹的**字面量内容**，只留引号本身之外的 shell 语法。
 *
 * 为什么必须剥（2026-09-22 实测的误报）：重定向正则原本直接在原文上匹配，于是
 * `echo '===saveProfileRemote->persist callsite==='` 里的 `->` 被当成重定向 ⇒
 * **一条纯只读命令被只读门禁拒绝**（会话 `corum-task-ef3f751e` turn 4 step 5，
 * 白烧一次往返）。引号里的 `>` 是字符串内容，shell 不会当重定向。
 *
 * 注意**只**用于重定向判定与命令名提取：内联解释器的写盘特征（
 * {@link INLINE_WRITE_PATTERNS}）恰恰长在**引号里**（`node -e "writeFileSync(...)"`），
 * 故那些判定必须继续用未剥的原文。
 *
 * @param command - bash 工具的 `command` 参数原文。
 * @returns 引号内容被清空的命令文本（引号本身保留，以维持段结构）。
 */
export function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
}

/** 拆一条 shell 命令为「按运算符切开的段」（不求完备，只为定位真正的命令名）。 */
function shellSegments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
}

/** 去掉 `sudo` / `env` / `nohup` / `time` / 环境变量赋值前缀，露出真正的命令名。 */
function commandWordOf(segment: string): string {
  const tokens = segment.split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue }        // VAR=value
    if (['sudo', 'env', 'nohup', 'time', 'command', 'builtin', 'exec'].includes(token)) { index += 1; continue }
    break
  }
  const raw = tokens[index] ?? ''
  // 去掉路径前缀（/bin/rm → rm）
  return raw.split('/').pop() ?? raw
}

/**
 * 段内**第一个非选项词**（= 子命令位置），跳过命令名之后的选项与其取值。
 *
 * ## 为什么必须跳过选项（2026-09-22 实测缺陷，**改动前就存在**）
 *
 * 原实现直接取 `tokens[index + 1]`，于是 `git -C /repo merge` 的「第二个词」是 `-C`
 * 而不是 `merge` ⇒ {@link detectBashWrite} 判不出这是写形态 ⇒ **`git -C <主树> merge`
 * 这条越界命令在只读门禁下也从未被拦过**（实测会话 `corum-task-ef3f751e` 的 worker
 * 正是用它把分支并进了主树）。凡「选项带取值」的形态都会踩中：`git -C /repo`、
 * `git --git-dir=/repo/.git`、`rm -rf /repo/x`（`rm` 靠命令名已能判，但同类形态一致处理）。
 *
 * 判据：跳过 `-x` 短选项；**已知带取值的全局选项**（`-C` / `--git-dir` / `--work-tree`
 * 等）连带跳过它的值；`--opt=value` 是一体，直接跳过自身。
 *
 * @param segment - 一条 shell 段（已按运算符切开）。
 * @returns 第一个非选项词；不存在时 `undefined`。
 */
function subcommandOf(segment: string): string | undefined {
  const tokens = segment.split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue }
    if (['sudo', 'env', 'nohup', 'time', 'command', 'builtin', 'exec'].includes(token)) { index += 1; continue }
    break
  }
  // 跳过命令名本身
  index += 1
  while (index < tokens.length) {
    const token = tokens[index]!
    if (!token.startsWith('-')) return token
    // `--opt=value` 一体：跳过自身即可
    if (token.startsWith('--') && token.includes('=')) { index += 1; continue }
    // 已知「选项 + 取值」形态：连带跳过取值（`git -C /repo merge` 的关键）
    if (OPTIONS_TAKING_A_VALUE.has(token)) { index += 2; continue }
    index += 1
  }
  return undefined
}

/**
 * 判定一条 bash 命令**是否试图写盘**——只读门禁与写边界门禁共同的判据。
 *
 * ⚠️ **这是启发式，不是完备的 shell 语义分析**（如实标注）。设计取舍：
 * - 按**命令名**判定而不是全文匹配，避免把 `grep "rm " f` 误判成删除；
 * - 覆盖高频写形态（重定向 / in-place 编辑 / 文件与 git 与包管理器变更 / 内联解释器写盘）；
 * - 宁可**漏判也不误伤**只读工作（误伤会让 Agent 反复撞墙、白烧往返）。
 *
 * 因此它定位是**纵深防御的一层**而非唯一屏障：`write`/`edit` 已由 `tools.restrict`
 * 从工具面摘除（只读场景）；若将来能用「会话级不可覆盖的沙箱」表达只读，门禁可退为兜底。
 *
 * @param command - bash 工具的 `command` 参数原文。
 * @returns 命中的写形态描述（用于拒绝文案）；只读时 `undefined`。
 */
export function detectBashWrite(command: string): string | undefined {
  // 1) 重定向。在**剥掉引号字面量**的文本上判定（引号里的 `>` 不是重定向，
  //    见 stripQuoted 的误报记录）。排除两类**无害形态**（否则会误伤常见只读写法）：
  //    · fd 复制：`2>&1` / `>&2`
  //    · 写入 `/dev/null`：丢弃输出是惯用只读手法，不产生任何文件
  const unquoted = stripQuoted(command)
  const withoutFd = unquoted.replace(/\d?>>?\s*&\s*\d/g, '')
  const withoutDevNull = withoutFd.replace(/>>?\s*\/dev\/null\b/g, '')
  if (/(^|[^>])>>?\s*(?!&\s*\d)(?=\S)/.test(withoutDevNull)) {
    return 'shell redirection writes to a file'
  }

  for (const segment of shellSegments(command)) {
    const word = commandWordOf(segment)
    const sub = subcommandOf(segment)

    if (WRITE_COMMANDS.has(word)) {
      // `sed` / `perl` / `patch` / `tar` 只有带写选项才算写；其余默认算写。
      if (word === 'sed') { if (/(^|\s)-i/.test(segment)) return '`sed -i` edits a file in place' ; continue }
      if (word === 'perl') { if (/(^|\s)-[a-zA-Z]*i/.test(segment)) return '`perl -i` edits a file in place'; continue }
      if (word === 'patch') return '`patch` modifies files'
      if (word === 'tar') { if (/(^|\s)-[a-zA-Z]*[xc]/.test(segment)) return '`tar` extracts or creates files'; continue }
      if (word === 'unzip' || word === 'gunzip') return `\`${word}\` writes files`
      if (word === 'rsync') return '`rsync` writes files'
      return `\`${word}\` writes to the filesystem`
    }

    if (word === 'git' && sub !== undefined && GIT_WRITE_SUBCOMMANDS.has(sub)) {
      return `\`git ${sub}\` changes the repository`
    }
    if (PACKAGE_COMMANDS.has(word) && sub !== undefined && PACKAGE_WRITE_SUBCOMMANDS.has(sub)) {
      return `\`${word} ${sub}\` installs or modifies dependencies`
    }
    // 内联解释器里写盘（**用未剥引号的原文**：写盘特征就在引号里）
    if (['python', 'python3', 'node', 'ruby', 'perl'].includes(word)) {
      for (const pattern of INLINE_WRITE_PATTERNS) {
        if (pattern.test(segment)) return 'inline script writes to a file'
      }
    }
  }
  return undefined
}

/**
 * 目标路径是否落在某个根之内（词法判定，根与目标都已 resolve）。
 *
 * 与官方 `dsh-fs-sandbox` 的 `isPathUnder` 相比少了两件事：不做 realpath/设备号
 * 等价判定，也不处理 Windows 大小写别名——**有意如此**。本函数服务的是
 * {@link confinementGuard}（纵深防御的一层启发式门禁），真正的强边界是
 * `workspace-write` 沙箱本身（它做完整判定）。门禁若在这里做重量级 syscall，
 * 只会让热路径变慢而不增加保证。
 *
 * @param target - 已 resolve 的目标绝对路径。
 * @param root - 已 resolve 的根绝对路径。
 * @returns 目标等于根或位于其下时为 true。
 */
export function isPathInside(target: string, root: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target.startsWith(prefix)
}

/**
 * 从一条 shell 命令里提取**显式写出的绝对路径**（`/...`）与家目录简写（`~`/`$HOME`）。
 *
 * 覆盖三种出现位置：独立参数、`--opt=/abs`、以及 `-C /abs` / `--git-dir /abs`
 * 这类「选项与值分列」的形态（后者正是 `git -C <主树> merge` 这种越界的载体）。
 *
 * 有意**不**提取相对路径：子会话 cwd 就是 worktree，相对路径天然落在边界内。
 *
 * @param command - bash 工具的 `command` 参数原文。
 * @returns 去重后的越界候选（绝对路径已 resolve；`~`/`$HOME` 原样标记）。
 */
export function absolutePathsIn(command: string): string[] {
  const found = new Set<string>()
  // 独立出现的 /abs 或 --opt=/abs（引号内外的都算：写形态下的绝对路径一律要审）
  for (const match of command.matchAll(/(?:^|[\s='"])(\/[^\s'"|;&()<>]*)/g)) {
    const raw = match[1]
    if (raw !== undefined && raw !== '/' && !raw.startsWith('//')) found.add(path.resolve(raw))
  }
  // 家目录简写
  if (/(^|[\s='"])~(?=[/\s'"]|$)/.test(command) || /\$HOME\b|\$\{HOME\}/.test(command)) {
    found.add('~')
  }
  return [...found]
}

/**
 * 构造一个**隔离子会话**的写边界门禁（agent-scoped `tools.guard`）。
 *
 * ## 判定
 * - **变异工具**（`write`/`edit`/`str_replace_editor`）：路径参数 resolve 后落在
 *   边界外 ⇒ 拒绝。
 * - **shell**（`bash`/`pwsh`）：先过 {@link detectBashWrite}——只读命令一律放行
 *   （隔离**不**限制读，通知里明说「reads are still allowed for reference」）；
 *   写形态再要求命令里**没有**越界的绝对路径 / 家目录简写 ⇒ 否则拒绝。
 * - 其余工具：不表态（abstain）。
 *
 * ## 为什么不把 `<repo>/.git` 数据目录加进允许集
 *
 * 子会话**必须能提交**（`git add/commit` 要写 `<repo>/.git` 的数据目录），而那是
 * worktree 之外。但它的实现方式是：git 自己按内部记录去写，**命令文本里不出现**
 * 那些绝对路径（`git add -A` 没有任何绝对路径）⇒ 走「无绝对路径 ⇒ 放行」这条。
 * 而 `git -C <主树> merge` **会**把主树路径写进命令文本 ⇒ 被拦。
 * 若把 `.git` 数据目录加进允许集，`git -C <主树> …` 就会因为主树路径不在 `.git`
 * 下而被拒——仍拦得住；但 `<repo>/.git` 的**授权语义**属于 `@corum/corum-sandbox-local`
 * 那层（它有明确的安全评审与「不给 config/hooks」的边界，见 `docs/fork-delta.md` §15），
 * 本门禁不复制那份名单，避免两处名单漂移。
 *
 * @param options.worktreeRoot - 隔离子会话的 worktree 根（= 子会话 `header.cwd`）。
 * @param options.parentTreeRoot - 委派方的**主工作树**根（隔离要保护的对象）。
 *   **拒绝优先于允许**：它即便落在临时区之内（工作区就建在 /tmp 下的场景）也照样被拒——
 *   否则临时区允许集会把它一起放行，门禁等于没装（本仓测试环境正是这种形态）。
 * @returns 门禁函数；放行返回 `undefined`，拒绝返回可操作的拒绝文案。
 */
export function confinementGuard(options: {
  readonly worktreeRoot: string
  readonly parentTreeRoot?: string | undefined
}): (execution: {
  readonly name: string
  readonly arguments?: unknown
}) => string | undefined {
  const root = path.resolve(options.worktreeRoot)
  const parentTree = options.parentTreeRoot === undefined || options.parentTreeRoot === ''
    ? undefined
    : path.resolve(options.parentTreeRoot)
  // 允许集与官方 `writableRoots` 的「workspace + /tmp + tmpdir」口径一致：在 /tmp 造
  // fixture 是 build/test 的常见需要，拦它只会制造误伤。真正的边界仍是沙箱（fix 1）。
  const allowed = [root, ...confinementTempRoots()]
  const inside = (candidate: string): boolean => allowed.some(entry => isPathInside(candidate, entry))
  /** 主工作树**优先于**允许集：工作区在临时区里时，临时允许不能把它一起放行。 */
  const inParentTree = (candidate: string): boolean =>
    parentTree !== undefined && isPathInside(candidate, parentTree) && !isPathInside(candidate, root)
  const deny = (what: string): string =>
    `isolated child: ${what} — writes are confined to your worktree (${root}). `
    + 'Commit your work on your own branch inside the worktree; the parent (or the mechanism\'s integrator) merges it '
    + 'into the main tree. Do not write, redirect into, or run git commands against the parent working tree.'
  return (execution) => {
    const args = execution.arguments
    const argRecord = typeof args === 'object' && args !== null ? args as Record<string, unknown> : undefined

    const pathArgs = MUTATION_TOOL_PATH_ARGS[execution.name]
    if (pathArgs !== undefined && argRecord !== undefined) {
      for (const key of pathArgs) {
        const value = argRecord[key]
        if (typeof value !== 'string' || value === '') continue
        const resolved = path.resolve(root, value)
        if (inParentTree(resolved)) return deny(`${execution.name} targets "${value}" in the parent working tree`)
        if (!inside(resolved)) return deny(`${execution.name} targets "${value}" outside the worktree`)
      }
      return undefined
    }

    if (execution.name === 'bash' || execution.name === 'pwsh') {
      const command = argRecord?.['command']
      if (typeof command !== 'string' || command === '') return undefined
      const writeForm = detectBashWrite(command)
      // 只读命令一律放行：隔离限制的是「写」，通知里明说 reads are still allowed。
      if (writeForm === undefined) return undefined
      for (const candidate of absolutePathsIn(command)) {
        if (candidate === '~') return deny(`${writeForm} — the command targets the home directory`)
        if (inParentTree(candidate)) return deny(`${writeForm} — the command targets "${candidate}" in the parent working tree`)
        if (!inside(candidate)) return deny(`${writeForm} — the command targets "${candidate}" outside the worktree`)
      }
      return undefined
    }

    return undefined
  }
}

/**
 * fork（corum）：临时区允许集。
 *
 * 与官方 `writableRoots` 的「workspace + /tmp + tmpdir」口径一致——隔离子会话在
 * `/tmp` 造 fixture 是合法工作（build/test 的常见需要）。
 * @returns 平台临时目录（已 resolve）。
 */
export function confinementTempRoots(): string[] {
  return [...new Set([path.resolve('/tmp'), path.resolve(tmpdir())])]
}
