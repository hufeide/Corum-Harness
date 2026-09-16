/**
 * 新会话空态（blank 会话）：标语 + 副标语 + 快捷指令卡。
 *
 * **2026-09-16 从 `ConversationRoot.tsx` 抽出独立成文件**（用户要求
 * 「最低要求代码文件上要独立」，并据此定下空态与会话的重构方向）。
 *
 * 抽出的意义不只是「少几行」：空态此前是 `ConversationRoot` 里的一段**内联组件 + 内联 CSS**，
 * 于是它与会话正文共用同一套宽度变量轴（`--dsh-chat-user-width` →
 * `--dsh-chat-content-width` → `--dsh-composer-card-max-width`）——用户拖拽会话宽度会把空态一起拖窄。
 * 独立成文件后：
 *   · 本组件**自带**自己的宽度规则（见 NewSessionHero.module.css），不再依赖会话的宽度轴；
 *   · 由 `ConversationRoot` 在 `.scrollBody` 下**与会话视图并列为兄弟**渲染，
 *     而不是塞进 `.composerStack`（那里是给输入框用的宽度上下文）。
 *
 * 职责边界：本文件只管空态的**结构与自己的样式**；点卡片后的动作（填进 composer）
 * 由调用方经 `onPick` 注入，本组件不感知 cordis / 服务 / 会话状态。
 */
import { Bug, Compass, FileText, History, LayoutGrid, Megaphone, PenLine, TestTube2, Wand2 } from 'lucide-react'
import type { TaskAgentInfo } from '../contract/slots.ts'
import css from './NewSessionHero.module.css'

/** 一条快捷指令卡（icon + 标题 + 描述 + 填入 composer 的提示词）。 */
interface QuickCommand {
  icon: typeof History
  title: string
  desc: string
  prompt: string
}

/** 通用快捷指令卡（设计稿 L4 1:1）：无岗位维度信息（official preset / 查询失败）时的回退集。 */
export const GENERIC_QUICK_COMMANDS: readonly QuickCommand[] = [
  { icon: History, title: '继续未完成的任务', desc: '从上次中断的地方接着推进当前工作区的工作', prompt: '继续未完成的任务：从上次中断的地方接着推进当前工作区的工作。' },
  { icon: Wand2, title: '整理代码', desc: '清理结构、统一风格，让项目更易维护', prompt: '整理代码：清理结构、统一风格，让项目更易维护。' },
  { icon: Compass, title: '帮我探索项目', desc: '梳理项目结构，说明各模块职责与关联', prompt: '帮我探索项目：梳理项目结构，说明各模块职责与关联。' },
]

/**
 * 按 Agent 岗位维度定制的快捷指令卡（2026-09-07 用户定调：不同专业领域的
 * Agent，对话起始页的推荐命令应贴合其专业方向）。key = profile.dimension
 * （研发/产品/设计/市场/自媒体/创作）；未命中（含无 dimension 的 official
 * preset）回退 {@link GENERIC_QUICK_COMMANDS}。
 */
