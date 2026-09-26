/**
 * 统一会话索引：两模式（project / task）共用一套按工作区分组的会话账本。
 *
 * ## 为什么需要它
 *
 * 用户 2026-09-14 定的统一模型（`architecture.project.unified-with-type-field`）：
 * **TASK 模式下工作区其实也是一个项目**，两种模式共用同一套文件行为。此前两模式
 * 各有一套**键空间不同构**的索引，无法机械合并：
 *
 * | 索引 | 路径 | 键 | 一键一会话？ |
 * | --- | --- | --- | --- |
 * | project 模式（旧） | `$CORUM_HOME/projects/<id>/corum/sessions.json` | `"<profileId><type>"` | ✅ 是（泳道 = profile×type，天然唯一） |
 * | task 模式（旧） | `$CORUM_HOME/projects/task/corum/task-sessions.json` | `sessionId` | ❌ 否（一个工作区可多会话） |
 *
 * 实测：217 条 task 会话覆盖 17 个 cwd / 37 个 `(cwd, profileId)` 组合 ⇒ 按
 * project 侧形态（`profileId+type`）合并会**静默丢掉 180 条（82.9%）**
 * （台账 `bug.unified-index-shape-loses-task-sessions`）。丢掉的是索引条目，
 * 而索引正是「这条会话属于哪个工作区」的唯一依据 ⇒ 会话在 UI 里消失、
 * 磁盘上的本体还在却够不着。
 *
 * ## 本形态（取 task 侧、而非 project 侧）
 *
 * **键 = `sessionId`，值 = `{cwd, profileId, type, ...}`**：实测 217 条零丢失。
 * project 侧原有的 `(profileId, type) → sessionId` 查找语义在此之上**派生**
 * （按 cwd + profileId + type 过滤取一条），不需要反向压缩键空间。
 *
 * ## 落盘位置
 *
 * `$CORUM_HOME/sessions.json`——**一个全局文件**，按 `cwd` 分组（会话本体与
 * 会话索引都是「本机运行时账本」，用户已裁定留在 `$CORUM_HOME`、不入 git：
 * `architecture.storage.sessions-in-corum-home`）。之所以不像项目数据那样
 * 落进 `<cwd>/.corum/`：会话日志**含明文凭据**，不入 git 就没有「随工作区走」
 * 的理由（同条目理由链）。
 *
 * 写入原子化（tmp + rename），读路径对两套旧形态**向后兼容**（见
 * `legacy-index.ts` 的 `readLegacySessionIndexes`），保证迁移前后读路径等价。
 *
 * @module @corum/corum-agent/session-index
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// 工作区身份（L0）+ 工程类型（L1）：项目模式剥离后由两个助手模块承接。
import { canonicalWorkspaceKey } from './workspace-identity.ts'
import { isProjectType, type ProjectType } from './workspace-type.ts'

/**
 * 一条会话索引记录。
 *
 * `sessionId` 是**唯一键**（不再是 `<profileId><type>`），因为 task 模式
 * 一个工作区可以有任意多个会话——这是两套旧索引无法合并的根因。
 */
export interface SessionIndexEntry {
  /** 会话所属工作区（原始 cwd 字形；比较一律走 {@link canonicalWorkspaceKey}）。 */
  cwd: string
  /** 创建该会话的 profile id。 */
  profileId: string
  /** 工程类型（决定该会话在哪个模式的列表里显示）。 */
  type: ProjectType
  /**
   * 泳道标签（project 模式的 `(profile, laneKey)` 复用键）。
   *
   * project 模式的泳道要点是「同 profile 同泳道可 resume」，故需记住 laneKey；
   * task 模式无泳道语义（每次新建独立会话），此处缺省。
   */
  laneKey?: string
}

/** 索引文件的磁盘形（`{ version, sessions }`；version 供后续演进）。 */
interface SessionIndexFile {
  version: number
  sessions: Record<string, SessionIndexEntry>
}

/** 当前索引文件版本。 */
export const SESSION_INDEX_VERSION = 2

/** 会话索引根（`$CORUM_HOME`）。 */
export function corumHome(): string {
  const configured = process.env.CORUM_HOME !== undefined && process.env.CORUM_HOME.trim() !== ''
    ? process.env.CORUM_HOME
    : '~/.corum'
  return resolveDshHome(configured)
}

/** 统一会话索引文件路径（`$CORUM_HOME/sessions.json`）。 */
export function sessionIndexPath(): string {
  return join(corumHome(), 'sessions.json')
}

/** 非原子 rename 的 EXDEV 兜底（先拷后删）。 */
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
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameAtomic(tmp, path)
}

