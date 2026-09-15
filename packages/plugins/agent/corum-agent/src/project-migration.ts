/**
 * 项目存储迁移（「项目数据跟随项目走」Round 1，幂等可重跑）。
 *
 * 旧形态（本轮之前）：一切都在 `$CORUM_HOME/projects/<id>/` ——
 *   project.json              全量 CorumProject（含 group/workTypes/description）
 *   scheduler-events.jsonl    调度事件日志
 *
 * 新形态：
 *   $CORUM_HOME/projects/<id>/project.json   轻索引（6 字段）
 *   <cwd>/.corum/project/project.json        项目侧详字段（ProjectInfo）
 *   <cwd>/.corum/project/events.jsonl        事件日志
 *
 * 迁移步骤（每次启动跑一遍，已迁移项天然跳过）：
 *   0. 备份：cpSync 整个 projectsRoot → $CORUM_HOME/backups/projects-migration-<ts>/
 *   1. 对每个索引 project.json：详字段搬进 <cwd>/.corum/project/project.json
 *      （已存在则不覆盖——项目侧为准），索引重写为轻形（原子写）。
 *   2. scheduler-events.jsonl → <cwd>/…/events.jsonl（rename 原子搬移）。
 *   3. cwd 失联（目录被移动/改名）的条目本次跳过（数据留在 $CORUM_HOME，
 *      等目录恢复后下次启动自动补迁；读取路径有旧形态回退兜底）。
 * @module @corum/corum-agent/project-migration
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { projectsRoot, projectJsonPath, writeJsonAtomic, projectDataDir } from './project-store.ts'
import { isValidProjectId } from './project.ts'

/** 本轮迁移搬到项目侧的详字段键（= ProjectInfo 形）。 */
const DETAIL_KEYS = ['description', 'workTypes', 'group'] as const

/** 备份根（$CORUM_HOME/backups）。 */
function backupRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), 'backups')
}

/** rename 的 EXDEV 兜底（项目 cwd 可能在另一块盘）。 */
function renameAcross(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    writeFileSync(dest, readFileSync(src))
    rmSync(src)
  }
}

export interface MigrationResult {
  /** 备份目录（本轮真实拷贝的路径；备份已存在时为 null）。 */
  backupDir: string | null
  /** 详字段搬入项目侧的项目 id。 */
  detailMigrated: string[]
  /** 事件日志搬移的项目 id。 */
  eventsMigrated: string[]
  /** cwd 失联跳过的项目 id（留在 $CORUM_HOME，目录恢复后自动补迁）。 */
  skippedUnavailable: string[]
  /** 已经是新形态、无需处理的项目 id。 */
  alreadyMigrated: string[]
  /** 共享 cwd 且归属他人的项目 id（保持旧形态存储，数据不覆盖不丢失）。 */
  legacySharedCwd: string[]
  /** 单条迁移失败（如 cwd 不可写）的项目 id；保持旧形态，下次启动重试。 */
  failed: string[]
}

/**
 * 执行迁移（幂等）。只搬数据、不删项目（cwd 失联的条目原样保留）。
 * 任何单项目失败只记日志并跳过该条，不中断整体迁移。
 */
export function migrateProjectStore(log?: (msg: string) => void): MigrationResult {
  const say = log ?? ((_msg: string) => {})
  const root = projectsRoot()
  const result: MigrationResult = {
    backupDir: null,
    detailMigrated: [],
    eventsMigrated: [],
    skippedUnavailable: [],
    alreadyMigrated: [],
    legacySharedCwd: [],
    failed: [],
  }
  if (!existsSync(root)) return result

  // 共享 cwd 归属表（本轮内：先到先得；跨轮由项目侧 ownerId 落盘仲裁）。
  const ownedCwds = new Map<string, string>()

  // 1. 先**干跑**（不写盘）判定是否确有迁移动作——见下方备份策略。
  const pending: string[] = []
  for (const dirent of readdirSafe(root)) {
    if (!dirent.isDirectory() || !isValidProjectId(dirent.name)) continue
    if (needsMigration(dirent.name)) pending.push(dirent.name)
  }

  // 0. 备份：**只在确有迁移动作时**才拷（bug.project-migration-backs-up-unconditionally-
  //    on-every-startup：旧实现每次启动无条件全量 cpSync，2 小时累积 9 份逐字节相同的
  //    快照且无清理期）。没活干 ⇒ 零拷贝、零目录增长。
  if (pending.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(backupRoot(), `projects-migration-${stamp}`)
    mkdirSync(dirname0(backupDir), { recursive: true })
    cpSync(root, backupDir, { recursive: true, force: false, errorOnExist: true })
    result.backupDir = backupDir
    say(`project-migration: 备份 $CORUM_HOME/projects → ${backupDir}（${pending.length} 个待迁条目：${pending.join(',')}）`)
  } else {
    say('project-migration: 无待迁条目，跳过备份')
  }

  for (const id of pending) {
    try {
      migrateOne(id, result, ownedCwds, say)
    } catch (error) {
      // 单项目失败（如 cwd 不可写）不中断整体迁移；该条保持旧形态（读路径兜底），
      // 下次启动重跑自动补迁。
      result.failed.push(id)
      say(`project-migration: [${id}] 迁移失败（保持旧形态，下次启动重试）：${String(error)}`)
    }
  }
  return result
}

