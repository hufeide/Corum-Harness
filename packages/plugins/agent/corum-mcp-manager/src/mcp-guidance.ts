/**
 * MCP 使用指导段：把注册表里 `guidance` 变成**模型可见的提示词段**。
 *
 * ## 为什么需要（2026-09-27 用户需求，含实测依据）
 *
 * 官方 MCP 客户端只把 server 自己写的工具描述带进 schema（实测 30~70 字，例如
 * `pencil__execute` 的描述是「Use get_app_state if you don't have execute documentation」
 * ——把指导推给另一个工具）。模型因此知道"这个工具干什么"，但不知道"何时用、怎么组合、有什么坑"。
 * 用户要的正是后者：**一段简短的、贴着这套工具的上手指导**。
 *
 * ## 落在哪里
 *
 * 由 **preset 代理行**（`proxy.ts`）注入到它所在 scope 的 system prompt：代理行本来就按
 * profile 挂在 preset scope 上 ⇒ 粒度天然是「这个 profile 授权了这个 server」✓；而且
 * 保存 profile 触发的重挂会重新注入 ⇒ **改指导立即生效**（与工具面同一条路径）。
 *
 * @module @corum/corum-mcp-manager/mcp-guidance
 */

/** 段名前缀（每 server 一段，避免互相覆盖：`corum:mcp-guidance:<serverName>`）。 */
export const MCP_GUIDANCE_SECTION_PREFIX = 'corum:mcp-guidance'

/** 单段长度上限（防御：注册表是用户可编辑文本，过长会把提示词挤爆）。 */
export const MCP_GUIDANCE_MAX_CHARS = 4_000

/**
 * 该 server 的段名。
 * @param serverName - 服务名。
 * @returns 段名。
 */
export function mcpGuidanceSectionName(serverName: string): string {
  return `${MCP_GUIDANCE_SECTION_PREFIX}:${serverName}`
}

/**
 * 生成段文本（**纯函数**，便于单测）。
 *
 * 包装文本（标题 / 接入说明 / 截断提示）**一律英文** —— 模型可见提示词的语言纪律（用户 2026-09-10
 * 定调「提示词都以英文编写」，守卫 `prompt-language.spec.ts`）；本文件此前漏在守卫覆盖之外，
 * 2026-09-27 扫出并修 **同时补了本包门禁**（`tests/guidance-language.spec.ts`）。
 *
 * 正文原样引用 `guidance`：指导文本由用户/服务作者撰写，我们不重写、不翻译（改写会把具体命令与
 * 参数名弄错）—— 故若 `guidance` 本身是中文，正文仍保持原样，那是内容而非包装。
 *
 * @param serverName - 服务名。
 * @param guidance - 注册表里的指导文本。
 * @returns 段文本；`guidance` 为空 ⇒ 返回空串（调用方据此**不注入**该段）。
 */
export function mcpGuidanceSectionText(serverName: string, guidance: string | undefined): string {
  const body = (guidance ?? '').trim()
  if (body === '') return ''
  const clipped = body.length > MCP_GUIDANCE_MAX_CHARS
    ? `${body.slice(0, MCP_GUIDANCE_MAX_CHARS)}\n… (guidance truncated — it is too long to include in full)`
    : body
  return [
    `## MCP tool usage: ${serverName}`,
    '',
    `This session has the MCP server \`${serverName}\` connected (its tool names look like \`mcp__${serverName}__<tool>\`).`,
    'How to use it:',
    '',
    clipped,
  ].join('\n')
}
