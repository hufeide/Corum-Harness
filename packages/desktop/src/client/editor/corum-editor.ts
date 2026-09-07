/**
 * fork（corum）：「在编辑器打开」可编程入口的 cordis 服务面（统一事件中心
 * 三-2：`corum:open-in-editor` 跨 bundle CustomEvent 服务化）。
 *
 * 原实现：chat 插件 dispatch window CustomEvent('corum:open-in-editor')，
 * desktop client 监听并 fire-and-forget——chat 拿不到失败反馈，desktop 侧还带
 * 「100ms 轮询 3s 等 EditorColumn 挂载」的脆弱补偿。现收敛为 cordis 服务
 * `ctx.corumEditor`（provide 于 client/index.ts 的 apply）：
 *   - `openFile(absolutePath): Promise<OpenFileResult>` 返回 { ok, error }，
 *     调用方（chat）拿到结构化失败反馈（未打开项目 / 路径不在工作区根 /
 *     编辑器挂载超时）。
 *   - pending 队列替代 3s 轮询：EditorColumn 未挂载时请求挂起（最多 3s 兜底
 *     超时），EditorColumn 挂载（经 onEditorReady 订阅通知）时一次性认领——
 *     事件驱动，零轮询。时序参照 AppFrame openNewTaskForm 的「未挂载置 pending、
 *     挂载认领」模式。
 *
 * 本文件保持 cordis-free（纯库纪律）：无 cordis import，Context 合并由
 * client/index.ts 侧声明。
 */

/** openFile 结果（chat 侧给用户可见反馈的数据源）。 */
export interface OpenFileResult {
  ok: boolean
  error?: string
}

/**
 * corumEditor 服务面（cordis 服务，跨 bundle 单例）。
 * chat 等消费端用局部能力接口收窄注入（dev-conventions §2.4 红线 2/3）。
 */
export interface CorumEditorService {
  /**
   * 在工作区编辑器打开文件（绝对路径）。
   * 内部：绝对 → corumFs 相对 → 点亮编辑器区域 → EditorColumn.openFile(pin)。
   * EditorColumn 未挂载时请求挂起，挂载认领；3s 仍未挂载报超时。
   */
  openFile(absolutePath: string): Promise<OpenFileResult>
}

/**
 * 编辑器就绪订阅面（服务实现内部用；EditorColumn 挂载/卸载时经 index.ts 的
 * notify 回调触发）。subscribe(listener) 返回退订函数。
 */
export interface EditorReadySource {
  subscribe(listener: () => void): () => void
}

/** 点亮区域 + 路径换算的后端面（由 index.ts 注入，隔离 cordis/layout 面）。 */
export interface EditorOpenBackend {
  /** 绝对路径 → corumFs 相对路径；未打开项目 / 路径不在工作区根时返回 null。 */
  toRelativePath(absolute: string): string | null
  /** 当前工作区根（错误反馈用）。 */
  currentRoot(): string | null
  /** 点亮编辑器区域（清两层隐藏）。 */
  showEditorRegion(): void
}

/** EditorApiRef 的最小类型面（与 EditorColumn.tsx 的 EditorApiRef 结构一致；
 *  用结构化类型避免反向 import 组件文件）。 */
interface OpenFileRef {
  openFile: ((path: string, opts?: { preview?: boolean; pin?: boolean }) => Promise<void>) | null
}

/** pending 挂载超时（与原 3s 轮询窗口一致，但纯事件驱动、零轮询）。 */
const MOUNT_TIMEOUT_MS = 3000

/**
 * 创建 corumEditor 服务实例（index.ts 的 ctx.inject 回调里 new 出并 provide）。
 * @param editorApiRef - slot inject 面传入 EditorColumn 的 ref（挂载时 openFile 写入）。
 * @param readySource - EditorColumn 挂载/卸载通知源（认领 pending 的触发器）。
 * @param backend - 路径换算 + 点亮区域的后端面。
 */
export function createCorumEditor(
  editorApiRef: OpenFileRef,
  readySource: EditorReadySource,
  backend: EditorOpenBackend,
): CorumEditorService {
  // pending 槽：EditorColumn 未挂载时的挂起请求（挂载认领；超时拒绝）。
  let pending: { rel: string; resolve: (r: OpenFileResult) => void; timer: ReturnType<typeof setTimeout> } | null = null

  const clearPending = (): void => {
    if (pending === null) return
    clearTimeout(pending.timer)
    pending = null
  }

  const claimPending = (): void => {
    if (pending === null || editorApiRef.openFile === null) return
    const { rel, resolve } = pending
    clearPending()
    void editorApiRef.openFile(rel, { pin: true })
      .then(() => resolve({ ok: true }))
      .catch((err: unknown) => resolve({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  }

  // EditorColumn 挂载/卸载时通知：挂载则认领 pending（卸载时 openFile=null，
  // claimPending 内部守卫自然 no-op）。
  readySource.subscribe(claimPending)

  return {
    openFile: (absolutePath: string): Promise<OpenFileResult> => {
      if (absolutePath === '') return Promise.resolve({ ok: false, error: '路径为空' })
      const rel = backend.toRelativePath(absolutePath)
      if (rel === null) {
        const root = backend.currentRoot()
        return Promise.resolve({
          ok: false,
          error: root === null || root === ''
            ? '未打开项目（编辑器没有当前工作区根）'
            : `路径不在当前工作区根下（root: ${root}）`,
        })
      }
      backend.showEditorRegion()
      if (editorApiRef.openFile !== null) {
        return editorApiRef.openFile(rel, { pin: true })
          .then((): OpenFileResult => ({ ok: true }))
          .catch((err: unknown): OpenFileResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      }
      // 未挂载：挂起等认领（单 pending 槽——新的 openFile 覆盖旧的，避免
      // 快速连点时排队打开多个文件；超时拒绝给 chat 可见反馈）。
      clearPending()
      return new Promise<OpenFileResult>((resolve) => {
        const timer = setTimeout(() => {
          pending = null
          console.warn('[corum-desktop] corumEditor.openFile: editor mount timeout', { path: rel })
          resolve({ ok: false, error: '编辑器挂载超时（3s 未就绪）' })
        }, MOUNT_TIMEOUT_MS)
        pending = { rel, resolve, timer }
      })
    },
  }
}

/**
 * 创建 EditorColumn 就绪通知源（index.ts 持有；slot inject 的 editorApi
 * 包装对象在 openFile 被写入/清空时调 notify）。同一 bundle 内部实现细节。
 */
export function createEditorReadySource(): EditorReadySource & { notify(): void } {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify() {
      for (const fn of [...listeners]) fn()
    },
  }
}