/**
 * 该条目是否**确有**迁移动作（详字段待搬 / 事件日志待搬）。
 *
 * 只读判断，用于「无事可做就不备份」。判据与 migrateOne 的实际动作对齐：
 *   - 索引里还残留详字段（description/workTypes/group）⇒ 要搬详字段 + 索引瘦身；
 *   - 旧事件日志还在（且项目侧尚无 events.jsonl）⇒ 要搬事件日志。
 * cwd 失联的条目**不算**待迁（本轮什么也做不了，等目录恢复）。
 */
function needsMigration(id: string): boolean {
  const indexPath = projectJsonPath(id)
  if (!existsSync(indexPath)) return false
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>
  } catch {
    return false // 解析失败：migrateOne 只会记日志跳过，不算待迁
  }
  const cwd = typeof raw.cwd === 'string' && raw.cwd !== '' ? resolve(raw.cwd) : undefined
  if (cwd === undefined || !existsSync(cwd)) return false
  if (DETAIL_KEYS.some(key => raw[key] !== undefined)) return true
  const legacyLog = join(projectsRoot(), id, 'scheduler-events.jsonl')
  return existsSync(legacyLog) && !existsSync(join(projectDataDir(cwd), 'events.jsonl'))
}

/** 迁移单个索引条目（migrateProjectStore 的循环体；抛错由调用方兜）。 */
function migrateOne(
  id: string,
  result: MigrationResult,
  ownedCwds: Map<string, string>,
  say: (msg: string) => void,
): void {
  const root = projectsRoot()
  const indexPath = projectJsonPath(id)
  if (!existsSync(indexPath)) return
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    say(`project-migration: [${id}] 索引解析失败，跳过：${String(error)}`)
    return
  }
  const cwd = typeof raw.cwd === 'string' && raw.cwd !== '' ? resolve(raw.cwd) : undefined
  if (cwd === undefined || !existsSync(cwd)) {
    result.skippedUnavailable.push(id)
    return
  }
  // 共享 cwd 归属仲裁：历史脏数据里两个索引条目可指向同一目录（实测：
  // fresh-check 与 project 都指 /Users/kukucai/work/dsh_test）。项目侧
  // ProjectInfo/events 归「先迁入者」（ownerId 落盘）；后来者保持旧形态
  // 存储（读路径回退兜底），绝不覆盖先到者的数据。
  const claimed = ownedCwds.get(cwd)
  if (claimed !== undefined) {
    result.legacySharedCwd.push(id)
    say(`project-migration: [${id}] cwd 已被 [${claimed}] 占用（共享 cwd），保持旧形态存储`)
    return
  }
  ownedCwds.set(cwd, id)
  const dataDir = projectDataDir(cwd)

  // 1. 详字段 → 项目侧 ProjectInfo（已存在则不覆盖：项目侧为准，重跑幂等）。
  //    已存在的 ProjectInfo 属于本项目（ownerId 校验）才视为已迁移；属于他人
  //    （共享 cwd）→ 回退旧形态存储。
  const detail: Record<string, unknown> = {}
  for (const key of DETAIL_KEYS) {
    if (raw[key] !== undefined) detail[key] = raw[key]
  }
  const infoPath = join(dataDir, 'project.json')
  let foreignOwner = false
  if (existsSync(infoPath)) {
    try {
      const existing = JSON.parse(readFileSync(infoPath, 'utf8')) as { ownerId?: string }
      foreignOwner = existing.ownerId !== undefined && existing.ownerId !== id
    } catch {
      foreignOwner = false // 解析失败按「本项目损坏文件」处理，重写收敛
    }
  }
  const hasDetail = Object.keys(detail).length > 0
  if (foreignOwner) {
    result.legacySharedCwd.push(id)
    say(`project-migration: [${id}] 项目侧 ProjectInfo 属于其他项目，保持旧形态存储`)
    return
  }
  if (hasDetail) {
    if (!existsSync(infoPath)) {
      writeJsonAtomic(infoPath, { ...detail, ownerId: id })
      result.detailMigrated.push(id)
      say(`project-migration: [${id}] 详字段 → ${infoPath}`)
    } else {
      say(`project-migration: [${id}] 项目侧 ProjectInfo 已存在，不覆盖`)
    }
    // 索引重写为轻形（即便项目侧已存在也要剥旧残留 → 索引收敛到 6 字段）。
    const light: Record<string, unknown> = { ...raw }
    for (const key of DETAIL_KEYS) delete light[key]
    if (!('addedAt' in light) && 'createdAt' in light) light.addedAt = light.createdAt
    delete light.createdAt
    writeJsonAtomic(indexPath, light)
  } else {
    result.alreadyMigrated.push(id)
  }

  // 2. 事件日志搬移（旧在才搬；新已在 = 已迁移，旧文件保留为迁移前残影）。
  const legacyLog = join(root, id, 'scheduler-events.jsonl')
  const newLog = join(dataDir, 'events.jsonl')
  if (existsSync(legacyLog)) {
    if (!existsSync(newLog)) {
      mkdirSync(dataDir, { recursive: true })
      renameAcross(legacyLog, newLog)
      result.eventsMigrated.push(id)
      say(`project-migration: [${id}] events → ${newLog}`)
    } else {
      say(`project-migration: [${id}] events.jsonl 已存在，旧日志保留未搬`)
    }
  }
}

/** readdir 的安全包装（root 必然存在——调用方已判）。 */
function readdirSafe(dir: string): import('node:fs').Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** path.dirname 的本地小包装（避免多一个顶层 import）。 */
function dirname0(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? p : p.slice(0, i)
}
