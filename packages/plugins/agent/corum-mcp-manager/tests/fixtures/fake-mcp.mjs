/**
 * 假 MCP server（测试夹具）：stdio 传输，用于验证池的独占/排队/超时/重连/进程唯一性。
 *
 * 用具名工具而不是 mock 模块，理由：**被验证对象是"真进程上的真协议"** —— 连接、
 * 进程 pid、崩溃重连这些必须在真进程边界上测，否则测的只是我们自己写的假接口。
 *
 * 工具：
 *   · echo({ text })  → { pid, text, calls }
 *   · slow({ delayMs }) → 阻塞 delayMs，返回 { pid, startedAt, endedAt, maxConcurrent }
 *   · stats()          → { pid, calls, maxConcurrent, active }
 *   · crash()          → 先正常返回，再 50ms 后 exit(1)（用于"下一次调用应重连"）
 *   · 超长名工具（>64 字符）→ 供命名规则对照
 *
 * 并发计数在**服务端**统计（`maxConcurrent`）：独占租约若失效，这个数字会大于 1。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const LONG_NAME = `long_${'x'.repeat(80)}`

let calls = 0
let active = 0
let maxConcurrent = 0

const server = new Server({ name: 'fake-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'slow', description: 'sleep', inputSchema: { type: 'object', properties: { delayMs: { type: 'number' } } } },
    { name: 'stats', description: 'server stats', inputSchema: { type: 'object' } },
    { name: 'crash', description: 'die after replying', inputSchema: { type: 'object' } },
    { name: LONG_NAME, description: 'tool with a very long name', inputSchema: { type: 'object' } },
  ],
}))

/** 所有结果都用 JSON 文本包一层，测试侧统一 JSON.parse。 */
function reply(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name
  const args = request.params.arguments ?? {}
  calls += 1
  active += 1
  maxConcurrent = Math.max(maxConcurrent, active)
  const startedAt = Date.now()
  try {
    if (name === 'echo') return reply({ pid: process.pid, text: args.text ?? '', calls, startedAt })
    if (name === 'slow') {
      await new Promise(resolve => setTimeout(resolve, Number(args.delayMs ?? 0)))
      return reply({ pid: process.pid, startedAt, endedAt: Date.now(), maxConcurrent })
    }
    if (name === 'stats') return reply({ pid: process.pid, calls, active, maxConcurrent })
    if (name === 'crash') {
      setTimeout(() => process.exit(1), 50)
      return reply({ pid: process.pid, dying: true })
    }
    if (name === LONG_NAME) return reply({ pid: process.pid, long: true })
    return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
  } finally {
    active -= 1
  }
})

await server.connect(new StdioServerTransport())
