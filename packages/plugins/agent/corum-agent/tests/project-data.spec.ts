/**
 * Round 2「四表按项目分域」验证（project-data-service + project-data-migration）。
 *
 * 官方存储栈真装（dsh-storage hub + dsh-storage-json 后端 + dsh-storage-domain
 * 设施，corum-subagent list-children.spec.ts 同款 wiring），CORUM_HOME 指向
 * /tmp 隔离目录——不动真实 dev home。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import { CorumProjectDataService } from '../src/project-data-service.ts'
import { migrateProjectData } from '../src/project-data-migration.ts'
import { projectDataDomainName } from '../src/project-entities.ts'

let home: string
let workdir: string
const prevCorumHome = process.env.CORUM_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-pd-home-'))
  workdir = mkdtempSync(join(tmpdir(), 'corum-pd-ws-'))
  process.env.CORUM_HOME = home
})

afterEach(() => {
  if (prevCorumHome === undefined) delete process.env.CORUM_HOME
  else process.env.CORUM_HOME = prevCorumHome
  rmSync(home, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** 建索引条目 + 项目工作区（cwd 存在才有 per-project 后端 root）。 */
function seedProject(id: string, cwd: string): void {
  mkdirSync(join(home, 'projects', id), { recursive: true })
  writeFileSync(join(home, 'projects', id, 'project.json'), JSON.stringify({
    id, name: id, cwd, addedAt: 1, lastOpenedAt: 1, version: 0,
  }))
  mkdirSync(join(cwd, '.corum', 'project'), { recursive: true })
  if (cwd !== '') {
    // 项目组成员（createTask/createBug 的 assigneeId 必须是组成员）。
    writeJsonAtomic0(join(cwd, '.corum', 'project', 'project.json'), {
      group: { members: [{ profileId: 'user', role: 'pm' }] },
      ownerId: id,
    })
  }
}

function writeJsonAtomic0(path: string, value: unknown): void {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

/** 写旧形态单域文档（official single-layout 同形）。 */
function seedLegacyStore(records: Record<string, Record<string, unknown>>): void {
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'corum_project.json'), JSON.stringify({
    unit: { name: 'corum_project', version: 1 },
    global: null,
    tables: records,
  }, null, 2))
}

async function setupService(): Promise<{ ctx: Context; data: CorumProjectDataService }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root: join(home, 'storages') })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  // CorumAgentService 构造依赖重（agents/sessions…）；本套验证只触数据层公开方法
  // 里不经过 caller 反查的部分（list*/create* 直接传 caller 对象），传 null 断言即可。
  // Service 基类构造即 provide（cordis Service 语义），无需手动 ctx.provide。
  const data = ctx.get('corumProjectData') ?? new CorumProjectDataService(ctx, null as never)
  return { ctx, data }
}

const human = (projectId: string) => ({ kind: 'human' as const, id: 'user', projectId, role: 'human' as const })

