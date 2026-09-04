/**
 * Settings sections — 1:1 复刻 design.pen 设置中心 20 个 section 页面。
 *
 * 每个 section 注册到 `settings.section` slot，使用共享组件组装：
 * - SettingGroup（glass-1 卡片）
 * - SettingRow（label+desc+control）
 * - SelectField / Switch / Badge / KbdKey / ColorChips
 *
 * 数据为设计稿静态文案占位，功能后续接入。
 */
import { useState, useEffect, useRef, useContext, createContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, Star, Plug, Puzzle, Server, Plus, X, Sparkles, Upload, Package, ChevronDown, ChevronUp, ChevronRight, ChevronLeft, ArrowLeft, Bot, Cpu, Search, Check, Box, Ghost, Maximize2, Minimize2 } from 'lucide-react'
import { SettingGroup } from './SettingGroup.tsx'
import { SettingRow } from './SettingRow.tsx'
import { SelectField } from './SelectField.tsx'
import { Switch } from './Switch.tsx'
import { Badge } from './Badge.tsx'
import { KbdKey } from './KbdKey.tsx'
import { ColorChips } from './ColorChips.tsx'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import css from './SettingsSections.module.css'

/* ── corum RPC 调用上下文（由 index.tsx 在注册 sections 时 provide）────────── */

/** 全局 RPC 调用函数上下文：SkillsSection 等业务 section 经此调 host 服务。 */
export const CorumRpcContext = createContext<CorumRpcCall | null>(null)

/** 取出 RPC 调用函数；未 provide 时返回 null（组件降级为静态占位）。 */
function useCorumRpc(): CorumRpcCall | null {
  return useContext(CorumRpcContext)
}

/* ── 通用玻璃按钮（设计稿 btn: glass-2, radius 13, padding [9,16]）────── */

