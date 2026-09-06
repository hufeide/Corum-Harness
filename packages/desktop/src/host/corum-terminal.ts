/**
 * corum-desktop/corum-terminal — 真实终端 Host 半（Typert Remote，service 名
 * `corumTerminal`）。把 IDE 底部面板（corum.panel 槽）的假 TERM_LINES 换成
 * node-pty 驱动的真实登录 shell：renderer 的 xterm.js 经本服务 spawn / 输入 /
 * resize / kill / 轮询输出。
 *
 * 输出回流（统一事件中心一期，2026-09 迁移）：pty.onData 除累积进环形缓冲外，
 * 同步 `ctx.emit('corum/terminal/output', { id, data })`——该事件经 fork 包
 * @corum/corum-api-remotes 的官方 forwarded-Remote-event 通道实时推给
 * renderer（client `ctx.remote.$on('corum/terminal/output', ...)` 直收，
 * 不再依赖 60ms poll）。`poll` 端点与缓冲暂保留作降级兜底（确认 $on 稳定后
 * 二期删除；原「缓冲区 + 轮询拉取」注释见 git 历史）。缓冲钳制
 * `MAX_BUFFER_CHARS`（溢出从头截断保尾部，终端语义取最新输出）。
 *
 * @Remote 方法直接 return value（信封自动包成 `{ ok: true, value }`），失败
 * throw（包成 `{ ok: false, error }`）。
 * @module corum-desktop/corum-terminal
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import * as pty from 'node-pty'
// 拉入 corum 领域事件的 cordis Events 声明（'corum/terminal/output' 等）——
// 声明在 fork 包 @corum/corum-api-remotes 自包含（UNIFIED-EVENT-BUS §2.2 类型
// 安全三段式之一），type-only import 编译期即擦除，无运行时依赖。
import type {} from '@corum/corum-api-remotes/corum-events'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 真实终端服务（IDE 底部面板 xterm.js 的数据源）。 */
    corumTerminal: CorumTerminalService
  }
}

/** 单会话环形缓冲上限（字符数）。溢出从头截断保尾部。 */
const MAX_BUFFER_CHARS = 256 * 1024

/** 一个终端会话：pty 句柄 + 待取走的输出缓冲 + 退出状态。 */
interface TerminalSession {
  proc: pty.IPty
  /** onData 累积的输出（client poll 拉走即清）。 */
  buffer: string
  /** 子进程退出码（未退出为 undefined）。 */
  exitCode?: number
  /** 是否已退出（exitCode 可能在异常路径下缺席，故独立标记）。 */
  exited: boolean
}

/**
 * 真实终端 Remote：node-pty 登录 shell 会话管理。
 *
 * 不走 fiber 的 static inject：本服务由 boot 回调在根 ctx 直 new（与
 * CorumFsService 同一模式），无依赖服务。
 */
export class CorumTerminalService extends TypertRemoteService {
  /** 活跃会话表（id → session）。 */
  private sessions = new Map<string, TerminalSession>()

  constructor(ctx: Context) {
    super(ctx, 'corumTerminal')
  }

  /**
   * spawn 一个登录 shell 会话。macOS 用 `process.env.SHELL || '/bin/zsh'`、
   * args `['-l']`（登录 shell 让 PATH/别名等用户配置生效）。cwd 缺省回退
   * host 进程 cwd（IDE 场景即项目根）。
   * @param cwd - 会话初始工作目录（绝对路径；不存在时 node-pty 抛错，信封
   *   自动包成 `{ ok: false, error }`）。
   * @returns 会话 id（后续 write/resize/poll/kill 的句柄）。
   */
  @Remote('create')
  async create(cwd?: string): Promise<{ id: string }> {
    const shell = process.env.SHELL || '/bin/zsh'
    const id = randomUUID()
    let proc: pty.IPty
    try {
      proc = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: cwd ?? process.cwd(),
        env: process.env,
      })
    } catch (error) {
      throw new Error(`cannot spawn shell ${shell}: ${String(error)}`)
    }
    const session: TerminalSession = { proc, buffer: '', exited: false }
    proc.onData((data) => {
      session.buffer += data
      if (session.buffer.length > MAX_BUFFER_CHARS) {
        session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_CHARS)
      }
      // 统一事件中心：pty 输出实时推给 renderer（client $on 直收；poll 端点
      // 保留作降级兜底）。emit 先于缓冲清理无关——载荷是本帧原始数据。
      this.ctx.emit('corum/terminal/output', { id, data })
    })
    proc.onExit(({ exitCode }) => {
      session.exited = true
      session.exitCode = exitCode
    })
    this.sessions.set(id, session)
    return { id }
  }

  /**
   * 向会话写输入（xterm onData 的键盘/粘贴数据原样透传）。
   * @param id - create 返回的会话 id。
   * @param data - 要写入 pty 的数据（含控制序列，如 \r 回车、ANSI）。
   */
  @Remote('write')
  async write(id: string, data: string): Promise<{ written: boolean }> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`unknown terminal session: ${id}`)
    session.proc.write(data)
    return { written: true }
  }

  /**
   * 调整会话窗口尺寸（xterm FitAddon.fit() 后同步给 pty，让 shell 的
   * readline/全屏程序按真实行列排版）。
   * @param id - 会话 id。
   * @param cols - 列数。
   * @param rows - 行数。
   */
  @Remote('resize')
  async resize(id: string, cols: number, rows: number): Promise<{ resized: boolean }> {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`unknown terminal session: ${id}`)
    // pty.resize 对非法尺寸（0/负）抛错；钳到最小 1。
    session.proc.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
    return { resized: true }
  }

  /**
   * 拉走累积的输出（client 轮询循环的数据源）。返回后清空缓冲；附带退出
   * 状态让 client 在 shell 退出后停轮询。
   * @param id - 会话 id。
   * @returns data（本周期新输出，可能为空串）+ exited/exitCode。
   */
  @Remote('poll')
  async poll(id: string): Promise<{ data: string; exited: boolean; exitCode?: number }> {
    const session = this.sessions.get(id)
    if (session === undefined) {
      // 会话不存在（已 kill 或从未创建）：按已退出回报，client 停轮询。
      return { data: '', exited: true }
    }
    const data = session.buffer
    session.buffer = ''
    if (session.exited) {
      // 退出状态的会话最后一次 poll 后即清理（client 拿到 exited 停轮询，
      // 不会再回来；id 残留会让 Map 单调增长）。
      this.sessions.delete(id)
      // exactOptionalPropertyTypes：exitCode 缺席时用条件展开而非显式 undefined。
      return { data, exited: true, ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}) }
    }
    return { data, exited: false }
  }

  /**
   * 终止会话（client unmount / 关闭区域 / 手动 kill）。幂等：id 不存在不
   * 报错（关闭路径可能重复触发）。
   * @param id - 会话 id。
   */
  @Remote('kill')
  async kill(id: string): Promise<{ killed: boolean }> {
    const session = this.sessions.get(id)
    if (session === undefined) return { killed: false }
    this.sessions.delete(id)
    try {
      session.proc.kill()
    } catch {
      // pty 已死亡（子进程先退出）时 kill 抛错——幂等语义下吞掉。
    }
    return { killed: true }
  }
}
