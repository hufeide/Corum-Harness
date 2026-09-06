/**
 * BottomPanel — the IDE terminal region (design.pen ⑥, 浅 xGd58 / 深 mOtXy).
 * A normal grid leaf like every other region — resizable and freely composable
 * with the rest, no special floating/fixed semantics. Structure follows the
 * design frame: tabs (bU2zf: pt-终端 active glass-2 + active-border r10
 * pad[6,12] + spacer + × close) → term (JYZCL: 真实 xterm.js 终端，JetBrains
 * Mono，经 host corumTerminal RPC 驱动 node-pty 登录 shell)。
 * The × close hides this leaf via `ctx.layout.closeRegion`.
 *
 * 真实终端接线（0.1.2 换真）：
 *   - onMount：`create` 拿会话 id → 启动 ~60ms 轮询循环（`poll` 拉输出
 *     `term.write(data)`）→ xterm `onData` 调 `write` 透传输入 →
 *     ResizeObserver 触发 FitAddon.fit() + `resize` 同步行列 → unmount /
 *     关闭区域时 `kill` + 清轮询。
 *   - 输出回流走「缓冲区 + 轮询拉取」（coding combo 无 stream 桥，见 host
 *     corum-terminal.ts 模块注释）。
 */
import { useEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import css from './BottomPanel.module.css'

/** RPC 信封（host Typert Remote：成功 `{ok:true,value}` / 失败 `{ok:false,error}`）。 */
interface RpcEnvelope<T> {
  ok: boolean
  value?: T
  error?: { message?: string }
}

/** 本插件的注入面（见 client/index.ts apply：connection.rpc.call 封装 + closeRegion）。 */
export interface BottomPanelInjected {
  /** 关闭本区域（隐藏叶子，可在插件中心「视图管理」恢复）。 */
  closeRegion: () => void
  /** spawn 登录 shell 会话（host node-pty；cwd 缺省 host 进程 cwd = 项目根）。 */
  create: () => Promise<RpcEnvelope<{ id: string }>>
  /** 向会话写输入（xterm onData 原样透传）。 */
  writeTerm: (id: string, data: string) => Promise<RpcEnvelope<{ written: boolean }>>
  /** 同步窗口尺寸（FitAddon.fit() 后）。 */
  resizeTerm: (id: string, cols: number, rows: number) => Promise<RpcEnvelope<{ resized: boolean }>>
  /** 拉走累积输出（轮询数据源；返回后 host 清缓冲）。 */
  poll: (id: string) => Promise<RpcEnvelope<{ data: string; exited: boolean; exitCode?: number }>>
  /** 终止会话（幂等）。 */
  kill: (id: string) => Promise<RpcEnvelope<{ killed: boolean }>>
}

/** Composed props: the shell's owner share + 本插件注入面。 */
export type BottomPanelProps = PropsRuntime<'corum.panel'> & BottomPanelInjected

/** 轮询周期（ms）：够低保证交互流畅，又不至于打满 unary RPC 桥。 */
const POLL_INTERVAL_MS = 60

/** The IDE terminal panel (real xterm.js driven by host node-pty; see module doc). */
export function BottomPanel({ closeRegion, create, writeTerm, resizeTerm, poll, kill }: BottomPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    // xterm 主题：透明背景融入玻璃卡（RegionCard 基座承载玻璃外观），前景/光标/
    // 选区对齐现有 data-tone 终端配色与 ide-ui theme.css 的 --corum-*/--dsw-* 设计
    // token。xterm 主题要具体色值（不吃 var()），但 var() 可内联进 CSS 颜色字符串——
    // xterm ITheme 接受任意 CSS color，故直接用 var() 引用设计 token（明暗主题随动）。
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', 'Menlo', monospace",
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 2000,
      allowProposedApi: true,
      theme: {
        background: '#00000000',
        foreground: 'var(--dsw-alias-label-primary)',
        cursor: 'var(--dsw-alias-brand-text)',
        cursorAccent: '#00000000',
        selectionBackground: 'var(--corum-glass-3, rgba(128,128,128,0.35))',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

    // 会话 id 与轮询定时器（create 成功后填充）。
    let sessionId: string | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let disposed = false
    // 未 attach 前的 kill 防护：unmount 若抢在 create resolve 前，记录后补杀。
    let killRequested = false

    const stopPolling = (): void => {
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const startPolling = (id: string): void => {
      pollTimer = setInterval(() => {
        void poll(id).then((res) => {
          if (disposed) return
          if (!res.ok || res.value === undefined) return
          const { data, exited } = res.value
          if (data !== '') term.write(data)
          if (exited) {
            stopPolling()
            term.write('\r\n\x1b[2m[进程已退出]\x1b[0m\r\n')
          }
        }).catch(() => {
          // 单周期 RPC 失败（连接瞬断）不致命——下周期重试。
        })
      }, POLL_INTERVAL_MS)
    }

    // 输入透传：xterm onData（键盘/粘贴/控制序列）→ host pty。
    const dataSub = term.onData((data) => {
      if (sessionId === null) return
      void writeTerm(sessionId, data).catch(() => {})
    })

    // 尺寸同步：FitAddon.fit() 量出真实行列 → 同步给 host pty。
    const applyFit = (): void => {
      try {
        fit.fit()
      } catch {
        return // 容器尚未布局（display:none / 0 尺寸）时 fit 抛错，跳过本轮。
      }
      if (sessionId !== null) {
        void resizeTerm(sessionId, term.cols, term.rows).catch(() => {})
      }
    }
    // 容器尺寸变化（拖拽调整 grid 叶子）→ 重排。
    const resizeObserver = new ResizeObserver(() => { applyFit() })
    resizeObserver.observe(container)

    // 初次布局（open 后下一帧，容器已有真实尺寸）。
    applyFit()

    // 建会话 → 拿 id → 起轮询；此时再把当前行列补同步一次（create 默认 80×24）。
    void create().then((res) => {
      if (disposed || killRequested) {
        // unmount 抢在 create resolve 前：补杀刚建好的会话防泄漏。
        if (res.ok && res.value !== undefined) void kill(res.value.id).catch(() => {})
        return
      }
      if (!res.ok || res.value === undefined) {
        term.write(`\x1b[31m[终端启动失败: ${res.error?.message ?? 'unknown error'}]\x1b[0m\r\n`)
        return
      }
      sessionId = res.value.id
      startPolling(sessionId)
      applyFit()
    }).catch((error) => {
      if (!disposed) term.write(`\x1b[31m[终端启动失败: ${String(error)}]\x1b[0m\r\n`)
    })

    return () => {
      disposed = true
      stopPolling()
      resizeObserver.disconnect()
      dataSub.dispose()
      if (sessionId !== null) {
        void kill(sessionId).catch(() => {})
      } else {
        killRequested = true
      }
      term.dispose()
    }
    // 注入面方法在 plugin 生命周期内稳定（index.ts apply 闭包），只需挂一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={css.panel}>
      <div className={css.tabs}>
        <span className={css.tabActive}>终端</span>
        <span className={css.spacer} />
        {/* × 关闭：终端已纳入网格，隐藏本叶子（可在插件中心「视图管理」恢复）。 */}
        <button
          type="button"
          className={css.close}
          title="关闭此区域（可在插件中心「视图管理」恢复）"
          onClick={closeRegion}
        >
          <X size={17} strokeWidth={2} />
        </button>
      </div>
      {/* xterm 挂载点：填满 .term 区域（CSS 里 flex:1 + 内边距由 xterm 自带）。 */}
      <div className={css.term} ref={containerRef} />
    </div>
  )
}
