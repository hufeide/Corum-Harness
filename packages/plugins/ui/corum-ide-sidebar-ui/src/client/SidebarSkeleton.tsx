/**
 * SidebarSkeleton — the IDE left column 骨架（design.pen ① 双模式侧栏的壳）。
 *
 * 骨架只做：品牌行（品牌卡 + 版本小字 + 档位徽标）+ 两个子槽渲染
 * （corum.sidebar.sessions / corum.sidebar.project）。内容（会话列表 / 项目模式）
 * 由子槽 occupant 提供——开源版只插 sessions 插件（project 槽空 → 无项目面板，
 * 仅剩任务模式，档位徽标显示「社区版」）。
 *
 * PR1（2026-09）：原 brand-row 的 modeSwitch「项目|任务」滑块**已删除**——模式切换
 * 改由活动栏承担（PR3）。模式状态服务（ctx.layout）与下面的面板联动一行未动：
 * project 槽空时仍强制回落 task（付费插件卸载后的兜底）。
 *
 * 集体脱出：子槽填充物随 corum.sidebar 这一个 grid leaf 的渲染树走，脱出时
 * 整列（含付费版才有项目段）一起进浮动窗，壳无需感知插件拆法。
 *
 * 模式切换反转动画（DESIGN §7.10）：mode 是目标（服务值），restMode
 * 是当前静止面板；两者不一致 = 反转进行中——旧面板 data-flipping="out"（rotateY
 * 0→90° + 淡出 120ms easeIn，绝对定位覆盖在新内容上），新面板 data-flipping="in"
 * （rotateY -90°→0° + 淡入 200ms easeOutExpo，延迟 40ms 起跳 = 与退出重叠 80ms），
 * 总时长后 restMode 对齐 mode。双面板常驻挂载（仅切可见性）保住组件态的语义不变。
 *
 * C3a：模式状态收进 IDE 壳的 cordis 服务（ctx.layout，跨 bundle 单例）——本骨架
 * 经 inject 面的 `useSidebarMode` 选择器 Hook 读（`setSidebarMode` 动作仍由 inject
 * 面提供，供会话域空态操作写同一服务）。原本地 useState + window 全局
 * __corumSidebarMode 广播（空态收敛后已无读端、成死写）已退役。
 *
 * PR2（2026-09）：底部新增 footer 用户区（design.pen Aotdf 画板 D，48px 行）——
 * 分割线 + 左侧「头像 + 本机使用 / 未登录」+ 右侧更新/设置两个图标按钮；点头像
 * 向上弹轻量 popover 菜单。窄轨（非 data-wide）下整个 footer 随骨架直接子级规则
 * 隐藏（.sidebar:not([data-wide]) > :not(.brandRow)）。更新机制尚未存在（无
 * auto-updater），本 PR 只画 UI：红点角标与「v… 可用」均为静态占位 + TODO。
 */
import { useEffect, useRef, useState } from 'react'
import { Copy, Info, RefreshCw, Settings as SettingsIcon, Star, User } from 'lucide-react'
import type { InjectFace, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarMode } from '@corum/corum-ide-ui/client'
import type { SidebarSkeletonInjected } from './index.ts'
// 物理相对路径而非 @corum/corum-ui-base 子路径：原因同 ProjectPane.tsx（tsdown
// 跨包 css 子路径 import 错乱，相对路径才能正确抽取内联进 bundle）。
import css from '../../../corum-ui-base/src/client/sidebar.module.css'

/** Composed props: 壳的 owner 面 + 子槽渲染面 + 骨架 inject 面（hooks 室绑定为 use* 选择器 Hook）。 */
export type SidebarSkeletonProps =
  & PropsRuntime<'corum.sidebar'>
  & PropsRenderSlots<'corum.sidebar.sessions' | 'corum.sidebar.project'>
  & InjectFace<SidebarSkeletonInjected>

/** 反转动画总时长：出 120ms + 入 200ms − 重叠 80ms（DESIGN §7.10；reduced-motion 下 CSS 降级为 150ms 纯透明度，仍被覆盖）。 */
const FLIP_TOTAL_MS = 240

/** `window.corumDesktop` 的窄化面（只用到版本号一项；本地能力接口，红线 3）。 */
interface AppVersionFace {
  getAppVersion?: () => Promise<string>
}

