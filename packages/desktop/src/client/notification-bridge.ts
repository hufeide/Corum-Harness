/**
 * 事件 → 通知桥（corum-desktop）：把「用户真正关心」的领域事件接进通知栏。
 *
 * 背景（2026-09-10 用户「我怎么没看到通知栏呢…要把一些常用的事件接入通知栏」）：
 * 通知通道本身早就通了（`notifications.ts` + `NotificationHost`），但**只有两个
 * 消费方**——HMR 失败与两处聊天错误路径，全是罕见失败分支。于是通知栏在日常使用中
 * 从不出现，用户根本看不到它。本模块补上「常用事件」这一层。
 *
 * 选型原则（三条，避免把通知栏做成噪音源）：
 *   ① **只接「用户需要知道、且不在当前视野里」的事件**——异步完成、失败、需要决策。
 *      高频过程事件（`corum/terminal/output`、`corum/file/changed`、
 *      `corum/subagent/progress`）**一律不接**：它们每帧都可能变，接了就是刷屏。
 *   ② **同键去重**：同一实体（同一子会话 / 同一任务 / 同一 worktree）的同类事件
 *      合并成一条并刷新其内容，而不是不断堆新条（否则一次 orchestrate 会吐 N 条）。
 *   ③ **可点击跳转**：通知带 `sessionId` 时，点整条即打开来源会话
 *      （`ctx.sessions.open`）——这是通知从「提示」变成「入口」的关键。
 *
 * 接入清单（`docs/TODO.md` 的「通知栏接入常用事件」）：
 *   - `corum/task/completed`     任务闭环        → success「任务完成」
 *   - `corum/task/stalled`       任务卡住        → warn「任务疑似卡住」
 *   - `corum/task/blocked`       任务遇阻        → warn「任务被阻塞」
 *   - `corum/task/deferred`      派发失败重试    → warn「派发失败，已重试」
 *   - `corum/task/evicted`       未执行被逐出    → error「任务被逐出队列」
 *   - `corum/task/cancelled`     任务中止        → warn「任务已中止」
 *   - `corum/subagent/child` + `corum/subagent/progress` → 子 Agent 完成（同键合并）
 *   - `corum/worktree-ledger`    隔离分支待集成  → info（同 session 合并）
 *   - `corum/artgen/download-progress` / `corum/ollama/download-progress`
 *                                下载完成/失败   → success/error（同槽位合并）
 *
 * @module corum-desktop/client/notification-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { NotificationStore, NotificationTone } from './notifications.ts'

/** `ctx.remote` 的窄化面（只用到转发事件订阅）。 */
interface RemoteFace {
  $on: (event: string, listener: (frame: never) => void) => () => void
}

/** 发通知所需的最小会话打开面（`ctx.sessions.open`）。 */
interface SessionsFace {
  open: (sessionId: never) => void
}

/** 事件帧里可能出现的会话身份字段（按事件类型取其一）。 */
interface SessionBearing {
  sessionId?: string
  resultRef?: { sessionId?: string }
  task?: { sessionId?: string; label?: string; id?: string }
}

/** 任务事件帧（`corum/task/*` 的并集窄化）。 */
interface TaskFrame extends SessionBearing {
  task?: {
    id?: string
    label?: string
    entityId?: string
    profileId?: string
  }
  /** `corum/task/completed` 的完成说明（complete_task 上报原文）。 */
  result?: string
  reason?: string
  idleSec?: number
  fate?: string
  sessionId?: string
}

/** 子 Agent 进度帧（`corum/subagent/progress`）。 */
interface SubagentProgressFrame {
  sessionId?: string
  turn?: number
  step?: number
  currentAction?: string
  done?: boolean
}

/** 子 Agent spawn 帧（`corum/subagent/child`）。 */
interface SubagentChildFrame {
  parentSessionId?: string
  callId?: string
  childSessionId?: string
  label?: string
  mode?: 'foreground' | 'background'
}

/** 隔离台账帧（`corum/worktree-ledger`）。 */
interface WorktreeLedgerFrame {
  sessionId?: string
  entries?: ReadonlyArray<{ slug?: string; branch?: string; status?: string }>
  pending?: number
}

