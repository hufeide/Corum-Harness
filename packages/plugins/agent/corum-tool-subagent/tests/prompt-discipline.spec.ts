/**
 * fork（corum）提示词纪律的机器化对账（2026-09-14 委派正确性 + 效率合并轮）。
 *
 * 为什么需要「源码扫描式」对账（本仓先例：`corum-agent/tests/builtin-roles.spec.ts`
 * 用 `indexOf` 切片钉住规则顺序）：机制段的文本是**模型唯一读到的规则面**，它一旦
 * 被悄悄改写或漂移，只有实机重启后读工具描述才看得出来。本 spec 把两件事变成断言：
 *
 *   1. **决策点分工**：只读调研必须路由到只读研究工具、写任务才用写能力工具，
 *      且「无修改就不召唤写能力子 Agent」这条负向规则必须同时出现在
 *      （a）工具 description 的决策点文本、（b）机制段；
 *   2. **写作纪律**：机制段条目里不得出现实测数字/监督调试框架/项目专属特例
 *      ——这是用户 2026-09-14 定调的通用性要求，靠人工复核容易回潮，落成断言。
 *
 * 覆盖边界：本 spec 只做**文本面**断言，不改任何机制语义；实机装配仍由 CDP 取证。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  corumEfficiencyDisciplineLines,
  corumSandboxEscalationLines,
} from '../src/index.ts'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

/** 取出一段源码文本：从 `from` 到 `to`（不含）——顺序即语义锚点。 */
function between(from: string, to: string): string {
  const start = SRC.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0)
  const end = SRC.indexOf(to, start + from.length)
  expect(end, `closing anchor not found: ${to}`).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('决策点分工 — 只读调研不走写能力子 Agent（源码扫描对账单测）', () => {
  it('工具 description 的决策点文本：按「需不需要执行」分流，且写明两边工具面边界', () => {
    // 2026-09-14 修正后的契约（用户点名「主 Agent 派 research 去验收」）：
    // 旧文案把 `verification by inspection`（验收）整类划给只读工具 ⇒ 执行型验收被派给
    // 没有 write 的子会话 ⇒ 派单里「不许改文件」与「必须造 fixture」并存（实证 6364e3ea）。
    // 现在按 **EXECUTE 还是 JUDGE** 分流，并把工具面边界写在决策点上。
    const anchor = 'Choose by whether the subtask must EXECUTE or only JUDGE'
    const start = SRC.indexOf(anchor)
    expect(start, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0)
    const block = SRC.slice(start, SRC.indexOf('parameters:', start))
    expect(block).not.toBe('')

    // ① 只读工具的能力边界必须写清（这是旧文案缺失、导致误派的部分）。
    expect(block).toContain('`subagent_research` is read-only')
    expect(block).toContain('write/edit are denied')
    expect(block).toContain('pinned to `read-only`')
    // ② **执行型验收**必须走写能力工具（本次修的核心）。
    expect(block).toContain('executable verification')
    expect(block).toContain('Running a verification is not the same as inspecting one')
    // ③ 「不许改文件」与「必须造 fixture」不可并存，必须显式点明。
    expect(block).toContain('cannot both hold')
    // ④ 负向规则保留：没有修改就不该召唤写能力子 Agent。
    expect(block).toContain('A subtask that changes nothing must not be given a write-capable child')
    // ⑤ 决策点文本必须**排在**参数表之前（模型先读到分工，再看到参数）。
    expect(start).toBeLessThan(SRC.indexOf('parameters: {', start))
  })

  it('机制段：只读与写两条并列在选择清单最前，且带负向规则', () => {
    const block = between('Choose the right delegation form by the shape of the work:', 'if (hasFork)')
    const readAt = block.indexOf('- READ-ONLY work')
    const writeAt = block.indexOf('- Work that CHANGES files')
    const singleAt = block.indexOf('- ONE focused, self-contained subtask that must create or modify files')
    expect(readAt).toBeGreaterThanOrEqual(0)
    expect(writeAt).toBeGreaterThan(readAt)
    expect(singleAt).toBeGreaterThan(writeAt)
    expect(block).toContain('call `subagent_research`')
  })

  it('机制段：隔离是「改动」的属性，只读委派不消耗隔离面', () => {
    expect(SRC).toContain('Isolation is a property of CHANGE, not of delegation')
    expect(SRC).toContain('never call the write-capable `subagent` for a task that changes nothing')
  })
})

