/**
 * AGENTS.md 工作区指令文件的「选定即创建」helper。
 *
 * 语义（用户定）：AGENTS.md 是工作区级指令——选定工作区时就该存在，
 * `dsh-agent-instructions` 在 agent 首个 pre-step 把它注入 durable context
 * （有则注入、无则不注入）。这里只做幂等创建：已存在（含用户手写）绝不覆盖。
 * @module @corum/corum-agent/workspace-agents
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 新工作区的 AGENTS.md 模板骨架（用户可自由改写；注入器只负责读）。 */
const AGENTS_TEMPLATE = `# AGENTS.md — workspace instructions

> Corum creates this file when a workspace is selected; its content is yours (and your team's) to maintain.
> dsh-agent-instructions injects this file into context before the first request of every agent session
> (AGENTS.local.md / CLAUDE.md / CLAUDE.local.md work the same way).
> Write here: project red lines, stack conventions, build/test entry points, directory conventions.
`

/**
 * 确保工作区存在 AGENTS.md（幂等；已存在则不写，保留用户/历史内容）。
 * @param cwd - 工作区绝对路径。
 * @returns 是否新建（true=本次创建；false=已存在跳过）。
 */
export function ensureWorkspaceAgentsMd(cwd: string): boolean {
  const path = join(cwd, 'AGENTS.md')
  if (existsSync(path)) return false
  try {
    writeFileSync(path, AGENTS_TEMPLATE, { flag: 'wx' })
    return true
  } catch {
    // 并发双写 / 只读目录：放弃创建，不阻断主流程（注入器对缺文件本就容错）。
    return false
  }
}
