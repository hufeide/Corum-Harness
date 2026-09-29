/**
 * 「用户自定义多个档位」的单测（2026-09-29 用户定调）：
 *
 * > 在模型设置中给用户自定义多个档位的入口。当用户选择该模型时，
 * > 让用户选择其自定义的档位。
 * > —— pi-ai 的表是做兜底的，自定义的思考等级应该由用户来设置。
 *
 * 被测两条通路：
 *   - `declaredLevelsOf`：多选控件的**回显**（只认用户显式声明过的档位集合）；
 *   - `piAiThinkingWrite`：保存时的**落盘归一**（三条不变式，见其文档）。
 *
 * 背景硬约束（dsh-llm-pi-ai `config.ts`）：`reasoningEfforts` 的**键**被
 * `z.union(THINKING_LEVELS)` 校验，只能是 off/minimal/low/medium/high/xhigh/max
 * 这 7 个 id；可自由填的是**值**（每档发给网关的 wire 拼写）。
 */
import { describe, expect, it } from 'vitest'
import { KNOWN_LEVELS, declaredLevelsOf, piAiThinkingWrite } from '../src/client/reasoning.ts'
import type { SettingsSchemaOperations } from '../src/client/schema-operations.ts'

/** 极简 schema 操作替身：getPath 走真实对象路径（与官方语义一致）。 */
const schema = {
  getPath(value: unknown, path: readonly string[]): unknown {
    let cur: unknown = value
    for (const segment of path) {
      if (typeof cur !== 'object' || cur === null) return undefined
      cur = (cur as Record<string, unknown>)[segment]
    }
    return cur
  },
} as unknown as SettingsSchemaOperations

const PATH = ['providers', 'localhost'] as const
const view = (models: unknown[]): never =>
  ({ value: { providers: { localhost: { models } } }, revision: 1 }) as never

describe('KNOWN_LEVELS — pi-ai 键域', () => {
  it('恰好是 pi-ai 的 7 个合法档位 id（顺序 = THINKING_LEVELS）', () => {
    expect(KNOWN_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('declaredLevelsOf — 多选控件回显用户已声明的档位集合', () => {
  it('未声明过 ⇒ undefined（区别于「声明了空集」，调用方据此改用侦测建议）', () => {
    expect(declaredLevelsOf(schema, view([{ id: 'glm-5.2' }]), PATH, 'glm-5.2')).toBeUndefined()
  })

  it('模型不在列表里 ⇒ undefined', () => {
    expect(declaredLevelsOf(schema, view([{ id: 'other' }]), PATH, 'glm-5.2')).toBeUndefined()
  })

  it('原样回显已声明集合，**且不补 off**', () => {
    // 实测现场：kimi-k3 的 reasoningEfforts 只有 low/high/max，没有 off。
    // 若用 readModelThinking（它会 `['off', ...keys]`）回显，保存就会把 off 悄悄写回盘。
    const levels = declaredLevelsOf(
      schema,
      view([{ id: 'kimi-k3', reasoningEfforts: { low: 'low', high: 'high', max: 'max' } }]),
      PATH,
      'kimi-k3',
    )
    expect(levels).toEqual(['low', 'high', 'max'])
    expect(levels).not.toContain('off')
  })

  it('按 KNOWN_LEVELS 归一序（同配置重复保存不产生 diff）', () => {
    const levels = declaredLevelsOf(
      schema,
      view([{ id: 'm', reasoningEfforts: { max: 'max', off: null, high: 'high', low: 'low' } }]),
      PATH,
      'm',
    )
    expect(levels).toEqual(['off', 'low', 'high', 'max'])
  })

  it('reasoningEfforts: false（显式声明非推理模型）⇒ 只有 off', () => {
    expect(declaredLevelsOf(schema, view([{ id: 'm', reasoningEfforts: false }]), PATH, 'm')).toEqual(['off'])
  })

  it('历史非法键保留在回显里（由控件提示 + 保存时剔除，不静默吞）', () => {
    const levels = declaredLevelsOf(
      schema,
      view([{ id: 'm', reasoningEfforts: { high: 'high', ultra: 'ultra' } }]),
      PATH,
      'm',
    )
    expect(levels).toEqual(['high', 'ultra'])
  })
})

describe('piAiThinkingWrite — 保存归一（三条不变式）', () => {
  it('不变式① 键域：历史非法档位 id 被剔除（否则整段 settings 注册失败）', () => {
    const w = piAiThinkingWrite(['high', 'ultra', 'turbo'], 'high')
    expect(Object.keys(w.efforts ?? {})).toEqual(['high'])
  })

  it('不变式② 没有非 off 档 ⇒ 写 false（pi-ai 的非推理模型编码），**不是删键**', () => {
    // 删键在 catalog 路由上的语义是「继承内置目录能力」，会把推理能力放回来，
    // 用户的「取消全部勾选」就会静默失效；pi-ai 又拒绝只有 off 的 dict。
    // 故正确编码是 `false`（显式声明非推理模型）。
    expect(piAiThinkingWrite(['off'], 'off').efforts).toBe(false)
    expect(piAiThinkingWrite([], 'high').efforts).toBe(false)
  })

  it('默认档不在集合内 ⇒ 回落集合首个非 off 档', () => {
    // 现场形态：kimi-k3 配了 reasoning: xhigh，但其档位集合没有 xhigh。
    const w = piAiThinkingWrite(['low', 'high', 'max'], 'xhigh')
    expect(w.defaultLevel).toBe('low')
  })

  it('默认档在集合内 ⇒ 原样保留', () => {
    expect(piAiThinkingWrite(['low', 'high', 'max'], 'high').defaultLevel).toBe('high')
  })

  it("默认档 'off' ⇒ defaultLevel ''（不写 reasoning 键，沿用既有语义）", () => {
    expect(piAiThinkingWrite(['off', 'high'], 'off').defaultLevel).toBe('')
  })

  it('off → null（支持但不发参数），其余 → 档位 id 本身（无 wire 映射）', () => {
    expect(piAiThinkingWrite(['off', 'low', 'high'], 'high').efforts).toEqual({
      off: null,
      low: 'low',
      high: 'high',
    })
  })

  it('**用户声明优先于内置表**：集合就是勾选结果，不掺入表里的档位', () => {
    // 用户只勾 high（表里 glm-5.2 是 off/high/max）⇒ 落盘只有 high。
    expect(Object.keys(piAiThinkingWrite(['high'], 'high').efforts ?? {})).toEqual(['high'])
  })

  it('回归：档位里混入布尔 false ⇒ 归一为 off，绝不产出 YAML 布尔键', () => {
    const w = piAiThinkingWrite([false as never, 'high'], 'high')
    expect(w.efforts).toEqual({ off: null, high: 'high' })
    for (const key of Object.keys(w.efforts ?? {})) {
      expect(['false', 'true', 'null', '~']).not.toContain(key)
      expect(typeof key).toBe('string')
    }
  })
})
