/**
 * AgentProfile → preset 编译（路径 A 的核心）。
 *
 * 把 AgentProfile 翻译成一份 agent.cordis.yml 文本 + preset.yml 元数据，
 * 落盘到 agent-presets 的 user root（`~/.corum/.agent-presets/<id>/`），
 * 再由 `ctx.agentPresets.mount(agentCtx, id)` 走官方组装链路。
 *
 * 编译架构（2026-09-02 用户定调）：corum Agent **默认继承官方 standard 模式**
 * （standard 全量行）+ corum 覆盖/增量，不是另一套精简组合。
 *   prompt        → persona 行（text，替换官方模板）
 *   model         → 不进 preset（创建 Agent 时的 agentOptions）
 *   skills        → skill-filesystem 覆盖行（includeDefaultRoots:false +
 *                   customSkillDirs 指向 Agent 自身 skills/ 目录）
 *   mcpServers    → dsh-mcp-client 追加行（每 server 一行）
 *   terminal      → persistent-shell 组覆盖一次性 tool-bash/tool-pwsh（sandbox
 *                   由 host 层提供）
 *   filesystem    → 追加 fs-local + str-replace-editor 组（与 standard 沙箱
 *                   tool-fs 并存）
 *   memoryPolicy  → 不进 preset（记忆由专属工具/服务注入，后续接入）
 *
 * 纯函数，无副作用：输出两份文件的内容，由调用方落盘。
 * @module @corum/corum-agent/compile
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { McpServerConfig } from '@corum/corum-mcp-manager'
import type { AgentProfile } from './profile.ts'

/**
 * corum 运行目录（统一 home 解析，废弃 ~/.dsh）。
 * 桌面进程已把 DSH_HOME 指向 CORUM_HOME（见 corum-desktop/host/home.ts），
 * 所以 skill 根 = CORUM_HOME/skills。纯函数模式下优先读 CORUM_HOME。
 */
function corumHome(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : '~/.corum'
  return resolveDshHome(configured)
}

/** 一行 cordis 配置（编译成 YAML 的中间表示）。 */
interface CordisRow {
  id: string
  name: string
  config?: Record<string, unknown>
  /** 布尔或 `!!js ...` 表达式字符串（YAML 标记）。 */
  disabled?: boolean | string
  group?: boolean
  isolate?: Record<string, boolean>
  children?: CordisRow[]
}

/** 编译结果：preset 目录的两份文件内容。 */
export interface CompiledPreset {
  /** agent.cordis.yml 文本。 */
  cordisYml: string
  /** preset.yml 文本。 */
  presetYml: string
}

/**
 * 官方 standard preset 的全量行（2026-09-02 用户定调：corum Agent **默认继承
 * 官方 standard 模式**——corum Agent 是 standard 的拓展，不是另一套精简组合）。
 * 来源：`@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml`。
 *
 * 中间表示与官方逐行对应（persona/tool-bash/tool-pwsh/tool-fs/tool-fs-search/
 * tool-jobs/skill-filesystem/tool-skill/command-goal/tool-goal/planning 组/
 * compaction 组/delegation 组/tool-ask-user/tool-todo/tool-web）。
 *
 * **官方升级同步**：bump dsh-agent-presets 后，对照官方 standard 源文件逐行
 * diff 本数组（结构一致，机械合并）。
 */
function standardRows(): CordisRow[] {
  return [
    // ── identity ──
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },

    // ── shell（一次性 bash/pwsh；corum 覆盖为 persistent-shell 持久终端）──
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: '!!js process.platform === \'win32\'' },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: '!!js process.platform !== \'win32\'' },

    // ── filesystem（沙箱工具集；corum 追加 fs-local 裸本地 FS）──
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },

    // ── background jobs ──
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },

    // ── skills（skill-filesystem 由 corum 按 profile.skills 定制覆盖；tool-skill 保留）──
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

    // ── goals ──
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },

    // ── plan mode（entry-local realm 是正确生命周期）──
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      children: [
        {
          id: 'plan-mode',
          name: '@deepseek-ai/dsh-plan-mode',
          config: {
            section:
              'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user\'s conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.\n\n'
              + 'Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.\n\n'
              + 'The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.\n\n'
              + 'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.\n\n'
              + 'Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.\n\n'
              + 'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.',
          },
        },
      ],
    },

    // ── compaction（compaction-basic + command-compact + tool-result-pruner 同 realm）──
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      children: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },

    // ── delegation & workflows（subagent 全家 + workflow + ralph；workflowEngine realm）──
    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      isolate: { workflowEngine: true },
      children: [
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
        {
          id: 'tool-subagent',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true, backgroundMode: 'continuable' },
        },
        {
          id: 'tool-subagent-fork',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' },
        },
        {
          id: 'tool-subagent-codex',
          name: '@deepseek-ai/dsh-tool-subagent',
          disabled: true,
          config: { provider: 'codex', toolName: 'subagent_codex', backgroundMode: 'one-shot', maxDepth: 'provider-managed' },
        },
        {
          id: 'tool-subagent-claude-code',
          name: '@deepseek-ai/dsh-tool-subagent',
          disabled: true,
          config: { provider: 'claude-code', toolName: 'subagent_claude_code', backgroundMode: 'one-shot', maxDepth: 'provider-managed' },
        },
        { id: 'workflow-worker-thread', name: '@deepseek-ai/dsh-workflow-worker-thread', config: { provider: 'spawn' } },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
        { id: 'tool-ralph', name: '@deepseek-ai/dsh-tool-ralph', config: { subagentProvider: 'spawn', maxRounds: 64 } },
      ],
    },

    // ── 其余模型面行 ──
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  ]
}