describe('CorumProjectDataService — 一项目一域（per-record 落盘跟随 cwd）', () => {
  it('create/list/get 走项目专属域；四表文件落在 <cwd>/.corum/project/<projectId>/ 下', async () => {
    const wsA = join(workdir, 'alpha')
    seedProject('alpha', wsA)
    const { ctx, data } = await setupService()

    const req = await data.createRequirement(human('alpha'), { title: '登录' })
    expect(req.projectId).toBe('alpha')
    expect(req.version).toBe(0)

    const task = await data.createTask(human('alpha'), { requirementId: req.id, title: '实现登录', assigneeId: 'user' })
    const auditCount = 2

    // 物理落盘证据：per-record 文档在项目 cwd 下。
    const unitDir = join(wsA, '.corum', 'project', 'corum_project_alpha')
    const reqDocs = readFileSync(join(unitDir, 'requirements', `${req.id}.json`), 'utf8')
    expect(JSON.parse(reqDocs)).toMatchObject({ version: 1, record: { title: '登录' } })
    expect(existsSync(join(unitDir, 'tasks', `${task.id}.json`))).toBe(true)
    // 审计表也在同一 unit 下（每条审计一个文档）。
    const auditDir = join(unitDir, 'audits')
    expect(readdirSync(auditDir).length).toBe(2)

    // 读路径等价：list 与 get 返回刚写的实体。
    expect((await data.listRequirements('alpha')).map(r => r.id)).toEqual([req.id])
    expect((await data.listTasks('alpha', req.id)).map(t => t.id)).toEqual([task.id])
    const auditFile = readdirSync(auditDir)[0]!
    expect(JSON.parse(readFileSync(join(auditDir, auditFile), 'utf8')).record).toBeDefined()
    expect(auditCount).toBe(2)

  })

  it('项目间隔离：另一个项目的域读不到 alpha 的实体；$CORUM_HOME/storages 不再有项目数据', async () => {
    const wsA = join(workdir, 'alpha')
    const wsB = join(workdir, 'beta')
    seedProject('alpha', wsA)
    seedProject('beta-x', wsB)
    const { data } = await setupService()

    await data.createRequirement(human('alpha'), { title: '仅 alpha' })
    expect(await data.listRequirements('beta-x')).toEqual([])
    await expect(data.createRequirement(human('beta-x'), { title: '仅 beta' })).resolves.toMatchObject({ projectId: 'beta-x' })
    expect((await data.listRequirements('alpha')).length).toBe(1)
    expect((await data.listRequirements('beta-x'))[0]!.title).toBe('仅 beta')

    // 全局 storages 目录下不存在 corum_project*.json（旧单文件已迁走/新数据不落全局）。
    const storages = join(home, 'storages')
    const leftovers = readdirSafe0(storages).filter(f => f.startsWith('corum_project'))
    expect(leftovers).toEqual([])
  })

  it('cwd 失联 / 未绑定工作区：报错且不静默写全局', async () => {
    seedProject('ghost', join(workdir, 'ghost'))
    const { data } = await setupService()
    rmSync(join(workdir, 'ghost'), { recursive: true, force: true })
    await expect(data.listRequirements('ghost')).rejects.toThrow(/cwd/)

    seedProject('noglobal', '')
    // 无 cwd 的项目：索引 cwd 为空串 → 报 no workspace cwd bound。
    await expect(data.listRequirements('noglobal')).rejects.toThrow()
  })

  it('域名归一：合法 projectId（仅 [a-z0-9-]）之间域名互不碰撞；物理隔离成立', async () => {
    const ws1 = join(workdir, 'ws1')
    const ws2 = join(workdir, 'ws2')
    seedProject('a-b', ws1)
    seedProject('ab', ws2)
    // 合法 projectId 集不含下划线 → 归一化（- → _）是单射，无碰撞。
    expect(projectDataDomainName('a-b')).not.toBe(projectDataDomainName('ab'))
    const { data } = await setupService()
    await data.createRequirement(human('a-b'), { title: 'one' })
    await data.createRequirement(human('ab'), { title: 'two' })
    expect((await data.listRequirements('a-b'))[0]!.title).toBe('one')
    expect((await data.listRequirements('ab'))[0]!.title).toBe('two')
  })
})

