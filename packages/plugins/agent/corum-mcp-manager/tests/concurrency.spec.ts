/**
 * 策略推导单测（2026-09-27 用户口径：「可复用的则不独占」）。
 *
 * 判据 = **目标资源是配置时定死、还是调用时传入**：
 *   · CDP 带 `--browser-url=…`（连用户那台既有浏览器）⇒ 独占（用户明确点名）；
 *   · CDP 自己拉起浏览器 / `--isolated` ⇒ 可按 pageId 路由 ⇒ per-resource(pageId)；
 *   · pencil 式服务提供者（每个工具都要 `filePath`）⇒ per-resource(filePath)；
 *   · 推不出 ⇒ 独占（保守默认，宁可串行也不要两个 Agent 互相踩）。
 *
 * 顺序：**显式配置 > 绑既有实例 > 自持目标 > 工具面共同参数 > 保守默认**。
 */
import { describe, expect, it } from 'vitest'
import { concurrencyLimitOf, deriveConcurrencyPolicy, resourceValueOf, sharedResourceArgOf } from '../src/concurrency.ts'
import type { McpServerConfig } from '../src/types.ts'

function stdio(command: string, args: string[] = []): McpServerConfig {
  return { name: 'probe', transport: 'stdio', command, args }
}

const tool = (name: string, properties: Record<string, unknown> = {}) => ({
  name,
  inputSchema: { type: 'object', properties },
})

describe('策略推导：配置时定死 ⇒ 独占；调用时传入 ⇒ 可复用', () => {
  it('★ CDP 绑到既有实例（--browser-url）⇒ exclusive（压过工具面的 pageId 规则）', () => {
    const decision = deriveConcurrencyPolicy({
      config: stdio('npx', ['-y', 'chrome-devtools-mcp@latest', '--browser-url=http://127.0.0.1:9333']),
      tools: [tool('click', { pageId: {}, uid: {} }), tool('list_pages')],
    })
    expect(decision.mode).toBe('exclusive')
    expect(decision.reason).toContain('existing browser')
  })

  it('★ CDP 自持目标（自己拉起 / --isolated）⇒ per-resource(pageId)', () => {
    for (const args of [
      ['-y', 'chrome-devtools-mcp@latest'],
      ['-y', 'chrome-devtools-mcp@latest', '--isolated'],
      ['-y', 'chrome-devtools-mcp@latest', '--headless'],
    ]) {
      const decision = deriveConcurrencyPolicy({ config: stdio('npx', args) })
      expect(decision.mode, args.join(' ')).toBe('per-resource')
      expect(decision.resourceArg).toBe('pageId')
    }
  })

  it('★ CDP 走远端 http（桥到一台既有浏览器）⇒ exclusive', () => {
    const decision = deriveConcurrencyPolicy({
      config: { name: 'p', transport: 'streamable-http', url: 'https://chrome-devtools-mcp.internal/mcp' },
      tools: [tool('click', { pageId: {} })],
    })
    expect(decision.mode).toBe('exclusive')
    expect(decision.reason).toContain('existing browser')
  })

  it('通用远端 http 端点（非 CDP）：按工具面推导，推不出则保守默认独占', () => {
    // ⚠️ 首版我把这条写成「http ⇒ existing browser」⇒ 红。正确口径：只有 **CDP** 才因"连到既有
    // 浏览器"而独占；别的远端端点仍应看它是否按参数寻址（这里没给工具面 ⇒ 保守默认）。
    const generic = deriveConcurrencyPolicy({ config: { name: 'p', transport: 'streamable-http', url: 'https://x/mcp' } })
    expect(generic.mode).toBe('exclusive')
    expect(generic.reason).toContain('no per-call resource')
    // ≥2 个资源型工具才足以推断（单工具属"证据不足 ⇒ 保守默认"，另有专门用例钉住）
    const withTools = deriveConcurrencyPolicy({
      config: { name: 'p', transport: 'streamable-http', url: 'https://x/mcp' },
      tools: [tool('execute', { filePath: {} }), tool('browser', { filePath: {}, action: {} })],
    })
    expect(withTools).toMatchObject({ mode: 'per-resource', resourceArg: 'filePath' })
  })

  it('★ pencil 式服务提供者（每个带参工具都要 filePath）⇒ per-resource(filePath)', () => {
    const decision = deriveConcurrencyPolicy({
      config: stdio('/Applications/Pen.app/…/mcp-server-darwin-arm64', ['--agent', 'corum']),
      tools: [tool('execute', { filePath: {}, input: {} }), tool('browser', { filePath: {}, action: {} }), tool('get_app_state')],
    })
    expect(decision.mode).toBe('per-resource')
    expect(decision.resourceArg).toBe('filePath')
    expect(decision.reason).toContain('filePath')
  })

  it('★ Pencil 真实形态：资源型工具 + 元数据工具混排 ⇒ 仍判 per-resource(filePath)', () => {
    // 实机教训：原规则要求「每个带参工具都必须有该键」⇒ Pencil 被判 exclusive（错）。
    const decision = deriveConcurrencyPolicy({
      config: stdio('/Applications/Pen.app/…/mcp-server-darwin-arm64', ['--app', 'desktop', '--agent', 'corum']),
      tools: [
        tool('execute', { filePath: {}, input: {}, editId: {}, edits: {} }),
        tool('browser', { filePath: {}, action: {}, nodeId: {}, querySelector: {}, target: {}, url: {} }),
        tool('get_style', { name: {}, params: {} }),   // 元数据
        tool('read_skill', { path: {} }),               // 自带 skill
        tool('get_app_state'),                          // 无参
      ],
    })
    expect(decision.mode).toBe('per-resource')
    expect(decision.resourceArg).toBe('filePath')
  })

  it('★ 只有一个工具带该键（覆盖 <2）⇒ 说明不了寻址方式 ⇒ 保守默认', () => {
    const decision = deriveConcurrencyPolicy({
      config: stdio('/bin/other-mcp'),
      tools: [tool('a', { filePath: {} }), tool('b', { query: {} }), tool('c', { q: {} })],
    })
    expect(decision.mode).toBe('exclusive')
    expect(decision.reason).toContain('no per-call resource')
  })

  it('覆盖不足一半（3 个带参工具里只有 1 个有 filePath、1 个有 pageId…）⇒ 保守默认', () => {
    const decision = deriveConcurrencyPolicy({
      config: stdio('/bin/mixed-mcp'),
      tools: [tool('a', { filePath: {} }), tool('b', { q: {} }), tool('c', {}), tool('d', {})],
    })
    expect(decision.mode).toBe('exclusive')
  })

  it('★ 显式配置优先：exclusive 覆盖推导；shared 也只在显式时出现', () => {
    const tools = [tool('execute', { filePath: {} })]
    expect(deriveConcurrencyPolicy({ config: { ...stdio('/bin/x'), concurrency: { mode: 'exclusive' } }, tools }))
      .toMatchObject({ mode: 'exclusive', reason: 'explicit' })
    expect(deriveConcurrencyPolicy({ config: { ...stdio('/bin/x'), concurrency: { mode: 'shared' } }, tools }))
      .toMatchObject({ mode: 'shared', reason: 'explicit' })
    expect(deriveConcurrencyPolicy({ config: { ...stdio('/bin/x'), concurrency: { mode: 'per-resource', resourceArg: 'doc' } }, tools }))
      .toMatchObject({ mode: 'per-resource', resourceArg: 'doc', reason: 'explicit' })
  })

  it('裸 server（无工具面信息、无特征参数）⇒ 保守默认独占', () => {
    expect(deriveConcurrencyPolicy({ config: stdio('/bin/plain-mcp') })).toMatchObject({ mode: 'exclusive' })
    expect(deriveConcurrencyPolicy({ config: undefined })).toMatchObject({ mode: 'exclusive' })
  })
})

