/**
 * 视觉能力运行时段（corum）。
 *
 * 背景：普通会话下用户切换到**带视觉的模型**后，模型自身并不知道「此刻我能收图」——
 * 部署默认模型是纯文本时尤其明显，用户发图前模型没有任何「可以看图」的自我认知，
 * 容易在用户说「看这张图」时先要求文字描述。
 *
 * 机制：本段由 `CorumAgentService` 在**模型选择变更时**按目标模型能力动态挂载/撤销
 * （`inputModalities` 显式含 `image` → 挂载；不含或未知 → 撤销）。
 *
 * 写作纪律（docs/PROMPT-INVENTORY.md §1）：只讲**能力事实与行为倾向**，不重复工具机制
 * （读图走什么工具由各 preset 的工具段负责，此处不点名，避免与实际挂载工具相悖）。
 */

/** 视觉能力段的段名（Agent scope 注册键，可幂等撤销）。 */
export const VISION_SECTION = 'corum:vision'

/**
 * 视觉能力段文本（模型可见 → 必须英文，由 tests/prompt-language.spec.ts 强制）。
 *
 * 三条事实：① 我现在能收图；② 图会随消息到达，不需要用户先转述；③ 看不到图时明说而不是猜。
 */
export const VISION_CAPABILITY = [
  'You can see images in this conversation. The current model accepts image input.',
  '',
  'When the user attaches or references an image, read it directly instead of asking them to describe it in words.',
  'Describe what is actually in the image, and ground your answer in visible details rather than assumptions.',
  'If an image genuinely does not reach you, say so plainly — never guess at its contents.',
].join('\n')
