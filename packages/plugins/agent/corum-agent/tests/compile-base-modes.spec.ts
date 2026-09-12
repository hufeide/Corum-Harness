/**
 * 基准模式工具面对账（2026-09-12 用户定调：「5 个模式不再直接选中、只作继承模板，
 * 系统内置继承它们的 Agent」）。
 *
 * 本 spec 守住 compile.ts 追加 ⑤ 的三条模式差异——它们逐行对账自官方 preset
 * （packages/desktop/shipped-presets/official/<mode>/agent.cordis.yml）：
 *   ptc     = standard + tool-presentation（mode: ptc）
 *   cordis  = standard + tool-cordis
 *   minimal = persona + persistent-shell + filesystem + tool-fs
 *             （官方 minimal 是 bash + str_replace_editor 双工具面；corum 2026-09-11
 *              让 str_replace_editor 退场，等价写面是官方 fs 的 write/edit，故取 tool-fs）
 * standard / conductor 仍是全量面（conductor 的裁剪在运行时 tools.restrict）。
 */
import { describe, expect, it } from 'vitest'
import { compilePreset } from '../src/compile.ts'
import type { AgentProfile, BaseMode } from '../src/profile.ts'

function profile(baseMode: BaseMode): AgentProfile {
  return {
    id: `mode-${baseMode}`,
    nickname: '模式探针',
    title: '模式探针',
    dimension: '研发',
    baseMode,
    prompt: 'probe',
    model: { provider: 'localhost', model: 'deepseek-v4-pro' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
}

const ymlOf = (baseMode: BaseMode): string => compilePreset(profile(baseMode)).cordisYml

describe('基准模式工具面 — 继承哪个模式就真的是那个模式的面', () => {
  it('standard：全量面（bash + fs + 检索 + skills + 目标 + 编排 + 网页）', () => {
    const yml = ymlOf('standard')
    for (const id of ['persistent-shell', 'filesystem', 'tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill', 'tool-subagent', 'tool-web']) {
      expect(yml).toContain(`id: ${id}`)
    }
    expect(yml).not.toContain('id: tool-presentation')
    expect(yml).not.toContain('id: tool-cordis')
  })

  it('conductor：工具面同 standard（裁剪在运行时，不在编译期）', () => {
    const yml = ymlOf('conductor')
    for (const id of ['persistent-shell', 'tool-fs', 'skill-filesystem', 'tool-subagent']) {
      expect(yml).toContain(`id: ${id}`)
    }
  })

  it('ptc：standard + tool-presentation(mode: ptc)', () => {
    const yml = ymlOf('ptc')
    expect(yml).toContain('id: tool-presentation')
    expect(yml).toContain('dsh-agent-tool-presentation')
    expect(yml).toMatch(/mode:\s*"?ptc"?/)
    expect(yml).toContain('id: tool-fs')
  })

  it('cordis：standard + tool-cordis（运行时自省/插件实验）', () => {
    const yml = ymlOf('cordis')
    expect(yml).toContain('id: tool-cordis')
    expect(yml).toContain('dsh-tool-cordis')
    expect(yml).toContain('id: tool-fs')
  })

  it('minimal：只留 persona + persistent-shell + filesystem + tool-fs', () => {
    const yml = ymlOf('minimal')
    for (const id of ['persona', 'persistent-shell', 'filesystem', 'tool-fs']) {
      expect(yml).toContain(`id: ${id}`)
    }
    // 极简面之外的一律不出现（skills / 子 Agent / 目标 / 计划 / 网页 / 待办 / 后台任务 / MCP）
    for (const id of ['skill-filesystem', 'tool-skill', 'tool-subagent', 'tool-subagent-research', 'command-goal', 'tool-goal', 'planning', 'compaction', 'delegation', 'tool-web', 'tool-todo', 'tool-jobs', 'tool-ask-user', 'tool-fs-search']) {
      expect(yml).not.toContain(`id: ${id}`)
    }
  })
})