describe('migrateProjectData — 旧单文件拆分（幂等 + 备份先行）', () => {
  it('按 projectId 拆进各项目 cwd；全部成功后旧文件删除且备份存在', async () => {
    const wsA = join(workdir, 'alpha')
    const wsB = join(workdir, 'beta')
    seedProject('alpha', wsA)
    seedProject('beta', wsB)
    seedLegacyStore({
      requirements: {
        'alpha/req-1': { id: 'req-1', projectId: 'alpha', title: 'R1', ownerId: 'user', status: 'submitted', priority: 1, statusHistory: [], createdAt: 1, updatedAt: 1, version: 0 },
        'beta/req-2': { id: 'req-2', projectId: 'beta', title: 'R2', ownerId: 'user', status: 'submitted', priority: 1, statusHistory: [], createdAt: 1, updatedAt: 1, version: 0 },
      },
      tasks: {},
      bugs: {},
      audits: {},
    })

    const first = migrateProjectData()
    expect(first.backupPath).toBeTruthy()
    expect(first.projectsSplit).toEqual(['alpha', 'beta'])
    expect(first.removed).toBe(true)
    expect(existsSync(first.backupPath!)).toBe(true)
    expect(existsSync(join(home, 'storages', 'corum_project.json'))).toBe(false)

    // 新位置文档可读（official per-record 同形）。
    const docA = JSON.parse(readFileSync(join(wsA, '.corum', 'project', 'corum_project_alpha', 'requirements', 'req-1.json'), 'utf8'))
    expect(docA).toEqual({ version: 1, record: expect.objectContaining({ id: 'req-1' }) })

    // 幂等重跑：无事可做。
    const second = migrateProjectData()
    expect(second.alreadyMigrated).toBe(true)
    expect(second.backupPath).toBeNull()

  })

  it('归属失败的项目数据不搬不删（保留在旧文件 + 备份），可恢复后下轮补迁', async () => {
    const wsA = join(workdir, 'alpha')
    seedProject('alpha', wsA)
    // beta 索引缺失。
    seedLegacyStore({
      requirements: {
        'alpha/req-1': { id: 'req-1', projectId: 'alpha', title: 'R1', ownerId: 'user', status: 'submitted', priority: 1, statusHistory: [], createdAt: 1, updatedAt: 1, version: 0 },
        'beta/req-2': { id: 'req-2', projectId: 'beta', title: 'R2', ownerId: 'user', status: 'submitted', priority: 1, statusHistory: [], createdAt: 1, updatedAt: 1, version: 0 },
      },
      tasks: {}, bugs: {}, audits: {},
    })

    const first = migrateProjectData()
    expect(first.projectsSplit).toEqual(['alpha'])
    expect(first.unknownProjects).toEqual(['beta'])
    expect(first.removed).toBe(false)
    // 旧文件仍在（含 beta 的数据）。
    const legacy = JSON.parse(readFileSync(join(home, 'storages', 'corum_project.json'), 'utf8'))
    expect(legacy.tables.requirements['beta/req-2']).toBeDefined()
    // 备份仍有完整原件。
    const backup = JSON.parse(readFileSync(first.backupPath!, 'utf8'))
    expect(backup.tables.requirements['alpha/req-1']).toBeDefined()

    // 目录恢复（补上索引）后下轮补迁成功并删除旧文件（alpha 的文档已存在 → 不覆盖仍计入已迁）。
    seedProject('beta', join(workdir, 'beta'))
    const second = migrateProjectData()
    expect(second.projectsSplit.sort()).toEqual(['alpha', 'beta'])
    expect(second.unknownProjects).toEqual([])
    expect(second.removed).toBe(true)
    expect(existsSync(join(wsA, '.corum', 'project', 'corum_project_alpha', 'requirements', 'req-1.json'))).toBe(true)
  })

  it('共享 cwd：两个项目各自的 unit 目录互不覆盖', async () => {
    const shared = join(workdir, 'shared')
    seedProject('pa', shared)
    seedProject('pb', shared)
    seedLegacyStore({
      requirements: {
        'pa/req-1': { id: 'req-1', projectId: 'pa', title: 'A', ownerId: 'user', status: 'submitted', priority: 1, statusHistory: [], createdAt: 1, updatedAt: 1, version: 0 },
        'pb/req-2': { id: 'req-2', projectId: 'pb', title: 'B', ownerId: 'user', status: 'submitted', priority: 1, statusHistory: [], createdAt: 1, updatedAt: 1, version: 0 },
      },
      tasks: {}, bugs: {}, audits: {},
    })
    const result = migrateProjectData()
    expect(result.projectsSplit.sort()).toEqual(['pa', 'pb'])
    expect(result.removed).toBe(true)
    expect(JSON.parse(readFileSync(join(shared, '.corum', 'project', 'corum_project_pa', 'requirements', 'req-1.json'), 'utf8')).record.title).toBe('A')
    expect(JSON.parse(readFileSync(join(shared, '.corum', 'project', 'corum_project_pb', 'requirements', 'req-2.json'), 'utf8')).record.title).toBe('B')
  })
})

/** readdir 安全包装（测试内使用）。 */
function readdirSafe0(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
