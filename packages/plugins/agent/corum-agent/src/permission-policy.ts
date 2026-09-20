/**
 * fork（corum）：**权限合成**——把「用户选的档位」与「模式约束」合成出各主体的有效档位。
 *
 * ## 为什么需要这个文件（2026-09-20 实测漏洞）
 *
 * `agent-service.ts` 里原本有**两个互不知情的写入者**写同一个会话沙箱：
 *
 * | 位置 | 方法 | 写什么 |
 * |---|---|---|
 * | :1945 | `applyTaskPermission` | **用户选的**档位（经 `permissionPresets.set`） |
 * | :2019 | `applyConductorMode` | **模式要求的**只读 |
 *
 * 而沙箱投影是**纯 last-write-wins**（`sandbox-policy/src/index.ts:137` 的
 * `apply: (state, event) => event.data.mode`）⇒ **谁最后写谁赢**。
 *
 * 实测后果（会话 `corum-task-e72b1a8f`，5 秒内被突破）：
 *
 * ```
 * 14:13:09  sandbox/mode → read-only          ← 指挥模式钉的
 * 14:13:14  sandbox/mode → danger-full-access ← 用户切「完全权限」即覆盖
 * ```
 *
 * 全会话普查：`conductor-lead` 会话 **read-only 存活 0 次**（danger-full-access 5 /
 * workspace-write 1）——指挥者实际上一直是**可写**的。
 *
 * ## 修法：把「表决权」显式建模
 *
 * 补一个 `if` 只是让**第三个写入者**加入混战。真正的修法是让**只有一个地方**决定档位：
 * 本文件是那条**纯函数**规则，`applyTaskPermission` / `applyConductorMode` 不再各自写沙箱，
 * 而是各自**声明约束**、由调用方合并后写一次。
 *
 * ## 用户定调（2026-09-20）
 *
 * 「如果开了 bash 全部权限，指挥者能够自己通过 bash 进行文件编辑，这是一种**不可接受**的
 * 使用状态……用户选择工作区读写和完全权限**只能生效给 work 子 Agent**，但是**主 Agent 和
 * search 只读是必须要保证的**。」
 *
 * @module @corum/corum-agent/permission-policy
 */

/** 沙箱档位（与官方 `SANDBOX_MODES` 同集，本包不引运行时依赖故本地声明）。 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * 权限主体的**种类**——决定它受不受模式约束。
 *
 * 与 `@corum/corum-subagent` 的 `ChildKind` 刻意同形但**不共用类型**：那是子 Agent 装配面
 * 的概念，这里是权限面；`main` 是只有本面才有的第三个主体。绑定会让两个包产生不必要的类型耦合。
 */
export type PermissionSubject = 'main' | 'worker' | 'researcher'

/** conductor 模式对该主体的硬约束（`undefined` = 不受约束，透传用户档位）。 */
export type SubjectConstraint = SandboxMode | undefined

/**
 * **权限合成**：给定用户选的档位与各主体的模式约束，算出某主体的有效档位。
 *
 * 规则（用户 2026-09-20 定调）：
 * - 有约束 ⇒ **约束赢**（指挥模式下主 Agent / research 恒只读，用户选什么都不放宽）；
 * - 无约束 ⇒ 用户档位透传（worker，以及非指挥模式的全部主体）；
 * - 用户未选档位 ⇒ `undefined`（交给官方「全局默认档位」语义，不越权代填）。
 *
 * 「约束赢」而不是「取更严者」是**有意**的：取更严者看起来更安全，但它会让
 * 「用户在指挥模式选 workspace-write」与「选 danger-full-access」在 worker 上
 * 表现相同——而用户明确要求 worker **可以**拿到他选的档位（含完全权限）。
 * 所以这里不是比大小，而是**按主体分档**：约束只作用于被约束的主体的**上限**。
 *
 * @param userSelection - 用户在「新建任务」表单 / composer 里选的档位。
 * @param constraint - 该主体的模式约束（由 `conductor-runtime` 声明）。
 * @returns 该主体的有效档位；`undefined` = 不代填，沿用官方默认。
 */
export function composeSandboxMode(
  userSelection: SandboxMode | undefined,
  constraint: SubjectConstraint,
): SandboxMode | undefined {
  if (constraint !== undefined) return constraint
  return userSelection
}

/**
 * conductor 模式下的**主体约束表**——单一事实源。
 *
 * 用户定调的三分：主 Agent 与 research **必须只读**；worker **可以**拿到用户档位
 * （含完全权限）。这里只描述「模式要求什么」，不涉及用户选了什么（合成见
 * {@link composeSandboxMode}）。
 */
export const CONDUCTOR_SUBJECT_CONSTRAINTS: Readonly<Record<PermissionSubject, SubjectConstraint>> = {
  main: 'read-only',
  researcher: 'read-only',
  worker: undefined,
}

/**
 * 某主体在给定模式下的模式约束。
 *
 * @param subject - 权限主体。
 * @param conductorMode - 该会话是否处于指挥模式。
 * @returns 约束档位；非指挥模式或该主体不受约束时 `undefined`。
 */
