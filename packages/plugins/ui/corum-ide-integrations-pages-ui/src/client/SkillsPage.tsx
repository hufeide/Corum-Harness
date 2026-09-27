/**
 * SkillsPage — 集成中心 · 技能页（PR6：自设置中心 SettingsSkillsSection 迁出）。
 *
 * 数据链路：skillManager/listAll|getSkillContent|getSkillHistory|pinVersion|
 * commitVersion|deleteSkill|importFromFile|importFromText|scanDirectory|
 * importDirectory|importBuiltinSkills + corumAgent/listProfiles（绑定数）。
 * 视图结构：技能卡列表（名称/描述/来源/启停）+ 详情（基本信息 / SKILL.md 内容 /
 * 版本历史 / 绑定关系）。
 *
 * 迁出改动仅三处：① 组件名 SkillsSection → SkillsPage；② RPC 来源
 * useCorumRpc（设置壳 CorumRpcContext）→ useIntegrationsRpc（本包注入面，
 * 同形同义）；③ SettingGroup/ConfirmDialog/GlassButton/CSS module 换成本包
 * 自持副本。各 RPC 方法名与参数逐字未动。
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ChevronDown, Star, Trash2, X } from 'lucide-react'
import { SettingGroup } from './SettingGroup.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { GlassButton, useIntegrationsRpc } from './face.tsx'
import type { SkillInfo, SkillVersion, ProfileSummary, ScannedSkill, SkillAgentBind, BuiltinSkillImportResult } from './types.ts'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import css from './IntegrationsPages.module.css'

/* ── 技能 ──────────────────────────────────────────────────────────── */


type SkillsView = { kind: 'list' } | { kind: 'detail'; name: string }

/**
 * 把「导入内置技能」的三桶摘要压成一行读得懂的结果。
 * 空桶不出现；三桶全空说明内置技能都已就位，给一句明确结论而不是空白。
 */
function formatBuiltinSummary(r: BuiltinSkillImportResult): string {
  const parts: string[] = []
  if (r.installed.length > 0) parts.push(`新装 ${r.installed.length} 个（${r.installed.join('、')}）`)
  if (r.skipped.length > 0) parts.push(`跳过 ${r.skipped.length} 个已有同名的，未覆盖（${r.skipped.join('、')}）`)
  if (r.tombstoned.length > 0) parts.push(`不复活 ${r.tombstoned.length} 个你删除过的（${r.tombstoned.join('、')}）`)
  if (parts.length === 0) return '内置技能都已在库，没有需要变更的。'
  return parts.join('；')
}

export function SkillsPage() {
  const rpc = useIntegrationsRpc()
  const [view, setView] = useState<SkillsView>({ kind: 'list' })
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SkillInfo | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [builtinBusy, setBuiltinBusy] = useState(false)
  const [builtinResult, setBuiltinResult] = useState<BuiltinSkillImportResult | null>(null)

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

  /**
   * 「导入内置技能」：把随包分发的官方技能集装进技能库。
   * 幂等且不破坏——已有同名一律不覆盖、用户删过的不复活（host 侧策略），
   * 这里只负责发起 + 把三桶结果如实摊给用户看。
   */
  const importBuiltin = async () => {
    if (!rpc) return
    setBuiltinBusy(true)
    setBuiltinResult(null)
    try {
      const r = await rpc<BuiltinSkillImportResult>('skillManager', 'importBuiltinSkills', {})
      setBuiltinResult(r)
      if (r.ok) await reload()
    } catch (e) {
      setBuiltinResult({ ok: false, error: e instanceof Error ? e.message : String(e), installed: [], skipped: [], tombstoned: [] })
    } finally {
      setBuiltinBusy(false)
    }
  }

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
          <GlassButton onClick={() => void importBuiltin()} disabled={builtinBusy}>
            {builtinBusy ? '导入中…' : '导入内置技能'}
          </GlassButton>
        </div>
        {builtinResult !== null && (
          builtinResult.ok
            ? <p className={css.hintText}>内置技能：{formatBuiltinSummary(builtinResult)}</p>
            : <p className={css.confirmWarn}>导入内置技能失败：{builtinResult.error ?? '未知错误'}</p>
        )}
      </SettingGroup>
      <p className={css.hintText}>技能是可复用的指令与资源包，可在 Agent 预设中按版本绑定。点击条目查看详情。「导入内置技能」装入随产品的官方技能集：已有同名的保留你的版本不覆盖，你删除过的不再装回。</p>
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
  return (
    <ConfirmDialog
      title="删除技能"
      message={<>确定删除技能「{skill.name}」吗？</>}
      warning={bindCount > 0 ? `该技能已绑定 ${bindCount} 个 Agent。删除后这些 Agent 将失去此技能，且不可恢复。` : undefined}
      error={error}
      confirmLabel="删除"
      busyLabel="删除中…"
      busy={busy}
      onConfirm={() => void doDelete()}
      onCancel={onClose}
    />
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
