/**
 * MCP 服务管理数据模型。
 *
 * 全局注册表存储在 ~/.corum/mcp-servers.json，
 * AgentProfile 通过 mcpServers: string[] 引用授权的服务名。
 * @module @corum/corum-mcp-manager/types
 */

/** stdio 传输的 MCP 服务配置。 */
export interface McpStdioServer {
  /** 唯一服务名（Agent 授权引用此名）。 */
  name: string
  /** 显示名。 */
  description?: string
  transport: 'stdio'
  /** 可执行命令。 */
  command: string
  /** 命令参数。 */
  args?: string[]
  /** 环境变量。 */
  env?: Record<string, string>
  /** 工作目录。 */
  cwd?: string
  /** 工具调用超时（ms）。 */
  toolCallTimeoutMs?: number
  /** 停用后不再编译进 preset、不自动探测连接。 */
  disabled?: boolean
  /**
   * **写给模型的使用指导**（2026-09-27 用户需求：「给一个 MCP 工具简单的使用指导，让 LLM 能够快速上手」）。
   *
   * 与 `description`（给人看的服务简介）不同：这段会进**提示词**，只对该服务被授权的 profile 生效。
   * 官方 schema 只给每个工具 30~70 字的"干什么"（实测 `pencil__execute` 的描述甚至是
   * "Use get_app_state if you don't have execute documentation"——把指导推给另一个工具），
   * 缺的正是"何时用 / 怎么组合 / 有什么坑"。
   *
   * 建议写法（短才好用，建议 ≤ 1200 字）：① 一句话用途；② 典型调用顺序（先读什么再写什么）；
   * ③ 坑（例如"同一文档不能被两个 Agent 同时改"）；④ 若该服务自带 skill 工具（如 Pencil 的
   * `read_skill`），在这里点名"先读它"。
   */
  guidance?: string
  /**
   * 独占/复用策略；**不写则自动推导**（见 {@link McpConcurrencyPolicy} 与 `concurrency.ts`）。
   * 想强制现状（整机独占）就写 `{ mode: 'exclusive' }`。
   */
  concurrency?: McpConcurrencyPolicy
}

/** streamable-http 传输的 MCP 服务配置。 */
export interface McpHttpServer {
  /** 唯一服务名。 */
  name: string
  /** 显示名。 */
  description?: string
  transport: 'streamable-http'
  /** MCP 端点 URL。 */
  url: string
  /** 请求头。 */
  headers?: Record<string, string>
  /** 工具调用超时（ms）。 */
  toolCallTimeoutMs?: number
  /** 停用后不再编译进 preset、不自动探测连接。 */
  disabled?: boolean
  /** 写给模型的使用指导；语义与 stdio 变体一致（见 {@link McpStdioServer.guidance}）。 */
  guidance?: string
  /** 独占/复用策略；语义与 stdio 变体一致（见 {@link McpStdioServer.concurrency}）。 */
  concurrency?: McpConcurrencyPolicy
}

/**
 * 独占/复用策略（2026-09-27 用户口径：「**可复用的则不独占**」）。
 *
 * 判据不是 server 类型，而是**目标资源是配置时定死、还是调用时传入**：
 *   · 服务提供者按参数寻址（pencil 的 `execute{filePath}`）⇒ `per-resource`：不同文档并发、同一文档串行；
 *   · 绑定到**已存在**的固定实例（CDP `--browser-url=http://127.0.0.1:9333` ⇒ 就那一台）⇒ `exclusive`；
 *   · server **自持**目标（CDP 自己拉起浏览器 / `--isolated`）⇒ 可按 `pageId` 路由 ⇒ `per-resource('pageId')`。
 *
 * 缺省（不写本字段）⇒ **自动推导**，见 `concurrency.ts` 的 {@link deriveConcurrencyPolicy}。
 */
export interface McpConcurrencyPolicy {
  /**
   * · `exclusive` —— 整机一个：同一时刻只允许一个调用（上限恒为 1）。
   * · `per-resource` —— 按资源参数分桶，**每桶**上限 `maxConcurrent`（缺省 1/桶）：不同文档/page 并行、同一个串行。
   * · `parallel` —— 不分桶，整机可并发，上限 `maxConcurrent`（缺省不限）：用户口径「大家都可以同时访问，只是可以设置一个访问上限」。
   * · `shared` —— 与 `parallel` 无上限同义（保留为显式逃生口：完全不仲裁，省掉记账）。
   */
  mode: 'exclusive' | 'per-resource' | 'parallel' | 'shared'
  /** `per-resource` 时，从调用参数里取资源值的键名（如 `filePath` / `pageId`）。 */
  resourceArg?: string
  /** 并发上限（信号量容量）。缺省：exclusive=1、per-resource=1/桶、parallel=不限；`0` = 不限。 */
  maxConcurrent?: number
}

/** MCP 服务配置（判别联合）。 */
export type McpServerConfig = McpStdioServer | McpHttpServer

/** UI 投影的 MCP 服务摘要。 */
export interface McpServerSummary {
  name: string
  description?: string
  transport: 'stdio' | 'streamable-http'
  /** 连接目标（command 或 url）。 */
  endpoint: string
  /** 已停用（不编译进 preset、不自动探测）。 */
  disabled?: boolean
}

/** 添加/更新 MCP 服务的 RPC 入参。 */
export type SaveMcpServerInput = McpServerConfig

/** 握手探测发现的工具摘要。 */
export interface McpToolSummary {
  name: string
  description?: string
}

/** testConnection 探测结果。 */
export type TestConnectionResult =
  | { ok: true; tools: McpToolSummary[] }
  | { ok: false; error: string }

/** 校验服务名（防路径逃逸，与 serverName 命名规则一致）。 */
export function isValidMcpServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(name)
}