/** 下载进度帧（artgen / ollama 共用字段子集）。 */
interface DownloadFrame {
  key?: 'engine' | 'model'
  percent?: number
  status?: string
  error?: string
  target?: string
}

/**
 * 去重键 → 已发通知 id 的登记表。
 *
 * ⚠️ 为什么在模块级（而非闭包里）：同一个键的事件可能跨越多次 `apply`
 * （插件重载）；放模块级保证重载后仍能续用同一条通知、不重复堆。
 * 这是「进程内 UI 记账」，不是跨 bundle 共享状态，故不违反红线 1。
 */
const liveByKey = new Map<string, string>()

/** 取任务的展示名（label 优先，兜底 id 末段）。 */
function taskLabel(frame: TaskFrame): string {
  const label = frame.task?.label
  if (label !== undefined && label !== '') return label
  const id = frame.task?.id
  if (id !== undefined && id !== '') return id.length > 18 ? `${id.slice(0, 18)}…` : id
  return '未命名任务'
}

/** 取帧里携带的会话 id（任务事件给 resultRef.sessionId，子 Agent 给 sessionId）。 */
function frameSessionId(frame: SessionBearing): string | undefined {
  return frame.sessionId ?? frame.resultRef?.sessionId ?? frame.task?.sessionId
}

/** 截断长文案（通知副文案是单行，过长会被 ellipsis 吃掉关键信息）。 */
function clip(text: string, max = 90): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** 发布/更新一条通知（同键合并：已有则先撤旧的再发新的）。 */
function publish(
  store: NotificationStore,
  key: string,
  input: { tone: NotificationTone; title: string; message?: string },
  onOpen?: (() => void) | undefined,
): void {
  const previous = liveByKey.get(key)
  if (previous !== undefined) store.dismiss(previous)
  const id = store.notify({
    tone: input.tone,
    title: input.title,
    ...input.message === undefined ? {} : { message: input.message },
    ...onOpen === undefined ? {} : { onOpen },
  })
  liveByKey.set(key, id)
}

/** `window.corumDesktop` 的窄化面（只用到系统通知两项；本地能力接口，红线 3）。 */
interface NativeNotifyBridge {
  notifyNative?: (request: {
    title: string
    body?: string
    silent?: boolean
    notificationId?: string
  }) => Promise<{ ok: boolean; error?: string }>
  onNativeNotificationClick?: (callback: (payload: { notificationId: string | null }) => void) => () => void
}

/** 取桌面桥（非桌面壳环境返回 undefined，调用方静默降级）。 */
function nativeBridge(): NativeNotifyBridge | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { corumDesktop?: NativeNotifyBridge }).corumDesktop
}

/**
 * 把应用内通知**镜像到 macOS 系统通知中心**（2026-09-10 用户定调「先做 macOS」）。
 *
 * 三条设计规则（决定用户体验好坏，不是可选项）：
 *   ① **只在窗口失焦/隐藏时发**——窗口在前台时应用内 toast 已经够，再弹系统通知
 *      是重复打扰。判据 `document.hasFocus() && document.visibilityState === 'visible'`。
 *   ② **点击走既有 `onOpen` 通路**——主进程负责唤醒窗口，renderer 收到点击回传后
 *      调用 `store.open(id)`，于是「打开来源会话」等动作全部复用，无需第二套语义。
 *   ③ **失败静默降级**——非 macOS / 权限被拒 / 平台不支持时 `notifyNative` 返回
 *      `ok:false`，应用内 toast 仍在，用户不会失去信息（只是少了系统级提示）。
 *
 * @param store - 通知 store（作为「新通知出现」的事件源）。
 * @returns 退订函数。
 */
