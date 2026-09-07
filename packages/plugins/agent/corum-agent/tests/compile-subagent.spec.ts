/**
 * fork #10 双实例编译产物对账（PLAN-subagent-isolation §1.1/§3）：
 *   1. delegation 组含 worker（subagent）+ research（subagent_research）双行，
 *      provider=corum-spawn、name=@corum/corum-tool-subagent；
 *   2. research 实例恒只读：readonlyResearch + deny 全写工具（不可移除）；
 *   3. 模型锁：subagentModel/researchModel → config.model（research 缺省同 worker）；
 *   4. parallelWork 显式键才进 config（缺省省略，由 host settings 兜底）；
 *   5. 写工具清单与 fork #10 常量逐字对账（防 mount fail-loud）。
 */
import { describe, expect, it } from 'vitest'
import { compilePreset } from '../src/compile.ts'
import type { AgentProfile } from '../src/profile.ts'

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test-dual',
    baseMode: 'standard',
    prompt: '测试 Agent',
    model: { provider: 'local', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
    ...overrides,
  }
}

/** 与 fork #10（corum-tool-subagent/src/index.ts）常量逐字一致——改任一侧需同步。 */
const FORK10_WRITE_TOOLS = ['str_replace_editor', 'write', 'edit', 'bash', 'pwsh']

function dualRows(yml: string): { worker: string; research: string } {
  // 双实例行在 delegation 组的 config 里（缩进 `    - id: `），按行首 id 切分。
  const rows = yml.split(/\n {4}- id: /)
  const worker = rows.find(r => r.startsWith('tool-subagent\n'))
  const research = rows.find(r => r.startsWith('tool-subagent-research\n'))
  expect(worker, 'worker row missing').toBeDefined()
  expect(research, 'research row missing').toBeDefined()
  return { worker: worker!, research: research! }
}

describe('compilePreset — fork #10 双实例行', () => {
  it('双实例恒输出（research 不可移除），provider=corum-spawn', () => {
    const { worker, research } = dualRows(compilePreset(profile()).cordisYml)
    expect(worker).toContain('name: "@corum/corum-tool-subagent"')
    expect(worker).toContain('provider: "corum-spawn"')
    expect(worker).toContain('toolName: "subagent"')
    expect(research).toContain('toolName: "subagent_research"')
    expect(research).toContain('readonlyResearch: true')
  })

  it('research 预 deny 全部写工具（与 fork #10 清单对账；pwsh 仅 win32）', () => {
    const { research } = dualRows(compilePreset(profile()).cordisYml)
    const expected = process.platform === 'win32'
      ? FORK10_WRITE_TOOLS
      : FORK10_WRITE_TOOLS.filter(t => t !== 'pwsh')
    for (const tool of expected) {
      expect(research).toContain(`"${tool}"`)
    }
    if (process.platform !== 'win32') {
      // 非 win32 不 deny 未装载的 pwsh（tools.restrict 未知名 fail loud）。
      expect(research).not.toContain('"pwsh"')
    }
  })

  it('模型锁：subagentModel 进 worker config.model；research 缺省同 worker', () => {
    const { worker, research } = dualRows(compilePreset(profile({
      subagentModel: { provider: 'local', model: 'deepseek-v4-flash' },
    })).cordisYml)
    expect(worker).toContain('model:')
    expect(worker).toContain('provider: "local"')
    expect(research).toContain('provider: "local"')
  })

  it('researchModel 独立配置时覆盖 research 实例模型', () => {
    const { research } = dualRows(compilePreset(profile({
      subagentModel: { provider: 'local', model: 'deepseek-v4-flash' },
      researchModel: { provider: 'pi-ai', model: 'kimi-k3-1' },
    })).cordisYml)
    expect(research).toContain('provider: "pi-ai"')
    expect(research).toContain('model: "kimi-k3-1"')
  })

  it('parallelWork 显式键才进 config；缺省省略', () => {
    const bare = dualRows(compilePreset(profile()).cordisYml)
    expect(bare.worker).not.toContain('isolation:')
    expect(bare.worker).not.toContain('maxParallelChildren')
    const full = dualRows(compilePreset(profile({
      parallelWork: { isolation: 'always', maxParallelChildren: 2, integrateChecks: ['pnpm lint'] },
    })).cordisYml)
    expect(full.worker).toContain('mode: "always"')
    expect(full.worker).toContain('maxParallelChildren: 2')
    expect(full.worker).toContain('"pnpm lint"')
  })
})