/**
 * 读统一索引（不存在/解析失败 = 空索引；绝不 throw——索引损坏不该让应用起不来）。
 * 逐条做形状校验：**坏条目单独丢弃**而不是整表作废（一条脏记录不该淹没 216 条好的）。
 */
export function readSessionIndex(): Record<string, SessionIndexEntry> {
  const path = sessionIndexPath()
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
  // 兼容两种外壳：`{version, sessions}`（本模块写的）与裸表（早期手写/迁移中间态）。
  const table = (raw !== null && typeof raw === 'object' && 'sessions' in raw)
    ? (raw as SessionIndexFile).sessions
    : raw
  if (table === null || typeof table !== 'object') return {}
  const out: Record<string, SessionIndexEntry> = {}
  for (const [sessionId, value] of Object.entries(table as Record<string, unknown>)) {
    const entry = normalizeEntry(value)
    if (entry !== undefined) out[sessionId] = entry
  }
  return out
}

/** 单条索引记录的形状校验 + 归一（不合法返回 undefined = 丢弃该条）。 */
function normalizeEntry(value: unknown): SessionIndexEntry | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.cwd !== 'string' || v.cwd === '') return undefined
  if (typeof v.profileId !== 'string' || v.profileId === '') return undefined
  return {
    cwd: v.cwd,
    profileId: v.profileId,
    // type 缺省按史实读作 project（旧条目都是项目模式创建的；见 project.ts 同名常量）。
    type: isProjectType(v.type) ? v.type : 'project',
    ...(typeof v.laneKey === 'string' && v.laneKey !== '' ? { laneKey: v.laneKey } : {}),
  }
}

/** 整表原子落盘。 */
export function writeSessionIndex(sessions: Record<string, SessionIndexEntry>): void {
  const file: SessionIndexFile = { version: SESSION_INDEX_VERSION, sessions }
  writeJsonAtomic(sessionIndexPath(), file)
}

/**
 * 登记（或更新）一条会话索引。读-改-写整体串行在调用方（host 单线程 +
 * 同步 IO，天然无并发交错）。
 */
export function registerSession(sessionId: string, entry: SessionIndexEntry): void {
  const sessions = readSessionIndex()
  sessions[sessionId] = entry
  writeSessionIndex(sessions)
}

/**
 * 按 `(profileId, laneKey)` 查已持久化的会话 id——project 模式泳道 resume 入口。
 *
 * 可选 `cwd` 过滤：泳道复用必须**按工作区判**（台账
 * `bug.task-lane-reuse-misses-project-sessions`：旧实现只查 task 索引，导致同一
 * 工作区出现两条并行泳道）。传 cwd 时只在该工作区内查。
 *
 * 多条命中（同 profile 同泳道多会话）取**任意一条稳定结果**：按 sessionId 排序
 * 取首个，保证同输入同输出（旧实现取对象插入序，行为不稳定）。
 */
export function findSessionByLane(
  profileId: string,
  laneKey: string,
  cwd?: string,
): string | undefined {
  const want = cwd === undefined ? undefined : canonicalWorkspaceKey(cwd)
  const sessions = readSessionIndex()
  const hits: string[] = []
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (entry.profileId !== profileId || entry.laneKey !== laneKey) continue
    if (want !== undefined && canonicalWorkspaceKey(entry.cwd) !== want) continue
    hits.push(sessionId)
  }
  return hits.sort()[0]
}

/** 按 sessionId 查一条索引（无则 undefined）。 */
export function findSession(sessionId: string): SessionIndexEntry | undefined {
  return readSessionIndex()[sessionId]
}

/**
 * 列出某个工作区的会话（按 type 过滤可选）。
 *
 * 「会话按 type 隔离显示」的落地点（`architecture.project.unified-with-type-field`
 * 边界：数据文件统一、**会话按 type 隔离**）。
 */
export function listSessionsForWorkspace(
  cwd: string,
  type?: ProjectType,
): Array<{ sessionId: string; entry: SessionIndexEntry }> {
  const want = canonicalWorkspaceKey(cwd)
  if (want === undefined) return []
  const out: Array<{ sessionId: string; entry: SessionIndexEntry }> = []
  for (const [sessionId, entry] of Object.entries(readSessionIndex())) {
    if (canonicalWorkspaceKey(entry.cwd) !== want) continue
    if (type !== undefined && entry.type !== type) continue
    out.push({ sessionId, entry })
  }
  return out
}

/** 删除一条索引记录（返回是否真的删掉了）。 */
export function unregisterSession(sessionId: string): boolean {
  const sessions = readSessionIndex()
  if (!(sessionId in sessions)) return false
  delete sessions[sessionId]
  writeSessionIndex(sessions)
  return true
}