export function installNativeNotificationMirror(store: NotificationStore): () => void {
  const bridge = nativeBridge()
  if (bridge?.notifyNative === undefined) return () => {}

  // 已镜像过的通知 id（store 是快照订阅，同一条会在多次 emit 里重复出现）。
  const mirrored = new Set<string>()

  // 点击回传：主进程已唤醒窗口，这里执行通知自带的动作。
  const disposeClick = bridge.onNativeNotificationClick?.((payload) => {
    const id = payload.notificationId
    if (id === null || id === '') return
    store.open(id)
    store.setPanelOpen(false)
  }) ?? (() => {})

  const unsubscribe = store.subscribe(() => {
    const next = store.getSnapshot()
    // 窗口在前台：不镜像（应用内 toast 已足够）。
    const focused = typeof document !== 'undefined'
      && document.hasFocus()
      && document.visibilityState === 'visible'
    if (!focused) {
      for (const item of next) {
        if (mirrored.has(item.id)) continue
        mirrored.add(item.id)
        void bridge.notifyNative?.({
          title: item.title,
          ...item.message === undefined ? {} : { body: item.message },
          notificationId: item.id,
        })
      }
    } else {
      // 前台时也登记 id：切到后台后不该把「刚才前台已看到」的旧通知补弹一遍。
      for (const item of next) mirrored.add(item.id)
    }
  })

  // 首帧快照（挂载前已存在的通知不补发——它们多半已被看到）。
  for (const item of store.getSnapshot()) mirrored.add(item.id)

  return () => {
    unsubscribe()
    disposeClick()
  }
}

/**
 * 把常用事件接进通知栏。
 *
 * 调用方应在 `ctx.inject(['remote','sessions','notifications'], …)` 内调用，
 * 并把返回的清理函数挂到 `ctx.effect`（随插件生命周期退订）。
 * @param ctx - 已解析出 three 个依赖的上下文。
 * @param store - 通知 store（`ctx.notifications`）。
 * @returns 退订函数。
 */
