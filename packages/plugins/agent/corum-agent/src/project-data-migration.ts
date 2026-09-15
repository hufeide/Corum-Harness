/**
 * 四表存量数据迁移（「项目数据跟随项目走」Round 2，幂等可重跑，备份先行）。
 *
 * 旧形态（本轮之前）：四个业务表全在单文件单域
 *   `$CORUM_HOME/storages/corum_project.json`
 *   （官方 storage-json `single` layout：{unit:{name,version}, global, tables}，
 *   记录键 `<projectId>/<entityId>`）。
 *
 * 新形态：每条记录一个文档，落进各项目 cwd（官方 per-record layout 的
 * `serializeRecord` 同形：{version, record}）：
 *   `<cwd>/.corum/project/corum_project_<projectId>/<table>/<entityId>.json`
 * 其中 `corum_project_<projectId>` 是 per-record unit 目录名（= 域名，连字符
 * 归一为下划线；官方后端 join(root, descriptor.name)），
 * `<table> ∈ {requirements, tasks, bugs, audits}`。
 *
 * 迁移步骤（每次启动跑一遍，源文件消失即天然跳过）：
 *   0. 备份：旧单文件原样拷贝到 `$CORUM_HOME/backups/project-data-migration-<ts>.json`
 *      （时间戳命名；同毫秒重跑换后缀，绝不覆盖已有备份）。
 *   1. 解析旧文件，按键前缀 `<projectId>/` 分组。
 *   2. 每组：查索引 `$CORUM_HOME/projects/<id>/project.json` 取 cwd；cwd 存在
 *      → 逐条写入新形态文档（已存在不覆盖——重跑幂等）。
 *   3. 归属失败（索引缺失 / cwd 失联）的项目 → 数据**不写不删**，保留旧文件，
 *      等目录恢复后下次启动自动补迁（绝不静默丢数据）。
 *   4. 全部组都成功落盘后才删除旧单文件（备份仍在）。
 *
 * 共享 cwd 说明：两个 projectId 指向同一 cwd 时，unit 目录按 projectId 分开
 * （`<cwd>/.corum/project/<idA>/…` 与 `<idB>/…`），互不覆盖；域名归一碰撞
 * （`a-b`/`a_b` → 同域名）不影响落盘布局，只影响运行期域句柄名（见
 * project-data-service.ts）。
 * @module @corum/corum-agent/project-data-migration
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { projectJsonPath, projectDataDir, writeJsonAtomic } from './project-store.ts'
import { isValidProjectId } from './project.ts'
import { projectDataUnitName } from './project-entities.ts'

/** 旧单域文件名（官方 storage-json single layout 的 unit 文件名 = 域名）。 */
const LEGACY_DOMAIN_FILE = 'corum_project.json'

/** 四表名（与 projectDataTables() 一致；显式列出以防未来加表时误搬）。 */
const TABLES = ['requirements', 'tasks', 'bugs', 'audits'] as const

/** 备份根（$CORUM_HOME/backups）。 */
function backupRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), 'backups')
}

/** 旧单文件路径（$CORUM_HOME/storages/corum_project.json）。 */
function legacyDomainPath(): string {
  return join(storageRoot(), LEGACY_DOMAIN_FILE)
}

/** $CORUM_HOME/storages（旧单域文件所在目录）。 */
function storageRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), 'storages')
}

export interface ProjectDataMigrationResult {
  /** 本轮真实拷贝的备份文件路径；源文件不存在（无事可做）时为 null。 */
  backupPath: string | null
  /** 旧单文件是否已删除（仅全部项目成功落盘后为 true）。 */
  removed: boolean
  /** 成功拆分到项目 cwd 的 projectId。 */
  projectsSplit: string[]
  /** 索引缺失或 cwd 失联、无法归属的项目（数据保留在旧文件 + 备份中）。 */
  unknownProjects: string[]
  /** 源文件不存在（已迁移过或本就无数据）。 */
  alreadyMigrated: boolean
  /** 单条记录写入失败的项目（该组回退为「不搬」，下轮重试）。 */
  failed: string[]
}

/**
 * 旧单文件记录键 → {projectId, entityId}。非 `<projectId>/<entityId>` 形的键
 * 返回 null（迁移时原样保留在旧文件中，不静默丢弃）。
 */
function splitKey(key: string): { projectId: string; entityId: string } | null {
  const i = key.indexOf('/')
  if (i <= 0 || i === key.length - 1) return null
  return { projectId: key.slice(0, i), entityId: key.slice(i + 1) }
}

/** readdir 安全包装。 */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 目录内现存的项目 unit（补迁判断用：新位置已有该项目目录 = 至少部分已迁）。 */
function existingUnits(dataDir: string): Set<string> {
  return new Set(readdirSafe(dataDir))
}

