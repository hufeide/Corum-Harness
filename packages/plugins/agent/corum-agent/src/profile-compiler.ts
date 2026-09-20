/**
 * fork（corum）：**Profile 编译与落盘**——从 `agent-service.ts` 按关注点抽出（2026-09-20）。
 *
 * ## 为什么独立成文件
 *
 * 用户 2026-09-20 定调：「整个 `agent-service` 混入了太多业务能力……各个模块**至少要在文件
 * 层面切分清晰**，方便维护。」
 *
 * 本模块只回答一个问题：**一个 `AgentProfile` 怎么变成磁盘上的 preset 产物**
 * （`agent.cordis.yml` + `preset.yml` + pinned skill 版本）。它不碰会话、权限、指挥模式、
 * 泳道编排 —— 是「编译与落盘」这一条窄职责。
 *
 * ## 谁在消费
 *
 * - `agent-service` 的 `persistProfileAndRecompile`（保存 profile 的统一收尾）；
 * - 若干路径在 select/mount 之前「先编译落盘再 select」
 *   （`agentPresets.select` 要读 `agent.cordis.yml`；从未编译的 corum profile 若先 select
 *   会抛 `agent-preset/invalid`（composition missing），见 `docs/fork-delta.md` §8 note 3）；
 * - 2026-09-20 的教训：**改 `agent.json` 后必须立刻重新编译落盘**，不能只改 json 就删产物
 *   ——「删掉派生文件等它懒重编译」是错的：官方 discovery 的判据是目录里有 `agent.cordis.yml`，
 *   缺它的目录**不被跳过**而是升成 broken roster row，于是**目录空占 id** ⇒ resume 直接
 *   fail-loud（`docs/LESSONS.md` §4.29，实测导致用户会话无法继续）。
 *
 * @module @corum/corum-agent/profile-compiler
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compilePreset } from './compile.ts'
import { corumHome } from './home.ts'
import type { AgentProfile } from './profile.ts'

/** 记日志的最小能力面（避免耦合 cordis 的完整 logger 类型）。 */
export interface ProfileCompilerLogger {
  warn: (message: string, ...rest: readonly unknown[]) => void
}

/**
 * 编译 `AgentProfile` 并落盘到 Agent 目录（写 `agent.cordis.yml` + `preset.yml`）。
 *
 * @param profile - 待编译的 profile（调用方保证已 `saveProfile` 落盘 `agent.json`）。
 * @param dir - 目标目录（通常 `agentDirPath(profile.id)`）。
 */
export function writeAgentDir(profile: AgentProfile, dir: string): void {
  mkdirSync(dir, { recursive: true })
  const compiled = compilePreset(profile)
  writeFileSync(join(dir, 'agent.cordis.yml'), compiled.cordisYml)
  writeFileSync(join(dir, 'preset.yml'), compiled.presetYml)
}

/**
 * 把绑定的 skill 切换到 pinned 版本：把 `.versions/<versionId>/SKILL.md` 复制为当前
 * `SKILL.md`。`versionId` 为空 = 用当前 `SKILL.md`（不锁定）。
 *
 * @param logger - 用于告警的能力面。
 * @param profile - 提供 `skills` 绑定列表。
 */
export function checkoutPinnedSkills(logger: ProfileCompilerLogger, profile: AgentProfile): void {
  const skillsRoot = join(corumHome(), 'skills')
  for (const binding of profile.skills) {
    const skillDir = join(skillsRoot, binding.name)
    if (!existsSync(skillDir)) {
      logger.warn(`corum-agent: skill "${binding.name}" not found in ${skillsRoot}`)
      continue
    }
    // 未锁定版本（versionId 空）→ 直接用当前 SKILL.md，跳过切换。
    if (binding.versionId === undefined || binding.versionId === '') continue
    const versionSkillMd = join(skillDir, '.versions', binding.versionId, 'SKILL.md')
    const currentSkillMd = join(skillDir, 'SKILL.md')
    if (!existsSync(versionSkillMd)) {
      // 没有版本目录，说明 skill 是手动放进去的，直接用当前 SKILL.md
      continue
    }
    try {
      const content = readFileSync(versionSkillMd, 'utf8')
      writeFileSync(currentSkillMd, content, 'utf8')
    } catch (error) {
      logger.warn(`corum-agent: failed to switch skill "${binding.name}" to version ${binding.versionId}`, error)
    }
  }
}
