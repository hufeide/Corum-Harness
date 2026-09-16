/**
 * corum-desktop 通知服务（框架级）：任何 combo 可用的应用内 toast 通知。
 *
 * 设计来源：design.pen「row-通知框」（YbfO9，深色 g5jAt / 浅色 QEM1e）——
 * 右下角纵向堆叠的**单行** toast：状态图标（16，state-*）+ 标题（12/600
 * label-primary）/副文案（10.5 label-secondary）+ 相对时间（JetBrains Mono
 * 9.5 label-tertiary）+ 关闭 ×（16 框内 9 图标）。宽 340、圆角 14、
 * padding 10/12、gap 9、玻璃底 $glass-1 + 外阴影 0 10 28 #0000003D。
 * 本模块是无 React 依赖的 store（subscribe/getSnapshot），UI 由
 * NotificationHost 挂载；生产方（HMR 失败、会话事件、任意插件）只调 notify()。
 *
 * 框架定位：这是 corum-desktop 提供的基础能力，不限 dev——HMR 失败只是
 * 第一个消费方。通知服务本身常驻，任何 combo 的生产方都可经 ctx 或
 * 直接 import notify() 发通知。
 * @module corum-desktop/client/notifications
 */

/** 通知语义色（对应设计稿状态图标配色 $state-*）。 */
export type NotificationTone = 'success' | 'warn' | 'info' | 'error'

/** 一条通知（结构 = 设计稿 toast 单行四元素）。 */
export interface CorumNotification {
  id: string
  /** 语义色，决定状态图标与配色（默认 info）。 */
  tone: NotificationTone
  /** 标题（12/600 $label-primary）。 */
  title: string
  /** 副文案（10.5 $label-secondary，缺省只显示标题）。 */
  message?: string
  /** 创建时间戳（ms），相对时间显示用。 */
  createdAt: number
  /**
   * 已自动收起（design.pen `drawer-tab`：右下角 bell 常驻图标 + 未读数）。
   * 由 NotificationHost 在 5s 未处理后置位；展开列表可重新看到它。
   */
  collapsed: boolean
  /**
   * 已读（用户已确认）。未读数 = `!read` 的条数，即 bell 徽标数字；
   * 「全部已读」把它们一次置位 → 徽标消失（设计稿：无未读时不渲染 bell）。
   */
  read: boolean
  /**
   * 点击整条通知时的动作（如「打开来源会话」）。
   *
   * 存**函数**而非 `sessionId` 字符串：跳转需要 `ctx.sessions.open`，那是
   * cordis 服务面、不能跨 bundle 放进 store 的可序列化数据里（红线 1）；
   * 由生产方在 install 时闭包捕获，store 只负责持有与调用。
   */
  onOpen?: (() => void) | undefined
}

/**
 * 通知偏好（PRD v2 §4.4 NO1/NO2/NO4）。
 *
 * 语义（与设置页一一对应）：
 * - `enabled`：「任务完成时通知」总开关。关闭后**任何**通知都不进栈
 *   （toast / bell / 通知中心 / 托盘未读数同源，故一处拦截全链路静默）。
 * - `sound`：「通知声音」。通知到达时播放一声短提示音（WebAudio 合成，
 *   无音频资源文件）。初始默认**关**——声音是侵入性反馈，未经用户开启
 *   不应出声（与 PRD §6.1「不伪造状态」同原则：默认开会让用户在不知情
 *   时被发声）。
 * - `dnd`：「勿扰模式」。开启后不弹出任何通知（设计稿另有起止时段，
 *   属后续增量；本期先兑现开关维度，见 PRD §4.4 NO4 的「设计稿比代码
 *   多时段维度」裁定）。
 */
export interface NotificationPrefs {
  enabled: boolean
  sound: boolean
  dnd: boolean
}

/** bell 吸附的屏幕边缘（决定圆角朝向与定位轴）。 */
export type BellEdge = 'left' | 'right' | 'top' | 'bottom'

