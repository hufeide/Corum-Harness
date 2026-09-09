/**
 * fork（corum）P2-4（.dbg/event-bus-audit-2026-09.md）：Remote 转发机制的运行时守护。
 *
 * 前 5 例**逐字移植官方** `@deepseek-ai/dsh-api-remotes/tests/remote-events.host.spec.ts`
 * （232 行；fork 的 index.ts/types.ts 与官方逐字节一致，故断言同样成立）——守住
 * 「allowlist 队列 / 非 JSON 拒收 / waterfall 三段式 / source 撤回」四条机制语义。
 *
 * 后 3 例是 corum 增量：**逐条 allowlist 的 corum 事件都要真能转发到 renderer**
 * （此前只有编译期声明、无运行时守护——漏加 allowlist 时 renderer 永远收不到，
 * 且没有任何测试会红）。
 */
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type {
  RemoteEventHostInfo,
  TypertRemoteEventInvocation,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/index.ts'
import { API_REMOTE_FORWARDED_EVENTS } from '../src/remote-events.ts'

interface GatewayProbe {
  source: TypertRemoteEventSource | undefined
  host: RemoteEventHostInfo | undefined
  removals: number
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>
}

async function setup(): Promise<{
  readonly ctx: Context
  readonly gateway: GatewayProbe
  readonly fiber: Fiber
}> {
  const ctx = new Context()
  const gateway: GatewayProbe = {
    source: undefined,
    host: undefined,
    removals: 0,
    registerRemoteEvents(source, host) {
      gateway.source = source
      gateway.host = host
      return async () => {
        if (gateway.source !== source) return
        gateway.source = undefined
        gateway.host = undefined
        gateway.removals += 1
      }
    },
  }
  ctx.reflect.provide('typertGateway', gateway)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return { ctx, gateway, fiber }
}

function sourceOf(gateway: GatewayProbe): TypertRemoteEventSource {
  if (gateway.source === undefined) throw new Error('fixture Gateway has no Remote event source')
  return gateway.source
}

function emitRaw(ctx: Context, event: string, args: readonly unknown[]): void {
  const emit = ctx.emit.bind(ctx) as unknown as (name: string, ...values: readonly unknown[]) => void
  emit(event, ...args)
}

function waterfallRaw(
  ctx: Context,
  target: object,
  event: string,
  args: readonly unknown[],
  next: () => Promise<unknown>,
): Promise<unknown> {
  const waterfall = ctx.waterfall.bind(ctx) as unknown as (
    receiver: object,
    name: string,
    ...values: readonly unknown[]
  ) => Promise<unknown>
  return waterfall(target, event, ...args, next)
}

function invocationOf(value: unknown): TypertRemoteEventInvocation {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'context')) {
    throw new Error('fixture did not receive a scoped Remote Event invocation')
  }
  return value as TypertRemoteEventInvocation
}

