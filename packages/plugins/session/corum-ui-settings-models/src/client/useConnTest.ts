/**
 * 连通性测试：走 `llm/discoverModels`（官方为此设计——一次性 apiKey 不过夜、
 * AbortSignal 可取消、稳定错误码 model-discovery-failed）。返回延迟毫秒数。
 *
 * 注意（侦察报告 §3 的 caveat）：已登记 catalog 路由会短路不发网络请求、
 * 非 OpenAI 兼容协议不可探测。对这类路由，结果标注「内置目录，未发网络请求」。
 */

import { useState } from 'react'
import type { ModelsWire } from './store.ts'
import { messageOf } from './store.ts'
import { isNoDiscoveryError } from './catalog-fallback.ts'

export type ConnTestResult =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; ms: number; count: number }
  | { kind: 'catalog'; count: number }
  | { kind: 'error'; message: string }

export interface ConnTestArgs {
  settingsNs: string
  baseURL?: string | undefined
  apiKey?: string | undefined
  api?: string | undefined
  provider?: string | undefined
}

export function useConnTest(api: ModelsWire): {
  result: ConnTestResult
  run: (args: ConnTestArgs) => Promise<void>
  reset: () => void
} {
  const [result, setResult] = useState<ConnTestResult>({ kind: 'idle' })

  const run: (args: ConnTestArgs) => Promise<void> = async (args) => {
    setResult({ kind: 'busy' })
    const started = Date.now()
    try {
      const request: Record<string, unknown> = {}
      if (args.baseURL !== undefined && args.baseURL !== '') request.baseURL = args.baseURL
      if (args.apiKey !== undefined && args.apiKey !== '') request.apiKey = args.apiKey
      if (args.api !== undefined && args.api !== '') request.api = args.api
      if (args.provider !== undefined && args.provider !== '') request.provider = args.provider
      const response = await api.llm.discoverModels(
        args.settingsNs,
        request as unknown as Parameters<ModelsWire['llm']['discoverModels']>[1],
      )
      const ms = Date.now() - started
      if (!response.ok) {
        // catalog 目录路由（如 llm-deepseek）：discoverModels 不注册网络发现，
        // 返回「no model discovery is registered」——转成内置目录友好结果（非错误）。
        if (isNoDiscoveryError(response.error.message)) {
          // 从该 namespace 的 settings 读模型目录计数（catalog 路由的模型在 profile.models）。
          setResult({ kind: 'catalog', count: -1 })
          return
        }
        setResult({ kind: 'error', message: response.error.message })
        return
      }
      setResult({ kind: 'ok', ms, count: response.value.length })
    } catch (error) {
      setResult({ kind: 'error', message: messageOf(error) })
    }
  }

  const reset = (): void => { setResult({ kind: 'idle' }) }
  return { result, run, reset }
}
