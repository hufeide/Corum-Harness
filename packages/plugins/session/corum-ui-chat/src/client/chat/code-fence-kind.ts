/**
 * fork（corum）：围栏代码卡的**分档判据**（纯函数，无 React / 无 cordis / 无 CSS）。
 *
 * 独立成模块的原因有两条：
 *   ① **可测**：判据是产品行为的分界（决定「在终端运行」出不出现），必须有断言钉住；
 *      若留在 `CodeCard.tsx` 里，单测一导入就会连带拉进 CSS module 而无法运行
 *      （与 `file-tool-card.ts` / `edit-not-found.ts` 抽出纯函数的同款纪律）。
 *   ② **单一事实源**：分档规则只在这里一处，避免渲染处再散落一份语言名单。
 *
 * @module @corum/corum-ui-chat/chat/code-fence-kind
 */

/**
 * 脚本类围栏语言 —— 命中即视为「**给用户去跑的脚本**」而非「给人读的代码」。
 *
 * **判据为什么取语言名**：markdown 里「这段是脚本」这一意图**没有别的表达方式**；
 * 围栏的 info string 是模型自己写的、唯一稳定可得的信号。
 *
 * **产品语义（2026-09-15 用户定调）**：脚本片段才出现「**在终端运行**」，
 * 典型场景是**受沙箱限制 Agent 无法自行执行**（例如需要写工作区外的路径），
 * 于是把命令交给用户去跑；代码片段是给人读的，**不该**有执行入口。
 */
const SCRIPT_FENCE_LANGS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'shell', 'zsh', 'fish', 'ksh', 'console', 'powershell', 'ps1', 'cmd', 'bat', 'dos',
])

/**
 * 该围栏是否属于「脚本片段」（决定是否出现「在终端运行」）。
 *
 * **判据是精确匹配、不是前缀/子串**：`bashrc` / `shell-note` 这类名字不该命中 ——
 * 无法确定时**宁可少给入口**（误给一个跑不了的执行按钮，比不给更糟）。
 * @param lang - 围栏 info string（可为 undefined / 空串）。
 * @returns 命中脚本类语言为 `true`。
 */
export function isScriptFence(lang: string | undefined): boolean {
  if (lang === undefined) return false
  return SCRIPT_FENCE_LANGS.has(lang.trim().toLowerCase())
}