describe('Remote event Host source', () => {
  it('registers the Host home used by Client connection generations', async () => {
    const { gateway, fiber } = await setup()
    expect(gateway.host?.home).toBeTypeOf('string')
    expect(gateway.host?.home.length).toBeGreaterThan(0)
    await fiber.dispose()
    expect(gateway.host).toBeUndefined()
  })

  it('gives each Client stream an independent allowlisted event queue', async () => {
    const { ctx, gateway, fiber } = await setup()
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = sourceOf(gateway)(firstAbort.signal)[Symbol.asyncIterator]()
    const second = sourceOf(gateway)(secondAbort.signal)[Symbol.asyncIterator]()

    emitRaw(ctx, 'settings/document-updated', ['ui-theme', 1])
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 1] },
    })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 1] },
    })

    const firstDone = first.next()
    firstAbort.abort(new Error('first Client disconnected'))
    emitRaw(ctx, 'commands/change', [])
    await expect(firstDone).resolves.toEqual({ done: true, value: undefined })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'commands/change', args: [] },
    })

    const secondDone = second.next()
    secondAbort.abort(new Error('second Client disconnected'))
    await expect(secondDone).resolves.toEqual({ done: true, value: undefined })

    await fiber.dispose()
    expect(gateway.source).toBeUndefined()
    expect(gateway.removals).toBe(1)
    await ctx.fiber.dispose()
  })

  it('rejects a non-JSON argument without poisoning the stream', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()

    expect(() => {
      emitRaw(ctx, 'settings/document-updated', ['ui-theme', 1n])
    }).toThrow('argument 1 is not lossless JSON data')
    emitRaw(ctx, 'settings/document-updated', ['ui-theme', 2])
    await expect(pending).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 2] },
    })

    const done = iterator.next()
    abort.abort()
    await expect(done).resolves.toEqual({ done: true, value: undefined })

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(sourceOf(gateway)(alreadyAborted.signal)[Symbol.asyncIterator]().next())
      .resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('bridges scoped waterfall result, next delegation, and rejection', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { ctx: agentCtx }
    const target = scopeTarget(ctx, agent)
    const request = { questions: [], agent }

    const claimed = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const claimedDispatch = invocationOf((await iterator.next()).value)
    expect(claimedDispatch).toMatchObject({
      event: 'user-questions/request',
      request,
      context: { value: agentCtx, subject: agent },
    })
    claimedDispatch.resolve({ kind: 'result', value: 'client answer' })
    await expect(claimed).resolves.toBe('client answer')

    const delegated = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const delegatedDispatch = invocationOf((await iterator.next()).value)
    delegatedDispatch.resolve({ kind: 'next' })
    await expect(delegated).resolves.toBe('host fallback')

    const rejection = Object.assign(new Error('the user cancelled ask_user_question'), {
      code: 'ASK_CANCELLED',
    })
    const rejected = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const rejectedAssertion = expect(rejected).rejects.toBe(rejection)
    const rejectedDispatch = invocationOf((await iterator.next()).value)
    rejectedDispatch.reject(rejection)
    await rejectedAssertion

    const done = iterator.next()
    abort.abort()
    await expect(done).resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('rejects a queued scoped waterfall when its source is withdrawn', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const delivery = iterator.next()
    const agent = { ctx: ctx.extend() }
    const reason = new Error('forwarded event source removed')
    const pending = waterfallRaw(
      ctx,
      scopeTarget(ctx, agent),
      'user-questions/request',
      [{ questions: [], agent }],
      () => Promise.resolve('host fallback'),
    )
    const rejected = expect(pending).rejects.toBe(reason)

    abort.abort(reason)

    await rejected
    await expect(delivery).resolves.toEqual({ done: true, value: undefined })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})

describe('corum 事件转发（P2-4 运行时守护）', () => {
  /** allowlist 里的 corum 事件名（P2-9 脚本亦会核对声明↔转发双向一致）。 */
  const CORUM_EVENTS = API_REMOTE_FORWARDED_EVENTS
    .map(entry => entry.event)
    .filter(event => event.startsWith('corum/'))

  it('allowlist 含全部 19 个 corum 事件（新增事件必须同步登记）', () => {
    expect(CORUM_EVENTS.length).toBe(19)
    expect(new Set(CORUM_EVENTS).size).toBe(CORUM_EVENTS.length)
  })

  it('逐条 corum 事件都能转发到 Client 队列', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()

    for (const event of CORUM_EVENTS) {
      const pending = iterator.next()
      // 载荷形状由 cordis Events 声明在编译期守护（emitRaw 走 unknown 断言）；
      // 本用例只守「allowlist 是否真的把该事件转发出去」。
      emitRaw(ctx, event, [{ probe: true }])
      await expect(pending).resolves.toEqual({
        done: false,
        value: { event, args: [{ probe: true }] },
      })
    }

    abort.abort()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('未登记的事件不转发（不污染队列）', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()

    emitRaw(ctx, 'corum/not-a-real-event', [{ probe: 'dropped' }])
    const pending = iterator.next()
    emitRaw(ctx, 'corum/task/assigned', [{ probe: 'forwarded' }])
    await expect(pending).resolves.toEqual({
      done: false,
      value: { event: 'corum/task/assigned', args: [{ probe: 'forwarded' }] },
    })

    abort.abort()
    await ctx.fiber.dispose()
  })

  it('corum 事件的非 JSON 载荷被拒且不毒化流', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()

    expect(() => {
      emitRaw(ctx, 'corum/task/assigned', [{ probe: 1n }])
    }).toThrow('argument 0 is not lossless JSON data')
    const pending = iterator.next()
    emitRaw(ctx, 'corum/task/assigned', [{ probe: 'ok' }])
    await expect(pending).resolves.toEqual({
      done: false,
      value: { event: 'corum/task/assigned', args: [{ probe: 'ok' }] },
    })

    abort.abort()
    await ctx.fiber.dispose()
  })
})