export function installNotificationBridge(ctx: Context, store: NotificationStore): () => void {
  const remote = ctx.get('remote') as RemoteFace | undefined
  const sessions = ctx.get('sessions') as SessionsFace | undefined
  if (remote === undefined) return () => {}

  /** 打开来源会话（无 sessions 面无 sessionId 时不挂跳转）。 */
  const opener = (sessionId: string | undefined): (() => void) | undefined => {
    if (sessionId === undefined || sessionId === '' || sessions === undefined) return undefined
    return () => { sessions.open(sessionId as never) }
  }

  const disposers: Array<() => void> = []
  const on = <T>(event: string, handler: (frame: T) => void): void => {
    disposers.push(remote.$on(event, handler as (frame: never) => void))
  }

  // ── 任务事件（corum/task/*）────────────────────────────────────────────
  on<TaskFrame>('corum/task/completed', (frame) => {
    const label = taskLabel(frame)
    publish(store, `task:${frame.task?.id ?? label}:completed`, {
      tone: 'success',
      title: '任务完成',
      message: clip(frame.result ?? `${label} 已闭环`),
    }, opener(frameSessionId(frame)))
  })

  on<TaskFrame>('corum/task/stalled', (frame) => {
    const label = taskLabel(frame)
    const idle = frame.idleSec
    publish(store, `task:${frame.task?.id ?? label}:stalled`, {
      tone: 'warn',
      title: '任务疑似卡住',
      message: idle === undefined ? label : `${label} · 已 ${Math.round(idle)}s 无活动`,
    }, opener(frameSessionId(frame)))
  })

  on<TaskFrame>('corum/task/blocked', (frame) => {
    const label = taskLabel(frame)
    publish(store, `task:${frame.task?.id ?? label}:blocked`, {
      tone: 'warn',
      title: '任务被阻塞',
      message: clip(`${label}：${frame.reason ?? '等待前置信息'}`),
    }, opener(frameSessionId(frame)))
  })

  on<TaskFrame>('corum/task/deferred', (frame) => {
    const label = taskLabel(frame)
    publish(store, `task:${frame.task?.id ?? label}:deferred`, {
      tone: 'warn',
      title: '派发失败，已放回队列重试',
      message: clip(`${label}：${frame.reason ?? '未知原因'}`),
    }, opener(frameSessionId(frame)))
  })

  on<TaskFrame>('corum/task/evicted', (frame) => {
    const label = taskLabel(frame)
    publish(store, `task:${frame.task?.id ?? label}:evicted`, {
      tone: 'error',
      title: '任务被逐出队列',
      message: clip(frame.reason === undefined ? `${label} 未执行即被逐出` : `${label}：${frame.reason}`),
    }, opener(frameSessionId(frame)))
  })

  on<TaskFrame>('corum/task/cancelled', (frame) => {
    const label = taskLabel(frame)
    const fate = frame.fate
    publish(store, `task:${frame.task?.id ?? label}:cancelled`, {
      tone: 'warn',
      title: '任务已中止',
      message: `${label}${fate === undefined ? '' : ` · ${fate}`}`,
    }, opener(frameSessionId(frame)))
  })

  // ── 子 Agent：spawn 记账 + 结算通知（同 callId 合并）──────────────────
  //
  // 机制：`corum/subagent/child`（spawn 那一刻的精确父子映射）建账，
  // `corum/subagent/progress`（子会话事件增量折叠）判完成。**只在 done 时提示**——
  // 启动提示属于「已经知道的事」（父 Agent 刚派发），且 orchestrate 会一次派 N 个，
  // 逐条提示就是刷屏（选型原则①）。
  const childLabels = new Map<string, { label: string; parentSessionId?: string }>()
  on<SubagentChildFrame>('corum/subagent/child', (frame) => {
    const child = frame.childSessionId
    if (child === undefined || child === '') return
    childLabels.set(child, {
      label: frame.label === undefined || frame.label === '' ? '子 Agent' : frame.label,
      ...frame.parentSessionId === undefined ? {} : { parentSessionId: frame.parentSessionId },
    })
  })

  on<SubagentProgressFrame>('corum/subagent/progress', (frame) => {
    if (frame.done !== true) return
    const child = frame.sessionId
    if (child === undefined || child === '') return
    const known = childLabels.get(child)
    const label = known?.label ?? '子 Agent'
    // 结算后清账（下次同名 label 是新的一轮）。
    childLabels.delete(child)
    publish(store, `subagent:${child}:done`, {
      tone: 'success',
      title: '子 Agent 完成',
      message: frame.step === undefined ? label : `${label} · Step ${frame.step}`,
    }, opener(known?.parentSessionId ?? child))
  })

  // ── 隔离分支待集成（同父会话合并成一条）──────────────────────────────
  on<WorktreeLedgerFrame>('corum/worktree-ledger', (frame) => {
    const parent = frame.sessionId
    const pending = frame.pending ?? 0
    if (parent === undefined || parent === '') return
    if (pending === 0) {
      // 全部集成/丢弃 → 撤掉待集成提示（不留过期通知）。
      const stale = liveByKey.get(`worktree:${parent}`)
      if (stale !== undefined) { store.dismiss(stale); liveByKey.delete(`worktree:${parent}`) }
      return
    }
    const branches = (frame.entries ?? [])
      .filter(entry => entry.status === 'active' || entry.status === 'settled')
      .map(entry => entry.branch ?? entry.slug ?? '')
      .filter(branch => branch !== '')
    publish(store, `worktree:${parent}`, {
      tone: 'info',
      title: `${pending} 个隔离分支待集成`,
      message: clip(branches.join(' · ')),
    }, opener(parent))
  })

  // ── 下载完成 / 失败（同槽位合并；下载中是高频过程事件，不提示）────────
  const download = (slot: string) => (frame: DownloadFrame): void => {
    const status = frame.status
    if (status !== 'done' && status !== 'error') return
    const what = frame.target ?? (slot === 'artgen'
      ? (frame.key === 'engine' ? '文生图引擎' : '文生图模型')
      : 'Ollama 模型')
    const key = `download:${slot}:${frame.key ?? ''}:${frame.target ?? ''}`
    if (status === 'done') {
      publish(store, key, { tone: 'success', title: '下载完成', message: what })
    } else {
      publish(store, key, {
        tone: 'error',
        title: '下载失败',
        message: clip(`${what}${frame.error === undefined ? '' : `：${frame.error}`}`),
      })
    }
  }
  on<DownloadFrame>('corum/artgen/download-progress', download('artgen'))
  on<DownloadFrame>('corum/ollama/download-progress', download('ollama'))

  return () => { for (const dispose of disposers) dispose() }
}
