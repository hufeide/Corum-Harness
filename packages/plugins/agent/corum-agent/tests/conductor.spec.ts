/**
 * 指挥模式（`conductor`）单测——2026-09-10 用户需求「把编排者固化为与标准模式同级的
 * 基准模式」。
 *
 * 覆盖：
 *   1. `isConductorMode` 判定（基准 preset / 旧 orchestrator profile / 其他模式不误伤）；
 *   2. `conductorExecutionDeny` 平台口径（pwsh 仅 win32——deny 未知名会让
 *      `tools.restrict()` fail-loud，见 docs/LESSONS.md §6.18）；
 *   3. 人格段写作纪律（不重复机制事实——隔离触发/模型锁/结果回传形态由 fork #10 的
 *      机制段单一事实源负责，见 docs/PROMPT-INVENTORY.md §1）；
 *   4. preset 数据面存在且与代码常量对账（id / 显示名 / 工具面与标准模式同款）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONDUCTOR_MODE_LABEL,
  CONDUCTOR_PERSONA,
  CONDUCTOR_PRESET_ID,
  CONDUCTOR_SECTION,
  CONDUCTOR_STALE_SECTIONS,
  conductorExecutionDeny,
  conductorModeOf,
  effectiveExecutionTools,
} from '../src/conductor.ts'

const PRESET_DIR = join(import.meta.dirname, '../../../../desktop/shipped-presets/official')

describe('conductorModeOf — 指挥模式判定', () => {
  it('基准 preset `conductor` → preset 形态（官方 preset 路径）', () => {
    expect(conductorModeOf(CONDUCTOR_PRESET_ID, true)).toBe('preset')
  })

  it('旧 orchestrator profile → profile 形态（兼容既有用户数据，人格由它自己的 preset 带）', () => {
    expect(conductorModeOf('deepseek-orchestrator', false, 'orchestrator')).toBe('profile')
  })

  it('其他官方模式 → off', () => {
    for (const id of ['standard', 'ptc', 'cordis', 'minimal']) {
      expect(conductorModeOf(id, true)).toBe('off')
    }
  })

  it('corum profile 缺省/full → off', () => {
    expect(conductorModeOf('frontend-engineer', false)).toBe('off')
    expect(conductorModeOf('frontend-engineer', false, 'full')).toBe('off')
  })

  it('同名 id 但非官方 preset → off（防止 user 目录同名 profile 误伤）', () => {
    expect(conductorModeOf(CONDUCTOR_PRESET_ID, false)).toBe('off')
  })
})

describe('CONDUCTOR_SECTION — 角色段不覆盖部署人格', () => {
  it('段名独立于 deployment:persona（基准模式必须保留部署事实）', () => {
    expect(CONDUCTOR_SECTION).toBe('corum:conductor')
    expect(CONDUCTOR_SECTION).not.toBe('deployment:persona')
  })
})

describe('conductorExecutionDeny — 执行工具平台口径', () => {
  it('macOS/Linux 不含 pwsh（未装载的名字会让 restrict fail-loud）', () => {
    if (process.platform === 'win32') return
    expect(conductorExecutionDeny()).not.toContain('pwsh')
    expect(conductorExecutionDeny()).toEqual(
      expect.arrayContaining(['str_replace_editor', 'write', 'edit', 'bash']),
    )
  })

  it('deny 覆盖全部写/执行入口（主 Agent 物理上无法亲手执行）', () => {
    const deny = conductorExecutionDeny()
    for (const tool of ['str_replace_editor', 'write', 'edit', 'bash']) {
      expect(deny).toContain(tool)
    }
  })
})

describe('CONDUCTOR_PERSONA — 人格段写作纪律', () => {
  it('声明「不亲手执行」与四个工作阶段', () => {
    expect(CONDUCTOR_PERSONA).toContain('绝不亲手')
    for (const stage of ['理解', '拆解', '派活', '裁决']) expect(CONDUCTOR_PERSONA).toContain(stage)
  })

  it('不重复机制事实（隔离触发/模型锁/验收门禁由机制段单一事实源负责）', () => {
    // 并发感知隔离、声明式验收、notice 回传形态——这些属于机制段，人格段不得复述。
    expect(CONDUCTOR_PERSONA).not.toContain('worktree')
    expect(CONDUCTOR_PERSONA).not.toContain('并发')
    expect(CONDUCTOR_PERSONA).not.toContain('notice')
    expect(CONDUCTOR_PERSONA).not.toContain('autoIntegrate')
  })

  it('点名两个只读/编排入口（模型可据此选择工具）', () => {
    expect(CONDUCTOR_PERSONA).toContain('subagent')
    expect(CONDUCTOR_PERSONA).toContain('subagent_research')
    expect(CONDUCTOR_PERSONA).toContain('orchestrate')
  })
})

describe('preset 数据面与代码常量对账', () => {
  const presetYml = readFileSync(join(PRESET_DIR, CONDUCTOR_PRESET_ID, 'preset.yml'), 'utf8')
  const composition = readFileSync(join(PRESET_DIR, CONDUCTOR_PRESET_ID, 'agent.cordis.yml'), 'utf8')

  it('preset.yml 的 name 与 CONDUCTOR_MODE_LABEL 一致', () => {
    expect(presetYml).toContain(`name: ${CONDUCTOR_MODE_LABEL}`)
  })

  it('工具面与标准模式逐行一致（裁剪只在运行时，preset 不裁行）', () => {
    const rows = (text: string): string => text.slice(text.indexOf('- id: '))
    expect(rows(composition)).toBe(rows(readFileSync(join(PRESET_DIR, 'standard', 'agent.cordis.yml'), 'utf8')))
  })

  it('挂 corum 双实例 + 退役 fork/workflow/ralph（与标准模式同款）', () => {
    expect(composition.match(/name: '@corum\/corum-tool-subagent'/g)?.length).toBe(2)
    expect(composition).toContain('readonlyResearch: true')
    for (const retired of ['tool-subagent-fork', 'tool-workflow', 'tool-ralph', 'workflow-worker-thread']) {
      expect(composition).toMatch(new RegExp(`- id: ${retired}[\\s\\S]{0,200}?disabled: true`))
    }
  })

  it('陈旧工具指引段名单覆盖 write/edit（裁工具后提示词不得仍教模型使用）', () => {
    expect([...CONDUCTOR_STALE_SECTIONS]).toEqual(['tool:write', 'tool:edit'])
  })
})


describe('effectiveExecutionTools — baseMode conductor 继承指挥语义', () => {
  it('baseMode conductor 且未声明 executionTools → orchestrator（继承指挥模式）', () => {
    expect(effectiveExecutionTools({ baseMode: 'conductor' })).toBe('orchestrator')
  })

  it('显式 executionTools 优先（作者可让 conductor 角色亲手执行）', () => {
    expect(effectiveExecutionTools({ baseMode: 'conductor', executionTools: 'full' })).toBe('full')
  })

  it('其他 baseMode 不受影响', () => {
    for (const baseMode of ['standard', 'ptc', 'minimal', 'cordis']) {
      expect(effectiveExecutionTools({ baseMode })).toBeUndefined()
    }
  })

  it('conductor 角色（baseMode conductor）经 conductorModeOf 走 profile 形态', () => {
    const profile = { baseMode: 'conductor', executionTools: undefined }
    expect(conductorModeOf('conductor-lead', false, effectiveExecutionTools(profile))).toBe('profile')
  })
})
