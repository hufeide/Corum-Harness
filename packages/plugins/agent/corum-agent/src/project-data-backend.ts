/**
 * Per-project storage backend（「项目数据跟随项目走」Round 2：四表分域）。
 *
 * 官方机制复用（零 fork、零官方源修改）：
 *   - `@deepseek-ai/dsh-storage`（storage hub）：backend registry 名字可任意，
 *     同名拒绝重复注册（StorageError "duplicate-backend"）→ 本模块用
 *     `corum-project:<cwd 绝对路径>` 作注册名，同名 = 同一实例复用（同 cwd 的
 *     多个域共享一个后端），异名并存。
 *   - `@deepseek-ai/dsh-storage-json`：官方 JsonStorageBackend 构造时接收
 *     root（Config schema 就是 `{ root }`；root 无默认是有意设计——位置由
 *     后端持有者决定）。这里**以官方 backend 类按项目 cwd 直接实例化**，
 *     root = `<cwd>/.corum/project/`，与 Round 1 的 project.json /
 *     events.jsonl 同目录，四表数据真正跟随项目走（目录移动/改名即整体迁移）。
 *   - `@deepseek-ai/dsh-storage-domain`：DomainFacility 的 Config.routes 是
 *     静态域名表（加载期定死），无法表达「每个新项目的动态域名 → 动态 root」，
 *     所以 per-project 路由走 storage hub 的 backend registry（ctx.storage.
 *     backend.get(name)）——这正是官方 hub 的多后端并存语义（"which backend
 *     serves which consumer is the consumer's configuration"）。
 *
 * 为什么不 fork：本模块只是**组合**官方 hub + 官方 json 后端 + 官方 domain
 * 设施，不重实现任何存储语义；disposal 走官方 disposer（unregister + close）。
 *
 * @module @corum/corum-agent/project-data-backend
 */

import { join } from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { Storage } from '@deepseek-ai/dsh-storage'
import { projectDataDir } from './project-store.ts'
import { projectDataUnitName } from './project-entities.ts'

/** storage hub 注册名前缀（官方 BackendRegistry 允许任意名字；用前缀便于诊断）。 */
const BACKEND_PREFIX = 'corum-project:'

/**
 * 项目 cwd → 后端注册名。同 cwd（含共享 cwd 的历史脏数据）→ 同名 → 同一
 * JsonStorageBackend 实例复用（官方 registry 的 duplicate-backend 防护即缓存语义）。
 */
export function projectBackendName(cwd: string): string {
  return `${BACKEND_PREFIX}${join(cwd).normalize('NFC')}`
}

/** 是否本模块注册的 per-project 后端名（清理时只动自己的）。 */
export function isProjectBackendName(name: string): boolean {
  return name.startsWith(BACKEND_PREFIX)
}

/** 项目 cwd → 四表 per-record unit 的落盘目录（`<cwd>/.corum/project/<unit>`）。 */
export function projectDataUnitRoot(cwd: string, projectId: string): string {
  return join(projectDataDir(cwd), projectDataUnitName(projectId))
}

/**
 * 在 storage hub 上注册一个项目的专用 json 后端（root = `<cwd>/.corum/project`）。
 * 同名已注册（同 cwd 已有后端）时直接复用现有实例（返回 null 告知调用方）。
 * 返回官方 disposer（unregister + backend.close()），由服务层作为 ctx.effect 挂。
 */
export function registerProjectBackend(
  storage: Storage,
  cwd: string,
): { disposer: () => Promise<void>; created: true } | { disposer: null; created: false } {
  const name = projectBackendName(cwd)
  try {
    // 已注册 → 复用（同 cwd 第二个项目域共享同一后端实例）。
    storage.backend.get(name)
    return { disposer: null, created: false }
  } catch (error) {
    const code = error instanceof StorageError ? error.code : undefined
    if (code !== 'backend-not-found') throw error
  }
  const backend = new JsonStorageBackend(projectDataDir(cwd))
  const unregister = storage.backend.register(name, backend)
  const disposer = async (): Promise<void> => {
    unregister()
    await backend.close()
  }
  return { disposer, created: true }
}