describe('纯函数：资源参数提取与共同参数识别', () => {
  it('sharedResourceArgOf：候选优先级与"无带参工具"', () => {
    expect(sharedResourceArgOf([])).toBeUndefined()
    expect(sharedResourceArgOf([tool('a')])).toBeUndefined()
    // filePath 优先于 pageId
    expect(sharedResourceArgOf([tool('a', { filePath: {}, pageId: {} }), tool('b', { filePath: {}, pageId: {} })])).toBe('filePath')
    expect(sharedResourceArgOf([tool('a', { pageId: {} }), tool('b', { pageId: {} })])).toBe('pageId')
  })

  it('resourceValueOf：字符串/数字可用；空串、缺失、非标量 ⇒ undefined（= 整机键）', () => {
    expect(resourceValueOf({ filePath: '/a/b.pen' }, 'filePath')).toBe('/a/b.pen')
    expect(resourceValueOf({ pageId: 3 }, 'pageId')).toBe('3')
    expect(resourceValueOf({ filePath: '   ' }, 'filePath')).toBeUndefined()
    expect(resourceValueOf({ filePath: { nested: true } }, 'filePath')).toBeUndefined()
    expect(resourceValueOf({}, 'filePath')).toBeUndefined()
    expect(resourceValueOf({ filePath: 'x' }, undefined)).toBeUndefined()
    expect(resourceValueOf(null, 'filePath')).toBeUndefined()
  })
})

describe('容量（访问上限）计算：非独占则可同时访问、只限个数', () => {
  it('★ exclusive=1；parallel 缺省不限、可配 N；per-resource 缺省 1/桶、可配 N/桶；0=不限', () => {
    expect(concurrencyLimitOf({ mode: 'exclusive' })).toBe(1)
    expect(concurrencyLimitOf({ mode: 'parallel' })).toBe(Number.POSITIVE_INFINITY)
    expect(concurrencyLimitOf({ mode: 'parallel', maxConcurrent: 3 })).toBe(3)
    expect(concurrencyLimitOf({ mode: 'parallel', maxConcurrent: 0 })).toBe(Number.POSITIVE_INFINITY)
    expect(concurrencyLimitOf({ mode: 'per-resource', resourceArg: 'filePath' })).toBe(1)
    expect(concurrencyLimitOf({ mode: 'per-resource', resourceArg: 'filePath', maxConcurrent: 2 })).toBe(2)
    expect(concurrencyLimitOf({ mode: 'shared' })).toBe(Number.POSITIVE_INFINITY)
  })

  it('★ 显式 parallel + 上限 会原样带进推导产物', () => {
    const decision = deriveConcurrencyPolicy({
      config: { name: 'p', transport: 'stdio', command: '/bin/x', concurrency: { mode: 'parallel', maxConcurrent: 4 } },
    })
    expect(decision).toMatchObject({ mode: 'parallel', maxConcurrent: 4, reason: 'explicit' })
    expect(concurrencyLimitOf(decision)).toBe(4)
  })
})