function GlassButton({ children, variant = 'default', onClick, disabled }: { children: ReactNode; variant?: 'default' | 'primary' | 'danger'; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={variant === 'primary' ? css.btnPrimary : variant === 'danger' ? css.btnDanger : css.btnDefault} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

/* ── 通用卡片（设计稿 card: glass-1, radius 16, padding 14）────────────── */

function InfoCard({ title, desc, chips, actions, isDefault, onClick }: {
  title: string; desc: string; chips?: string[]; actions?: ReactNode; isDefault?: boolean; onClick?: () => void
}) {
  return (
    <div className={css.card} onClick={onClick} role={onClick ? 'button' : undefined}>
      <div className={css.cardInfo}>
        <div className={css.cardTitleRow}>
          <span className={css.cardTitle}>{title}</span>
          {isDefault && <span className={css.defaultBadge}>默认</span>}
        </div>
        <span className={css.cardDesc}>{desc}</span>
        {chips && (
          <div className={css.cardChips}>
            {chips.map(c => <span key={c} className={css.cardChip}>{c}</span>)}
          </div>
        )}
      </div>
      {actions && <div className={css.cardActions} onClick={e => e.stopPropagation()}>{actions}</div>}
    </div>
  )
}

/* ── 外观 ──────────────────────────────────────────────────────────── */

function AppearanceSection() {
  return (
    <>
      <SettingGroup title="主题">
        <SettingRow label="外观主题" desc="浅色 / 深色 / 跟随系统" badge={<Badge label="已修改" />}>
          <SelectField value="system" options={[{id:'light',label:'浅色'},{id:'dark',label:'深色'},{id:'system',label:'跟随系统'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="强调色" desc="高亮、链接与品牌元素使用的颜色">
          <ColorChips chips={[{id:'violet',color:'#5B21F5'},{id:'pink',color:'#F5276C'},{id:'green',color:'#0BA57C'},{id:'orange',color:'#E07A00'}]} selectedId="violet" onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="字体与排版">
        <SettingRow label="UI 字体" desc="界面与菜单使用的字体">
          <SelectField value="inter" options={[{id:'inter',label:'Inter'},{id:'system',label:'系统默认'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="代码字体" desc="编辑器与终端使用的等宽字体">
          <SelectField value="jbm" options={[{id:'jbm',label:'JetBrains Mono'},{id:'mono',label:'Menlo'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="界面字号" desc="界面文字基准字号（px）">
          <SelectField value="13" options={[{id:'12',label:'12'},{id:'13',label:'13'},{id:'14',label:'14'},{id:'16',label:'16'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="界面密度" desc="列表与控件的纵向留白" divider={false}>
          <SelectField value="comfortable" options={[{id:'compact',label:'紧凑'},{id:'comfortable',label:'舒适'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── 通知 ──────────────────────────────────────────────────────────── */

function NotificationsSection() {
  return (
    <>
      <SettingGroup title="任务通知">
        <SettingRow label="任务完成时通知" desc="Agent 任务执行完毕时弹出提醒">
          <Switch checked={true} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="通知声音" desc="通知到达时播放提示音">
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="系统通知权限" desc="需在系统设置中允许 Corum 发送通知" divider={false}>
          <GlassButton>去开启</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="勿扰">
        <SettingRow label="勿扰模式" desc="开启后不弹出任何通知" divider={false}>
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── 快捷键 ────────────────────────────────────────────────────────── */

function ShortcutsSection() {
  return (
    <>
      <div className={css.searchBox}>
        <span className={css.searchPlaceholder}>搜索快捷键…</span>
      </div>
      <SettingGroup title="命令">
        <SettingRow label="打开设置"><KbdKey label="Cmd+," /></SettingRow>
        <SettingRow label="快速打开文件"><KbdKey label="Cmd+K" /></SettingRow>
        <SettingRow label="命令面板"><KbdKey label="Cmd+Shift+P" /></SettingRow>
        <SettingRow label="新建会话"><KbdKey label="Cmd+N" /></SettingRow>
        <SettingRow label="关闭弹层" divider={false}><KbdKey label="Esc" /></SettingRow>
      </SettingGroup>
      <div className={css.resetWrap}>
        <GlassButton variant="primary">重置全部快捷键</GlassButton>
      </div>
    </>
  )
}

/* ── 终端 ──────────────────────────────────────────────────────────── */

function TerminalSection() {
  return (
    <>
      <SettingGroup title="执行器">
        <SettingRow label="默认 shell" desc="新建终端会话使用的 shell 解释器">
          <SelectField value="bash" options={[{id:'bash',label:'bash'},{id:'zsh',label:'zsh'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="工作目录 cwd" desc="终端启动时的初始工作目录">
          <input className={css.textInput} placeholder="~/workspace" defaultValue="~/workspace" />
        </SettingRow>
        <SettingRow label="超时 timeoutMs" desc="单次命令执行的最长等待时间">
          <SelectField value="120" options={[{id:'60',label:'60s'},{id:'120',label:'120s'},{id:'300',label:'300s'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="最大超时 maxTimeoutMs" desc="超时上限，超过将被强制终止">
          <SelectField value="600" options={[{id:'300',label:'300s'},{id:'600',label:'600s'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="最大输出 maxOutputBytes" desc="命令输出的最大保留字节数" divider={false}>
          <SelectField value="64" options={[{id:'32',label:'32 KB'},{id:'64',label:'64 KB'},{id:'128',label:'128 KB'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="外观">
        <SettingRow label="终端字体" desc="终端使用的等宽字体">
          <SelectField value="jbm" options={[{id:'jbm',label:'JetBrains Mono'},{id:'mono',label:'Menlo'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="字号" desc="终端文字大小（px）" divider={false}>
          <SelectField value="13" options={[{id:'12',label:'12'},{id:'13',label:'13'},{id:'14',label:'14'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── 高级 Agent Loop ──────────────────────────────────────────────── */

function AgentLoopSection() {
  return (
    <>
      <SettingGroup title="并发与重试">
        <SettingRow label="最大并发数" desc="同时运行的工具调用上限">
          <SelectField value="3" options={[{id:'1',label:'1'},{id:'3',label:'3'},{id:'5',label:'5'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="重试次数" desc="工具调用失败后的重试上限">
          <SelectField value="2" options={[{id:'0',label:'0'},{id:'2',label:'2'},{id:'5',label:'5'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="重试间隔" desc="每次重试之间的等待时间" divider={false}>
          <SelectField value="1" options={[{id:'0',label:'0s'},{id:'1',label:'1s'},{id:'5',label:'5s'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="提示">
        <SettingRow label="系统提示词前缀" desc="注入到每个会话开头的额外指令" divider={false}>
          <GlassButton>编辑</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── 权限 ──────────────────────────────────────────────────────────── */

function PermissionsSection() {
  return (
    <>
      <SettingGroup title="沙箱与审批">
        <SettingRow label="沙箱模式" desc="Agent 执行命令时可写入的文件范围。">
          <SelectField value="workspace-write" options={[{id:'read-only',label:'只读'},{id:'workspace-write',label:'工作区读写'},{id:'full',label:'完全访问'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="审批策略" desc="何时要求人工确认 Agent 的工具调用。">
          <SelectField value="ask" options={[{id:'never',label:'从不'},{id:'ask',label:'每次询问'},{id:'dangerous',label:'仅危险操作'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="危险完全访问" desc="关闭所有沙箱与审批保护，请谨慎开启。" divider={false}>
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="工具规则">
        <SettingRow label="允许规则" desc="这些工具调用无需审批即可执行。">
          <GlassButton>编辑</GlassButton>
        </SettingRow>
        <SettingRow label="禁止规则" desc="这些工具调用将被直接拒绝。" divider={false}>
          <GlassButton>编辑</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── 规则与指令 ────────────────────────────────────────────────────── */

function RulesSection() {
  return (
    <>
      <SettingGroup title="全局自定义指令">
        <div className={css.cmdArea}>
          <div className={css.cmdLine}># AGENTS.md — 全局自定义指令</div>
          <div className={css.cmdLine}>- 使用中文回答，代码注释保持英文</div>
          <div className={css.cmdLine}>- 修改前先列出计划，未经确认不要大范围重构</div>
          <div className={css.cmdLine}>- 提交信息遵循 Conventional Commits</div>
        </div>
        <div className={css.actionsRow}>
          <GlassButton>编辑</GlassButton>
        </div>
      </SettingGroup>
      <SettingGroup title="人格 Personality">
        <SettingRow label="人格预设" desc="决定 Agent 的沟通风格与行为倾向">
          <SelectField value="pragmatic" options={[{id:'pragmatic',label:'务实'},{id:'friendly',label:'友好'},{id:'concise',label:'简洁'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="启用自定义指令" desc="将上方全局指令注入到每个会话的系统提示词" divider={false}>
          <Switch checked={true} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── 记忆 ──────────────────────────────────────────────────────────── */

function MemorySection() {
  return (
    <>
      <SettingGroup title="记忆">
        <SettingRow label="启用记忆" desc="允许 Agent 在对话中沉淀长期记忆">
          <Switch checked={true} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="跨会话共享" desc="记忆在所有会话之间共享，关闭后仅当前会话可见" badge={<Badge label="重启后生效" variant="restart" />}>
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="记忆容量上限" desc="超出上限后自动淘汰最旧的记忆条目" divider={false}>
          <SelectField value="500" options={[{id:'100',label:'100 条'},{id:'500',label:'500 条'},{id:'1000',label:'1000 条'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="已存记忆">
        <div className={css.memRow}><span className={css.memDot} /><span className={css.memTxt}>用户偏好使用中文交流，代码注释保持英文</span><Trash2 size={14} className={css.memDel} /></div>
        <div className={css.memDivider} />
        <div className={css.memRow}><span className={css.memDot} /><span className={css.memTxt}>项目使用 pnpm workspace，构建命令为 pnpm --filter 包名 build</span><Trash2 size={14} className={css.memDel} /></div>
        <div className={css.memDivider} />
        <div className={css.memRow}><span className={css.memDot} /><span className={css.memTxt}>桌面应用主目录为 ~/.corum-shell，可通过 CORUM_HOME 覆盖</span><Trash2 size={14} className={css.memDel} /></div>
        <div className={css.actionsRow}>
          <GlassButton variant="danger">清空全部</GlassButton>
        </div>
      </SettingGroup>
    </>
  )
}

/* ── 隐私 ──────────────────────────────────────────────────────────── */

function PrivacySection() {
  return (
    <>
      <SettingGroup title="数据与遥测">
        <SettingRow label="匿名使用统计" desc="帮助改进产品，不含任何代码内容">
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="崩溃报告" desc="应用崩溃时自动发送报告" divider={false}>
          <Switch checked={true} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="敏感文件排除">
        <SettingRow label="排除模式" desc="匹配的文件不会被 Agent 读取或写入" divider={false}>
          <GlassButton>编辑</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── 数据管理 ──────────────────────────────────────────────────────── */

function DataSection() {
  return (
    <>
      <SettingGroup title="存储占用">
        <SettingRow label="技能仓库" desc="">
          <span className={css.sizeLabel}>45 MB</span>
          <GlassButton>清理</GlassButton>
        </SettingRow>
        <SettingRow label="缓存" desc="" divider={false}>
          <span className={css.sizeLabel}>312 MB</span>
          <GlassButton>清理</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="危险操作">
        <SettingRow label="清除全部缓存" desc="清空本地缓存文件，下次启动重新生成">
          <GlassButton variant="danger">清除</GlassButton>
        </SettingRow>
        <SettingRow label="重置全部设置" desc="恢复所有设置为默认值，不可撤销" divider={false}>
          <GlassButton variant="danger">重置</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── Hooks 与自动化 ────────────────────────────────────────────────── */

function HooksSection() {
  return (
    <>
      <SettingGroup title="事件钩子">
        <SettingRow label="PreToolUse" desc="工具执行前触发，可用于审批或拦截">
          <SelectField value="none" options={[{id:'none',label:'无'},{id:'approve',label:'审批'},{id:'block',label:'拦截'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="PostToolUse" desc="工具执行后触发，可用于自动检查">
          <SelectField value="lint" options={[{id:'none',label:'无'},{id:'lint',label:'运行 lint'},{id:'test',label:'运行测试'}]} onChange={() => {}} />
        </SettingRow>
        <SettingRow label="Notification" desc="Agent 发出通知时触发" divider={false}>
          <SelectField value="none" options={[{id:'none',label:'无'},{id:'log',label:'记录日志'}]} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="说明">
        <p className={css.hintText}>钩子脚本位于 ~/.corum/hooks/ 目录，使用 Node.js 编写。每个钩子接收事件数据并可通过返回值控制后续行为。</p>
      </SettingGroup>
    </>
  )
}

/* ── Agent 预设（名片式 + 筛选 + 详情编辑）────────────────────────────── */

/** ProfileSummary 投影（与 host agent-service.ts 对齐）。 */
interface AgentProfileSummary {
  id: string
  nickname?: string
  title?: string
  dimension?: string
  experience?: string
  persona?: string
  avatar?: string
  baseMode?: string
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  skills: SkillBinding[]
  mcpServers: string[]
  terminal: { mode: string }
  version: number
  trust: string
  source: 'corum' | 'official'
}

const AGENT_DIMENSIONS = ['研发', '产品', '设计', '市场', '自媒体', '创作'] as const

/** 按 prompt 生成「擅长什么」摘要（取首行，去 markdown 标记）。 */
function promptToMotto(prompt: string): string {
  const first = prompt.split('\n').find(l => l.trim().length > 0) ?? ''
  return first.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim() || '—'
}

/** 推断岗位维度（profile 未显式设置时按 title/id 关键词兜底）。 */
function inferDimension(p: AgentProfileSummary): string {
  if (p.dimension !== undefined && p.dimension !== '') return p.dimension
  const text = `${p.title ?? ''} ${p.id}`.toLowerCase()
  if (/产品|pm|product/.test(text)) return '产品'
  if (/设计|design/.test(text)) return '设计'
  if (/市场|营销|market/.test(text)) return '市场'
  if (/自媒体|媒体|content/.test(text)) return '自媒体'
  if (/创作|写作|creative|writer/.test(text)) return '创作'
  return '研发'
}

/* ── Agent 名片卡 ─────────────────────────────────────────────────────── */

function AgentCard({ profile, onClick }: { profile: AgentProfileSummary; onClick: () => void }) {
  const dim = inferDimension(profile)
  return (
    <div className={css.agentCard} onClick={onClick} role="button">
      <div className={css.agentCardHead}>
        <div className={css.agentAvatar}>
          {profile.avatar !== undefined && profile.avatar !== ''
            ? <img className={css.agentAvatarImg} src={profile.avatar} alt="" />
            : <div className={css.agentAvatarPlaceholder} />}
        </div>
        <div className={css.agentNameCol}>
          <div className={css.agentNameRow}>
            <span className={css.agentNickname}>{profile.nickname ?? profile.id}</span>
            <span className={css.trustBadge}>{profile.trust === 'system' ? '系统' : '用户'}</span>
          </div>
          <span className={css.agentRole}>{profile.title ?? 'Agent'}</span>
        </div>
        <ChevronRight size={14} className={css.agentChevron} />
      </div>
      <span className={css.agentMotto}>{promptToMotto(profile.prompt)}</span>
      {profile.experience !== undefined && profile.experience !== '' && (
        <span className={css.agentExp}>{profile.experience}</span>
      )}
      <div className={css.agentModelRow}>
        <Cpu size={11} className={css.agentModelIcon} />
        <span className={css.agentInheritTag}>继承自 {profile.baseMode ?? (profile.source === 'official' ? profile.id : 'standard')}</span>
        <span className={css.agentModelName}>{profile.model.model}</span>
        <span className={css.agentDimTag}>{dim}</span>
      </div>
    </div>
  )
}

/* ── 名片预览（编辑弹窗右上角）───────────────────────────────────────── */

function AgentCardPreview({ draft }: { draft: EditDraft }) {
  const pseudo: AgentProfileSummary = {
    id: draft.name || 'new-agent',
    ...(draft.nickname !== '' ? { nickname: draft.nickname } : {}),
    ...(draft.title !== '' ? { title: draft.title } : {}),
    ...(draft.dimension !== '' ? { dimension: draft.dimension } : {}),
    ...(draft.experience !== '' ? { experience: draft.experience } : {}),
    ...(draft.avatar !== '' ? { avatar: draft.avatar } : {}),
    prompt: draft.prompt,
    model: { provider: draft.provider, model: draft.model },
    skills: draft.skills,
    mcpServers: draft.mcpServers,
    terminal: { mode: draft.terminal },
    version: 1,
    trust: draft.trust,
    source: 'corum',
  }
  return (
    <div className={css.cardPreviewRow}>
      <span className={css.cardPreviewLabel}>名片预览 →</span>
      <div className={css.cardPreviewCard}>
        <AgentCard profile={pseudo} onClick={() => {}} />
      </div>
    </div>
  )
}

/* ── 官方模式只读卡 ──────────────────────────────────────────────────── */

const OFFICIAL_MODE_META: Record<string, { label: string; desc: string }> = {
  standard: { label: '标准模式', desc: '功能完整的编码 Agent，支持文件编辑 / Shell / 检索 / Skills' },
  ptc: { label: 'PTC 模式', desc: '标准模式 + Code Mode SDK 多步操作' },
  minimal: { label: '极简模式', desc: '仅持久 bash + 编辑器的双工具 Agent' },
  cordis: { label: '创造模式', desc: '用于创建自定义 Agent preset' },
}

function OfficialModeCard({ id }: { id: string }) {
  const meta = OFFICIAL_MODE_META[id] ?? { label: id, desc: '' }
  return (
    <div className={css.officialCard}>
      <div className={css.officialCardHead}>
        <Box size={13} className={css.officialCardIcon} />
        <span className={css.officialCardLabel}>{meta.label}</span>
        <span className={css.officialBadge}>官方</span>
        <span className={css.agentInheritTag}>继承自</span>
      </div>
      <span className={css.officialCardDesc}>{meta.desc}</span>
    </div>
  )
}

/* ── 编辑表单草稿 ────────────────────────────────────────────────────── */

interface EditDraft {
  name: string
  nickname: string
  title: string
  dimension: string
  experience: string
  persona: string
  avatar: string
  baseMode: string
  prompt: string
  provider: string
  model: string
  subEnabled: boolean
  subProvider: string
  subModel: string
  terminal: 'sandbox' | 'host'
  memory: string
  skills: SkillBinding[]
  mcpServers: string[]
  trust: 'system' | 'user'
}

function emptyDraft(): EditDraft {
  return {
    name: '', nickname: '', title: '', dimension: '研发', experience: '', persona: '', avatar: '',
    baseMode: 'standard', prompt: '', provider: 'deepseek-official', model: 'deepseek-v4-flash',
    subEnabled: false, subProvider: 'deepseek-official', subModel: 'deepseek-v4-flash',
    terminal: 'sandbox', memory: 'agent', skills: [], mcpServers: [], trust: 'user',
  }
}

function draftFromProfile(p: AgentProfileSummary): EditDraft {
  return {
    name: p.id,
    nickname: p.nickname ?? '',
    title: p.title ?? '',
    dimension: p.dimension ?? inferDimension(p),
    experience: p.experience ?? '',
    persona: p.persona ?? '',
    avatar: p.avatar ?? '',
    baseMode: p.baseMode ?? 'standard',
    prompt: p.prompt,
    provider: p.model.provider,
    model: p.model.model,
    subEnabled: false,
    subProvider: 'deepseek-official',
    subModel: 'deepseek-v4-flash',
    terminal: (p.terminal.mode === 'host' ? 'host' : 'sandbox') as 'sandbox' | 'host',
    memory: 'agent',
    skills: p.skills,
    mcpServers: p.mcpServers,
    trust: (p.trust === 'system' ? 'system' : 'user') as 'system' | 'user',
  }
}

/* ── 虚位以待占位卡（每行不足 3 张时补齐）───────────────────────────── */

function PlaceholderCard() {
  return (
    <div className={css.agentAddCard} style={{ minHeight: 143 }}>
      <Ghost size={16} style={{ color: 'var(--dsw-alias-label-dimmed)' }} />
      <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-dimmed)' }}>虚位以待</span>
    </div>
  )
}

/* ── 主 section（home / edit 两级 view）───────────────────────────────── */

type PresetsView =
  | { kind: 'home' }
  | { kind: 'edit'; profile: AgentProfileSummary | 'new' }

function AgentPresetsSection() {
  const rpc = useCorumRpc()
  const [view, setView] = useState<PresetsView>({ kind: 'home' })
  const [profiles, setProfiles] = useState<AgentProfileSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dimFilter, setDimFilter] = useState<string>('全部')
  const [search, setSearch] = useState('')

  const reload = async () => {
    if (!rpc) return
    try {
      const r = await rpc<{ profiles: AgentProfileSummary[] }>('corumAgent', 'listProfiles', {})
      setProfiles(r.profiles)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void reload() }, [rpc])

  if (!rpc) return <p className={css.hintText}>Agent 服务未就绪。</p>

  if (view.kind === 'edit') {
    return (
      <EditPresetView
        key={view.profile === 'new' ? '__new__' : view.profile.id}
        profile={view.profile === 'new' ? undefined : view.profile}
        rpc={rpc}
        onBack={() => setView({ kind: 'home' })}
        onSaved={() => { setView({ kind: 'home' }); void reload() }}
      />
    )
  }

  const corumProfiles = (profiles ?? []).filter(p => p.source === 'corum')
  const officialProfiles = (profiles ?? []).filter(p => p.source === 'official')

  const filtered = corumProfiles.filter(p => {
    if (dimFilter !== '全部' && inferDimension(p) !== dimFilter) return false
    if (search !== '') {
      const q = search.toLowerCase()
      const hay = `${p.nickname ?? ''} ${p.id} ${p.title ?? ''} ${promptToMotto(p.prompt)}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  const rows: AgentProfileSummary[][] = []
  for (let i = 0; i < filtered.length; i += 3) rows.push(filtered.slice(i, i + 3))

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>预设决定 Agent 的模型、技能与工具组合。点击名片进入 Agent 设置。</span>
        <GlassButton variant="primary" onClick={() => setView({ kind: 'edit', profile: 'new' })}>+ 新建预设</GlassButton>
      </div>

      <div className={css.agentFilterRow}>
        {(['全部', ...AGENT_DIMENSIONS] as const).map(d => (
          <button
            key={d}
            type="button"
            className={`${css.agentDimPill}${dimFilter === d ? ' ' + css.agentDimPillActive : ''}`}
            onClick={() => setDimFilter(d)}
          >{d}</button>
        ))}
        <div className={css.agentSearchBox}>
          <Search size={13} className={css.agentSearchIcon} />
          <input
            className={css.agentSearchInput}
            placeholder="搜索 Agent…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {error !== null && <p className={css.hintText}>加载失败:{error}</p>}
      {profiles === null && error === null && <p className={css.hintText}>加载中…</p>}
      {profiles !== null && filtered.length === 0 && (
        <p className={css.hintText}>{corumProfiles.length === 0 ? '暂无 Agent 预设，点击右上角「新建预设」创建。' : '没有匹配的 Agent。'}</p>
      )}

      <div className={css.agentCardGrid}>
        {rows.map((row, ri) => (
          <div key={ri} className={css.agentGridRow}>
            {row.map(p => (
              <AgentCard key={p.id} profile={p} onClick={() => setView({ kind: 'edit', profile: p })} />
            ))}
            {row.length < 3 && Array.from({ length: 3 - row.length }, (_, i) => (
              <PlaceholderCard key={`ph-${i}`} />
            ))}
          </div>
        ))}
      </div>

      {officialProfiles.length > 0 && (
        <div className={css.officialGroup}>
          <span className={css.officialGroupTitle}>官方基础模式</span>
          <div className={css.officialGrid}>
            <div className={css.officialRow}>
              {officialProfiles.slice(0, 2).map(p => <OfficialModeCard key={p.id} id={p.id} />)}
            </div>
            {officialProfiles.length > 2 && (
              <div className={css.officialRow}>
                {officialProfiles.slice(2, 4).map(p => <OfficialModeCard key={p.id} id={p.id} />)}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/* ── 编辑/新建 Agent 预设二级页（左右分栏，按设计稿 GHBvv 落码）────────── */

const BASE_MODE_OPTIONS = [
  { id: 'standard', label: 'standard · 标准（完整编码能力）' },
  { id: 'ptc', label: 'ptc · 多步操作' },
  { id: 'minimal', label: 'minimal · 极简双工具' },
  { id: 'cordis', label: 'cordis · 创造模式' },
]

const TERMINAL_OPTIONS = [
  { id: 'sandbox', label: 'sandbox' },
  { id: 'host', label: 'host' },
]

const MEMORY_OPTIONS = [
  { id: 'agent', label: 'agent' },
]

const DIMENSION_OPTIONS = AGENT_DIMENSIONS.map(d => ({ id: d, label: d }))

function EditPresetView({ profile, rpc, onBack, onSaved }: {
  profile: AgentProfileSummary | undefined
  rpc: CorumRpcCall
  onBack: () => void
  onSaved: () => void
}) {
  const isNew = profile === undefined
  const [draft, setDraft] = useState<EditDraft>(() => isNew ? emptyDraft() : draftFromProfile(profile))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [skillBindOpen, setSkillBindOpen] = useState(false)
  const [mcpBindOpen, setMcpBindOpen] = useState(false)
  const [promptZoom, setPromptZoom] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const set = <K extends keyof EditDraft>(k: K, v: EditDraft[K]) => setDraft(prev => ({ ...prev, [k]: v }))

  const handleAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file === undefined) return
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') set('avatar', reader.result) }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const doSave = async () => {
    const id = draft.name.trim().toLowerCase().replace(/\s+/g, '-')
    if (id === '') { setError('预设 ID 不能为空'); return }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { setError('预设 ID 只能包含小写字母、数字、连字符'); return }
    setBusy(true)
    setError(null)
    try {
      await rpc('corumAgent', 'saveProfile', {
        input: {
          id,
          ...(draft.nickname.trim() !== '' ? { nickname: draft.nickname.trim() } : {}),
          ...(draft.title.trim() !== '' ? { title: draft.title.trim() } : {}),
          dimension: draft.dimension,
          ...(draft.experience.trim() !== '' ? { experience: draft.experience.trim() } : {}),
          ...(draft.persona.trim() !== '' ? { persona: draft.persona.trim() } : {}),
          ...(draft.avatar !== '' ? { avatar: draft.avatar } : {}),
          baseMode: draft.baseMode as EditDraft['baseMode'],
          prompt: draft.prompt,
          model: { provider: draft.provider, model: draft.model },
          ...(draft.subEnabled ? { subagentModel: { provider: draft.subProvider, model: draft.subModel } } : {}),
          skills: draft.skills,
          mcpServers: draft.mcpServers,
          terminal: { mode: draft.terminal },
          memoryPolicy: { scope: 'agent' },
          trust: isNew ? 'user' : draft.trust,
        },
      })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    if (profile === undefined) return
    setBusy(true)
    try {
      await rpc('corumAgent', 'deleteProfile', { id: profile.id })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setDeleting(false)
    }
  }

  const EXP_QUICK = ['参与 N 个项目', '完成 N 次任务', '已服务 N 天']

  // Esc 缩小（设计稿 sBqOd：「Esc 缩小 · ⌘Z 撤销润色」）。
  // ⚠️ 必须用 capture 阶段：设置壳 dialog 的 bubble 阶段 Esc 处理器会关闭整个设置弹窗，
  //    capture 阶段先拿到事件并 stopPropagation，Esc 只缩小、不冒泡到壳。
  useEffect(() => {
    if (!promptZoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      setPromptZoom(false)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [promptZoom])

  // 提示词放大态（设计稿 sBqOd：单栏铺满内容区 — zoom-hd + big-area + hint）
  if (promptZoom) {
    return (
      <div className={css.promptZoomCol}>
        <div className={css.promptZoomHd}>
          <span className={css.promptZoomTitle}>提示词</span>
          <div className={css.promptZoomActions}>
            <button type="button" className={css.btnPolish} disabled title="即将上线"><Sparkles size={11} />AI 润色</button>
            <button type="button" className={css.btnGhost} onClick={() => setPromptZoom(false)}><Minimize2 size={12} />缩小</button>
          </div>
        </div>
        <div className={css.promptZoomArea}>
          <textarea
            className={css.promptZoomTextarea}
            value={draft.prompt}
            onChange={e => set('prompt', e.target.value)}
            placeholder="你是研发工程师。接到任务后简洁完成并调用 complete_task 上报。"
          />
        </div>
        <p className={css.hintText}>Esc 缩小 · ⌘Z 撤销润色</p>
      </div>
    )
  }

  const previewProfile: AgentProfileSummary = {
    id: draft.name || 'new-agent',
    ...(draft.nickname !== '' ? { nickname: draft.nickname } : {}),
    ...(draft.title !== '' ? { title: draft.title } : {}),
    ...(draft.dimension !== '' ? { dimension: draft.dimension } : {}),
    ...(draft.experience !== '' ? { experience: draft.experience } : {}),
    ...(draft.persona !== '' ? { persona: draft.persona } : {}),
    ...(draft.avatar !== '' ? { avatar: draft.avatar } : {}),
    prompt: draft.prompt,
    model: { provider: draft.provider, model: draft.model },
    skills: draft.skills,
    mcpServers: draft.mcpServers,
    terminal: { mode: draft.terminal },
    version: 1,
    trust: draft.trust,
    source: 'corum',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%', height: '100%', minHeight: 0 }}>
      {/* 返回行 */}
      <div style={{ width: '100%' }}>
        <button type="button" className={css.backBtn} onClick={onBack}>
          <ChevronLeft size={14} />返回 Agent 预设
        </button>
      </div>

      {/* 顶部一排：基本信息（左）+ 名片预览（右） */}
      <div style={{ display: 'flex', gap: 20, width: '100%' }}>
        {/* 左：基本信息（设计稿 GHBvv basicCol: gap 8 + avatarRow gap 18） */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className={css.formGroupTitle}>基本信息</div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            {/* avatarBlock：64 头像 + 上传提示 + AI 生成（纵向 gap 6，居中） */}
            <div className={css.avatarBlock}>
              <div className={css.avatarBox} onClick={() => fileRef.current?.click()} role="button">
                {draft.avatar !== ''
                  ? <img className={css.agentAvatarImg} src={draft.avatar} alt="" />
                  : <Upload size={26} className={css.avatarIcon} />}
              </div>
              <span className={css.avatarHint}>点击上传头像</span>
              <button type="button" className={css.btnPolish} disabled title="即将上线">
                <Sparkles size={12} className={css.btnPolishIcon} />AI 生成
              </button>
            </div>
            {/* fieldsBlock：两列字段（组内 gap 6） */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className={css.formCols}>
                <div className={css.formCol}>
                  <label className={css.fieldLabel}>预设 ID</label>
                  <input className={css.fieldInput} value={draft.name} onChange={e => set('name', e.target.value)} placeholder="my-agent" disabled={!isNew} />
                </div>
                <div className={css.formCol}>
                  <label className={css.fieldLabel}>昵称</label>
                  <input className={css.fieldInput} value={draft.nickname} onChange={e => set('nickname', e.target.value)} placeholder="我的 Agent" />
                </div>
              </div>
              <div className={css.formCols}>
                <div className={css.formCol}>
                  <label className={css.fieldLabel}>岗位 / 职位</label>
                  <input className={css.fieldInput} value={draft.title} onChange={e => set('title', e.target.value)} placeholder="如：前端工程师 / 测试 / PM" />
                </div>
                <div className={css.formCol}>
                  <label className={css.fieldLabel}>岗位维度（名片筛选）</label>
                  <SelectField value={draft.dimension} options={DIMENSION_OPTIONS} onChange={v => set('dimension', v)} variant="fill" />
                </div>
              </div>
            </div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarFile} />
        </div>

        {/* 右：名片预览（设计稿 prevCol: width 280, gap 4） */}
        <div style={{ flex: 'none', width: 280, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className={css.formGroupTitle}>名片预览</div>
          <AgentCard profile={previewProfile} onClick={() => {}} />
        </div>
      </div>

      {/* 记忆摘要 */}
      <div className={css.formGroup}>
        <div className={css.formGroupTitle}>记忆摘要（根据 Agent 的记忆沉淀自动汇总）</div>
        <label className={css.fieldLabel}>经验说明</label>
        <input className={css.fieldInput} value={draft.experience} onChange={e => set('experience', e.target.value)} placeholder="参与 6 个项目 · 完成 128 次任务" />
        <div className={css.expQuickRow}>
          {EXP_QUICK.map(q => (
            <button
              key={q}
              type="button"
              className={css.expQuickPill}
              onClick={() => set('experience', draft.experience === '' ? q : `${draft.experience} · ${q}`)}
            >+ {q}</button>
          ))}
        </div>
      </div>

      {/* 下方全宽表单（独立滚动） */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* 继承自（设计稿 GHBvv g-inherit: label + sel + hint，无组标题） */}
        <div className={css.formGroup} style={{ gap: 3 }}>
          <label className={css.fieldLabel}>继承自</label>
          <SelectField value={draft.baseMode} options={BASE_MODE_OPTIONS} onChange={v => set('baseMode', v)} variant="fill" />
          <p className={css.fieldHint}>将继承 {draft.baseMode} 的系统提示词与 persona</p>
        </div>

        {/* 人格设置（设计稿 GHBvv g-persona：AI 润色在文本域内底部行，与字数统计同行） */}
        <div className={css.formGroup}>
          <div className={css.formGroupTitle}>人格设置</div>
          <label className={css.fieldLabel}>用一段话描述 Agent 的人格特质与行为倾向（不超过 500 字符）</label>
          <div className={css.promptArea}>
            <textarea
              className={css.promptTextarea}
              value={draft.persona}
              onChange={e => set('persona', e.target.value.slice(0, 500))}
              placeholder="务实、简洁、注重结果。接到任务后先理解目标再动手，不废话不拖延。"
              rows={3}
              maxLength={500}
            />
            <div className={css.promptActionsRow}>
              <span className={css.promptCount}>{draft.persona.length} / 500</span>
              <button type="button" className={css.btnPolish} disabled title="即将上线">
                <Sparkles size={11} className={css.btnPolishIcon} />AI 润色
              </button>
            </div>
          </div>
        </div>

        {/* 提示词（设计稿 GHBvv g-prompt：放大钮为 ghost 小钮；AI 润色在文本域内底部行） */}
        <div className={css.formGroup}>
          <div className={css.formGroupTitle} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>提示词</span>
            <button type="button" className={css.btnGhost} onClick={() => setPromptZoom(true)}><Maximize2 size={12} />放大</button>
          </div>
          <label className={css.fieldLabel}>自定义提示词（叠加在基础模式 persona 之上，非替代）</label>
          <div className={css.promptArea}>
            <textarea className={css.promptTextarea} value={draft.prompt} onChange={e => set('prompt', e.target.value)} placeholder="你是研发工程师。接到任务后简洁完成并调用 complete_task 上报。" rows={3} />
            <div className={css.promptActionsRow}>
              <button type="button" className={css.btnPolish} disabled title="即将上线">
                <Sparkles size={11} className={css.btnPolishIcon} />AI 润色
              </button>
            </div>
          </div>
        </div>

        {/* 模型 */}
        <div className={css.formGroup}>
          <div className={css.formGroupTitle}>模型</div>
          <div className={css.formCols}>
            <div className={css.formCol}>
              <label className={css.fieldLabel}>主 Agent</label>
              <div className={css.selectStack}>
                <SelectField value={draft.provider} options={[{ id: 'deepseek-official', label: 'deepseek-official' }, { id: 'pi-ai', label: 'pi-ai' }]} onChange={v => set('provider', v)} variant="fill" />
                <SelectField value={draft.model} options={[{ id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }, { id: 'deepseek-v4', label: 'deepseek-v4' }, { id: 'deepseek-r1', label: 'deepseek-r1' }]} onChange={v => set('model', v)} variant="fill" />
              </div>
            </div>
            <div className={css.formCol}>
              <label className={css.fieldLabel}>子 Agent（可选，缺省同主 Agent）</label>
              <div className={css.selectStack}>
                <SelectField value={draft.subEnabled ? draft.subProvider : ''} options={[{ id: '', label: '（同主 Agent）' }, { id: 'deepseek-official', label: 'deepseek-official' }, { id: 'pi-ai', label: 'pi-ai' }]} onChange={v => { set('subEnabled', v !== ''); if (v !== '') set('subProvider', v) }} variant="fill" />
                <SelectField value={draft.subEnabled ? draft.subModel : ''} options={[{ id: '', label: '（同主 Agent）' }, { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }, { id: 'deepseek-v4', label: 'deepseek-v4' }, { id: 'deepseek-r1', label: 'deepseek-r1' }]} onChange={v => { if (v !== '') set('subModel', v) }} disabled={!draft.subEnabled} variant="fill" />
              </div>
            </div>
          </div>
        </div>

        {/* 技能 + MCP */}
        <div className={css.formGroup}>
          <div className={css.formCols}>
            <div className={css.formCol}>
              <div className={css.formGroupTitle}>技能配置</div>
              {draft.skills.map((s, i) => (
                <div key={`${s.name}-${i}`} className={css.listRow}>
                  <Star size={12} className={css.listIcon} />
                  <span className={css.listName}>{s.name}</span>
                  <span className={css.bindVersionText}>{s.versionId}</span>
                  <Trash2 size={12} className={css.listDel} onClick={() => set('skills', draft.skills.filter((_, idx) => idx !== i))} />
                </div>
              ))}
              <button type="button" className={css.btnAdd} onClick={() => setSkillBindOpen(true)}><Plus size={12} />添加技能</button>
            </div>
            <div className={css.formCol}>
              <div className={css.formGroupTitle}>MCP 服务</div>
              {draft.mcpServers.map((s, i) => (
                <div key={`${s}-${i}`} className={css.listRow}>
                  <span className={css.listDot} />
                  <span className={css.listName}>{s}</span>
                  <Trash2 size={12} className={css.listDel} onClick={() => set('mcpServers', draft.mcpServers.filter((_, idx) => idx !== i))} />
                </div>
              ))}
              <button type="button" className={css.btnAdd} onClick={() => setMcpBindOpen(true)}><Plus size={12} />添加 MCP</button>
            </div>
          </div>
        </div>

        {/* 终端 + 记忆 */}
        <div className={css.formGroup}>
          <div className={css.formCols}>
            <div className={css.formCol}>
              <label className={css.fieldLabel}>终端模式</label>
              <SelectField value={draft.terminal} options={TERMINAL_OPTIONS} onChange={v => set('terminal', v as 'sandbox' | 'host')} variant="fill" />
            </div>
            <div className={css.formCol}>
              <label className={css.fieldLabel}>记忆作用域</label>
              <SelectField value={draft.memory} options={MEMORY_OPTIONS} onChange={v => set('memory', v)} variant="fill" />
            </div>
          </div>
        </div>

        {error !== null && <p className={css.hintText}>{error}</p>}

        {/* footer */}
        <div className={css.formGroup} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className={css.trustLabel}>信任级</span>
            <span className={css.trustBadge}>{draft.trust}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!isNew && (
              <GlassButton variant="danger" onClick={() => setDeleting(true)}>删除</GlassButton>
            )}
            <GlassButton onClick={onBack}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => void doSave()} disabled={busy}>{busy ? '保存中…' : isNew ? '创建' : '保存'}</GlassButton>
          </div>
        </div>
      </div>

      {/* 弹窗 */}
      {skillBindOpen && (
        <SkillBindDialog
          rpc={rpc}
          bound={draft.skills}
          onClose={() => setSkillBindOpen(false)}
          onConfirm={skills => { set('skills', skills); setSkillBindOpen(false) }}
        />
      )}
      {mcpBindOpen && (
        <McpBindDialog
          rpc={rpc}
          bound={draft.mcpServers}
          onClose={() => setMcpBindOpen(false)}
          onConfirm={servers => { set('mcpServers', servers); setMcpBindOpen(false) }}
        />
      )}
      {deleting && profile !== undefined && (
        <DeletePresetDialog
          profile={profile}
          rpc={rpc}
          onClose={() => setDeleting(false)}
          onDeleted={() => { setDeleting(false); onSaved() }}
        />
      )}
    </div>
  )
}

/* ── 账户与用量 ────────────────────────────────────────────────────── */

function AccountSection() {
  return (
    <>
      <SettingGroup title="账户">
        <SettingRow label="当前账户" desc="corum@local">
          <GlassButton>登出</GlassButton>
        </SettingRow>
        <SettingRow label="订阅" desc="免费版" divider={false}>
          <GlassButton>升级</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="用量统计">
        <SettingRow label="本月 API 调用" desc="">
          <span className={css.sizeLabel}>1,234 次</span>
        </SettingRow>
        <SettingRow label="Token 用量" desc="" divider={false}>
          <span className={css.sizeLabel}>5.6M tokens</span>
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── MCP 与集成 ────────────────────────────────────────────────────── */

type McpTransport = 'stdio' | 'SSE / HTTP' | 'WebSocket'

interface McpTool {
  name: string
  enabled: boolean
}

interface McpServerData {
  id: string
  name: string
  transport: McpTransport
  desc: string
  workdir: string
  tools: McpTool[]
  enabled: boolean
}

const FILESYSTEM_TOOLS: McpTool[] = [
  'read_file', 'write_file', 'list_directory', 'search_files', 'move_file',
  'create_directory', 'delete_file', 'get_file_info', 'read_multiple', 'edit_file',
  'copy_file', 'rename_file', 'stat_directory', 'watch_directory',
].map(name => ({ name, enabled: true }))

const WEB_SEARCH_TOOLS: McpTool[] = [
  'search', 'fetch_page', 'extract_text', 'summarize', 'crawl_site', 'query_news',
].map(name => ({ name, enabled: true }))

const DB_INSPECTOR_TOOLS: McpTool[] = [
  'list_tables', 'describe_table', 'run_query', 'run_select', 'explain_plan',
  'list_indexes', 'table_stats', 'export_csv', 'inspect_schema',
].map(name => ({ name, enabled: true }))

const INITIAL_MCP_SERVERS: McpServerData[] = [
  {
    id: 'filesystem', name: 'filesystem', transport: 'stdio',
    desc: '本地文件系统读写', workdir: '/Users/kukucai/work',
    tools: FILESYSTEM_TOOLS, enabled: true,
  },
  {
    id: 'web-search', name: 'web-search', transport: 'SSE / HTTP',
    desc: '联网搜索', workdir: 'https://mcp.corum.dev/search',
    tools: WEB_SEARCH_TOOLS, enabled: true,
  },
  {
    id: 'db-inspector', name: 'db-inspector', transport: 'WebSocket',
    desc: '数据库结构检查', workdir: 'ws://127.0.0.1:7788/inspect',
    tools: DB_INSPECTOR_TOOLS, enabled: false,
  },
]

const TRANSPORT_OPTIONS: McpTransport[] = ['stdio', 'SSE / HTTP', 'WebSocket']

/* 不同传输方式对应不同的配置示例 */
const MCP_JSON_PLACEHOLDERS: Record<McpTransport, string> = {
  'stdio': `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
}`,
  'SSE / HTTP': `{
  "url": "https://mcp.example.com/sse",
  "headers": { "Authorization": "Bearer <token>" }
}`,
  'WebSocket': `{
  "url": "ws://127.0.0.1:7788/mcp",
  "protocols": ["mcp.v1"]
}`,
}

/* 添加 MCP 服务器对话框（设计稿 sIDC1） */
function AddMcpServerDialog({ onClose, onAdd }: {
  onClose: () => void
  onAdd: (server: McpServerData) => void
}) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [configJson, setConfigJson] = useState('')
  const [startTimeout, setStartTimeout] = useState('60000')
  const [runTimeout, setRunTimeout] = useState('60000')

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>添加 MCP 服务器</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <div className={css.formGroup}>
            <label className={css.fieldLabel}>服务器名称</label>
            <input className={css.fieldInput} value={name} onChange={e => setName(e.target.value)} placeholder="my-mcp-server" />
          </div>
          <div className={css.formGroup}>
            <label className={css.fieldLabel}>传输方式</label>
            <div className={css.transportPills}>
              {TRANSPORT_OPTIONS.map(t => (
                <button
                  key={t}
                  type="button"
                  className={`${css.transportPill}${t === transport ? ' ' + css.transportPillActive : ''}`}
                  onClick={() => setTransport(t)}
                >{t}</button>
              ))}
            </div>
          </div>
          <div className={css.formGroup}>
            <label className={css.fieldLabel}>配置（JSON）</label>
            <textarea
              className={css.jsonTextarea}
              value={configJson}
              onChange={e => setConfigJson(e.target.value)}
              placeholder={MCP_JSON_PLACEHOLDERS[transport]}
            />
          </div>
          <div className={css.formGroup}>
            <div className={css.formCols}>
              <div className={css.formCol}>
                <label className={css.fieldLabel}>启动超时（ms）</label>
                <input className={css.fieldInput} value={startTimeout} onChange={e => setStartTimeout(e.target.value)} />
              </div>
              <div className={css.formCol}>
                <label className={css.fieldLabel}>运行超时（ms）</label>
                <input className={css.fieldInput} value={runTimeout} onChange={e => setRunTimeout(e.target.value)} />
              </div>
            </div>
          </div>
          <div className={css.marketRow}>
            <Package size={14} />
            <span>或从 MCP 市场一键安装</span>
            <button type="button" className={css.marketLink}>浏览市场 →</button>
          </div>
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => onAdd({
              id: name || 'my-mcp-server',
              name: name || 'my-mcp-server',
              transport,
              desc: '',
              workdir: '',
              tools: [],
              enabled: true,
            })}>添加</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* MCP 服务器详情对话框（设计稿 fw8aK） */
function McpServerDetailDialog({ server, onClose, onSave, onDelete }: {
  server: McpServerData
  onClose: () => void
  onSave: (server: McpServerData) => void
  onDelete: (id: string) => void
}) {
  const [draft, setDraft] = useState<McpServerData>(() => JSON.parse(JSON.stringify(server)) as McpServerData)
  const [expanded, setExpanded] = useState(false)

  const visibleTools = expanded ? draft.tools : draft.tools.slice(0, 5)
  const hiddenCount = draft.tools.length - visibleTools.length

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()}>
        <div className={css.modalHeader}>
          <div className={css.detailHead}>
            <span className={draft.enabled ? css.detailDot : css.detailDotOff} />
            <span className={css.detailName}>{draft.name}</span>
            <span className={css.detailChip}>{draft.transport}</span>
          </div>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <div className={css.formGroup}>
            <div className={css.formGroupTitle}>基本信息</div>
            <label className={css.fieldLabel}>描述</label>
            <input
              className={css.fieldInput}
              value={draft.desc}
              onChange={e => setDraft(prev => ({ ...prev, desc: e.target.value }))}
              placeholder="服务器用途说明"
            />
            <div className={css.kvRow}>
              <span className={css.kvLabel}>工作目录</span>
              <span className={css.kvValue}>{draft.workdir || '—'}</span>
            </div>
            <div className={css.kvRow}>
              <span className={css.kvLabel}>已注册工具</span>
              <span className={css.kvValue}>{draft.tools.length} 个</span>
            </div>
          </div>
          <div className={css.formGroup}>
            <div className={css.formGroupTitle}>工具列表</div>
            {visibleTools.map((tool, i) => (
              <div key={tool.name} className={css.toolRow}>
                <span className={css.toolName}>{tool.name}</span>
                <Switch
                  checked={tool.enabled}
                  onChange={v => setDraft(prev => {
                    const tools = prev.tools.slice()
                    tools[i] = { ...tools[i], enabled: v }
                    return { ...prev, tools }
                  })}
                />
              </div>
            ))}
            {hiddenCount > 0 && (
              <div className={css.expandRow}>
                <button type="button" className={css.expandLink} onClick={() => setExpanded(true)}>
                  <ChevronDown size={13} />展开全部 {draft.tools.length} 个工具
                </button>
              </div>
            )}
            {expanded && draft.tools.length > 5 && (
              <div className={css.expandRow}>
                <button type="button" className={css.expandLink} onClick={() => setExpanded(false)}>
                  <ChevronUp size={13} />收起
                </button>
              </div>
            )}
          </div>
          <div className={css.kvRow}>
            <span className={css.kvLabel}>启用此服务器</span>
            <Switch checked={draft.enabled} onChange={v => setDraft(prev => ({ ...prev, enabled: v }))} />
          </div>
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft}>
            <GlassButton variant="danger" onClick={() => onDelete(server.id)}>删除</GlassButton>
          </div>
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => onSave(draft)}>保存</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function McpSection() {
  const [servers, setServers] = useState<McpServerData[]>(INITIAL_MCP_SERVERS)
  const [addOpen, setAddOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = servers.find(s => s.id === selectedId) ?? null

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>连接外部 MCP 服务器，为 Agent 提供工具与数据源。</span>
        <GlassButton variant="primary" onClick={() => setAddOpen(true)}>+ 添加服务器</GlassButton>
      </div>
      {servers.map(s => (
        <button key={s.id} type="button" className={css.serverCardBtn} onClick={() => setSelectedId(s.id)}>
          <div className={css.serverLeft}>
            <span className={s.enabled ? css.serverDotOn : css.serverDotOff} />
            <div className={css.serverMeta}>
              <span className={css.serverName}>{s.name}</span>
              <span className={css.serverDesc}>{s.desc || s.transport}</span>
            </div>
          </div>
          <div className={css.serverRight}>
            <span className={css.serverTools}>{s.tools.length} 个工具</span>
            <span onClick={e => e.stopPropagation()}>
              <Switch
                checked={s.enabled}
                onChange={v => setServers(prev => prev.map(x => x.id === s.id ? { ...x, enabled: v } : x))}
              />
            </span>
            <Trash2
              size={15}
              className={css.memDel}
              onClick={e => { e.stopPropagation(); setServers(prev => prev.filter(x => x.id !== s.id)) }}
            />
          </div>
        </button>
      ))}
      {addOpen && (
        <AddMcpServerDialog
          onClose={() => setAddOpen(false)}
          onAdd={server => { setServers(prev => [...prev, server]); setAddOpen(false) }}
        />
      )}
      {selected && (
        <McpServerDetailDialog
          server={selected}
          onClose={() => setSelectedId(null)}
          onSave={updated => {
            setServers(prev => prev.map(x => x.id === updated.id ? updated : x))
            setSelectedId(null)
          }}
          onDelete={id => {
            setServers(prev => prev.filter(x => x.id !== id))
            setSelectedId(null)
          }}
        />
      )}
    </>
  )
}

/* ── 技能 ──────────────────────────────────────────────────────────── */

/* skill-manager / corumAgent 的 UI 投影类型（与 host 端 types.ts 对齐） */
interface SkillInfo {
  name: string
  description: string
  path: string
  currentVersion?: string
  versionCount: number
  createdAt?: string
}
interface SkillVersion { id: string; date: string; label: string }
interface SkillBinding { name: string; versionId: string }
interface ProfileSummary { id: string; nickname?: string; skills: SkillBinding[] }
interface ScannedSkill { name: string; description: string; sourcePath: string }

/** 绑定某 skill 的 Agent 投影（详情页「绑定关系」列表用）。 */
interface SkillAgentBind { agentId: string; agentName: string; versionId: string }

type SkillsView = { kind: 'list' } | { kind: 'detail'; name: string }

function SkillsSection() {
  const rpc = useCorumRpc()
  const [view, setView] = useState<SkillsView>({ kind: 'list' })
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SkillInfo | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const reload = async () => {
    if (!rpc) return
    try {
      const [sk, pf] = await Promise.all([
        rpc<{ skills: SkillInfo[] }>('skillManager', 'listAll', {}),
        rpc<{ profiles: ProfileSummary[] }>('corumAgent', 'listProfiles', {}),
      ])
      setSkills(sk.skills)
      setProfiles(pf.profiles)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void reload() }, [rpc])

  /** 计算某 skill 被多少个 Agent 绑定。 */
  const bindCount = (name: string) =>
    profiles.filter(p => (p.skills ?? []).some(s => s.name === name)).length

  if (!rpc) {
    return <p className={css.hintText}>技能服务未就绪。</p>
  }

  if (view.kind === 'detail') {
    const info = (skills ?? []).find(s => s.name === view.name)
    return (
      <SkillDetailView
        name={view.name}
        info={info}
        profiles={profiles}
        rpc={rpc}
        onBack={() => setView({ kind: 'list' })}
        onChanged={() => { void reload() }}
      />
    )
  }

  return (
    <>
      <SettingGroup title="全局技能">
        {error && <p className={css.hintText}>加载失败：{error}</p>}
        {skills === null && !error && <p className={css.hintText}>加载中…</p>}
        {skills !== null && skills.length === 0 && (
          <p className={css.hintText}>暂无技能，点击下方按钮导入。</p>
        )}
        {(skills ?? []).map((s, i) => (
          <div key={s.name}>
            {i > 0 && <div className={css.memDivider} />}
            <button type="button" className={css.skillRowBtn} onClick={() => setView({ kind: 'detail', name: s.name })}>
              <Star size={14} className={css.skillIcon} />
              <div className={css.skillMeta}>
                <span className={css.skillLabel}>{s.name}</span>
                <span className={css.skillDesc}>{(s.currentVersion ?? '—')} · {s.description}</span>
              </div>
              <span className={css.skillChip}>已绑定 {bindCount(s.name)} 个 Agent</span>
              <span onClick={e => e.stopPropagation()}>
                <Trash2 size={15} className={css.memDel} onClick={() => setDeleting(s)} />
              </span>
            </button>
          </div>
        ))}
        <div className={css.actionsRow}>
          <GlassButton onClick={() => setImportOpen(true)}>导入技能</GlassButton>
        </div>
      </SettingGroup>
      <p className={css.hintText}>技能是可复用的指令与资源包，可在 Agent 预设中按版本绑定。点击条目查看详情。</p>
      {deleting && (
        <DeleteSkillDialog
          skill={deleting}
          bindCount={bindCount(deleting.name)}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); void reload() }}
          rpc={rpc}
        />
      )}
      {importOpen && (
        <ImportSkillDialog
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); void reload() }}
          rpc={rpc}
        />
      )}
    </>
  )
}

/* ── 版本选择下拉（触发按钮 + portal 面板，面板内每个版本用 item 富形态）────── */

function VersionSelect({ versions, pinned, onSelect, disabled }: {
  versions: SkillVersion[]
  pinned: string | undefined
  onSelect: (versionId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const current = versions.find(v => v.id === pinned) ?? versions[versions.length - 1]

  useEffect(() => {
    if (!open) return
    const btn = btnRef.current
    if (btn) {
      const r = btn.getBoundingClientRect()
      setPos({ top: r.bottom + 4, left: r.left, width: r.width })
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <div className={css.versionSelectWrap}>
      <button
        ref={btnRef}
        type="button"
        className={css.versionSelectBtn}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span className={css.radioOn} />
        <span className={css.versionMeta}>
          <span className={css.versionId}>{current.id}</span>
          <span className={css.versionLabel}>{current.label}</span>
        </span>
        <ChevronDown size={16} className={css.versionSelectChevron} />
      </button>
      {open && !disabled && pos && createPortal(
        <div
          ref={panelRef}
          className={css.versionPanel}
          role="listbox"
          style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width }}
        >
          {versions.map(v => {
            const active = v.id === current.id
            return (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={active}
                className={active ? css.versionRowActive : css.versionRow}
                onClick={() => { onSelect(v.id); setOpen(false) }}
              >
                <span className={active ? css.radioOn : css.radioOff} />
                <div className={css.versionMeta}>
                  <span className={css.versionId}>{v.id}</span>
                  <span className={css.versionLabel}>{v.label}</span>
                </div>
                {active && <span className={css.currentTag}>当前使用</span>}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}

/* ── 技能详情视图（基本信息 / SKILL.md 内容 / 版本历史 / 绑定关系）────────── */

function SkillDetailView({ name, info, profiles, rpc, onBack, onChanged }: {
  name: string
  info: SkillInfo | undefined
  profiles: ProfileSummary[]
  rpc: CorumRpcCall
  onBack: () => void
  onChanged: () => void
}) {
  const [content, setContent] = useState<string | null>(null)
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [pinned, setPinned] = useState<string | undefined>(info?.currentVersion)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [commitOpen, setCommitOpen] = useState(false)

  // 绑定此 skill 的全部 Agent（含各自 pin 的版本）
  const bindings: SkillAgentBind[] = profiles
    .filter(p => (p.skills ?? []).some(s => s.name === name))
    .map(p => ({
      agentId: p.id,
      agentName: p.nickname ?? p.id,
      versionId: (p.skills ?? []).find(s => s.name === name)!.versionId,
    }))

  const load = async () => {
    try {
      const [c, h] = await Promise.all([
        rpc<{ ok: boolean; error?: string; content?: string }>('skillManager', 'getSkillContent', { name }),
        rpc<{ versions: SkillVersion[] }>('skillManager', 'getSkillHistory', { name }),
      ])
      if (c.ok && c.content !== undefined) setContent(c.content)
      setVersions(h.versions)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void load() }, [name])

  const switchVersion = async (versionId: string) => {
    setBusy(true)
    try {
      await rpc('skillManager', 'pinVersion', { name, versionId })
      setPinned(versionId)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveAndCommit = async (label?: string) => {
    setBusy(true)
    try {
      const r = await rpc<{ ok: boolean; error?: string; version?: SkillVersion }>(
        'skillManager', 'commitVersion', { name, content: draft, label: label ?? '手动提交' })
      if (!r.ok) { setError(r.error ?? '提交失败'); return }
      setEditing(false)
      setCommitOpen(false)
      await load()
      if (r.version) setPinned(r.version.id)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = () => { setDraft(content ?? ''); setEditing(true) }

  return (
    <>
      <div className={css.detailHeadRow}>
        <button type="button" className={css.backBtn} onClick={onBack}>
          <ArrowLeft size={14} />返回列表
        </button>
      </div>

      {/* 基本信息 */}
      <SettingGroup title="基本信息">
        <div className={css.skillTitleRow}>
          <Star size={16} className={css.skillIcon} />
          <span className={css.skillTitle}>{name}</span>
          {pinned && <span className={css.skillChip}>{pinned}</span>}
        </div>
        <div className={css.kvRow}><span className={css.kvLabel}>描述</span><span className={css.kvValue}>{info?.description ?? '—'}</span></div>
        <div className={css.kvRow}><span className={css.kvLabel}>存储路径</span><span className={css.kvValue}>{info?.path ?? '—'}</span></div>
        <div className={css.kvRow}><span className={css.kvLabel}>版本数量</span><span className={css.kvValue}>{info?.versionCount ?? versions.length} 个</span></div>
        <div className={css.kvRow}><span className={css.kvLabel}>创建时间</span><span className={css.kvValue}>{info?.createdAt ?? '—'}</span></div>
      </SettingGroup>

      {/* SKILL.md 内容 */}
      <SettingGroup title="SKILL.md 内容">
        {error && <p className={css.hintText}>{error}</p>}
        {!editing ? (
          <>
            <pre className={css.skillViewer}>{content ?? '加载中…'}</pre>
            <div className={css.actionsRow}>
              <GlassButton onClick={startEdit}>✎ 编辑</GlassButton>
              <GlassButton variant="primary" onClick={() => { setDraft(content ?? ''); setCommitOpen(true) }}>提交新版本</GlassButton>
            </div>
          </>
        ) : (
          <>
            <textarea className={css.skillEditor} value={draft} onChange={e => setDraft(e.target.value)} rows={14} />
            <p className={css.hintText}>编辑不会立即生效——保存后将当前内容提交为新版本（自动设为当前版本）。</p>
            <div className={css.actionsRow}>
              <GlassButton onClick={() => setEditing(false)}>取消</GlassButton>
              <GlassButton variant="primary" onClick={() => void saveAndCommit()} disabled={busy}>{busy ? '提交中…' : '保存并提交新版本'}</GlassButton>
            </div>
          </>
        )}
      </SettingGroup>

      {/* 版本历史：下拉选择（不 list 平铺），面板内版本项用 item 富形态，选中即生效 */}
      <SettingGroup title={`版本历史（${versions.length}）`}>
        {versions.length === 0 && <p className={css.hintText}>暂无版本记录。</p>}
        {versions.length > 0 && (
          <VersionSelect
            versions={versions}
            pinned={pinned}
            onSelect={id => void switchVersion(id)}
            disabled={busy}
          />
        )}
      </SettingGroup>

      {/* 绑定关系（全列表，只读） */}
      <SettingGroup title={`绑定此技能的 Agent（${bindings.length}）`}>
        {bindings.length === 0 && <p className={css.hintText}>暂无 Agent 绑定此技能。</p>}
        {bindings.map(b => (
          <div key={b.agentId} className={css.bindRow}>
            <span className={css.bindAvatar}>{b.agentName[0] ?? '?'}</span>
            <span className={css.bindName}>{b.agentName}</span>
            <span className={css.skillChip}>pin {b.versionId}</span>
          </div>
        ))}
        <p className={css.hintText}>绑定关系在 Agent 预设中管理，此处仅展示。</p>
      </SettingGroup>

      {commitOpen && (
        <CommitVersionDialog
          name={name}
          onClose={() => setCommitOpen(false)}
          onSubmit={label => void saveAndCommit(label)}
          busy={busy}
        />
      )}
    </>
  )
}

/* ── 提交新版本对话框 ─────────────────────────────────────────────── */

function CommitVersionDialog({ name, onClose, onSubmit, busy }: {
  name: string
  onClose: () => void
  onSubmit: (label: string) => void
  busy: boolean
}) {
  const [label, setLabel] = useState('')
  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>提交新版本</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <p className={css.hintText}>把「{name}」当前的 SKILL.md 保存为一个新版本快照。</p>
          <div className={css.formGroup}>
            <label className={css.fieldLabel}>版本备注</label>
            <input className={css.fieldInput} value={label} onChange={e => setLabel(e.target.value)} placeholder="如：优化评审分级模板" />
          </div>
          <p className={css.hintText}>提交后该版本将自动设为当前生效版本；Agent 仍按各自 pin 的版本引用。</p>
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => onSubmit(label || '手动提交')} disabled={busy}>{busy ? '提交中…' : '提交'}</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── 删除技能确认对话框 ───────────────────────────────────────────── */

function DeleteSkillDialog({ skill, bindCount, onClose, onDeleted, rpc }: {
  skill: SkillInfo
  bindCount: number
  onClose: () => void
  onDeleted: () => void
  rpc: CorumRpcCall
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const doDelete = async () => {
    setBusy(true)
    try {
      const r = await rpc<{ ok: boolean; error?: string }>('skillManager', 'deleteSkill', { name: skill.name })
      if (!r.ok) { setError(r.error ?? '删除失败'); setBusy(false); return }
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return createPortal(
    <div className={css.confirmOverlay} onClick={onClose}>
      <div className={css.confirmDialog} onClick={e => e.stopPropagation()}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>删除技能</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <p className={css.confirmMsg}>确定删除技能「{skill.name}」吗？</p>
          {bindCount > 0 && (
            <p className={css.confirmWarn}>该技能已绑定 {bindCount} 个 Agent。删除后这些 Agent 将失去此技能，且不可恢复。</p>
          )}
          {error && <p className={css.confirmWarn}>{error}</p>}
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="danger" onClick={() => void doDelete()} disabled={busy}>{busy ? '删除中…' : '删除'}</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── 导入技能对话框（文件 / 文本粘贴 / 扫描目录）───────────────────── */

type ImportTab = 'file' | 'text' | 'scan'

function ImportSkillDialog({ onClose, onImported, rpc }: {
  onClose: () => void
  onImported: () => void
  rpc: CorumRpcCall
}) {
  const [tab, setTab] = useState<ImportTab>('file')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // file
  const [filePath, setFilePath] = useState('')
  // text
  const [textName, setTextName] = useState('')
  const [textContent, setTextContent] = useState('')
  // scan
  const [scanDir, setScanDir] = useState('')
  const [scanned, setScanned] = useState<ScannedSkill[] | null>(null)
  const [existing, setExisting] = useState<string[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const importFile = () => run(async () => {
    const name = filePath.replace(/\/+$/, '').split('/').pop() ?? ''
    const r = await rpc<{ ok: boolean; error?: string }>('skillManager', 'importFromFile', { skillName: name, sourcePath: filePath })
    if (!r.ok) { setError(r.error ?? '导入失败'); return }
    onImported()
  })

  const importText = () => run(async () => {
    const r = await rpc<{ ok: boolean; error?: string }>('skillManager', 'importFromText', { skillName: textName, content: textContent })
    if (!r.ok) { setError(r.error ?? '导入失败'); return }
    onImported()
  })

  const doScan = () => run(async () => {
    const r = await rpc<{ skills: ScannedSkill[]; existing: string[] }>('skillManager', 'scanDirectory', { sourcePath: scanDir })
    setScanned(r.skills)
    setExisting(r.existing)
    setChecked(new Set(r.skills.filter(s => !r.existing.includes(s.name)).map(s => s.name)))
  })

  const importScanned = () => run(async () => {
    const r = await rpc<{ imported: number; skipped: number; failed: { name: string; error: string }[] }>('skillManager', 'importDirectory', { sourcePath: scanDir })
    if (r.failed.length > 0) { setError(`部分失败：${r.failed.map(f => f.name).join('、')}`); return }
    onImported()
  })

  const TABS: { id: ImportTab; label: string }[] = [
    { id: 'file', label: '从文件导入' },
    { id: 'text', label: '从文本粘贴' },
    { id: 'scan', label: '扫描目录' },
  ]

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>导入技能</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <div className={css.transportPills}>
            {TABS.map(t => (
              <button key={t.id} type="button" className={`${css.transportPill}${tab === t.id ? ' ' + css.transportPillActive : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
          {error && <p className={css.confirmWarn}>{error}</p>}

          {tab === 'file' && (
            <div className={css.formGroup}>
              <label className={css.fieldLabel}>技能目录或 SKILL.md 路径</label>
              <input className={css.fieldInput} value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="/path/to/skill" />
              <p className={css.hintText}>需包含有效 frontmatter（name + description）的 SKILL.md。</p>
            </div>
          )}

          {tab === 'text' && (
            <>
              <div className={css.formGroup}>
                <label className={css.fieldLabel}>技能名称</label>
                <input className={css.fieldInput} value={textName} onChange={e => setTextName(e.target.value)} placeholder="my-skill" />
              </div>
              <div className={css.formGroup}>
                <label className={css.fieldLabel}>SKILL.md 内容</label>
                <textarea className={css.skillEditor} value={textContent} onChange={e => setTextContent(e.target.value)} rows={10} placeholder={'---\nname: my-skill\ndescription: 技能描述\n---\n在此粘贴 markdown 正文…'} />
                <p className={css.hintText}>frontmatter 必须包含 name 和 description 字段。</p>
              </div>
            </>
          )}

          {tab === 'scan' && (
            <>
              <div className={css.formGroup}>
                <label className={css.fieldLabel}>目录路径</label>
                <div className={css.formCols}>
                  <input className={css.fieldInput} value={scanDir} onChange={e => setScanDir(e.target.value)} placeholder="/Users/you/my-skills" style={{ flex: 1 }} />
                  <GlassButton onClick={() => void doScan()} disabled={busy || !scanDir}>扫描</GlassButton>
                </div>
              </div>
              {scanned !== null && (
                <div className={css.formGroup}>
                  <label className={css.fieldLabel}>识别到 {scanned.length} 个技能（已存在将跳过）</label>
                  {scanned.length === 0 && <p className={css.hintText}>该目录下未识别到技能。</p>}
                  {scanned.map(s => {
                    const exists = existing.includes(s.name)
                    return (
                      <label key={s.name} className={css.scanRow}>
                        <input
                          type="checkbox"
                          checked={checked.has(s.name)}
                          disabled={exists}
                          onChange={e => setChecked(prev => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(s.name); else next.delete(s.name)
                            return next
                          })}
                        />
                        <span className={exists ? css.scanNameDim : css.scanName}>{s.name}</span>
                        <span className={css.scanDesc}>{s.description}</span>
                        {exists && <span className={css.scanExists}>已存在</span>}
                      </label>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            {tab === 'file' && <GlassButton variant="primary" onClick={() => void importFile()} disabled={busy || !filePath}>{busy ? '导入中…' : '导入'}</GlassButton>}
            {tab === 'text' && <GlassButton variant="primary" onClick={() => void importText()} disabled={busy || !textName || !textContent}>{busy ? '导入中…' : '导入'}</GlassButton>}
            {tab === 'scan' && <GlassButton variant="primary" onClick={() => void importScanned()} disabled={busy || scanned === null || checked.size === 0}>{busy ? '导入中…' : `导入（${checked.size}）`}</GlassButton>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── 高级 ──────────────────────────────────────────────────────────── */

function AdvancedSection() {
  return (
    <>
      <SettingGroup title="配置文件">
        <SettingRow label="打开 settings.yaml" desc="直接编辑全局配置文件">
          <GlassButton>打开</GlassButton>
        </SettingRow>
        <SettingRow label="打开配置目录" desc="在文件管理器中显示配置目录" divider={false}>
          <GlassButton>打开</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="诊断">
        <SettingRow label="复制诊断信息" desc="复制版本、平台与运行环境信息到剪贴板">
          <GlassButton>复制</GlassButton>
        </SettingRow>
        <SettingRow label="打开日志目录" desc="在文件管理器中显示日志目录">
          <GlassButton>打开</GlassButton>
        </SettingRow>
        <SettingRow label="开发者模式" desc="启用调试面板与详细日志" divider={false}>
          <Switch checked={false} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── 配置档案 ──────────────────────────────────────────────────────── */

function ProfilesSection() {
  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>配置档案保存一整套设置，可随时切换或导入导出。</span>
        <div className={css.topActions}>
          <GlassButton>导入</GlassButton>
          <GlassButton variant="primary">+ 新建档案</GlassButton>
        </div>
      </div>
      <div className={css.profileCard}>
        <div className={css.cardInfo}>
          <div className={css.cardTitleRow}>
            <span className={css.cardTitle}>默认档案</span>
            <span className={css.currentBadge}>当前</span>
          </div>
          <span className={css.cardDesc}>3 个模型 · 深色主题</span>
        </div>
        <GlassButton>切换</GlassButton>
      </div>
      <div className={css.profileCard}>
        <div className={css.cardInfo}>
          <div className={css.cardTitleRow}>
            <span className={css.cardTitle}>前端</span>
          </div>
          <span className={css.cardDesc}>2 个模型 · 浅色主题 · 启用技能</span>
        </div>
        <div className={css.cardActions}>
          <GlassButton variant="primary">切换</GlassButton>
          <Trash2 size={16} className={css.memDel} />
        </div>
      </div>
      <div className={css.profileCard}>
        <div className={css.cardInfo}>
          <div className={css.cardTitleRow}>
            <span className={css.cardTitle}>评审</span>
          </div>
          <span className={css.cardDesc}>1 个模型 · 只读权限</span>
        </div>
        <div className={css.cardActions}>
          <GlassButton variant="primary">切换</GlassButton>
          <Trash2 size={16} className={css.memDel} />
        </div>
      </div>
    </>
  )
}

/* ── 扩展面板 ──────────────────────────────────────────────────────── */

function ExtensionsSection() {
  return (
    <>
      <SettingGroup title="已安装扩展">
        <SettingRow label="模型选择器" desc="会话侧栏模型选择面板" divider={false}>
          <Switch checked={true} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="插件市场">
        <SettingRow label="自动检查更新" desc="启动时检查已安装插件更新" divider={false}>
          <Switch checked={true} onChange={() => {}} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

/* ── 技能绑定弹窗（设计稿 ExxZt）─────────────────────────────────────── */

function SkillBindDialog({ rpc, bound, onClose, onConfirm }: {
  rpc: CorumRpcCall
  bound: SkillBinding[]
  onClose: () => void
  onConfirm: (skills: SkillBinding[]) => void
}) {
  const [allSkills, setAllSkills] = useState<SkillInfo[] | null>(null)
  const [versionsMap, setVersionsMap] = useState<Record<string, SkillVersion[]>>({})
  const [checked, setChecked] = useState<Map<string, string>>(() => new Map(bound.map(b => [b.name, b.versionId])))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await rpc<{ skills: SkillInfo[] }>('skillManager', 'listAll', {})
        if (cancelled) return
        setAllSkills(r.skills)
        // 拉取每个技能的版本列表
        const entries = await Promise.all(r.skills.map(async s => {
          const h = await rpc<{ versions: SkillVersion[] }>('skillManager', 'getSkillHistory', { name: s.name })
          return [s.name, h.versions] as const
        }))
        if (cancelled) return
        const map: Record<string, SkillVersion[]> = {}
        for (const [name, versions] of entries) map[name] = versions
        setVersionsMap(map)
        setLoading(false)
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [rpc])

  const toggle = (name: string) => {
    setChecked(prev => {
      const next = new Map(prev)
      if (next.has(name)) next.delete(name)
      else {
        const versions = versionsMap[name] ?? []
        next.set(name, versions[versions.length - 1]?.id ?? '')
      }
      return next
    })
  }

  const setVersion = (name: string, versionId: string) => {
    setChecked(prev => new Map(prev).set(name, versionId))
  }

  const doConfirm = () => {
    const result: SkillBinding[] = [...checked.entries()]
      .filter(([, v]) => v !== '')
      .map(([name, versionId]) => ({ name, versionId }))
    onConfirm(result)
  }

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()} style={{ width: 480 }}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>添加技能</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <p className={css.hintText}>从全局技能库选择技能并绑定版本；一个 Agent 可绑定多个技能。</p>
          {error !== null && <p className={css.hintText}>{error}</p>}
          {loading && <p className={css.hintText}>加载中…</p>}
          {!loading && allSkills !== null && allSkills.length === 0 && (
            <p className={css.hintText}>暂无技能，请先在「技能」页导入。</p>
          )}
          {(allSkills ?? []).map(s => {
            const isChecked = checked.has(s.name)
            const versions = versionsMap[s.name] ?? []
            // 设计稿 ExxZt：未选中行也显示版本选择器（dimmed 禁用态，值为最新版）
            const latest = versions[versions.length - 1]?.id ?? ''
            const displayVersion = isChecked ? (checked.get(s.name) ?? latest) : latest
            return (
              <div
                key={s.name}
                className={`${css.bindPickRow}${isChecked ? ' ' + css.bindPickRowActive : ''}`}
                onClick={() => toggle(s.name)}
                role="button"
              >
                <span className={`${css.bindCheckbox}${isChecked ? ' ' + css.bindCheckboxOn : ''}`}>
                  {isChecked && <Check size={10} className={css.bindCheckIcon} />}
                </span>
                <div className={css.bindPickMeta}>
                  <div className={css.bindPickName}>
                    <Star size={12} className={css.listIcon} />
                    <span className={css.skillLabel}>{s.name}</span>
                  </div>
                  <span className={css.bindPickDesc}>{s.description}</span>
                </div>
                {versions.length > 0 && (
                  <span
                    className={isChecked ? undefined : css.bindVersionDim}
                    onClick={e => e.stopPropagation()}
                  >
                    <SelectField
                      value={displayVersion}
                      options={versions.map(v => ({ id: v.id, label: v.id }))}
                      onChange={v => setVersion(s.name, v)}
                      disabled={!isChecked}
                      variant="compact"
                    />
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={doConfirm}>绑定 {checked.size} 个技能</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── MCP 绑定弹窗（设计稿 hMLsO）─────────────────────────────────────── */

interface McpServerSummaryWire {
  name: string
  description?: string
  transport: string
  endpoint: string
  disabled?: boolean
}

function McpBindDialog({ rpc, bound, onClose, onConfirm }: {
  rpc: CorumRpcCall
  bound: string[]
  onClose: () => void
  onConfirm: (servers: string[]) => void
}) {
  const [servers, setServers] = useState<McpServerSummaryWire[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(() => new Set(bound))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await rpc<{ servers: McpServerSummaryWire[] }>('mcpManager', 'listServers', {})
        if (!cancelled) { setServers(r.servers); setLoading(false) }
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [rpc])

  const toggle = (name: string) => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()} style={{ width: 480 }}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>添加 MCP 服务</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <p className={css.hintText}>从全局 MCP 注册表选择服务授权给此 Agent；新服务请在「MCP 与集成」中注册。</p>
          {error !== null && <p className={css.hintText}>{error}</p>}
          {loading && <p className={css.hintText}>加载中…</p>}
          {!loading && servers !== null && servers.length === 0 && (
            <p className={css.hintText}>暂无 MCP 服务，请先在「MCP 与集成」中添加。</p>
          )}
          {(servers ?? []).map(s => {
            const isChecked = checked.has(s.name)
            const disabled = s.disabled === true
            return (
              <div
                key={s.name}
                className={`${css.bindPickRow}${isChecked ? ' ' + css.bindPickRowActive : ''}`}
                onClick={() => toggle(s.name)}
                role="button"
              >
                <span className={`${css.bindCheckbox}${isChecked ? ' ' + css.bindCheckboxOn : ''}`}>
                  {isChecked && <Check size={10} className={css.bindCheckIcon} />}
                </span>
                <div className={css.bindPickMeta}>
                  <div className={css.bindPickName}>
                    <span className={css.listDot} style={disabled ? { background: 'var(--dsw-alias-label-dimmed)' } : undefined} />
                    <span className={css.skillLabel}>{s.name}</span>
                  </div>
                  <span className={css.bindPickDesc}>{s.description ?? s.transport}{disabled ? ' · 已停用' : ''}</span>
                </div>
              </div>
            )
          })}
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => onConfirm([...checked])}>授权 {checked.size} 个服务</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── 删除预设确认对话框 ──────────────────────────────────────────────── */

function DeletePresetDialog({ profile, rpc, onClose, onDeleted }: {
  profile: AgentProfileSummary
  rpc: CorumRpcCall
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const doDelete = async () => {
    setBusy(true)
    setError(null)
    try {
      await rpc('corumAgent', 'deleteProfile', { id: profile.id })
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className={css.confirmOverlay} onClick={onClose}>
      <div className={css.confirmDialog} onClick={e => e.stopPropagation()}>
        <span className={css.confirmTitle}>删除预设</span>
        <p className={css.confirmDesc}>确定要删除预设「{profile.nickname ?? profile.id}」吗？此操作不可撤销。</p>
        {error !== null && <p className={css.confirmWarn}>{error}</p>}
        <div className={css.confirmActions}>
          <GlassButton onClick={onClose}>取消</GlassButton>
          <GlassButton variant="danger" onClick={() => void doDelete()} disabled={busy}>{busy ? '删除中…' : '删除'}</GlassButton>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── 导出 section 组件映射 ──────────────────────────────────────────── */

export interface SectionDef {
  id: string
  order: number
  label: string
  Component: () => ReactNode
}

/** 所有 section 定义（用于 index.tsx 批量注册）。 */
export const SECTION_DEFS: SectionDef[] = [
  { id: 'appearance', order: 10, label: '外观', Component: AppearanceSection },
  { id: 'notifications', order: 20, label: '通知', Component: NotificationsSection },
  { id: 'shortcuts', order: 30, label: '快捷键', Component: ShortcutsSection },
  { id: 'permissions', order: 50, label: '权限', Component: PermissionsSection },
  { id: 'rules', order: 60, label: '规则与指令', Component: RulesSection },
  { id: 'memory', order: 70, label: '记忆', Component: MemorySection },
  { id: 'terminal', order: 80, label: '终端', Component: TerminalSection },
  { id: 'hooks', order: 90, label: 'Hooks 与自动化', Component: HooksSection },
  { id: 'agent-loop', order: 100, label: '高级 Agent Loop', Component: AgentLoopSection },
  { id: 'agent-presets', order: 110, label: 'Agent 预设', Component: AgentPresetsSection },
  { id: 'account', order: 120, label: '账户与用量', Component: AccountSection },
  { id: 'privacy', order: 130, label: '隐私', Component: PrivacySection },
  { id: 'data', order: 140, label: '数据管理', Component: DataSection },
  { id: 'mcp', order: 150, label: 'MCP 与集成', Component: McpSection },
  { id: 'skills', order: 160, label: '技能', Component: SkillsSection },
  { id: 'advanced', order: 170, label: '高级', Component: AdvancedSection },
  { id: 'profiles', order: 180, label: '配置档案', Component: ProfilesSection },
  { id: 'extensions', order: 190, label: '扩展面板', Component: ExtensionsSection },
]
