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
import { CHILD_WORKER_ROLE } from '../src/tool-policy.ts'

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
  it('声明「无写工具」与五个工作阶段（英文提示词）', () => {
    // 2026-09-19 重写：旧文本是 "Iron rule: you never write code, edit files, or run
    // commands yourself"；护栏语义保留（机制确实裁了 write/edit/bash），但开篇不再是
    // 「我绝不干什么」，而是「我是技术负责人、必须亲自调查与验收」。
    expect(CONDUCTOR_PERSONA).toContain('you cannot edit files or run commands')
    for (const stage of ['1. Investigate:', '2. Design:', '3. Delegate:', '4. Verify:', '5. Decide:']) {
      expect(CONDUCTOR_PERSONA).toContain(stage)
    }
    // 全英文：人格段不得含中日韩字符（2026-09-10 用户要求「提示词都以英文编写」）。
    expect(CONDUCTOR_PERSONA).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('要求主 Agent 亲自调查与验收（2026-09-19 用户报障：退化成纯派活器）', () => {
    // 用户实测（会话 `corum-task-0b812630`）：20 次工具调用里 read/glob/grep **一次都没调**，
    // 全是 subagent/send_message 之类——主 Agent 不调查、不验收，只转述子报告。
    // 人格段必须把「自己动手读」写成硬要求，否则模型只按最省力的「派活」模式跑。
    expect(CONDUCTOR_PERSONA).toContain('A child agent\'s self-report is never proof')
    expect(CONDUCTOR_PERSONA).toContain('read the actual diff')
    expect(CONDUCTOR_PERSONA).toMatch(/read-only tools/)
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

describe('CHILD_WORKER_ROLE — 执行者契约（2026-09-20 用户报障）', () => {
  // 用户原话：「对于子 Agent 需要一套强有力的约束 作为执行者 目前看思考和搜索的时间太多了，
  // 完全不是按照指令照做，而是从头再次核查」。
  //
  // 旧文本只讲身份（worker / 执行 brief / 不能继续委派），**没有任何行为约束**——
  // 没有「不许重做 brief 已给的调研」、没有范围纪律、没有停止条件。叠加「每个子 Agent
  // 都被注入完整 AGENTS.md(11KB) + runtime context」（那是给顶层 Agent 写的全局开发规范），
  // worker 就会从头重建认知。以下断言钉住新增的六条硬约束，防止被回退成纯身份描述。
  it('声明执行者身份（子 Agent 是执行者，不是规划者）', () => {
    expect(CHILD_WORKER_ROLE).toContain('executor, not a planner')
    expect(CHILD_WORKER_ROLE).toContain('authoritative specification')
  })

  it('禁止重做 brief 已给的调研（本模式最大的时间浪费源）', () => {
    expect(CHILD_WORKER_ROLE).toContain('Do not redo reconnaissance the brief already answers')
    expect(CHILD_WORKER_ROLE).toContain('Do not re-plan it')
  })

  it('禁止扩大范围与顺手重构（越界必须改为报告）', () => {
    expect(CHILD_WORKER_ROLE).toContain('Stay inside the brief')
    expect(CHILD_WORKER_ROLE).toContain('report it in your reply — do not fix it unasked')
  })

  it('给出停止条件（达标即停，不追求「更彻底」，不反复重验）', () => {
    expect(CHILD_WORKER_ROLE).toContain('Stop when the brief is satisfied')
    expect(CHILD_WORKER_ROLE).toContain('do not re-verify the same thing repeatedly')
  })

  it('brief 有错时必须回报而不是自行发挥', () => {
    expect(CHILD_WORKER_ROLE).toContain('do not improvise')
    expect(CHILD_WORKER_ROLE).toContain('blocked report')
  })

  it('保留既有三条身份句与「不能继续委派」（不得被重写丢掉）', () => {
    expect(CHILD_WORKER_ROLE).toContain('You cannot delegate further')
    expect(CHILD_WORKER_ROLE).toContain('verify what you can')
  })

  it('全英文（提示词纪律）且不复述机制事实', () => {
    expect(CHILD_WORKER_ROLE).not.toMatch(/[\u4e00-\u9fff]/)
    expect(CHILD_WORKER_ROLE).not.toContain('worktree')
    expect(CHILD_WORKER_ROLE).not.toContain('isolation')
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

  it('挂 corum 三实例 + 官方 workflow/ralph 经 corum provider 恢复（与标准模式同款）', () => {
    // 2026-09-10：worker + research + fork 三实例（fork 用 corum-fork provider）。
    expect(composition.match(/name: '@corum\/corum-tool-subagent'/g)?.length).toBe(3)
    expect(composition).toContain('readonlyResearch: true')
    expect(composition).toContain('provider: corum-fork')
    // 官方能力恢复：fork 实例 / workflow 引擎 / ralph 启用且走 corum provider；
    // workflow **工具行** 2026-09-10 起退役（语义并入 orchestrate script 模式）。
    for (const restored of ['tool-subagent-fork', 'workflow-worker-thread', 'tool-ralph']) {
      expect(composition).toMatch(new RegExp(`- id: ${restored}\\n(?![\\s\\S]{0,200}?disabled: true)`))
    }
    expect(composition).toMatch(/- id: tool-workflow[\s\S]{0,200}?disabled: true/)
    expect(composition).toContain('provider: corum-spawn')
    // ralph 子 Agent 走 corum-tracked（不隔离但计入并发信号，2026-09-10「ralph 一并纳入」）。
    expect(composition).toContain('subagentProvider: corum-tracked')
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
