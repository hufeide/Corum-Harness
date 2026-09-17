/** Composer takeover for one pending approval waterfall. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ApprovalComposerProps, PendingApproval } from './contract/slots.ts'
import css from './ApprovalPanel.module.css'

/**
 * Render one pending approval and its optional Tool-owned detail.
 * @param props - selector-matched request and standard Slot props.
 * @returns The approval composer takeover.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = props.matched
  const detail = approval.callId === undefined
    ? null
    : props.renderSlot('conversation.approval.detail', { callId: approval.callId })
  return <ApprovalFlow key={approval.key} pending={approval} detail={detail} t={props.t} />
}

function ApprovalFlow({ pending, detail, t }: {
  pending: PendingApproval
  detail: ReactNode
  t: ApprovalComposerProps['t']
}) {
  const [answered, setAnswered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  /** 审批卡容器（click-outside 判定边界：含拆分按钮与浮层 allowMenu）。 */
  const cardRef = useRef<HTMLDivElement | null>(null)
  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    setAnswered(true)
    setMenuOpen(false)
    void pending.answer(outcome).catch(() => { setAnswered(false) })
  }

  // 浮层收起（todo.approval-card.menu-dismiss）：打开期间，click-outside（落在审批卡
  // 之外，浮层 allowMenu 是 card 的子元素故点浮层不收）或 Escape 都收起——原先只能
  // 再点触发器关闭。
  useEffect(() => {
    if (!menuOpen) return undefined
    const onPointerDown = (e: PointerEvent): void => {
      const el = cardRef.current
      if (el !== null && e.target instanceof Node && !el.contains(e.target)) setMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menuOpen])
  return (
    <div className={css.root} data-approval-key={pending.key}>
      <div className={css.card} ref={cardRef}>
        {/* 轮头：avatar + 名 + 等待审批（对齐 corum 审批卡设计）。 */}
        <div className={css.head}>
          <span className={css.avatar} />
          <span className={css.who}>Corum Agent</span>
          <span className={css.tag}>{t('waiting')}</span>
        </div>
        <div
          className={css.body}
          data-approval-scroll=""
          tabIndex={0}
          role="group"
          aria-label={t('detail.aria')}
        >
          <div className={css.headline}>{pending.reason ?? t('escalation', { toolName: pending.toolName })}</div>
          {detail !== null && <div className={css.command}>{detail}</div>}
        </div>
        {/* actions：拆分按钮「允许一次 + ▾ 浮层 menu」+ 拒绝，靠右。 */}
        <div className={css.actionRow}>
          <div className={css.allowSplit}>
            <button type="button" className={css.allowMain} disabled={answered} onClick={() => { answer('allowed-once') }}>
              {t('allowOnce')}
            </button>
            <span className={css.allowDivider} />
            <button
              type="button"
              className={css.allowChev}
              disabled={answered}
              aria-expanded={menuOpen}
              title="允许方式"
              onClick={() => setMenuOpen(v => !v)}
            >
              <ChevronDown size={14} strokeWidth={2} />
            </button>
          </div>
          <button type="button" className={css.reject} disabled={answered} onClick={() => { answer('rejected') }}>
            {t('reject')}
          </button>
        </div>
        {menuOpen && (
          <div className={css.allowMenu}>
            <button type="button" className={`${css.allowMenuItem} ${css.allowMenuItemActive}`} onClick={() => { answer('allowed-once') }}>
              {t('allowOnce')}
            </button>
            <button type="button" className={css.allowMenuItem} disabled title="会话级始终允许暂未接入（需写回 approval/policy）">
              始终允许
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