export function subjectConstraintOf(
  subject: PermissionSubject,
  conductorMode: boolean,
): SubjectConstraint {
  if (!conductorMode) return undefined
  return CONDUCTOR_SUBJECT_CONSTRAINTS[subject]
}

/**
 * 主 Agent 在指挥模式下的**只读门禁**（`tools.guard`）。
 *
 * ## 为什么是门禁而不是沙箱
 *
 * 见 {@link composeSandboxMode} 的漏洞说明：沙箱是**可被合法用户操作覆盖的状态**，
 * 而 guard 是**单调的**（官方语义「deny or abstain, never allow」；后续监听者无法
 * 复活被拒的调用）⇒ 满足用户「主 Agent 只读**必须**保证」的要求。
 *
 * 且注册在 `agentCtx` 上的 guard **只对主 Agent 生效、不沿 scope 链泄漏给子 Agent**
 * ⇒ 用户选择的完全权限对 worker 依然有效（用户定调「完全权限只能生效给 work 子 Agent」）。
 *
 * ## 为什么只拦 bash
 *
 * 主 Agent 的 `write` / `edit` / `str_replace_editor` 已被 `tools.restrict`
 * 从**工具面**摘除，而权限切换只动沙箱与审批策略、**不动工具面** ⇒ 那三个不是可用通路。
 * 放开只读 bash 之后，**bash 是唯一的写通路**，故门禁只需覆盖它。
 */

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

/** 段内第二个词（子命令位置），跳过 `-x` 选项前的命令名。 */
function subcommandOf(segment: string): string | undefined {
  const tokens = segment.split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue }
    if (['sudo', 'env', 'nohup', 'time', 'command', 'builtin', 'exec'].includes(token)) { index += 1; continue }
    break
  }
  return tokens[index + 1]
}

/**
 * 判定一条 bash 命令**是否试图写盘**——只读门禁的判据。
 *
 * ⚠️ **这是启发式，不是完备的 shell 语义分析**（如实标注）。设计取舍：
 * - 按**命令名**判定而不是全文匹配，避免把 `grep "rm " f` 误判成删除；
 * - 覆盖高频写形态（重定向 / in-place 编辑 / 文件与 git 与包管理器变更 / 内联解释器写盘）；
 * - 宁可**漏判也不误伤**只读工作（误伤会让指挥者反复撞墙、白烧往返）。
 *
 * 因此它定位是**纵深防御的一层**而非唯一屏障：`write`/`edit` 已由 `tools.restrict`
 * 从工具面摘除；若将来能用「会话级不可覆盖的沙箱」表达只读，门禁可退为兜底。
 *
 * @param command - bash 工具的 `command` 参数原文。
 * @returns 命中的写形态描述（用于拒绝文案）；只读时 `undefined`。
 */
export function detectBashWrite(command: string): string | undefined {
  // 1) 重定向。排除两类**无害形态**（否则会误伤常见只读写法）：
  //    · fd 复制：`2>&1` / `>&2`
  //    · 写入 `/dev/null`：丢弃输出是惯用只读手法，不产生任何文件
  const withoutFd = command.replace(/\d?>>?\s*&\s*\d/g, '')
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
    // 内联解释器里写盘
    if (['python', 'python3', 'node', 'ruby', 'perl'].includes(word)) {
      for (const pattern of INLINE_WRITE_PATTERNS) {
        if (pattern.test(segment)) return 'inline script writes to a file'
      }
    }
  }
  return undefined
}

/**
 * 构造指挥模式下**主 Agent 的只读门禁**（传给 `agentCtx.tools.guard`）。
 *
 * - 只拦 `bash`：`write`/`edit`/`str_replace_editor` 已由 `tools.restrict` 从工具面摘除；
 * - 命中写形态即返回拒绝文案（guard 返回字符串 = 拒绝，且**单调不可复活**）；
 * - 只读命令返回 `undefined`（放行）——不干扰 `ls` / `git log` / `git diff` / 读日志。
 *
 * 拒绝文案要**可操作**：告诉模型「你是只读的、该委派谁」而不是只说「禁止」，
 * 否则它会换一种写法反复试探（这正是用户报障里 worker 反复找工具链的同款浪费）。
 *
 * @returns guard 函数；调用方负责注册与撤销。
 */
export function conductorMainReadonlyGuard(): (execution: {
  readonly name: string
  readonly arguments?: unknown
}) => string | undefined {
  return (execution) => {
    if (execution.name !== 'bash') return undefined
    const args = execution.arguments
    const command = typeof args === 'object' && args !== null && 'command' in args
      ? (args as { command?: unknown }).command
      : undefined
    if (typeof command !== 'string') return undefined
    const hit = detectBashWrite(command)
    if (hit === undefined) return undefined
    return `read-only mode: this shell cannot write (${hit}). You are the Conductor — you inspect here and delegate the change to a worker child instead of writing it yourself.`
  }
}