/** 诊断信息里的平台标签：UA-CH 优先，回落已废弃但仍普遍可用的 navigator.platform。 */
function platformLabel(): string {
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData
  return uaData?.platform ?? navigator.platform
}

/** The IDE left column skeleton (see module doc). */
export function SidebarSkeleton({ wide, renderSlot, useProjectOccupied, useSidebarMode, openSettingsSection }: SidebarSkeletonProps) {
  // 侧栏模式：服务的跨 bundle 单例状态（选择器 Hook 订阅）。PR1 起骨架**不再
  // 提供模式切换 UI**（modeSwitch「项目|任务」滑块已删，模式切换改由活动栏承担）；
  // 服务通路原样保留（inject 面的 setSidebarMode 仍可用，会话域空态操作照旧写它）。
  const mode = useSidebarMode(s => s)
  // 落定模式：当前静止展示的面板；反转动画播完后对齐 mode。
  const [restMode, setRestMode] = useState<SidebarMode>('task')
  // 项目槽占用（付费版项目插件插入后为 true）。hooks 室源已由 slots 绑定为选择器 Hook。
  const projectAvailable = useProjectOccupied(s => s)
  // 项目插件被卸载（付费→开源切换）时若正在项目模式，退回任务模式。
  const effectiveMode: SidebarMode = projectAvailable ? mode : 'task'
  const flipping = effectiveMode !== restMode

  // 应用版本号：品牌行挂载时经 window.corumDesktop 拉一次并缓存进 state（非桌面壳 /
  // 老 preload 下没有该方法，静默不显示版本）。
  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const bridge = (window as unknown as { corumDesktop?: AppVersionFace }).corumDesktop
      try {
        const version = await bridge?.getAppVersion?.()
        if (!cancelled && version !== undefined) setAppVersion(version)
      } catch (error) {
        console.warn('[sidebar] 读取应用版本号失败', error)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 档位：project 槽空 = 社区版；有 occupant（付费版项目插件）= PRO。
  const edition: 'community' | 'pro' = projectAvailable ? 'pro' : 'community'
  // 版本小字行：「v0.1.0 · 社区版 / PRO」；档位文案与右侧徽标同源（同一 edition 判定）。
  // 版本号异步到位：未到位时不显示「v」，避免出现「v · 社区版」这种半截文案。
  const editionLabel = edition === 'pro' ? 'PRO' : '社区版'
  const versionLabel = appVersion !== null ? `v${appVersion} · ${editionLabel}` : editionLabel

  /** 复制诊断信息（版本 + 平台）到系统剪贴板；剪贴板不可用时只记日志，不打断用户。 */
  const copyDiagnostics = (): void => {
    // 窄化取剪贴板：非 secure context / 老壳下 navigator.clipboard 不存在（拿不到就静默返回）。
    const clipboard = (navigator as unknown as {
      clipboard?: { writeText: (text: string) => Promise<void> }
    }).clipboard
    if (clipboard === undefined) return
    void clipboard.writeText(`Corum v${appVersion ?? 'unknown'} · ${platformLabel()}`).catch((error: unknown) => {
      console.warn('[sidebar] 复制诊断信息失败', error)
    })
  }

  // 反转收尾：总时长到点后把落定面板对齐目标模式（摘掉 data-flipping、可见性交还 data-active）。
  // 快速往返点击时清理重排：mode 回到 restMode 即刻静止，无残影。
  useEffect(() => {
    if (!flipping) return
    const timer = window.setTimeout(() => { setRestMode(effectiveMode) }, FLIP_TOTAL_MS)
    return () => { window.clearTimeout(timer) }
  }, [flipping, effectiveMode])

  /* ── PR2 footer 用户区 ─────────────────────────────────────────────── */

  // 底部轻量 popover：'user' = 用户菜单（点头像组开合），'about' = 关于小弹层
  // （菜单项「关于 Corum」打开）。二者互斥（同一时刻只浮一个）。
  const [openPopover, setOpenPopover] = useState<'user' | 'about' | null>(null)
  // popover 锚点 = 整个 footer 行：菜单项可以主动关闭并把焦点留在行内。
  const footerRef = useRef<HTMLElement>(null)

  /**
   * 关闭路径（Esc 处理参照 SettingsShell.tsx：137-143 的 keydown 监听）：
   * ① 点击 popover 与 footer 之外的任意处关闭；② Esc 关闭。popover 挂在
   * footer 内，所以「footer 内」= 不关（点菜单项由各 handler 自己关）。
   * 关闭时把焦点还给 footer（键盘用户不丢锚点）。
   */
  useEffect(() => {
    if (openPopover === null) return
    const onPointerDown = (event: MouseEvent): void => {
      const node = footerRef.current
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return
      setOpenPopover(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpenPopover(null)
      footerRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openPopover])

  // TODO(update: 更新机制未存在)：本 PR 只画 UI——红点角标与「v… 可用」小字
  // 恒为静态占位，待接入 auto-updater 后由真实状态（有新版本 / 无新版本 /
  // 未知）驱动。显式标 boolean 而不是字面量 false，保住下面两条渲染分支的
  // 类型检查（不被常量折叠掉）。
  const updateAvailable: boolean = false
  const updateVersionLabel = 'v0.2.0'

  /** 点「更新」/「检查更新」：只记日志（零行为机制），不假装已检查。 */
  const requestUpdate = (): void => {
    console.debug('[sidebar] 检查更新（占位：更新机制未接入）')
  }
  /** 点「升级 PRO」：只记日志（购买链路未接入）。 */
  const requestUpgrade = (): void => {
    console.debug('[sidebar] 升级 PRO（占位：购买链路未接入）')
  }
  /** 菜单项「账户与用量」：打开设置中心的账户页（壳的 openSettingsSection 信号）。 */
  const openAccountSettings = (): void => {
    setOpenPopover(null)
    openSettingsSection('account')
  }
  /** 齿轮按钮：打开设置中心通用页（不复用 sidebar.settings 槽，见 inject 面注释）。 */
  const openSettings = (): void => {
    setOpenPopover(null)
    openSettingsSection('general')
  }

  /** 一个面板的 data-flipping：静止时无值；反转中 = 自己是旧面（out）还是新面（in）。 */
  const flipStateOf = (paneMode: SidebarMode): 'out' | 'in' | undefined =>
    flipping ? (paneMode === restMode ? 'out' : 'in') : undefined

  return (
    <div className={css.sidebar} data-wide={wide || undefined}>
      {/* brand-row（PR1 定稿形态）：左侧 = 品牌卡（134×54 r10，鲸鱼+矩道+Corum
          Harness+Powered by DSH 一体卡，深/浅主题同一张）+ 其下版本小字行
          「v{版本} · 档位」与复制诊断信息按钮；右侧 = 档位徽标胶囊（社区版中性灰/
          PRO brand 色 + 星形）。PR1 删除了原 modeSwitch「项目|任务」滑块——模式切换
          改由活动栏承担（PR3），模式状态服务与下面两个面板的联动原样保留。
          侧边栏不可关闭（2026-08-25 设计：移除 region-actions）。 */}
      <header className={css.brandRow}>
        <div className={css.brandCol}>
          <span className={css.brand}>
            <img
              className={css.brandImg}
              src="corumapp://app/assets/brand_card.png"
              alt="矩道 Corum Harness"
              draggable={false}
            />
          </span>
          <div className={css.brandMeta}>
            <span className={css.brandVersion}>{versionLabel}</span>
            <button
              type="button"
              className={css.copyDiag}
              title="复制诊断信息"
              aria-label="复制诊断信息"
              onClick={copyDiagnostics}
            >
              <Copy size={12} aria-hidden="true" />
            </button>
          </div>
        </div>
        <span className={css.editionBadge} data-edition={edition}>
          {edition === 'pro' && <Star className={css.editionBadgeIcon} size={16} aria-hidden="true" />}
          {editionLabel}
        </span>
      </header>
      <div className={css.brandDivider} />

      {/* 内容区：两个子槽常驻挂载、仅按模式切可见性——切模式不丢组件态
          （项目详情的 activeProject 等），对齐旧单体侧栏的状态存活语义。
          sessions 槽必填（开源版也有）；project 槽付费版才有 occupant。
          sidebarBody 提供反转动画的透视与覆盖定位上下文（DESIGN §7.10）。 */}
      <div className={css.sidebarBody}>
        <div
          className={css.pane}
          data-active={restMode === 'task'}
          data-flipping={flipStateOf('task')}
        >
          {renderSlot('corum.sidebar.sessions', {})}
        </div>
        {projectAvailable && (
          <div
            className={css.pane}
            data-active={restMode === 'project'}
            data-flipping={flipStateOf('project')}
          >
            {renderSlot('corum.sidebar.project', {})}
          </div>
        )}
      </div>

      {/* footer 用户区（PR2 / design.pen Aotdf 画板 D，48px 行）：分割线 + 左侧
          「32px 圆形头像 + 本机使用 / 未登录」+ 右侧两个图标按钮（更新 / 设置）。
          头像组 = 用户菜单开关；更新 / 设置是两个**独立动作按钮**（检查更新 /
          打开设置中心），不参与菜单开合。窄轨下整行随
          .sidebar:not([data-wide]) > :not(.brandRow) 规则组一并隐藏。 */}
      <div className={css.footerDivider} />
      <footer
        ref={footerRef}
        className={css.sidebarFooter}
        tabIndex={-1}
        role="group"
        aria-label="账户与设置"
      >
        <button
          type="button"
          className={css.footerUser}
          aria-haspopup="menu"
          aria-expanded={openPopover === 'user'}
          onClick={() => { setOpenPopover(openPopover === 'user' ? null : 'user') }}
        >
          {/* 头像占位：登录体系与真实头像均未接入，用 lucide user 图标占位。 */}
          <span className={css.footerAvatar}>
            <User size={16} aria-hidden="true" />
          </span>
          <span className={css.footerUserCol}>
            <span className={css.footerUserName}>本机使用</span>
            <span className={css.footerUserSub}>未登录</span>
          </span>
        </button>
        <div className={css.footerActions}>
          <button
            type="button"
            className={css.footerIconBtn}
            title="检查更新"
            aria-label="检查更新"
            onClick={requestUpdate}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {updateAvailable && <span className={css.footerDot} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={css.footerIconBtn}
            title="设置"
            aria-label="设置"
            onClick={openSettings}
          >
            <SettingsIcon size={16} aria-hidden="true" />
          </button>
        </div>

        {openPopover !== null && (
          <div className={css.footerMenu} role="menu" aria-label="账户菜单">
            {/* 菜单头：头像 + 用户名 + 档位小徽标（复用品牌行 .editionBadge
                同形同色，档位同源同一 edition 判定）。 */}
            <div className={css.footerMenuHead}>
              <span className={css.footerAvatar}>
                <User size={16} aria-hidden="true" />
              </span>
              <span className={css.footerMenuName}>本机使用</span>
              <span className={css.editionBadge} data-edition={edition}>
                {edition === 'pro' && <Star className={css.editionBadgeIcon} size={16} aria-hidden="true" />}
                {editionLabel}
              </span>
            </div>
            <div className={css.footerMenuDivider} />
            {openPopover === 'about' ? (
              /* 关于小弹层：复用品牌行的版本来源（appVersion，挂载时经
                 window.corumDesktop 拉一次）；未就绪时如实显示「未知」。 */
              <div className={css.footerAbout}>版本 {appVersion !== null ? `v${appVersion}` : '未知'}</div>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={css.footerMenuItem}
                  onClick={openAccountSettings}
                >
                  <User className={css.footerMenuIcon} size={14} aria-hidden="true" />
                  <span className={css.footerMenuLabel}>账户与用量</span>
                </button>
                {/* 「升级 PRO」仅社区版显示（PRO 版已是最高档位）。 */}
                {edition === 'community' && (
                  <button
                    type="button"
                    role="menuitem"
                    className={css.footerMenuItem}
                    data-brand="true"
                    onClick={requestUpgrade}
                  >
                    <Star className={css.footerMenuIcon} size={14} aria-hidden="true" />
                    <span className={css.footerMenuLabel}>升级 PRO</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className={css.footerMenuItem}
                  onClick={requestUpdate}
                >
                  <span className={css.footerMenuIconWrap}>
                    <RefreshCw className={css.footerMenuIcon} size={14} aria-hidden="true" />
                    {updateAvailable && <span className={css.footerDot} aria-hidden="true" />}
                  </span>
                  <span className={css.footerMenuLabel}>检查更新</span>
                  {updateAvailable && (
                    <span className={css.footerMenuVersion}>{updateVersionLabel} 可用</span>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={css.footerMenuItem}
                  onClick={() => { setOpenPopover('about') }}
                >
                  <Info className={css.footerMenuIcon} size={14} aria-hidden="true" />
                  <span className={css.footerMenuLabel}>关于 Corum</span>
                </button>
              </>
            )}
          </div>
        )}
      </footer>
    </div>
  )
}
