// fork（corum）：子 Agent 改动区——展开 SubagentCard 时列出子会话改动的文件，
// 每条带 ±N 行数 + 打开 diff + 单文件撤销。
//
// 背景：父会话的 Review 卡只查 PARENT session 的轮次，子 Agent 的改动落在 CHILD
// session 的轮次（影子 git 仓库按 writing session id 分轮），所以父侧看不到。本区
// 把子会话的改动摘要（由 host 在终态帧 corum/subagent/progress.changeSummary 补发）
// 直接渲染进子 Agent 卡片的展开区，让用户在父会话里就能审查子 Agent 改了什么。
//
// 数据路径：
//   host corumAgent.emitChangeSummary(childSessionId)
//     → corumReview.snapshot(childSessionId)  [影子 git 快照：path/added/removed]
//     → corumOrchestration.entriesOf(parent)  [台账 status：integrated 判定]
//     → emit('corum/subagent/progress', { ..., changeSummary })
//   renderer: subagentProgressSubscribe → 本组件 useChangeSummary
//
// 隔离场景：改动在 worktree 里（childSessionId 的轮次仍由 corumReview 记录，
// 因为 corumReview 按 session.id + header.cwd 分轮，worktree 的 cwd 不同于父）。
// 台账 status='integrated' 时翻成「已集成」——由 worktree-ledger 推送帧实时更新。
//
// diff 打开与 per-file 撤销复用父侧 Review 卡同款 RPC：
//   openDiff  → corumReview/fileBefore(childSessionId, path) → corumEditor.openContentDiff
//   revertFile → corumReview/rollback { sessionId: childSessionId, path }

import { useEffect, useState } from 'react'
import { FileDiff, GitBranch, GitMerge, Loader, RotateCcw } from 'lucide-react'
import type { SubagentChangeSummary } from '@corum/corum-api-remotes/corum-events'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { chatRuntimeRef, subagentProgressSubscribe, worktreeLedgerSubscribe } from '../chat-runtime.ts'
import css from './SubagentChanges.module.css'

/** 推送帧的窄化形（只取 changeSummary 字段；与 SubagentProgressEvent 同构）。 */
interface ProgressFrame {
  readonly sessionId: string
  readonly changeSummary?: SubagentChangeSummary
}

/** 台账帧的窄化形（只取 entries）。 */
interface LedgerFrame {
  readonly sessionId: string
  readonly entries: readonly { readonly slug: string; readonly status: string }[]
}

/** RPC fileBefore 返回形（与 review-source.ts 同款）。 */
interface FileBeforeResult {
  exists: boolean
  content: string
  created: boolean
}

/** RPC rollback 返回形（与 review-source.ts 同款）。 */
interface RollbackResult {
  ok: boolean
  restored: number
  failed: number
  message?: string
}

/** `__corumNotify` 一次写只读桥（规范 §1 例外：CorumNotification 面）。 */
interface CorumNotifyBridge {
  __corumNotify?: (n: { tone: 'error'; title: string; message?: string | undefined }) => void
}

/** 用户可见失败反馈（与 apply.ts notifyUser 同款）。 */
function notifyUser(title: string, message?: string | undefined): void {
  const notify = (window as unknown as CorumNotifyBridge).__corumNotify
  notify?.({ tone: 'error', title, ...message === undefined ? {} : { message } })
}

/** 路径显示：超长时头省略（与 ReviewCard displayPath 同口径，但无 cwd 相对化）。 */
function displayPath(path: string): string {
  const MAX = 72
  if (path.length <= MAX) return path
  return `…${path.slice(-(MAX - 1))}`
}

/**
 * 从终态进度帧里取改动摘要。
 *
 * 订阅 'corum/subagent/progress' 推送帧，按 sessionId 过滤本卡子会话，
 * 取 changeSummary 字段。host 在终态时异步补发（见 agent-service.emitChangeSummary）。
 */
