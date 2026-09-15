/**
 * Project 持久化：「项目数据跟随项目走」拆分形态（2026-09-14 Round 1）。
 *
 * 两层存储：
 *   索引 `$CORUM_HOME/projects/<projectId>/project.json` — 轻量索引，只含
 *     id / name / cwd / addedAt / lastOpenedAt / version 六个字段（listProjects
 *     只枚举索引；cwd 失联时该条目仍可列出并标记「目录不可用」）。
 *   项目侧 `<cwd>/.corum/project/` — 详字段与事件日志跟随项目走：
 *     project.json（ProjectInfo：description/workTypes/group 等非索引字段）
 *     events.jsonl（调度事件日志，由 event-log.ts 读写）。
 *
 * 读路径：loadProject(id) = 读索引 → 用 cwd 读项目侧 ProjectInfo → 合并出
 * 完整 CorumProject。cwd 不存在（目录被移动/改名）→ 返回 undefined，调用方
 * 用 isProjectUnavailable()/listProjects() 的 available 标记做「目录不可用」UX。
 *
 * 写路径全部原子化（tmp + rename，writeJsonAtomic）：半写不留脏 JSON。
 *
 * 迁移：migrateProjectStore()（project-migration.ts）在启动时把旧版全量
 * project.json 的详字段 + scheduler-events.jsonl 搬进项目侧；本模块的读取
 * 对「索引带详字段」的旧形态向后兼容（详情缺失时回读索引），保证迁移前
 * 后读路径等价。
 * @module @corum/corum-agent/project-store
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { CorumProject, ProjectGroup, ProjectType, WorkType } from './project.ts'
import { canonicalWorkspaceKey, isValidProjectId, projectTypeOf } from './project.ts'

/** 项目存储根（$CORUM_HOME/projects）。 */
export function projectsRoot(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return join(resolveDshHome(configured), 'projects')
}

/** 一个项目的索引目录路径（$CORUM_HOME/projects/<id>）。 */
export function projectDir(id: string): string {
  if (!isValidProjectId(id)) throw new Error(`dev-agent: invalid project id "${id}"`)
  return join(projectsRoot(), id)
}

/** 项目索引 project.json 的路径。 */
export function projectJsonPath(id: string): string {
  return join(projectDir(id), 'project.json')
}

// ── 项目侧目录（<cwd>/.corum/project/）────────────────────────────────

/** 项目侧信息/事件目录名（相对项目 cwd）。 */
export const PROJECT_DATA_DIR = '.corum/project'

/** 非原子 rename 的 fs.renameSync 在跨设备（EXDEV）时的兜底：先拷后删。 */
function renameAtomic(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    writeFileSync(dest, readFileSync(src))
    rmSync(src)
  }
}

/** 原子写 JSON（tmp + rename；半写不留脏文件）。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameAtomic(tmp, path)
}

/** 判断 cwd 是否存在（目录级 liveness；软链解析跟随）。 */
export function projectCwdExists(cwd: string | undefined): boolean {
  if (cwd === undefined || cwd === '') return true // 未关联工作区 = 无从失联
  return existsSync(cwd)
}

/**
 * 项目侧数据目录（`<cwd>/.corum/project`）。cwd 缺省返回 undefined（无从落点）。
 * cwd 传入时必须已存在（调用方保证；本函数不判存活，纯路径拼接）。
 */
export function projectDataDir(cwd: string): string {
  return join(cwd, PROJECT_DATA_DIR)
}

/**
 * 项目侧 ProjectInfo 文件路径（`<cwd>/.corum/project/project.json`）。
 * 索引 cwd 缺省时返回 undefined（无处可落）。
 */
export function projectInfoPath(cwd: string | undefined): string | undefined {
  return cwd === undefined || cwd === '' ? undefined : join(projectDataDir(cwd), 'project.json')
}

/**
 * 索引轻字段形（磁盘上索引 project.json 的确切形）。允许 description/workTypes/
 * group 残留（旧形态向后兼容：迁移前写入的文件尚未搬空，读取宽容）。
 */
interface ProjectIndexEntry {
  id: string
  name: string
  /**
   * 工程类型（`project` | `task`）。**索引侧字段**：类型是工作区的身份属性，
   * 与「这个条目在哪、叫什么」同级，必须随索引走（cwd 失联时也要能读出 type，
   * 否则「目录不可用」的条目无法判定该按哪个模式打开）。
   */
  type?: ProjectType
  cwd?: string
  addedAt: number
  lastOpenedAt: number
  version: number
  // 旧形态残留字段（迁移后不再写入；读取宽容、保存时剥除）。
  description?: string
  workTypes?: WorkType[]
  group?: ProjectGroup
}

