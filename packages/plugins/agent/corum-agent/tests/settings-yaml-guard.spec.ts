/**
 * `settings.yaml` 布尔键预检单测（2026-09-15 真实故障的防线）。
 *
 * 事故：`:9333` 的 `settings.yaml` 把 `reasoningEfforts` 的合法键 `off` 写成了 `false`，
 * YAML 解析成**布尔键** ⇒ 段校验失败 ⇒ 段注册不上 ⇒ UI 报
 * 「settings namespace "llm-pi-ai" is not registered」（**完全不指向那个键**）。
 * 本守卫的目标：把这类键**大声报出来**，把「半小时排查」变成「一眼看到」。
 */
import { describe, expect, it } from 'vitest'
import { describeSuspiciousYamlKeys, scanSuspiciousYamlKeys } from '../src/settings-yaml-guard.ts'

describe('scanSuspiciousYamlKeys — 找出会被 YAML 解析成非字符串的映射键', () => {
  it('**真实事故原文**：`false: null` 被抓到，且定位到段名与行号', () => {
    const text = [
      'ui-onboarding:',
      '  welcomeNoticeVersion: 2026-08-13.1',
      'llm-pi-ai:',
      '  providers:',
      '    localhost:',
      '      models:',
      '        - id: kimi-k3-1',
      '          reasoningEfforts:',
      '            false: null',
    ].join('\n')
    const hits = scanSuspiciousYamlKeys(text)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.key).toBe('false')
    expect(hits[0]?.parsedAs).toBe('boolean false')
    expect(hits[0]?.section).toBe('llm-pi-ai')
    expect(hits[0]?.line).toBe(9)
  })

  it('`true` / `null` / `~` 同样被抓（YAML 1.2 core 的非字符串标量）', () => {
    const keys = scanSuspiciousYamlKeys(['a:', '  true: x', '  null: y', '  "~": z'].join('\n')).map(h => h.key)
    expect(keys).toContain('true')
    expect(keys).toContain('null')
    // `"~"` 是**带引号**的键 ⇒ 合法字符串，不该报。
    expect(keys).not.toContain('"~"')
  })

  it('⚠️ **不误报** `off`/`on`/`yes`/`no` —— YAML 1.2 core 里它们是普通字符串', () => {
    // 收到这些会把「正确的文件」报成坏的：dsh 用 YAML 1.2（不是 1.1），off 是字符串。
    const text = ['llm-pi-ai:', '  reasoningEfforts:', '    off: null', '    on: 1', '    yes: 1', '    no: 1'].join('\n')
    expect(scanSuspiciousYamlKeys(text)).toHaveLength(0)
  })

  it('带引号的键安全：`"false": null` 是字符串键，不报', () => {
    expect(scanSuspiciousYamlKeys(['a:', "  'false': null", '  "true": null'].join('\n'))).toHaveLength(0)
  })

  it('顶层段被正确追踪（用于告警定位）；顶层自身命中时段名为 undefined', () => {
    const hits = scanSuspiciousYamlKeys(['false:', '  x: 1', 'ok-section:', '  false: 2'].join('\n'))
    expect(hits).toHaveLength(2)
    expect(hits[0]?.section).toBeUndefined()
    expect(hits[1]?.section).toBe('ok-section')
  })

  it('干净文件零命中（不得把正常设置报成坏的）', () => {
    const text = ['agent-default-model:', '  provider: deepseek-official', '  model: deepseek-v4-flash'].join('\n')
    expect(scanSuspiciousYamlKeys(text)).toHaveLength(0)
  })

  it('值里出现这些词不算（只看**键**）', () => {
    expect(scanSuspiciousYamlKeys(['a:', '  supportsDeveloperRole: false', '  note: off'].join('\n'))).toHaveLength(0)
  })

  it('永不抛错（语法残缺的 YAML 也要能扫）', () => {
    expect(() => scanSuspiciousYamlKeys(':::\n\t\tfalse:\n  - [')).not.toThrow()
  })
})

describe('describeSuspiciousYamlKeys — 告警必须可执行', () => {
  const hits = scanSuspiciousYamlKeys(['llm-pi-ai:', '  reasoningEfforts:', '    false: null'].join('\n'))
  const text = describeSuspiciousYamlKeys('/tmp/settings.yaml', hits)

  it('给出行号与段名（用户能直接跳过去）', () => {
    expect(text).toContain('/tmp/settings.yaml:3')
    expect(text).toContain('[llm-pi-ai]')
  })

  it('解释**为什么**会让整段失效，并点明误导性的报错文案', () => {
    expect(text).toContain('namespace')
    expect(text).toContain('not registered')
  })

  it('给出**具体改法**（false → off），并说明判据是 YAML 1.2', () => {
    expect(text).toContain('off: null')
    expect(text).toContain('YAML 1.2')
  })

  it('无命中 ⇒ 空串（不产生噪声日志）', () => {
    expect(describeSuspiciousYamlKeys('/tmp/settings.yaml', [])).toBe('')
  })
})
