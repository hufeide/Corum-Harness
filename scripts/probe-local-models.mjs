#!/usr/bin/env node
// 本地模型网关探针：确认「配置里写的模型」真的可用、且 reasoning effort 被接受。
//
// 用途：委派之前/之后核对实际生效的模型路由（改了 agent-default-model 或 profile 锁之后
// 尤其需要）。任何模型探测失败时退出码为 1，可直接当验收断言用。
//
// 用法：
//   node scripts/probe-local-models.mjs
//   node scripts/probe-local-models.mjs --base http://127.0.0.1:8899/v1
//   node scripts/probe-local-models.mjs --models kimi-k3-1,glm-5.2 --effort high
// 环境变量：LOCALHOST_API_KEY（缺省 dummy，本地网关通常不校验）
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const BASE = String(flag('base', process.env.LOCAL_MODEL_BASE ?? 'http://127.0.0.1:8899/v1'))
const EFFORT = String(flag('effort', 'high'))
const MODELS = String(flag('models', 'kimi-k3-1,glm-5.2,deepseek-v4.1-flash'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

async function probe(model) {
  const started = Date.now()
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (process.env.LOCALHOST_API_KEY || 'dummy') },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        reasoning_effort: EFFORT,
        max_tokens: 2048,
        stream: false,
      }),
      signal: AbortSignal.timeout(180000),
    })
    const text = await res.text()
    const ms = Date.now() - started
    if (!res.ok) return { model, ok: false, status: res.status, ms, body: text.slice(0, 300) }
    let j
    try {
      j = JSON.parse(text)
    } catch {
      return { model, ok: false, status: res.status, ms, body: text.slice(0, 300) }
    }
    const msg = j.choices?.[0]?.message ?? {}
    return {
      model,
      ok: true,
      status: res.status,
      ms,
      content: (msg.content ?? '').trim().slice(0, 120),
      reasoningChars: (msg.reasoning_content ?? msg.reasoning ?? '').length,
      usage: j.usage ?? null,
    }
  } catch (e) {
    return { model, ok: false, ms: Date.now() - started, error: String((e && e.message) || e) }
  }
}

const results = await Promise.all(MODELS.map(probe))
for (const r of results) console.log(JSON.stringify(r))
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length}/${results.length} 可用（base=${BASE} effort=${EFFORT}）`)
process.exit(bad.length ? 1 : 0)