/**
 * 把一个 AgentProfile 编译成 preset 目录内容。
 *
 * **2026-09-02 架构定调（用户）**：corum Agent **默认继承官方 standard 模式**
 * （standard 全量行）+ corum 覆盖/增量：
 * - `persona` 替换为 profile.prompt（不用官方模板，且不用 complete:true——让
 *   框架正常组装完整 system prompt，与官方 headless bundle 一致）；
 * - `tool-bash`/`tool-pwsh` 替换为 persistent-shell 持久终端组（corum 刻意取舍：
 *   跨调用保留 shell 状态，一次性的 tool-bash 不满足）；
 * - `skill-filesystem` 替换为 corum 定制（includeDefaultRoots:false + 按
 *   profile.skills 绑定的 customSkillDirs）；
 * - 追加 `filesystem` 组（fs-local 裸本地 FS + str-replace-editor，corum 基础
 *   编辑能力，与 standard 的沙箱 tool-fs 并存）；
 * - 追加 MCP 行（profile.mcpServers 授权的服务）；
 * - 其余 standard 行原样保留（agent-instructions/tool-fs/tool-fs-search/tool-jobs/
 *   goal/plan/compaction/subagent/workflow/todo/web）。
 *
 * @param profile - AgentProfile。
 * @returns 两份文件文本（agent.cordis.yml + preset.yml）。
 */
