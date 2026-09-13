/**
 * skill-format — SKILL.md 契约的纯解析/校验助手。
 *
 * 从 skill-manager-service.ts 抽出，供三处共用：
 *   - 服务本体（导入 / 提交版本时的格式校验）
 *   - shipped-skills.ts（随包分发技能集的扫描）
 *   - scripts/check-shipped-skills.mjs（自检夹具）
 *
 * 零依赖（只用内置类型），保证可被独立脚本直接 import 编译产物。
 * @module @corum/corum-skill-manager/skill-format
 */

/** SKILL.md frontmatter 里本仓库关心的两个必填字段。 */
export interface SkillFrontmatter {
  /** skill 名（与目录名一致，官方 skill 加载器按此校验）。 */
  name: string
  /** 技能描述（模型可见的触发语，随 catalog 下发）。 */
  description: string
}

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 * 只认 `---` 之间、形如 `key: value` 的平铺字段——足够覆盖本仓库全部技能，
 * 且不引入 YAML 运行时依赖（与仓库既有实现保持一致）。
 *
 * @param content - SKILL.md 全文。
 * @returns name + description；缺 frontmatter 或缺任一字段时返回 undefined。
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch === null) return undefined
  const fm = fmMatch[1]
  const fields = new Map<string, string>()
  for (const line of fm.split('\n')) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/)
    if (m !== null) fields.set(m[1], m[2].trim())
  }
  const name = fields.get('name')
  const description = fields.get('description')
  if (name === undefined || description === undefined) return undefined
  return { name, description }
}

/**
 * 校验技能名可否作为 `<CORUM_HOME>/skills/` 下的目录名。
 * 拒绝空串、隐藏名（`.` 开头）和任何路径分隔符——防目录穿越。
 */
export function isValidSkillName(name: string): boolean {
  if (!name || name.length === 0) return false
  if (name.startsWith('.')) return false
  if (name.includes('/') || name.includes('\\')) return false
  return true
}
