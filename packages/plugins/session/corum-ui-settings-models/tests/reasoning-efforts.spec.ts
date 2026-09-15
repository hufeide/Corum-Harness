/**
 * `reasoningEffortsOf` 的**事故回归**单测（2026-09-15）。
 *
 * 事故：`:9333` 的 settings.yaml 里出现 `reasoningEfforts: { false: null }`（YAML 布尔键）
 * ⇒ pi-ai 段校验失败 ⇒ 整个 settings 段注册不上 ⇒ UI 只报
 * 「settings namespace "llm-pi-ai" is not registered」（**完全不指向那个键**）。
 *
 * 本组断言钉住「**写入侧不可能再产出布尔键**」这条不变式：
 * 档位 id 即使是布尔，也必须被归一化成合法字符串键（`false` → `'off'`），或直接跳过。
 */
import { describe, expect, it } from 'vitest'
import { reasoningEffortsOf } from '../src/client/reasoning.ts'

/** 键必须全是字符串 —— 这是 pi-ai 段校验通过的前提。 */
function assertAllStringKeys(dict: Record<string, unknown> | undefined): void {
  for (const key of Object.keys(dict ?? {})) {
    expect(typeof key).toBe('string')
    // `"false"` / `"true"` 这类**字符串形式的布尔**同样会被 YAML 无引号序列化成布尔键。
    expect(['false', 'true', 'null', '~']).not.toContain(key)
  }
}

describe('reasoningEffortsOf — 不得产出 YAML 布尔键', () => {
  it('**回归**：档位里混入布尔 false ⇒ 归一化为 `off`，绝不产出 `false` 键', () => {
    const dict = reasoningEffortsOf([false, 'high', 'max'] as never, undefined)
    expect(dict).toBeDefined()
    expect(dict?.off).toBeNull()
    expect(dict?.high).toBe('high')
    expect(Object.keys(dict ?? {})).not.toContain('false')
    assertAllStringKeys(dict)
  })

  it('布尔 true 不是合法档位 ⇒ 跳过（不产出 `true` 键）', () => {
    const dict = reasoningEffortsOf(['high', true] as never, undefined)
    expect(dict?.high).toBe('high')
    expect(Object.keys(dict ?? {})).not.toContain('true')
    assertAllStringKeys(dict)
  })

  it('undefined / 空串档位被跳过（不产出空键）', () => {
    const dict = reasoningEffortsOf(['high', undefined, ''] as never, undefined)
    expect(Object.keys(dict ?? {})).toEqual(['high'])
  })

  it('正常档位不受影响（off → null，其余 → 自身，已配 wire 值保留）', () => {
    const dict = reasoningEffortsOf(['off', 'low', 'high'], { high: 'high-wire' })
    expect(dict).toEqual({ off: null, low: 'low', high: 'high-wire' })
    assertAllStringKeys(dict)
  })

  it('只有 off ⇒ 返回 undefined（pi-ai 要求至少一个非 off 档）', () => {
    expect(reasoningEffortsOf(['off'], undefined)).toBeUndefined()
  })

  it('空档位集合 ⇒ undefined（不该写）', () => {
    expect(reasoningEffortsOf([], undefined)).toBeUndefined()
  })
})