/** bell 位置：贴在 `edge` 上，沿轴偏移 `offset` px（跨窗口缩放比绝对坐标稳健）。 */
export interface BellPosition {
  edge: BellEdge
  /** 贴 left/right 时为距视口顶部的 px；贴 top/bottom 时为距视口左侧的 px。 */
  offset: number
}

/** 通知的非 items UI 状态（通知中心开合 + bell 位置）。 */
export interface NotificationUiSnapshot {
  readonly panelOpen: boolean
  readonly bell: BellPosition
}

/** 通知 store 的可订阅快照。 */
export interface NotificationStore {
  getSnapshot(): readonly CorumNotification[]
  subscribe(listener: () => void): () => void
  /** 发一条通知，返回其 id（供调用方后续 dismiss）。 */
  notify(input: Omit<CorumNotification, 'id' | 'createdAt' | 'collapsed' | 'read'> & { createdAt?: number }): string
  /** 触发一条通知的点击动作（无动作时 no-op）。 */
  open(id: string): void
  /**
   * 标记**单条**已读（点击该条 = 已确认）。
   *
   * 与 `markAllRead`（面板上的「全部已读」）并列：点击一条只该消掉它自己的未读，
   * 旧实现点完没有任何已读副作用 —— 面板注释写着「点击 = 已确认：先标已读」，
   * 但 `open(id)` 只跑 `onOpen` 动作，于是 bell 徽标点多少次都不减（2026-09-12 实测：
   * 点过一条后 aria 仍是「通知（5 条未读）」）。
   */
  markRead(id: string): void
  /** 关闭指定通知（从列表移除）。 */
  dismiss(id: string): void
  /** 收起一条通知（5s 未处理 → 右下角 tray）。 */
  collapse(id: string): void
  /** 展开全部已收起通知（点 bell）。 */
  expandAll(): void
  /** 清空全部通知。 */
  clear(): void
  /** 全部已读：未读数清零（bell 随之隐藏）并收起通知中心。 */
  markAllRead(): void
  /** 通知中心（展开列表）是否打开。 */
  isPanelOpen(): boolean
  /** 打开/收起通知中心（手动收起与自动收起共用同一状态机）。 */
  setPanelOpen(open: boolean): void
  /** 订阅「通知中心开合 / bell 位置」这类非 items 状态的变化。 */
  subscribeUi(listener: () => void): () => void
  /**
   * 非 items 的 UI 状态快照（uSES 源）。
   *
   * ⚠️ 必须**引用稳定**：值不变时返回同一个对象，否则 uSES 每次比较都判定变化 →
   * 无限重渲染（通知拖动是本项唯一的写方，故用「写时换新对象」实现）。
   */
  getUiSnapshot(): NotificationUiSnapshot
  /** 当前 bell 位置（用户拖动吸附后的结果；缺省右下角）。 */
  getBellPosition(): BellPosition
  /** 设置 bell 位置（拖动松手吸附后调用；内部持久化到 localStorage）。 */
  setBellPosition(position: BellPosition): void
  /** 通知偏好快照（uSES 源；引用稳定——值不变时返回同一对象）。 */
  getPrefs(): NotificationPrefs
  /**
   * 更新通知偏好（局部更新；内部持久化到 localStorage）。
   *
   * 写方是设置页（跨 bundle，经 `ctx.notifications` cordis 服务拿到同一
   * 实例——root `reflect.store` 保证单例，红线 1 合规，非 window 全局）。
   */
  setPrefs(patch: Partial<NotificationPrefs>): void
  /** 订阅偏好变化（设置页回显用；与 items / ui 两个订阅集并列）。 */
  subscribePrefs(listener: () => void): () => void
}

/** bell 位置的持久化键（UI 偏好，不参与跨 bundle 共享状态）。 */
const BELL_POSITION_KEY = 'corum.notifications.bell'

/** 通知偏好的持久化键（PRD §4.4：通知开关此前**无任何持久化**，本期新建）。 */
const PREFS_KEY = 'corum.notifications.prefs'