export const DIMENSION_QUICK_COMMANDS: Readonly<Record<string, readonly QuickCommand[]>> = {
  研发: [
    { icon: Wand2, title: '重构这段代码', desc: '优化结构与命名，提升可读性与可维护性', prompt: '重构这段代码：优化结构与命名，提升可读性与可维护性。' },
    { icon: Bug, title: '排查并修复问题', desc: '定位根因，给出修复方案与验证步骤', prompt: '排查并修复问题：定位根因，给出修复方案与验证步骤。' },
    { icon: TestTube2, title: '补充自动化测试', desc: '为核心逻辑补齐单元测试与边界用例', prompt: '补充自动化测试：为核心逻辑补齐单元测试与边界用例。' },
  ],
  产品: [
    { icon: FileText, title: '起草需求文档', desc: '把想法整理成结构化的 PRD 与用户故事', prompt: '起草需求文档：把想法整理成结构化的 PRD 与用户故事。' },
    { icon: LayoutGrid, title: '梳理任务优先级', desc: '按价值与成本排出迭代计划与里程碑', prompt: '梳理任务优先级：按价值与成本排出迭代计划与里程碑。' },
    { icon: Compass, title: '竞品调研分析', desc: '对比同类产品，提炼差异化机会点', prompt: '竞品调研分析：对比同类产品，提炼差异化机会点。' },
  ],
  设计: [
    { icon: PenLine, title: '设计界面方案', desc: '给出布局、配色与组件的设计建议', prompt: '设计界面方案：给出布局、配色与组件的设计建议。' },
    { icon: LayoutGrid, title: '走查现有界面', desc: '指出一致性与可用性问题并给改进建议', prompt: '走查现有界面：指出一致性与可用性问题并给改进建议。' },
    { icon: Compass, title: '提炼设计规范', desc: '整理颜色/字体/间距为可复用的设计令牌', prompt: '提炼设计规范：整理颜色/字体/间距为可复用的设计令牌。' },
  ],
  市场: [
    { icon: Megaphone, title: '撰写推广文案', desc: '面向目标用户提炼卖点与行动号召', prompt: '撰写推广文案：面向目标用户提炼卖点与行动号召。' },
    { icon: Compass, title: '分析目标用户', desc: '勾勒用户画像与触达渠道建议', prompt: '分析目标用户：勾勒用户画像与触达渠道建议。' },
    { icon: FileText, title: '策划营销活动', desc: '给出活动主题、节奏与物料清单', prompt: '策划营销活动：给出活动主题、节奏与物料清单。' },
  ],
  自媒体: [
    { icon: PenLine, title: '生成内容选题', desc: '结合定位给一批可落地的选题方向', prompt: '生成内容选题：结合定位给一批可落地的选题方向。' },
    { icon: FileText, title: '撰写图文初稿', desc: '产出标题、正文与结尾互动的完整初稿', prompt: '撰写图文初稿：产出标题、正文与结尾互动的完整初稿。' },
    { icon: Megaphone, title: '优化标题封面', desc: '提升点击率：标题候选与封面文案建议', prompt: '优化标题封面：提升点击率：标题候选与封面文案建议。' },
  ],
  创作: [
    { icon: PenLine, title: '续写这段文字', desc: '保持语气与风格，自然推进情节或论述', prompt: '续写这段文字：保持语气与风格，自然推进情节或论述。' },
    { icon: Compass, title: '头脑风暴创意方向', desc: '围绕主题发散多个可选切入点', prompt: '头脑风暴创意方向：围绕主题发散多个可选切入点。' },
    { icon: Wand2, title: '润色这段文字', desc: '精炼表达、修正语病，保留原作者风格', prompt: '润色这段文字：精炼表达、修正语病，保留原作者风格。' },
  ],
}

/** 本组件的 props（不依赖 slot 契约的其余部分，便于独立测试与复用）。 */
export interface NewSessionHeroProps {
  /** 工作区显示名（副标语用）；缺省则不渲染副标语。 */
  workspaceTitle?: string | undefined
  /** 当前执行 Agent 的岗位信息（决定快捷指令卡用哪一组）。 */
  agentInfo?: TaskAgentInfo | undefined
  /** 点快捷指令卡：把该卡的提示词填进 composer。 */
  onPick: (prompt: string) => void
}

/**
 * 渲染 blank 会话的空态界面。
 * @param props - 见 {@link NewSessionHeroProps}。
 * @returns 标语 + 快捷指令卡；样式由本组件自己的 CSS module 提供，宽度与会话解耦。
 */
export function NewSessionHero({ workspaceTitle, agentInfo, onPick }: NewSessionHeroProps) {
  const sub = workspaceTitle !== undefined && workspaceTitle !== ''
    ? `已在 ${workspaceTitle} 工作区${agentInfo?.name !== undefined && agentInfo.name !== '' ? ` · 由 ${agentInfo.name} 执行` : ''}`
    : undefined
  const commands = (agentInfo?.dimension !== undefined ? DIMENSION_QUICK_COMMANDS[agentInfo.dimension] : undefined)
    ?? GENERIC_QUICK_COMMANDS
  return (
    <div className={css.newSessionHero} data-new-session-hero="">
      <div className={css.newSessionHeadline}>
        <span className={css.newSessionTitle}>输入指令，开始新的任务</span>
        {sub !== undefined && <span className={css.newSessionSub}>{sub}</span>}
      </div>
      <div className={css.quickCommands}>
        {commands.map((cmd) => {
          const Icon = cmd.icon
          return (
            <button
              key={cmd.title}
              type="button"
              className={css.quickCommand}
              onClick={() => onPick(cmd.prompt)}
            >
              <span className={css.quickCommandHead}>
                <span className={css.quickCommandIcon}><Icon size={16} /></span>
                <span className={css.quickCommandTitle}>{cmd.title}</span>
              </span>
              <span className={css.quickCommandDesc}>{cmd.desc}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