// ── 读路径 ─────────────────────────────────────────────────────────────

/** 读索引条目（轻字段 + 可能的旧形态详字段残留；不存在返回 undefined）。 */
export function loadProjectIndex(id: string): ProjectIndexEntry | undefined {
  const path = projectJsonPath(id)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProjectIndexEntry
  } catch {
    return undefined
  }
}

/**
 * 项目侧 ProjectInfo（详字段：description/workTypes/group 等）。
 * cwd 缺省（未关联工作区）= 无详字段文件，返回空对象。
 */
export interface ProjectInfo {
  description?: string
  workTypes?: WorkType[]
  group?: ProjectGroup
  /** 写入该文件的索引条目 id（数据归属判据：共享 cwd 的第二个项目回退旧形态存储）。 */
  ownerId?: string
}

/** 读项目侧 ProjectInfo（不存在/解析失败 = 空对象；绝不 throw）。 */
export function loadProjectInfo(cwd: string | undefined, ownerId?: string): ProjectInfo {
  const path = projectInfoPath(cwd)
  if (path === undefined || !existsSync(path)) return {}
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as ProjectInfo
    // 归属校验：ProjectInfo 属于别的索引条目（共享 cwd 的后来者）→ 不读。
    if (ownerId !== undefined && info.ownerId !== undefined && info.ownerId !== ownerId) return {}
    return info
  } catch {
    return {}
  }
}

/**
 * 读取一个项目的完整元信息（索引 + 项目侧 ProjectInfo 合并）。
 *
 * cwd 不存在（目录被移动/改名）→ 返回 undefined：上层应据此把该条目标记
 * 「目录不可用」（见 isProjectUnavailable / listProjects 的 available 标记），
 * 而不是静默丢条目。详字段缺失（迁移前/未关联 cwd）时回退索引残留字段。
 */
export function loadProject(id: string): CorumProject | undefined {
  const index = loadProjectIndex(id)
  if (index === undefined) return undefined
  if (!projectCwdExists(index.cwd)) return undefined
  const info = loadProjectInfo(index.cwd, id)
  return {
    id: index.id,
    name: index.name,
    // type 是索引侧字段（详见 ProjectIndexEntry.type）；缺省按史实读作 project。
    type: projectTypeOf(index),
    ...(index.cwd !== undefined ? { cwd: index.cwd } : {}),
    ...(info.description !== undefined ? { description: info.description } : index.description !== undefined ? { description: index.description } : {}),
    ...(info.workTypes !== undefined ? { workTypes: info.workTypes } : index.workTypes !== undefined ? { workTypes: index.workTypes } : {}),
    ...(info.group !== undefined ? { group: info.group } : index.group !== undefined ? { group: index.group } : {}),
    createdAt: index.addedAt,
    lastOpenedAt: index.lastOpenedAt,
    version: index.version,
  }
}

/** listProjects 的行形：完整 CorumProject + 目录存活标记。 */
export interface ProjectListEntry {
  /** 项目实体（cwd 失联时详字段不可得，只剩索引轻字段投影 + available=false）。 */
  project: CorumProject
  /** cwd 是否存活（false = 目录被移动/改名，项目「目录不可用」）。 */
  available: boolean
}

/**
 * 列出所有项目（按 lastOpenedAt 倒序，最近打开在前）。只枚举索引（轻量），
 * 详字段经 loadProject 合并。cwd 失联的条目照列，available=false（不静默丢弃）。
 * cwd 失联时详字段不可得：回退索引残留字段（迁移前的旧文件仍带 group 等），
 * 保证迁移前后的列表行为等价。
 */
export function listProjects(): ProjectListEntry[] {
  const root = projectsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && isValidProjectId(d.name))
    .map(d => {
      const index = loadProjectIndex(d.name)
      if (index === undefined) return undefined
      const available = projectCwdExists(index.cwd)
      const project = available
        ? loadProject(d.name)
        : {
            // 目录不可用：只能给索引轻字段投影（详字段在失联的 cwd 里够不着）。
            id: index.id,
            name: index.name,
            type: projectTypeOf(index),
            ...(index.cwd !== undefined ? { cwd: index.cwd } : {}),
            ...(index.description !== undefined ? { description: index.description } : {}),
            ...(index.workTypes !== undefined ? { workTypes: index.workTypes } : {}),
            ...(index.group !== undefined ? { group: index.group } : {}),
            createdAt: index.addedAt,
            lastOpenedAt: index.lastOpenedAt,
            version: index.version,
          }
      if (project === undefined) return undefined
      return { project, available }
    })
    .filter((e): e is ProjectListEntry => e !== undefined)
    .sort((a, b) => b.project.lastOpenedAt - a.project.lastOpenedAt)
}