/** 缺省偏好：通知开、声音关、勿扰关（理由见 NotificationPrefs 注释）。 */
const DEFAULT_PREFS: NotificationPrefs = { enabled: true, sound: false, dnd: false }

/** 缺省位置：右下角、距底 120px（与旧实现 `bottom: 120px` 视觉一致）。 */
const DEFAULT_BELL_POSITION: BellPosition = { edge: 'right', offset: 120 }

/** 读持久化的 bell 位置（异常数据回退缺省值）。 */
function readBellPosition(): BellPosition {
  if (typeof localStorage === 'undefined') return DEFAULT_BELL_POSITION
  try {
    const raw = localStorage.getItem(BELL_POSITION_KEY)
    if (raw === null) return DEFAULT_BELL_POSITION
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_BELL_POSITION
    const { edge, offset } = parsed as { edge?: unknown; offset?: unknown }
    if (edge !== 'left' && edge !== 'right' && edge !== 'top' && edge !== 'bottom') return DEFAULT_BELL_POSITION
    if (typeof offset !== 'number' || !Number.isFinite(offset)) return DEFAULT_BELL_POSITION
    return { edge, offset }
  } catch {
    return DEFAULT_BELL_POSITION
  }
}

/** 读持久化的通知偏好（异常数据回退缺省值；逐字段校验，坏字段单独回退）。 */
function readPrefs(): NotificationPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw === null) return DEFAULT_PREFS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS
    const { enabled, sound, dnd } = parsed as { enabled?: unknown; sound?: unknown; dnd?: unknown }
    return {
      enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_PREFS.enabled,
      sound: typeof sound === 'boolean' ? sound : DEFAULT_PREFS.sound,
      dnd: typeof dnd === 'boolean' ? dnd : DEFAULT_PREFS.dnd,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

/** 提示音的 AudioContext（懒建；浏览器要求用户手势后才能出声，故首次播放可能静默降级）。 */
let audioCtx: AudioContext | null = null

/**
 * 播一声短提示音（WebAudio 合成正弦短音：880Hz、120ms、指数衰减包络）。
 *
 * 为什么不用 `<audio src>`：无音频资源文件可引，且 WebAudio 合成零资产、
 * 零网络、可调参。自动播放策略下 `AudioContext` 可能处于 suspended ——
 * 调 `resume()` 尝试恢复，失败静默（通知本身已弹出，声音只是增强）。
 */
function playChime(): void {
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    const now = audioCtx.currentTime
    gain.gain.setValueAtTime(0.12, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12)
    osc.connect(gain).connect(audioCtx.destination)
    osc.start(now)
    osc.stop(now + 0.13)
  } catch {
    // 无声环境下静默降级（通知 UI 不受影响）。
  }
}