describe('H 写作纪律 — 机制段提示词不得夹带实测数字 / 监督调试框架 / 项目特例', () => {
  const lines = [...corumEfficiencyDisciplineLines(), ...corumSandboxEscalationLines()]

  it('两个导出块是机制段唯一事实源（段内不再内联字面量）', () => {
    expect(SRC).toContain('lines.push(...corumEfficiencyDisciplineLines())')
    expect(SRC).toContain('lines.push(...corumSandboxEscalationLines())')
    expect(SRC).not.toContain("'EFFICIENCY DISCIPLINE (measured on real delegations")
    expect(SRC).not.toContain('one delegation made 111 bash calls')
  })

  it('不得出现实测数字（墙钟分钟 / 缺陷数 / 百分比 / 工具调用计数）', () => {
    const text = lines.join('\n')
    for (const banned of [/\b7m40s\b/, /\b111\b/, /\b91\b/, /\b26%\b/, /minutes? of wall clock/, /ZERO new defects/i]) {
      expect(text, `banned measured figure: ${String(banned)}`).not.toMatch(banned)
    }
  })

  it('不得出现监督 / 调试模式专属框架', () => {
    const text = lines.join('\n')
    for (const banned of [/supervisor/i, /verifier OUTSIDE this session/i, /next round can compare/i, /verified on device/i, /measured on real delegations/i]) {
      expect(text, `banned framing: ${String(banned)}`).not.toMatch(banned)
    }
  })

  it('不得夹带项目专属特例（脚本名 / 端口 / 角色归属举例）', () => {
    const text = lines.join('\n')
    for (const banned of [/verify-fork-drift/, /corum-cdp-verify/, /:9222/, /:9333/, /\bcdp\.mjs\b/, /approval\/asked/]) {
      expect(text, `banned project-specific example: ${String(banned)}`).not.toMatch(banned)
    }
  })

  it('允许的量化只有机制常量（默认超时 / 上限 / 同回合一次）', () => {
    const text = lines.join('\n')
    expect(text).toContain('60s by default')
    expect(text).toContain('600000')
    expect(text).toContain('retry the exact same command once')
  })
})

describe('F 后台任务纪律 — 范畴与禁忌（照官方口径恢复）', () => {
  const background = corumEfficiencyDisciplineLines().find(l => l.includes('PUT LONG-RUNNING')) ?? ''

  it('范畴：长时/暂不需要结果的命令放后台，返回句柄，用收集/终止工具处理', () => {
    expect(background).toContain('run_in_background: true')
    expect(background).toContain('job_output')
    expect(background).toContain('job_kill')
    expect(background).toContain('A server, a watcher, a long build or a long test suite')
  })

  it('禁用轮询替代后台等待', () => {
    expect(background).toContain('Never replace that handle with "wait a moment, then look again"')
  })

  it('三条禁忌齐备：结果依赖 / 影响本会话运行环境 / 输出不可取回', () => {
    expect(background).toContain('Do not background a command whose result you need before the next step')
    expect(background).toContain('would stop or restart the runtime this session depends on')
    expect(background).toContain('whose output cannot be retrieved')
  })
})

describe('I 沙箱升级 — 被拒 → 同回合升级一次 → 由用户裁决', () => {
  const text = corumSandboxEscalationLines().join('\n')

  it('拒绝标记是策略决定，不是命令失败', () => {
    expect(text).toContain('[sandbox: file access denied under <mode> mode]')
    expect(text).toContain('policy decision, not a failure of the command')
  })

  it('同回合重试同一条命令一次，带最窄够用档 + 一句 justification，主会话审批弹窗即同意', () => {
    expect(text).toContain('retry the exact same command once, in the same turn')
    expect(text).toContain('sandbox_permissions')
    expect(text).toContain('narrowest wider mode that suffices')
    expect(text).toContain('justification')
    expect(text).toContain('approval policy is `ask`')
  })

  it('两条边界：不得预先猜测式升级；被拒即终结（但不影响后续其它命令）', () => {
    expect(text).toContain('never speculatively')
    expect(text).toContain('a denial is final')
    expect(text).toContain('A rejected escalation is final for that command')
    expect(text).toContain('does not forbid attempting or escalating other commands later')
  })

  it('措辞纪律：不写具体端口 / 脚本 / 会话', () => {
    for (const banned of [/:9222/, /:9333/, /verify-instance/, /danger-full-access/]) {
      expect(text, `banned concrete example: ${String(banned)}`).not.toMatch(banned)
    }
  })
})
