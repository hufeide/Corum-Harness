/**
 * AgentProfile 持久化：读写 `~/.corum/.agent-presets/<id>/agent.json`。
 *
 * 每个 Agent 是一个独立目录（`<preset-root>/<id>/`），包含：
 *   agent.json          — AgentProfile 描述文件（标准 Agent 描述）
 *   agent.cordis.yml     — 编译后的 Cordis 组合（由 compilePreset 生成）
 *   preset.yml           — preset 元数据
 *
 * Skill 采用引用绑定：agent.json 只记录 skill name 列表，不复制文件。
 * Skill 全局统一管理在 ~/.dsh/skills/，Agent mount 时 skill-filesystem
 * 从该目录发现 skill。
 *
 * 兼容旧路径：`~/.corum/agent-profiles/<id>.json` 会被自动迁移。
 * @module @corum/corum-agent/profile-store
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { AgentProfile } from './profile.ts'
import { isValidProfileId } from './profile.ts'

/** Agent 目录的存储根（= agent-presets user root）。 */
function agentsRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), '.agent-presets')
}

/** 一个 Agent 的目录路径。 */
function agentDir(id: string): string {
  if (!isValidProfileId(id)) throw new Error(`dev-agent: invalid profile id "${id}"`)
  return join(agentsRoot(), id)
}

/** agent.json 的路径。 */
function agentJsonPath(id: string): string {
  return join(agentDir(id), 'agent.json')
}

/** 旧路径（flat JSON，用于自动迁移）。 */
function legacyProfilePath(id: string): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  const legacyRoot = join(resolveDshHome(configured), 'agent-profiles')
  return join(legacyRoot, `${id}.json`)
}

/**
 * 读取一个 Agent 的描述文件（agent.json）。
 * 自动从旧路径迁移：若 agent.json 不存在但旧 JSON 存在，迁移之。
 */
export function loadProfile(id: string): AgentProfile | undefined {
  const path = agentJsonPath(id)
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as AgentProfile
    } catch {
      return undefined
    }
  }
  // 旧路径迁移
  const legacy = legacyProfilePath(id)
  if (existsSync(legacy)) {
    try {
      const profile = JSON.parse(readFileSync(legacy, 'utf8')) as AgentProfile
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(profile, null, 2))
      return profile
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 列出所有 Agent（扫描 agent-presets 目录下有 agent.json 的子目录）。 */
export function listProfiles(): AgentProfile[] {
  const root = agentsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(d.name))
    .map(d => loadProfile(d.name))
    .filter((p): p is AgentProfile => p !== undefined)
}

/**
 * 写入 Agent 描述文件（agent.json）。
 * 只写描述文件，不编译 preset（编译由 agent-service 的 writeAgentDir 负责）。
 */
export function saveProfile(profile: AgentProfile): void {
  const path = agentJsonPath(profile.id)
  mkdirSync(dirname(path), { recursive: true })
  const current = loadProfile(profile.id)
  const next: AgentProfile = {
    ...profile,
    version: (current?.version ?? 0) + 1,
    trust: profile.trust ?? 'user',
  }
  writeFileSync(path, JSON.stringify(next, null, 2))
}

/** 删除一个 Agent 的整个目录。 */
export function deleteProfile(id: string): void {
  const dir = agentDir(id)
  rmSync(dir, { recursive: true, force: true })
}

/** 获取一个 Agent 的目录绝对路径（供 compile/service 层使用）。 */
export function agentDirPath(id: string): string {
  return agentDir(id)
}

/* ── 官方基础模式覆盖（official overrides）────────────────────────────
 * 官方 preset（standard/ptc/minimal/cordis）本体只读，但允许用户覆盖
 * 「模型 / 子 Agent 模型 / 技能 / MCP」四项。覆盖存于
 * `.agent-presets/_official-overrides.json`（不进 profile 目录，避免被
 * listProfiles 当成一个 Agent）。 */

export interface OfficialModeOverride {
  model?: AgentProfile['model']
  subagentModel?: AgentProfile['subagentModel']
  skills?: AgentProfile['skills']
  mcpServers?: string[]
}

type OfficialOverrideMap = Record<string, OfficialModeOverride>

function officialOverridesPath(): string {
  return join(agentsRoot(), '_official-overrides.json')
}

/** 读取全部官方模式覆盖（缺文件/坏 JSON 回落空表）。 */
export function loadOfficialOverrides(): OfficialOverrideMap {
  const path = officialOverridesPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as OfficialOverrideMap
  } catch {
    return {}
  }
}

/** 写入某官方模式的覆盖（四字段全空时删除该键，保持文件干净）。 */
export function saveOfficialOverride(id: string, override: OfficialModeOverride): void {
  const map = loadOfficialOverrides()
  const empty = override.model === undefined
    && override.subagentModel === undefined
    && (override.skills === undefined || override.skills.length === 0)
    && (override.mcpServers === undefined || override.mcpServers.length === 0)
  if (empty) {
    delete map[id]
  } else {
    map[id] = override
  }
  mkdirSync(agentsRoot(), { recursive: true })
  writeFileSync(officialOverridesPath(), JSON.stringify(map, null, 2))
}

/* ── AI 润色配置（polish config）────────────────────────────────────
 * 「AI 润色」用哪个已配置的 provider/model 来润色提示词，存于
 * `.agent-presets/_polish.json`（全局一份，不入任何 Agent 目录）。 */

export interface PolishConfig {
  /** 润色引擎：auto（≥16 GB 且本地可用走本地，否则线上）/ local / online。缺省 auto。 */
  engine?: 'auto' | 'local' | 'online'
  /** 本地模型名（engine=local/auto 本地分支用；缺省 qwen3.5:2b）。 */
  localModel?: string
  provider: string
  model: string
  /** 思考程度（可选；缺省走协议默认）。 */
  reasoningEffort?: string
}

function polishConfigPath(): string {
  return join(agentsRoot(), '_polish.json')
}

/** 读取润色配置（缺文件/坏 JSON 回落 undefined = 未配置）。 */
export function loadPolishConfig(): PolishConfig | undefined {
  const path = polishConfigPath()
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PolishConfig>
    if (typeof raw.provider === 'string' && typeof raw.model === 'string' && raw.provider !== '' && raw.model !== '') {
      return {
        ...(raw.engine === 'local' || raw.engine === 'online' || raw.engine === 'auto' ? { engine: raw.engine } : {}),
        ...(typeof raw.localModel === 'string' && raw.localModel !== '' ? { localModel: raw.localModel } : {}),
        provider: raw.provider,
        model: raw.model,
        ...(typeof raw.reasoningEffort === 'string' && raw.reasoningEffort !== '' ? { reasoningEffort: raw.reasoningEffort } : {}),
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 写入润色配置。 */
export function savePolishConfig(config: PolishConfig): void {
  mkdirSync(agentsRoot(), { recursive: true })
  writeFileSync(polishConfigPath(), JSON.stringify(config, null, 2))
}