// ── 写路径 ─────────────────────────────────────────────────────────────

/**
 * 保存项目（索引 + 项目侧 ProjectInfo 双写，version 自增）。
 *
 * 索引只写 6 个轻字段（详字段剥到项目侧）；索引 cwd 失联时不抛错——只写索引
 * lastOpenedAt 等轻字段仍安全，详字段留待目录恢复后下次 save 补写。
 */
export function saveProject(project: CorumProject): void {
  const current = loadProjectIndex(project.id)
  const nextVersion = (current?.version ?? project.version ?? 0) + 1
  const { description, workTypes, group, ...indexFields } = project
  const addedAt = current?.addedAt ?? project.createdAt
  const index: ProjectIndexEntry = {
    ...indexFields,
    // type 恒显式落盘（缺省收敛为 DEFAULT_PROJECT_TYPE）：新写入的条目不该再靠
    // 「读时缺省」兜底，否则后续无法区分「真的没写过」与「写的是 project」。
    type: projectTypeOf(project),
    addedAt,
    version: nextVersion,
  }
  // 剥除残留的旧详字段键（保持索引轻形；详字段已落项目侧）。
  const light = index as unknown as Record<string, unknown>
  delete light.description
  delete light.workTypes
  delete light.group
  writeJsonAtomic(projectJsonPath(project.id), index)
  // 详字段 → 项目侧（cwd 缺省或失联时跳过：无从落点/等目录恢复）。带 ownerId
  // 归属标记，供 loadProjectInfo 做归属校验（共享 cwd 场景的数据隔离）。
  if (project.cwd !== undefined && existsSync(project.cwd)) {
    writeJsonAtomic(projectInfoPath(project.cwd)!, { description, workTypes, group, ownerId: project.id })
  }
}

// ── 工作区身份查找（一工作区一条目）──────────────────────────────────────

/**
 * 按工作区**身份**（`canonicalWorkspaceKey(cwd)`）查已有项目条目。
 *
 * 「一工作区一条目」（`architecture.project.type-is-authoritative-and-monotonic`
 * 甲案：身份由 cwd 决定）的读侧入口：打开/创建前先查这里，命中即**恢复原有
 * 项目、不再新建**。
 *
 * 比较用规范形而非原字符串——存量实测 `"/a/b/"` 与 `"/a/b"` 同指一个目录
 * （217 条 task 会话里两者并存），直接比字符串会把一个工作区判成两个。
 *
 * @param cwd - 待查工作目录（绝对路径）。
 * @param opts.includeUnavailable - 是否把 cwd 失联的条目计入（缺省 false：
 *   失联条目不能作为「恢复」目标，否则会打开一个够不着的项目）。
 * @returns 命中的项目条目（含 lastOpenedAt 最新者；无命中返回 undefined）。
 */
export function findProjectByCwd(
  cwd: string | undefined,
  opts: { includeUnavailable?: boolean } = {},
): ProjectListEntry | undefined {
  const key = canonicalWorkspaceKey(cwd)
  if (key === undefined) return undefined
  const hits = listProjects().filter((e) => {
    if (!opts.includeUnavailable && !e.available) return false
    return canonicalWorkspaceKey(e.project.cwd) === key
  })
  // 存量脏数据可能有多条同 cwd（实测 fresh-check 与 project 同指 dsh_test）：
  // 取最近打开者作「恢复」目标（迁移负责最终合并为一条）。
  return hits.sort((a, b) => b.project.lastOpenedAt - a.project.lastOpenedAt)[0]
}

// ── 删除 ───────────────────────────────────────────────────────────────

/**
 * 删除一个项目的索引条目（只删 `$CORUM_HOME/projects/<id>/`，不碰项目 cwd
 * ——「项目数据跟随项目走」后项目侧数据就在用户工作区里，删除项目（尤其
 * cwd 失联场景的「是否删除该项目」）绝不越界删用户目录）。
 */
export function deleteProject(id: string): void {
  rmSync(projectDir(id), { recursive: true, force: true })
}