function useChangeSummary(childSessionId: string | undefined): SubagentChangeSummary | undefined {
  const [summary, setSummary] = useState<SubagentChangeSummary | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined) { setSummary(undefined); return undefined }
    let cancelled = false
    const sub = subagentProgressSubscribe((frame: ProgressFrame) => {
      if (cancelled || frame.sessionId !== childSessionId) return
      if (frame.changeSummary !== undefined) setSummary(frame.changeSummary)
    })
    return () => { cancelled = true; sub.unsubscribe() }
  }, [childSessionId])
  return summary
}

/**
 * 台账 integrated 状态的实时更新。
 *
 * 终态帧的 changeSummary.integrated 是快照值；用户事后在别处点「集成」会让
 * 台账 status 翻成 integrated → worktree-ledger 推送帧 → 本 hook 更新。
 * 按本卡 worktree.slug 在帧 entries 里匹配。
 */
function useIntegratedStatus(
  worktreeSlug: string | undefined,
): boolean | undefined {
  const [integrated, setIntegrated] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (worktreeSlug === undefined) { setIntegrated(undefined); return undefined }
    let cancelled = false
    const sub = worktreeLedgerSubscribe((frame: LedgerFrame) => {
      if (cancelled) return
      // 台账帧按父 sessionId 广播；本卡只关心自己的 slug。
      const entry = frame.entries.find(e => e.slug === worktreeSlug)
      if (entry !== undefined) {
        setIntegrated(entry.status === 'integrated')
      }
    })
    return () => { cancelled = true; sub.unsubscribe() }
  }, [worktreeSlug])
  return integrated
}

/**
 * 子 Agent 改动区（SubagentCard 展开区的一个 section）。
 *
 * 当子 Agent 还在运行时（无 changeSummary）不渲染——终态帧到达后才有数据。
 * 当 changeSummary 到达但 filesChanged=0 → 渲染「无改动」。
 * 当有文件 → 逐条列出 path + ±N + 打开 diff + 撤销。
 */
