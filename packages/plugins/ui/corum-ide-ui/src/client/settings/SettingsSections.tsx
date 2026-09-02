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
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, Star, Plug, Puzzle, Server, Plus, X, Sparkles, Upload, Package, ChevronDown, ChevronUp } from 'lucide-react'
import { SettingGroup } from './SettingGroup.tsx'
import { SettingRow } from './SettingRow.tsx'
import { SelectField } from './SelectField.tsx'
import { Switch } from './Switch.tsx'
import { Badge } from './Badge.tsx'
import { KbdKey } from './KbdKey.tsx'
import { ColorChips } from './ColorChips.tsx'
import css from './SettingsSections.module.css'

/* ── 通用玻璃按钮（设计稿 btn: glass-2, radius 13, padding [9,16]）────── */

function GlassButton({ children, variant = 'default', onClick }: { children: ReactNode; variant?: 'default' | 'primary' | 'danger'; onClick?: () => void }) {
  return (
    <button type="button" className={variant === 'primary' ? css.btnPrimary : variant === 'danger' ? css.btnDanger : css.btnDefault} onClick={onClick}>
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

/* ── Agent 预设 ────────────────────────────────────────────────────── */

interface PresetData {
  id: string
  title: string
  desc: string
  chips: string[]
}

interface PresetFormData {
  name: string
  nickname: string
  title: string
  baseMode: string
  prompt: string
  provider: string
  model: string
  subagentModel: { provider: string; model: string } | undefined
  permission: string
  terminal: string
  memory: string
  skills: string[]
  mcpServers: string[]
}

const INITIAL_PRESETS: PresetData[] = [
  { id: 'standard', title: 'standard', desc: '通用编码助手，适合大多数开发任务。', chips: ['deepseek-v4', 'skills ×3', 'mcp ×2', 'workspace-write'] },
  { id: 'reviewer', title: 'reviewer', desc: '代码审查专用，挂载 review 技能与只读权限。', chips: ['deepseek-v4', 'skills ×1', 'read-only'] },
  { id: 'researcher', title: 'researcher', desc: '调研分析助手，联网检索 + 长上下文。', chips: ['deepseek-r1', 'skills ×2', 'mcp ×1', 'read-only'] },
]

function AgentPresetsSection() {
  const [presets, setPresets] = useState<PresetData[]>(INITIAL_PRESETS)
  const [defaultId, setDefaultId] = useState('standard')
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [editPreset, setEditPreset] = useState<PresetData | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const handleSetDefault = (id: string) => { setDefaultId(id) }

  const handleDelete = (id: string) => {
    setPresets(prev => prev.filter(p => p.id !== id))
    if (defaultId === id && presets.length > 1) {
      setDefaultId(presets.find(p => p.id !== id)?.id ?? '')
    }
    setDeleteConfirmId(null)
  }

  const handleSave = (data: PresetFormData) => {
    const id = data.name.toLowerCase().replace(/\s+/g, '-')
    const chips = [
      data.model,
      ...(data.skills.length > 0 ? [`skills ×${data.skills.length}`] : []),
      ...(data.mcpServers.length > 0 ? [`mcp ×${data.mcpServers.length}`] : []),
      data.permission,
    ]
    const newPreset: PresetData = {
      id,
      title: data.nickname || id,
      desc: data.prompt.split('\n')[0] || '自定义预设',
      chips,
    }
    if (editPreset) {
      setPresets(prev => prev.map(p => p.id === editPreset.id ? newPreset : p))
    } else {
      setPresets(prev => [...prev, newPreset])
    }
    setShowCreate(false)
    setEditPreset(null)
  }

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>预设决定 Agent 的模型、技能与工具组合，新建会话时默认使用。</span>
        <GlassButton variant="primary" onClick={() => setShowCreate(true)}>+ 新建预设</GlassButton>
      </div>
      {presets.map(p => (
        <InfoCard
          key={p.id}
          title={p.title}
          desc={p.desc}
          chips={p.chips}
          isDefault={p.id === defaultId}
          onClick={() => { setEditPreset(p) }}
          actions={
            p.id !== defaultId ? (
              <>
                <GlassButton onClick={() => handleSetDefault(p.id)}>设为默认</GlassButton>
                <Trash2 size={14} className={css.memDel} onClick={() => setDeleteConfirmId(p.id)} />
              </>
            ) : (
              <Trash2 size={14} className={css.memDel} onClick={() => setDeleteConfirmId(p.id)} />
            )
          }
        />
      ))}

      {/* 删除确认弹窗 */}
      {deleteConfirmId !== null && createPortal(
        <div className={css.confirmOverlay} onClick={() => setDeleteConfirmId(null)}>
          <div className={css.confirmDialog} onClick={e => e.stopPropagation()}>
            <span className={css.confirmTitle}>删除预设</span>
            <p className={css.confirmDesc}>确定要删除预设「{presets.find(p => p.id === deleteConfirmId)?.title}」吗？此操作不可撤销。</p>
            <div className={css.confirmActions}>
              <GlassButton onClick={() => setDeleteConfirmId(null)}>取消</GlassButton>
              <GlassButton variant="danger" onClick={() => handleDelete(deleteConfirmId)}>删除</GlassButton>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 编辑/新建预设弹窗 */}
      {(showCreate || editPreset !== null) && createPortal(
        <EditPresetDialog
          preset={editPreset ?? undefined}
          onSave={handleSave}
          onClose={() => { setShowCreate(false); setEditPreset(null) }}
        />,
        document.body,
      )}
    </>
  )
}

/* ── 编辑/新建预设弹窗（按设计稿 M5E2n 落码）────────────────────── */

const BASE_MODE_OPTIONS = [
  { id: 'standard', label: '标准模式 — 功能完整的编码 Agent，支持文件编辑/Shell/检索/Skills' },
  { id: 'ptc', label: 'PTC 模式 — 标准模式 + Code Mode SDK 多步操作' },
  { id: 'minimal', label: '极简模式 — 仅持久 bash + 编辑器的双工具 Agent' },
  { id: 'cordis', label: '创造模式 — 用于创建自定义 Agent preset' },
]

const PROVIDER_OPTIONS = [
  { id: 'deepseek-official', label: 'deepseek-official' },
  { id: 'pi-ai', label: 'pi-ai' },
]

const MODEL_OPTIONS = [
  { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  { id: 'deepseek-v4', label: 'deepseek-v4' },
  { id: 'deepseek-r1', label: 'deepseek-r1' },
]

const PERMISSION_OPTIONS = [
  { id: 'read-only', label: '只读' },
  { id: 'workspace-write', label: '工作区读写' },
  { id: 'full', label: '完全访问' },
]

const TERMINAL_OPTIONS = [
  { id: 'sandbox', label: 'sandbox' },
  { id: 'host', label: 'host' },
]

const MEMORY_OPTIONS = [
  { id: 'agent', label: 'agent' },
]

function EditPresetDialog({ preset, onSave, onClose }: {
  preset?: PresetData | undefined
  onSave: (data: PresetFormData) => void
  onClose: () => void
}) {
  const [name, setName] = useState(preset?.id ?? '')
  const [nickname, setNickname] = useState(preset?.title ?? '')
  const [title, setTitle] = useState('')
  const [baseMode, setBaseMode] = useState('standard')
  const [prompt, setPrompt] = useState('')
  const [provider, setProvider] = useState('deepseek-official')
  const [model, setModel] = useState('deepseek-v4-flash')
  const [subProvider, setSubProvider] = useState('deepseek-official')
  const [subModel, setSubModel] = useState('deepseek-v4-flash')
  const [subEnabled, setSubEnabled] = useState(false)
  const [permission, setPermission] = useState('workspace-write')
  const [terminal, setTerminal] = useState('sandbox')
  const [memory, setMemory] = useState('agent')
  const [skills, setSkills] = useState<string[]>(['code-review', 'web-research'])
  const [mcpServers, setMcpServers] = useState<string[]>(['filesystem', 'web-search'])

  return (
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()}>
        {/* HEADER */}
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>{preset ? '编辑 Agent 预设' : '新建 Agent 预设'}</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>

        {/* BODY */}
        <div className={css.modalBody}>
          {/* 1. 基本信息 */}
          <div className={css.formGroup}>
            <div className={css.formGroupTitle}>基本信息</div>
            <div className={css.avatarRow}>
              {/* 头像 */}
              <div className={css.avatarCol}>
                <div className={css.avatarBox}><Upload size={22} className={css.avatarIcon} /></div>
                <div className={css.avatarActions}>
                  <button type="button" className={css.btnUpload}><Upload size={11} />上传</button>
                  <button type="button" className={css.btnAiGen}><Sparkles size={11} />AI 生成</button>
                </div>
              </div>
              {/* ID + 昵称 */}
              <div className={css.formCols}>
                <div className={css.formCol}>
                  <label className={css.fieldLabel}>预设 ID</label>
                  <input className={css.fieldInput} value={name} onChange={e => setName(e.target.value)} placeholder="my-agent" />
                </div>
                <div className={css.formCol}>
                  <label className={css.fieldLabel}>昵称</label>
                  <input className={css.fieldInput} value={nickname} onChange={e => setNickname(e.target.value)} placeholder="我的 Agent" />
                </div>
              </div>
            </div>
            <label className={css.fieldLabel}>岗位 / 职位</label>
            <input className={css.fieldInput} value={title} onChange={e => setTitle(e.target.value)} placeholder="如：前端工程师 / 测试 / PM" />
          </div>

          {/* 2. 提示词 */}
          <div className={css.formGroup}>
            <div className={css.formGroupTitle}>提示词</div>
            <label className={css.fieldLabel}>基础模式（继承 dsh 系统提示词）</label>
            <div className={css.fieldRow}><SelectField value={baseMode} options={BASE_MODE_OPTIONS} onChange={setBaseMode} /></div>
            <label className={css.fieldLabel}>自定义提示词（叠加在基础模式之上，非替代）</label>
            <div className={css.promptArea}>
              <textarea className={css.promptTextarea} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="你是研发工程师。接到任务后简洁完成并调用 complete_task 上报。" rows={3} />
              <div className={css.promptActions}>
                <button type="button" className={css.btnPolish}><Sparkles size={11} />AI 润色</button>
              </div>
            </div>
          </div>

          {/* 3. 模型 */}
          <div className={css.formGroup}>
            <div className={css.formGroupTitle}>模型</div>
            <div className={css.formCols}>
              <div className={css.formCol}>
                <label className={css.fieldLabel}>主 Agent</label>
                <div className={css.selectStack}>
                  <SelectField value={provider} options={PROVIDER_OPTIONS} onChange={setProvider} />
                  <SelectField value={model} options={MODEL_OPTIONS} onChange={setModel} />
                </div>
              </div>
              <div className={css.formCol}>
                <label className={css.fieldLabel}>子 Agent（可选，缺省同主）</label>
                <div className={css.selectStack}>
                  <SelectField value={subEnabled ? subProvider : ''} options={PROVIDER_OPTIONS} onChange={v => { setSubEnabled(true); setSubProvider(v) }} disabled={false} />
                  <SelectField value={subEnabled ? subModel : ''} options={MODEL_OPTIONS} onChange={v => { setSubEnabled(true); setSubModel(v) }} disabled={false} />
                </div>
              </div>
            </div>
          </div>

          {/* 4. 技能 + MCP */}
          <div className={css.formGroup}>
            <div className={css.formCols}>
              <div className={css.formCol}>
                <div className={css.formGroupTitle}>技能</div>
                {skills.map((s, i) => (
                  <div key={i} className={css.listRow}>
                    <Star size={12} className={css.listIcon} />
                    <span className={css.listName}>{s}</span>
                    <Trash2 size={12} className={css.listDel} onClick={() => setSkills(prev => prev.filter((_, idx) => idx !== i))} />
                  </div>
                ))}
                <button type="button" className={css.btnAdd}><Plus size={12} />添加技能</button>
              </div>
              <div className={css.formCol}>
                <div className={css.formGroupTitle}>MCP 服务</div>
                {mcpServers.map((s, i) => (
                  <div key={i} className={css.listRow}>
                    <span className={css.listDot} />
                    <span className={css.listName}>{s}</span>
                    <Trash2 size={12} className={css.listDel} onClick={() => setMcpServers(prev => prev.filter((_, idx) => idx !== i))} />
                  </div>
                ))}
                <button type="button" className={css.btnAdd}><Plus size={12} />添加 MCP</button>
              </div>
            </div>
          </div>

          {/* 5. 终端 + 记忆 */}
          <div className={css.formGroup}>
            <div className={css.formCols}>
              <div className={css.formCol}>
                <label className={css.fieldLabel}>终端模式</label>
                <SelectField value={terminal} options={TERMINAL_OPTIONS} onChange={setTerminal} />
              </div>
              <div className={css.formCol}>
                <label className={css.fieldLabel}>记忆作用域</label>
                <SelectField value={memory} options={MEMORY_OPTIONS} onChange={setMemory} />
              </div>
            </div>
          </div>
        </div>

        {/* FOOTER */}
        <div className={css.modalFooter}>
          <div className={css.footerLeft}>
            <span className={css.trustLabel}>信任级</span>
            <span className={css.trustBadge}>user</span>
          </div>
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => onSave({
              name: name || 'new-preset', nickname, title, baseMode, prompt,
              provider, model, subagentModel: subEnabled ? { provider: subProvider, model: subModel } : undefined,
              permission, terminal, memory, skills, mcpServers,
            })}>{preset ? '保存' : '创建'}</GlassButton>
          </div>
        </div>
      </div>
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
                  className={t === transport ? css.transportPillActive : css.transportPill}
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

function SkillsSection() {
  return (
    <>
      <SettingGroup title="全局技能">
        <div className={css.skillRow}>
          <Star size={14} className={css.skillIcon} />
          <div className={css.skillMeta}>
            <span className={css.skillLabel}>code-review</span>
            <span className={css.skillDesc}>v1.2.0 · 代码审查流程与反馈模板</span>
          </div>
          <span className={css.skillChip}>已绑定 3 个 Agent</span>
          <Trash2 size={15} className={css.memDel} />
        </div>
        <div className={css.memDivider} />
        <div className={css.skillRow}>
          <Star size={14} className={css.skillIcon} />
          <div className={css.skillMeta}>
            <span className={css.skillLabel}>web-research</span>
            <span className={css.skillDesc}>v0.9.3 · 联网检索与资料整理</span>
          </div>
          <span className={css.skillChip}>已绑定 2 个 Agent</span>
          <Trash2 size={15} className={css.memDel} />
        </div>
        <div className={css.memDivider} />
        <div className={css.skillRow}>
          <Star size={14} className={css.skillIcon} />
          <div className={css.skillMeta}>
            <span className={css.skillLabel}>pdf-summary</span>
            <span className={css.skillDesc}>v2.0.1 · PDF 文档解析与摘要生成</span>
          </div>
          <span className={css.skillChip}>已绑定 1 个 Agent</span>
          <Trash2 size={15} className={css.memDel} />
        </div>
        <div className={css.actionsRow}>
          <GlassButton>导入技能</GlassButton>
          <GlassButton>从文本粘贴</GlassButton>
        </div>
      </SettingGroup>
      <p className={css.hintText}>技能是可复用的指令与资源包，可在 Agent 预设中按版本绑定。</p>
    </>
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
