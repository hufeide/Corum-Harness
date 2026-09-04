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
import type { AgentProfile, BaseMode, ProfileModel } from './profile.ts'

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
 *
 * @param subagentModel - 子 Agent 默认 LLM 路由（可选）。dsh `tool-subagent`
 *   原生支持 `Config.agentOptions` 作为该 tool 实例 spawn 的所有子 Agent 的
 *   默认 agentOptions（`requestedAgentOptions()` 把它作 baseline，逐次调用
 *   仍可覆盖）；profile.subagentModel 即映射到该 config，缺省则不注入
 *   （子 Agent 走 `resolveChildAgentOptions` 的 parentOptions 兜底 = 同主 Agent）。
 */
function standardRows(subagentModel?: ProfileModel): CordisRow[] {
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
          config: {
            provider: 'spawn',
            toolName: 'subagent',
            modelSelectionSettings: true,
            backgroundMode: 'continuable',
            // 子 Agent 默认模型（profile.subagentModel）：映射 dsh 原生
            // Config.agentOptions。reasoningEffort 缺省不注入——dsh 在换路由且
            // 未显式给 effort 时会丢弃继承值、用新模型默认档（与模型页默认 high 一致）。
            ...(subagentModel !== undefined
              ? {
                  agentOptions: {
                    provider: subagentModel.provider,
                    model: subagentModel.model,
                    ...(subagentModel.reasoningEffort !== undefined && subagentModel.reasoningEffort !== ''
                      ? { reasoningEffort: subagentModel.reasoningEffort }
                      : {}),
                  },
                }
              : {}),
          },
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
/**
 * dsh 四种预设模式的基础 persona 文本。
 * 来源：shipped-presets/official/<mode>/agent.cordis.yml 中的 persona config.text。
 * compilePreset 用基础模式 persona + 用户自定义提示词拼接为最终 persona。
 */
const BASE_MODE_PERSONA: Record<BaseMode, string> = {
  standard: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  ptc: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  minimal: 'You are a helpful software engineer assistant.',
  cordis: 'You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.\n\nYou can read and modify the harness you run on. Its composition is Cordis: every capability is a plugin row in a `cordis.yml`, and an agent preset is one such file mounted for a single session.',
}

/** 极简模式的特殊 flag（complete + suppressRuntimeContext）。 */
const BASE_MODE_COMPLETE: Set<BaseMode> = new Set(['minimal'])

/**
 * 编译 AgentProfile 为 preset 目录的两份文件。
 *
 * persona 拼接逻辑：基础模式 persona + "\n\n" + 用户自定义提示词。
 * 极简模式特殊：persona complete=true，自定义提示词追加在 complete persona 之后
 * （complete 模式下 system-prompt 只渲染 persona section，所以拼接后仍有效）。
 *
 * @param profile - AgentProfile。
 * @returns 两份文件文本（agent.cordis.yml + preset.yml）。
 */
/**
 * 覆盖模式（standard）的固定结构化 persona 模板组装。
 *
 * corum 自定义生成规则：先按固定段落拼装成完整 persona 文本（含 dsh 变量占位
 * {{model}}/{{cwd}}），再交 dsh agentLoop 做变量插值与 section 装配。
 * 各段按字段非空拼接，空字段省略对应子句；全空回退 basePersona。
 *
 * 结构：专业领域 + 岗位 + 人格 + 工作职责 + 模型/工作目录占位。
 * （{{memory摘要}} 段预留——待 Agent memory 机制设计完成后再接入，当前不参与组装。）
 */
function composeOverridePersona(profile: AgentProfile): string {
  const segments: string[] = []
  // 身份句：专业领域 + 岗位（合并为一句）。
  const domain = typeof profile.domain === 'string' ? profile.domain.trim() : ''
  const title = typeof profile.title === 'string' ? profile.title.trim() : ''
  if (domain !== '' && title !== '') segments.push(`You are an expert in the ${domain} field, working as a ${title}.`)
  else if (domain !== '') segments.push(`You are an expert in the ${domain} field.`)
  else if (title !== '') segments.push(`You are a ${title}.`)
  // 人格（做事风格）。
  if (typeof profile.persona === 'string' && profile.persona.trim() !== '') {
    segments.push(`Your working style: ${profile.persona.trim()}.`)
  }
  // TODO(memory): 「你有丰富的工作经验：{{memory摘要}}」段——待 memory 机制后接入，当前不组装。
  // 工作职责（用户自定义提示词）。
  if (profile.prompt.trim() !== '') {
    segments.push(`Your responsibilities: ${profile.prompt.trim()}`)
  }
  // 模型 + 工作目录占位（dsh 变量，render 时插值）。
  segments.push('You are powered by the {{model}} model. Your working directory is {{cwd}}.')
  return segments.join('\n\n')
}

export function compilePreset(profile: AgentProfile): CompiledPreset {
  // persona 拼接（语义按 baseMode 分覆盖/继承）：
  // - baseMode === 'standard'（用户自建 Agent，默认）：**覆盖**官方 coding-agent 模板，
  //   走 corum 固定结构化模板（composeOverridePersona）。
  // - 其它模式（开发者编排，ptc/minimal/cordis）：**继承**该模式模板，
  //   persona = 模式模板 + 人格 + 自定义提示词。
  const basePersona = BASE_MODE_PERSONA[profile.baseMode] ?? BASE_MODE_PERSONA.standard
  const isComplete = BASE_MODE_COMPLETE.has(profile.baseMode)
  let personaText: string
  if (profile.baseMode === 'standard') {
    const composed = composeOverridePersona(profile)
    // 仅有占位行、无任何实质内容（domain/title/persona/prompt 全空）时回退 basePersona。
    const hasSubstance =
      (typeof profile.domain === 'string' && profile.domain.trim() !== '') ||
      (typeof profile.title === 'string' && profile.title.trim() !== '') ||
      (typeof profile.persona === 'string' && profile.persona.trim() !== '') ||
      profile.prompt.trim() !== ''
    personaText = hasSubstance ? composed : basePersona
  } else {
    const parts: string[] = [basePersona]
    if (typeof profile.persona === 'string' && profile.persona.trim() !== '') parts.push(profile.persona.trim())
    if (profile.prompt.trim() !== '') parts.push(profile.prompt.trim())
    personaText = parts.join('\n\n')
  }

  const rows: CordisRow[] = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        text: personaText,
        ...(isComplete ? { complete: true, includeRuntimeContext: false } : {}),
      },
    },
    ...standardRows(profile.subagentModel),
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
          renderConfigLines(child.config, '        ', lines)
        }
      }
    } else {
      lines.push(`- id: ${row.id}`)
      lines.push(`  name: ${renderScalar(row.name)}`)
      if (row.disabled !== undefined) lines.push(`  disabled: ${row.disabled}`)
      if (row.config !== undefined) {
        lines.push(`  config:`)
        renderConfigLines(row.config, '    ', lines)
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

/** 把 config 的键值渲染成 YAML 行（嵌套对象递归缩进一层，标量走 renderScalar）。 */
function renderConfigLines(config: Record<string, unknown>, indent: string, lines: string[]): void {
  for (const [key, value] of Object.entries(config)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${indent}${key}:`)
      renderConfigLines(value as Record<string, unknown>, `${indent}  `, lines)
    } else {
      lines.push(`${indent}${key}: ${renderScalar(value)}`)
    }
  }
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
