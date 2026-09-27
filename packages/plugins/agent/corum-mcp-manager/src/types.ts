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
