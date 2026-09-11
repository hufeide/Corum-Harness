/**
 * ModelSelect's injected face. The target 'conversation.input.model' seat is
 * declared (children table) and typed by ui-conversation's composer-bar
 * entry; this package only contributes the single occupant, so no SlotMap
 * merge lives here.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from './directory.ts'

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** Whether this session supports Agent-bound model inspection and selection. */
  available: boolean
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<ModelDirectoryState>
  /**
   * 空日志镜像（host 推导；新会话=true）。为 true 时更换模型不弹确认——
   * 尚无上下文，换模型无「效果变差」代价。空会话直接换。
   */
  blank: SnapshotStore<boolean>
  /** Ensure the shared advisory catalog is loaded (errors land on the store). */
  load: () => void
  /**
   * Select a complete provider/model/reasoning selection.
   * @param selection - model selection and optional adapter-owned effort.
   * @returns whether the host accepted the selection.
   */
  select: (selection: ModelSelection) => Promise<boolean>
  /**
   * 会话图片态 × 目标模型视觉能力（切换前预警用）。
   *
   * 官方只在**发消息**时校验图片-模型匹配（`session/attachment-invalid` +
   * `MODEL_DOES_NOT_SUPPORT_IMAGES`），`selectModel` 本身不读会话历史——corum
   * 在切换那一刻主动查询，以便提前告知用户代价。查询失败返回 null
   * （调用方视为「未知」：不提示、不阻断）。
   */
  imageCompatibility: (
    selection: Pick<ModelSelection, 'provider' | 'model'>,
  ) => Promise<{ hasImage: boolean; supportsImage: boolean | null } | null>
}