/** 创建通知 store（单实例由桌面壳持有并暴露）。 */
export function createNotificationStore(): NotificationStore {
  let items: readonly CorumNotification[] = []
  const listeners = new Set<() => void>()
  const uiListeners = new Set<() => void>()
  const prefsListeners = new Set<() => void>()
  let panelOpen = false
  let bellPosition: BellPosition = readBellPosition()
  let prefs: NotificationPrefs = readPrefs()
  // UI 快照引用稳定（值不变时返回同一对象；见 getUiSnapshot 的注释）。
  let uiSnapshot: NotificationUiSnapshot = { panelOpen, bell: bellPosition }
  const syncUi = (): void => { uiSnapshot = { panelOpen, bell: bellPosition } }
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[corum-desktop] notification listener threw:', error)
      }
    }
  }
  /** 通知中心开合 / bell 位置变化：items 未变，故走独立的订阅集。 */
  const emitUi = (): void => {
    syncUi()
    for (const listener of [...uiListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[corum-desktop] notification ui listener threw:', error)
      }
    }
  }
  /** 偏好变化：独立订阅集（设置页回显只关心偏好，不随 items 重渲染）。 */
  const emitPrefs = (): void => {
    for (const listener of [...prefsListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[corum-desktop] notification prefs listener threw:', error)
      }
    }
  }
  return {
    getSnapshot: () => items,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    subscribeUi: (listener) => {
      uiListeners.add(listener)
      return () => { uiListeners.delete(listener) }
    },
    getUiSnapshot: () => uiSnapshot,
    getPrefs: () => prefs,
    setPrefs: (patch) => {
      const next: NotificationPrefs = {
        enabled: patch.enabled ?? prefs.enabled,
        sound: patch.sound ?? prefs.sound,
        dnd: patch.dnd ?? prefs.dnd,
      }
      if (next.enabled === prefs.enabled && next.sound === prefs.sound && next.dnd === prefs.dnd) return
      prefs = next
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(PREFS_KEY, JSON.stringify(next))
        } catch {
          // 持久化失败不影响本次会话内的偏好。
        }
      }
      emitPrefs()
    },
    subscribePrefs: (listener) => {
      prefsListeners.add(listener)
      return () => { prefsListeners.delete(listener) }
    },
    getBellPosition: () => bellPosition,
    setBellPosition: (position) => {
      if (bellPosition.edge === position.edge && bellPosition.offset === position.offset) return
      bellPosition = position
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(BELL_POSITION_KEY, JSON.stringify(position))
        } catch {
          // 持久化失败不影响本次会话内的拖动结果。
        }
      }
      emitUi()
    },
    isPanelOpen: () => panelOpen,
    setPanelOpen: (open) => {
      if (panelOpen === open) return
      panelOpen = open
      emitUi()
    },
    notify: (input) => {
      // 偏好拦截（PRD §4.4）：总开关关闭或勿扰开启时通知**不进栈**。
      //
      // 返回 ''（而非随机 id）：调用方拿 '' 调 dismiss/open 均为 no-op，语义安全。
      // ⚠️ notification-bridge 的同键去重登记「键→id」，勿扰期间键不登记 ⇒
      // 偏好恢复后同键新事件能正常发新条（不会卡在指向已消失旧条的死登记上）。
      if (!prefs.enabled || prefs.dnd) return ''
      const id = `ntf-${crypto.randomUUID()}`
      const next: CorumNotification = {
        id,
        tone: input.tone ?? 'info',
        title: input.title,
        createdAt: input.createdAt ?? Date.now(),
        collapsed: false,
        read: false,
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.onOpen === undefined ? {} : { onOpen: input.onOpen }),
      }
      items = [...items, next]
      emit()
      if (prefs.sound) playChime()
      return id
    },
    open: (id) => {
      const target = items.find(n => n.id === id)
      if (target?.onOpen === undefined) return
      try {
        target.onOpen()
      } catch (error) {
        console.error('[corum-desktop] notification open action threw:', error)
      }
    },
    markRead: (id) => {
      if (!items.some(n => n.id === id && !n.read)) return
      items = items.map(n => (n.id === id ? { ...n, read: true } : n))
      emit()
    },
    dismiss: (id) => {
      if (!items.some(n => n.id === id)) return
      items = items.filter(n => n.id !== id)
      emit()
    },
    collapse: (id) => {
      if (!items.some(n => n.id === id && !n.collapsed)) return
      items = items.map(n => (n.id === id ? { ...n, collapsed: true } : n))
      emit()
    },
    expandAll: () => {
      if (!items.some(n => n.collapsed)) return
      items = items.map(n => (n.collapsed ? { ...n, collapsed: false } : n))
      emit()
    },
    markAllRead: () => {
      // 未读清零 → bell 隐藏；通知中心一并收起（设计稿：无未读时不渲染 bell）。
      const changed = items.some(n => !n.read)
      if (changed) items = items.map(n => (n.read ? n : { ...n, read: true }))
      if (changed) emit()
      if (panelOpen) {
        panelOpen = false
        emitUi()
      }
    },
    clear: () => {
      if (items.length === 0) return
      items = []
      emit()
    },
  }
}