export function compilePreset(profile: AgentProfile): CompiledPreset {
  // persona 在最前（身份节），随后 standard 全量 + corum 覆盖/增量。
  const rows: CordisRow[] = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { text: profile.prompt },
    },
    ...standardRows(),
  ]

  // corum 覆盖 ①：一次性 tool-bash/tool-pwsh → persistent-shell 持久终端组。
  // sandbox 策略由 host 层提供；profile.terminal.mode 仅记录意图（host 级敏感
  // 能力需人显式开启，护栏在创建 Agent 处校验）。
  const persistentShell: CordisRow = {
    id: 'persistent-shell',
    name: 'cordis:group',
    group: true,
    isolate: { terminals: true },
    children: [
      { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
      { id: 'terminal-bash', name: '@deepseek-ai/dsh-terminal-bash', disabled: '!!js process.platform === \'win32\'', config: { timeoutMs: 300000 } },
      { id: 'persistent-bash', name: '@deepseek-ai/dsh-tool-bash-persistent', disabled: '!!js process.platform === \'win32\'', config: { timeoutMs: 300000 } },
      { id: 'terminal-pwsh', name: '@deepseek-ai/dsh-terminal-bash', disabled: '!!js process.platform !== \'win32\'', config: { shellDialect: 'pwsh', timeoutMs: 300000 } },
      { id: 'persistent-pwsh', name: '@deepseek-ai/dsh-tool-pwsh-persistent', disabled: '!!js process.platform !== \'win32\'', config: { timeoutMs: 300000 } },
    ],
  }
  const bashIdx = rows.findIndex(r => r.id === 'tool-bash')
  const pwshIdx = rows.findIndex(r => r.id === 'tool-pwsh')
  // tool-bash 与 tool-pwsh 相邻——在 tool-bash 位置插入 persistent-shell，删两行。
  rows.splice(bashIdx, pwshIdx - bashIdx + 1, persistentShell)

  // corum 覆盖 ②：skill-filesystem 按 profile.skills 定制（全局统一管理、按
  // Agent 授权可见）。standard 只有 tool-skill，skill-filesystem 行在 tool-skill 前插入。
  const skillsRoot = join(corumHome(), 'skills')
  const customSkillDirs = profile.skills.map(b => join(skillsRoot, b.name))
  const toolSkillIdx = rows.findIndex(r => r.id === 'tool-skill')
  rows.splice(toolSkillIdx, 0, {
    id: 'skill-filesystem',
    name: '@deepseek-ai/dsh-skill-filesystem',
    config: {
      includeDefaultRoots: false,
      ...(customSkillDirs.length > 0 ? { customSkillDirs } : {}),
    },
  })

  // corum 追加 ③：filesystem 组（fs-local 裸本地 FS + str-replace-editor）。
  const filesystem: CordisRow = {
    id: 'filesystem',
    name: 'cordis:group',
    group: true,
    isolate: { fs: true },
    children: [
      { id: 'fs-local', name: '@deepseek-ai/dsh-fs-local', config: { cwd: '!!js process.env.DSH_CWD ?? process.cwd()' } },
      { id: 'str-replace-editor', name: '@deepseek-ai/dsh-tool-str-replace-editor', config: { maxOutputChars: 16000 } },
    ],
  }
  // 插在 standard 的 tool-fs/tool-fs-search 之后（filesystem 语义区）。
  const fsSearchIdx = rows.findIndex(r => r.id === 'tool-fs-search')
  rows.splice(fsSearchIdx + 1, 0, filesystem)

  // corum 追加 ④：MCP（profile.mcpServers 授权的服务，注册表解析完整配置）。
  const mcpServers = resolveMcpServers(profile.mcpServers)
  for (const mcp of mcpServers) {
    const config: Record<string, unknown> = {
      serverName: mcp.name,
      transport: mcp.transport,
    }
    if (mcp.transport === 'stdio') {
      config.command = mcp.command
      if (mcp.args !== undefined && mcp.args.length > 0) config.args = mcp.args
      if (mcp.env !== undefined) config.env = mcp.env
      if (mcp.cwd !== undefined) config.cwd = mcp.cwd
      if (mcp.toolCallTimeoutMs !== undefined) config.toolCallTimeoutMs = mcp.toolCallTimeoutMs
    } else {
      config.url = mcp.url
      if (mcp.headers !== undefined) config.headers = mcp.headers
      if (mcp.toolCallTimeoutMs !== undefined) config.toolCallTimeoutMs = mcp.toolCallTimeoutMs
    }
    rows.push({
      id: `mcp-${mcp.name}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config,
    })
  }

  return {
    cordisYml: renderRows(rows),
    presetYml: `name: ${profile.id}\ndescription: ${profile.prompt.split('\n')[0] ?? ''}\n`,
  }
}

/** 把中间表示的行渲染成 YAML 文本（对齐官方 agent.cordis.yml 风格）。 */
function renderRows(rows: readonly CordisRow[]): string {
  const lines: string[] = []
  for (const row of rows) {
    if (row.group) {
      lines.push(`- id: ${row.id}`)
      lines.push(`  name: ${renderScalar(row.name)}`)
      lines.push(`  group: true`)
      if (row.isolate !== undefined) {
        lines.push(`  isolate:`)
        for (const [key, value] of Object.entries(row.isolate)) {
          lines.push(`    ${key}: ${value}`)
        }
      }
      lines.push(`  config:`)
      for (const child of row.children ?? []) {
        lines.push(`    - id: ${child.id}`)
        lines.push(`      name: ${renderScalar(child.name)}`)
        if (child.disabled !== undefined) lines.push(`      disabled: ${child.disabled}`)
        if (child.config !== undefined) {
          lines.push(`      config:`)
          for (const [key, value] of Object.entries(child.config)) {
            lines.push(`        ${key}: ${renderScalar(value)}`)
          }
        }
      }
    } else {
      lines.push(`- id: ${row.id}`)
      lines.push(`  name: ${renderScalar(row.name)}`)
      if (row.disabled !== undefined) lines.push(`  disabled: ${row.disabled}`)
      if (row.config !== undefined) {
        lines.push(`  config:`)
        for (const [key, value] of Object.entries(row.config)) {
          lines.push(`    ${key}: ${renderScalar(value)}`)
        }
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 把一个标量渲染成 YAML 标量（字符串用引号，数字/布尔原样）。 */
function renderScalar(value: unknown): string {
  if (typeof value === 'string') {
    // `!!js ...` 是 YAML 标记表达式（见官方 minimal preset 的 `disabled:` 与
    // `fs-local` 的 `cwd:`），必须不带引号原样输出——JSON.stringify 会把它
    // 包成普通字符串，使 `!!js` 标记失效，terminal/fs 行就会按错误的语义装载。
    if (value.startsWith('!!js ')) return value
    return JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return 'null'
  return JSON.stringify(value)
}

/**
 * 从全局注册表（CORUM_HOME/mcp-servers.json）按服务名解析 MCP 配置。
 * compilePreset 是纯函数，不能注入 Cordis 服务，直接读文件。
 */
function resolveMcpServers(names: readonly string[]): McpServerConfig[] {
  const registryPath = join(corumHome(), 'mcp-servers.json')
  if (!existsSync(registryPath)) return []
  let servers: McpServerConfig[]
  try {
    const data = JSON.parse(readFileSync(registryPath, 'utf8')) as { servers?: McpServerConfig[] }
    servers = data.servers ?? []
  } catch {
    return []
  }
  const map = new Map(servers.map(s => [s.name, s]))
  const result: McpServerConfig[] = []
  for (const name of names) {
    const server = map.get(name)
    // 已停用的服务不编进 preset。
    if (server !== undefined && server.disabled !== true) result.push(server)
  }
  return result
}
