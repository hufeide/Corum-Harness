/**
 * ModelAskPanel —— 子 Agent 模型不可用的决定面板（design.pen jO5So「方案C」）。
 *
 * 两态就地切换，**不跳转、不弹模态**：
 *   ① 收起态 notify-bar：一行告知 + 「处理」+ ×（挂起）
 *   ② 展开态 panel：phead + 四个档位 chip + 内嵌模型选择 + pfoot（应用并继续）
 *
 * 与提问卡（QuestionCard）的关键差别：**一轮完成**。官方的提问流要两轮问答
 * （先问处理方式，选「永久改为指定模型」再弹第二轮模型选择），方案 C 把模型选择
 * 内嵌进同一个面板。档位文案由 host 下发（`request.options`），本组件不硬编码。
 */
import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, ChevronUp, X, Zap } from 'lucide-react'
import {
  modelAskAnswerOf,
  modelAskNeedsRoute,
  type ModelAskCatalogProvider,
  type ModelAskKind,
  type PendingModelAsk,
} from './contract.ts'
import css from './ModelAskPanel.module.css'

export interface ModelAskPanelProps {
  pending: PendingModelAsk
}

/** 选中的路由（内嵌模型选择的内部状态）。 */
interface PickedRoute {
  provider: string
  model: string
  label: string
}

/** 档位 chip 的图标（按 kind 取；未知 kind 不画图标而不是画错）。 */
function iconFor(kind: ModelAskKind) {
  switch (kind) {
    case 'temporary': return <Zap size={11} />
    case 'permanent-follow': return <Check size={11} />
    case 'permanent-route': return <ChevronRight size={11} />
    case 'decline': return <X size={11} />
    default: return null
  }
}

/** 内嵌模型选择：按 provider 分组列出 catalog。 */
function ModelPicker({ catalog, picked, onPick }: {
  catalog: readonly ModelAskCatalogProvider[]
  picked: PickedRoute | undefined
  onPick: (route: PickedRoute) => void
}) {
  const [open, setOpen] = useState(true)
  const rows = catalog.flatMap(provider => provider.models.map(model => ({
    provider: provider.provider,
    providerLabel: provider.label,
    model: model.model,
    label: model.label,
  })))

  return (
    <div className={css.picker}>
      <button type="button" className={css.pickerHead} onClick={() => setOpen(v => !v)}>
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        <span className={css.pickerHeadText}>
          {picked === undefined ? '指定模型：选『永久改指定模型』时展开选择' : `${picked.label}（${picked.provider}/${picked.model}）`}
        </span>
      </button>
      {open && (
        <div className={css.pickerList}>
          {rows.length === 0 && <div className={css.pickerEmpty}>没有可用的模型</div>}
          {catalog.map(provider => (
            <div key={provider.provider}>
              <div className={css.pickerGroup}>{provider.label}</div>
              {provider.models.map(model => {
                const active = picked?.provider === provider.provider && picked?.model === model.model
                return (
                  <button
                    key={`${provider.provider}/${model.model}`}
                    type="button"
                    className={css.pickerRow}
                    data-active={active || undefined}
                    onClick={() => onPick({
                      provider: provider.provider,
                      model: model.model,
                      label: `${provider.label} / ${model.label}`,
                    })}
                  >
                    <span className={css.pickerModel}>{model.label}</span>
                    {active && <Check size={11} />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 决定面板。
 * @param props - 待决定项。
 */
export function ModelAskPanel({ pending }: ModelAskPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [kind, setKind] = useState<ModelAskKind | undefined>(undefined)
  const [picked, setPicked] = useState<PickedRoute | undefined>(undefined)
  const [applying, setApplying] = useState(false)
  const { request } = pending

  const needsRoute = modelAskNeedsRoute(kind)
  // 「永久改指定模型」必须真的选了一个模型才能应用（否则回传 dismissed = 什么都没变，
  // 却让用户以为已经处理好了）。
  const canApply = kind !== undefined && (!needsRoute || picked !== undefined) && !applying

  const apply = (): void => {
    if (!canApply) return
    setApplying(true)
    void pending.answer(modelAskAnswerOf(kind, picked === undefined
      ? undefined
      : { provider: picked.provider, model: picked.model }))
  }

  if (!expanded) {
    return (
      <div className={css.shell}>
        <div className={css.bar} role="status">
          <span className={css.barIcon}><AlertTriangle size={13} /></span>
          <span className={css.barTx}>
            <span className={css.barTitle}>子 Agent 模型不可用 · 任务已暂停</span>
            <span className={css.barDesc}>{request.label} · {request.cause}</span>
          </span>
          <button type="button" className={css.handleBtn} onClick={() => setExpanded(true)}>处理</button>
          <button
            type="button"
            className={css.iconBtn}
            title="稍后处理"
            aria-label="稍后处理"
            onClick={() => { void pending.dismiss() }}
          >
            <X size={12} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={css.shell}>
      <div className={css.panel} role="dialog" aria-label="模型不可用，选择处理方式">
        <div className={css.phead}>
          <span className={css.barIcon}><AlertTriangle size={13} /></span>
          <span className={css.pheadTx}>模型不可用，选择处理方式</span>
          <button
            type="button"
            className={css.iconBtn}
            aria-label="收起"
            onClick={() => setExpanded(false)}
          >
            <ChevronDown size={14} />
          </button>
        </div>

        <div className={css.chips}>
          {request.options.map(option => (
            <button
              key={option.kind}
              type="button"
              className={css.chip}
              data-active={kind === option.kind || undefined}
              title={option.description}
              onClick={() => setKind(option.kind)}
            >
              {iconFor(option.kind)}
              {option.label}
            </button>
          ))}
        </div>

        {needsRoute && (
          <ModelPicker catalog={request.catalog} picked={picked} onPick={setPicked} />
        )}

        <div className={css.pfoot}>
          <span className={css.footHint}>挂起后可从子 Agent 卡片随时恢复处理</span>
          <button type="button" className={css.applyBtn} disabled={!canApply} onClick={apply}>
            {applying ? '应用中…' : '应用并继续'}
          </button>
        </div>
      </div>
    </div>
  )
}