export function SubagentChanges({
  childSessionId, worktree, t,
}: {
  childSessionId: string | undefined
  worktree: { readonly slug: string; readonly branch: string } | undefined
  t: ChatNodeViewProps<'subagent-call'>['t']
}) {
  const summary = useChangeSummary(childSessionId)
  // 台账 integrated 实时更新（终态帧快照值 + 推送帧增量）。
  // ⚠️ hooks 必须无条件调用（React #310）：slug 在 summary 到达前取 worktree 兜底。
  const slug = summary?.worktreeSlug ?? worktree?.slug
  const ledgerIntegrated = useIntegratedStatus(slug)
  // 终态帧尚未到达（子 Agent 还在跑）→ 不渲染改动区（与展开区的 prompt 区共存）。
  if (summary === undefined) return null

  const integrated = summary.integrated ?? ledgerIntegrated

  const files = summary.files ?? []
  const hasChanges = files.length > 0 || summary.filesChanged > 0

  return (
    <div className={css.section}>
      <div className={css.head}>
        <FileDiff size={14} strokeWidth={2} className={css.headIcon} />
        <span className={css.headTitle}>{t('subagent.changes')}</span>
        {/* 隔离 worktree slug/branch + 已提交/已集成 状态行。 */}
        {(summary.worktreeSlug ?? worktree?.slug) !== undefined && (
          <span className={css.worktreeRow} title={t('subagent.worktreeTitle')}>
            <GitBranch size={12} strokeWidth={2} className={css.worktreeIcon} />
            <span className={css.worktreeText}>
              {summary.worktreeSlug ?? worktree?.slug}
            </span>
            {integrated ? (
              <span className={css.integratedChip}>
                <GitMerge size={11} strokeWidth={2.5} />
                {t('subagent.integrated')}
              </span>
            ) : summary.committed ? (
              <span className={css.committedChip}>{t('subagent.committed')}</span>
            ) : null}
          </span>
        )}
      </div>
      {!hasChanges ? (
        <div className={css.empty}>{t('subagent.noChanges')}</div>
      ) : (
        <ul className={css.fileList}>
          {files.map(file => (
            <FileRow
              key={file.path}
              path={file.path}
              added={file.added}
              removed={file.removed}
              childSessionId={childSessionId}
              worktreePath={summary.worktreePath}
              t={t}
            />
          ))}
          {/* 有 count 但无逐文件详情时（host 取不到 diff）→ 显示总数。 */}
          {files.length === 0 && summary.filesChanged > 0 && (
            <li className={css.fileRowFallback}>
              <span className={css.filePath}>{t('subagent.filesChanged', { count: summary.filesChanged })}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** 单文件行：path + ±N + 打开 diff + 撤销。 */
function FileRow({
  path, added, removed, childSessionId, worktreePath, t,
}: {
  path: string
  added: number
  removed: number
  childSessionId: string | undefined
  worktreePath: string | undefined
  t: ChatNodeViewProps<'subagent-call'>['t']
}) {
  const [busy, setBusy] = useState(false)

  const openDiff = (): void => {
    if (childSessionId === undefined) return
    void (async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) return
      try {
        const result = await conn.rpc.call('/api', 'corumReview/fileBefore', {
          args: { sessionId: childSessionId, path },
        }) as { ok: boolean; value?: FileBeforeResult }
        if (!result.ok || result.value === undefined || !result.value.exists) {
          notifyUser('取不到该文件的改动前内容', path)
          return
        }
        // 经 chatRuntime cordis 服务的 openContentDiff 桥 → corumEditor 直调
        // （apply.ts 注入，与 ReviewDock 的 openDiff 同款收窄）。
        const openDiffFn = chatRuntimeRef.current?.openContentDiff
        if (openDiffFn === undefined) {
          notifyUser('无法打开改动对比', '编辑器服务未就绪')
          return
        }
        // absolutePath：隔离时 = worktreePath/path，非隔离时 = path（相对父 cwd，
        // editor 侧自行解析）。worktreePath 来自 changeSummary（host 台账）。
        const absolutePath = worktreePath !== undefined
          ? `${worktreePath}/${path}`
          : path
        const opened = await openDiffFn({
          absolutePath,
          originalContent: result.value.content,
          ...result.value.created ? { note: '该文件是本轮新建的，左侧为空' } : {},
        })
        if (!opened.ok) {
          notifyUser('无法打开改动对比', opened.error)
        }
      } catch {
        notifyUser('无法打开改动对比', path)
      }
    })()
  }

  const revertFile = (): void => {
    if (childSessionId === undefined || busy) return
    setBusy(true)
    void (async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) { setBusy(false); return }
      try {
        const result = await conn.rpc.call('/api', 'corumReview/rollback', {
          args: { sessionId: childSessionId, path },
        }) as { ok: boolean; value?: RollbackResult }
        if (!result.ok || result.value === undefined || !result.value.ok) {
          notifyUser('撤销失败', result.value?.message ?? path)
        }
      } catch {
        notifyUser('撤销失败', path)
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <li className={css.fileRow}>
      <button
        type="button"
        className={css.filePathButton}
        title={`${path} — ${t('subagent.openDiff')}`}
        onClick={openDiff}
      >
        {displayPath(path)}
      </button>
      <span className={css.fileDiff}>
        <span className={css.added}>+{added}</span>
        <span className={css.removed}>−{removed}</span>
      </span>
      <span className={css.fileActions}>
        <button
          type="button"
          className={css.fileActionButton}
          disabled={busy}
          title={t('subagent.revert')}
          aria-label={`${t('subagent.revert')} ${displayPath(path)}`}
          onClick={revertFile}
        >
          {busy ? <Loader size={12} strokeWidth={2} className={css.actionIconSpin} /> : <RotateCcw size={12} strokeWidth={2} />}
          {t('subagent.revert')}
        </button>
      </span>
    </li>
  )
}