/** 执行四表迁移（幂等）。失败不抛出——结果对象里如实报告。 */
export function migrateProjectData(log?: (msg: string) => void): ProjectDataMigrationResult {
  const say = log ?? ((_msg: string) => {})
  const result: ProjectDataMigrationResult = {
    backupPath: null,
    removed: false,
    projectsSplit: [],
    unknownProjects: [],
    alreadyMigrated: false,
    failed: [],
  }
  const legacyPath = legacyDomainPath()
  if (!existsSync(legacyPath)) {
    result.alreadyMigrated = true
    return result
  }

  // 0. 备份（时间戳命名；冲突则追加序号，绝不覆盖既有备份）。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let backupPath = join(backupRoot(), `project-data-migration-${stamp}.json`)
  for (let n = 1; existsSync(backupPath); n++) {
    backupPath = join(backupRoot(), `project-data-migration-${stamp}-${n}.json`)
  }
  mkdirSync(backupRoot(), { recursive: true })
  copyFileSync(legacyPath, backupPath)
  result.backupPath = backupPath
  say(`project-data-migration: 备份 ${legacyPath} → ${backupPath}`)

  // 1. 解析旧单文件（official single-layout document）。
  let document: { unit?: { name?: unknown; version?: unknown }; global?: unknown; tables?: Record<string, Record<string, unknown>> }
  try {
    document = JSON.parse(readFileSync(legacyPath, 'utf8'))
  } catch (error) {
    say(`project-data-migration: 旧文件解析失败（保持原样，下次启动重试）：${String(error)}`)
    return result
  }
  const tables = document.tables
  if (document.unit?.name !== 'corum_project' || typeof tables !== 'object' || tables === null) {
    say(`project-data-migration: 旧文件不是 corum_project 单域文档（unit=${String(document.unit?.name)}），跳过`)
    return result
  }

  // 2. 按键前缀分组：<projectId> → {table → (entityId → record)}。
  const grouped = new Map<string, Map<string, Array<[string, unknown]>>>()
  const malformed: string[] = []
  for (const table of TABLES) {
    const records = tables[table]
    if (records === undefined) continue
    if (typeof records !== 'object') {
      say(`project-data-migration: 表 ${table} 形态异常，跳过该表`)
      continue
    }
    for (const [key, value] of Object.entries(records)) {
      const split = splitKey(key)
      if (split === null) {
        malformed.push(`${table}/${key}`)
        continue
      }
      let perProject = grouped.get(split.projectId)
      if (perProject === undefined) {
        perProject = new Map()
        grouped.set(split.projectId, perProject)
      }
      let rows = perProject.get(table)
      if (rows === undefined) {
        rows = []
        perProject.set(table, rows)
      }
      rows.push([split.entityId, value])
    }
  }
  if (malformed.length > 0) {
    say(`project-data-migration: ${malformed.length} 条键不符合 <projectId>/<entityId> 形（保留在旧文件）：${malformed.join(', ')}`)
  }

  // 3. 逐项目落盘。
  const touchedUnits = new Map<string, Set<string>>() // cwd → 已见 unit 名
  for (const [projectId, perTable] of grouped) {
    try {
      if (!isValidProjectId(projectId)) throw new Error(`invalid project id "${projectId}"`)
      const indexPath = projectJsonPath(projectId)
      if (!existsSync(indexPath)) throw new Error('index not found')
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { cwd?: unknown }
      const cwd = typeof index.cwd === 'string' && index.cwd !== '' ? resolve(index.cwd) : undefined
      if (cwd === undefined || !existsSync(cwd)) throw new Error('cwd unavailable')

      const dataDir = projectDataDir(cwd)
      let units = touchedUnits.get(cwd)
      if (units === undefined) {
        units = existingUnits(dataDir)
        touchedUnits.set(cwd, units)
      }
      // unit 目录 = <cwd>/.corum/project/<projectId>（per-record unit 名保留原 id）。
      // unit 目录名 = 域名（官方 json 后端 join(root, descriptor.name)）。
      const unitDir = join(dataDir, projectDataUnitName(projectId))
      let written = 0
      for (const [table, rows] of perTable) {
        for (const [entityId, record] of rows) {
          const docPath = join(unitDir, table, `${entityId}.json`)
          if (!existsSync(docPath)) {
            // 官方 per-record 文档同形：{version, record}，version=域版本 1。
            writeJsonAtomic(docPath, { version: 1, record })
            written++
          }
        }
      }
      units.add(projectId)
      result.projectsSplit.push(projectId)
      say(`project-data-migration: [${projectId}] ${written} 条 → ${unitDir}`)
    } catch (error) {
      // 归属失败/写入失败：该项目整组不搬，数据留在旧文件（+备份），下轮重试。
      result.unknownProjects.push(projectId)
      say(`project-data-migration: [${projectId}] 无法归属（${String(error)}），数据保留在旧文件`)
    }
  }

  // 4. 全部成功落盘（且无畸形键）才删除旧单文件；否则保留待下轮。
  if (result.unknownProjects.length === 0 && malformed.length === 0) {
    rmSync(legacyPath)
    result.removed = true
    say(`project-data-migration: 旧单文件已删除（备份：${backupPath}）`)
  } else {
    say(`project-data-migration: 存在未归属数据，旧单文件保留（${legacyPath}）`)
  }
  return result
}
