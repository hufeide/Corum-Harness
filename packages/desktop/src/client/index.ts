/**
 * corum-desktop client half: framework-level surfaces for the desktop shell.
 * The transport is the official web stack (the renderer loads the host's
 * loopback webserver directly), so this plugin carries no connection glue —
 * only the notification store/host and the resident editor column. Dev HMR is
 * served by the official `dsh-client-hmr` row (webserver SSE), enabled by the
 * desktop overlay.
 * @module corum-desktop/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { createNotificationStore, type NotificationStore } from './notifications.ts'
import { mountNotificationHost } from './mount-notifications.tsx'
// Type-only: pulls the `ctx.slots` Context merge (declared by dsh-client-ui-renderer).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `corum.editor` SlotMap row (declared by @corum/corum-ide-ui).
import type {} from '@corum/corum-ide-ui/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { EditorColumn } from './editor/EditorColumn.tsx'
import type { EditorApiRef, EditorColumnInjected } from './editor/EditorColumn.tsx'
import type { FsEntry } from './editor/ExplorerPane.tsx'

/** Required services: none — this is the wire root; the code-editor view registers lazily below. */
export const inject: string[] = []

/**
 * 跨 bundle 能力接口（dev-conventions §2.4）：本 bundle inject 的 ctx.layout
 * 类型面是官方基线 ILayout（corum 运行时 LayoutController 是其超集，新增
 * showRegion 面）。用局部能力接口收窄 + 可选链调用，不强耦合 ide-ui 实现包。
 */
interface ShowRegionCapableLayout {
  /** 点亮区域（清 userShown 运行时隐藏 + 树 hidden 持久化；实现缺该面时缺席）。 */
  showRegion?: (slot: string) => void
}

// Context merge: the framework notification store is injectable by any plugin.
declare module '@deepseek-ai/cordis' {
  interface Context {
    notifications: NotificationStore
  }
}

/**
 * Client plugin body: framework surfaces over the desktop IPC carrier.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  // Framework notifications (design.pen「row-通知框」): a framework-level
  // capability any combo can use — HMR failure is just the first consumer.
  // The store is provided as `ctx.notifications`; the host renders the toast
  // stack into a body-rooted portal (decoupled from any combo's slot system).
  const notifications = createNotificationStore()
  ctx.provide('notifications', notifications)
  const notificationHost = mountNotificationHost(notifications)
  ctx.effect(() => () => { notificationHost.dispose() }, 'corum-desktop: notification host')
  // Debug/console surface: lets CDP and the devtools console emit a notification
  // without a fiber reference (plugins should inject `ctx.notifications` instead).
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __corumNotify?: NotificationStore['notify'] }).__corumNotify = notifications.notify
  }

  // The resident Monaco editor (design.pen ③ 编辑器区合并卡，2026-09-03 改版：
  // 编辑器 + 资源管理器合一张卡): registered into the shell's `corum.editor`
  // slot (declared by @corum/corum-ide-ui, IDE mode only). Monaco's worker/
  // protocol infrastructure lives in this client bundle, so the editor column
  // registers here rather than in a separate plugin (which would have to
  // re-bundle Monaco + re-plumb the worker protocol).
  // inject 面 closeRegion 直通 ctx.layout.closeRegion（原 CLOSE_REGION_EVENT
  // 窗口事件桥已退役）；explorer 面（listDir + generation）内嵌资源管理器
  // 子面板的数据源——原独立插件 @corum/corum-ide-explorer-ui 已并入本卡。
  ctx.inject(['slots', 'layout', 'connection', 'sessions', 'conversation', 'workspaces'], (editorCtx) => {
    const connection = editorCtx.get('connection') as ConnectionHandle

    // ── 资源管理器根目录跟随当前工作区/会话（2026-09-04 用户定调：空态不该
    // 默认打开 host cwd /Users/kukucai/dsh——树/编辑器必须关联当前项目/任务
    // 的工作区）。优先级：当前会话 cwd > 首个工作区 path；**都没有（未打开
    // 项目/无会话）→ 广播空态**（资源管理器显示「未打开项目」提示，不开
    // host cwd）。
    const sessionsSvc = editorCtx.get('sessions') as {
      list: { subscribe: (fn: () => void) => () => void; getSnapshot: () => { current?: string; byId: Record<string, { cwd?: string }> } }
    } | undefined
    const workspacesSvc = editorCtx.get('workspaces') as {
      list: { subscribe: (fn: () => void) => () => void; getSnapshot: () => { items: { path: string }[] } }
    } | undefined
    let lastRoot: string | null = null
    /** 当前工作区根的只读快照（ExplorerPane 初始挂载时读——事件可能先于
     *  组件挂载发出而丢失，快照是最可靠的初始态）。 */
    const workspaceRootSnapshot = {
      get: (): { root: string | null; rootName: string | null } => {
        if (lastRoot === null || lastRoot === '') return { root: null, rootName: null }
        const base = lastRoot.split(/[\\/]/).filter(Boolean).pop() ?? null
        return { root: lastRoot, rootName: base }
      },
    }
    const syncRoot = (): void => {
      const snap = sessionsSvc?.list.getSnapshot()
      const currentCwd = snap?.current !== undefined && snap.current !== '' ? snap.byId[snap.current]?.cwd : undefined
      const target = (currentCwd !== undefined && currentCwd !== '')
        ? currentCwd
        : workspacesSvc?.list.getSnapshot().items[0]?.path
      if (target === undefined || target === '') {
        // 未打开项目：广播空态（ExplorerPane 显示提示，不渲染 dsh 树）。
        if (lastRoot !== '') {
          lastRoot = ''
          window.dispatchEvent(new CustomEvent('corum:workspace-root-changed', { detail: { root: null } }))
        }
        return
      }
      if (target === lastRoot) return
      lastRoot = target
      void connection.rpc.call('/api', 'corumFs/setRoot', { args: { cwd: target } }).then(() => {
        // 换根后重启 watch + 通知 EditorColumn 刷新树（cordis 红线：同 bundle
        // 内 CustomEvent 是合法的一次性信号，非共享可变状态）。
        void connection.rpc.call('/api', 'corumFs/watch', { args: {} })
        window.dispatchEvent(new CustomEvent('corum:workspace-root-changed', { detail: { root: target } }))
      }).catch((err: unknown) => {
        console.warn('[corum-desktop] corumFs/setRoot failed', err)
      })
    }
    // 启动时 + 会话/工作区列表变化时各同步一次。
    syncRoot()
    const unsubSessions = sessionsSvc?.list.subscribe(syncRoot)
    const unsubWorkspaces = workspacesSvc?.list.subscribe(syncRoot)
    editorCtx.effect(() => () => {
      unsubSessions?.()
      unsubWorkspaces?.()
    }, 'corum-desktop: workspace root tracking')

    // ── 「在编辑器打开」可编程入口（corum:open-in-editor CustomEvent 桥接）──
    // chat 插件 dispatch 一次性 CustomEvent（detail = { path: 绝对路径 }），
    // 此处监听 → 转 corumFs 相对路径 → 点亮编辑器 → 调 EditorColumn openFile。
    // 同 bundle 内 CustomEvent + ref，合法的一次性信号（非共享可变状态）。
    const editorApiRef: EditorApiRef = { openFile: null }

    /** 绝对路径 → corumFs 相对路径（去掉 lastRoot 前缀，保证 / 开头）。 */
    const toRelativePath = (absolute: string): string | null => {
      if (lastRoot === null || lastRoot === '') return null
      // lastRoot 可能是 /a/b 或 /a/b/（统一去掉尾部 /）
      const root = lastRoot.endsWith('/') ? lastRoot.slice(0, -1) : lastRoot
      if (!absolute.startsWith(root)) return null
      let rel = absolute.slice(root.length)
      if (rel === '') rel = '/'
      if (!rel.startsWith('/')) rel = '/' + rel
      return rel
    }

    const onOpenInEditor = (e: Event): void => {
      const detail = (e as CustomEvent<{ path?: string }>).detail
      const absolute = detail?.path
      if (typeof absolute !== 'string' || absolute === '') {
        console.warn('[corum-desktop] corum:open-in-editor: missing or invalid path in detail')
        return
      }
      const rel = toRelativePath(absolute)
      if (rel === null) {
        console.warn('[corum-desktop] corum:open-in-editor: path not under current workspace root', { absolute, lastRoot })
        return
      }
      // 点亮编辑器区域（两层隐藏一次清）：
      // ① 树 leaf.hidden 持久化标记 → setRegionHidden('corum.editor', false)；
      // ② AppFrame userShown 运行时隐藏集（DEFAULT_HIDDEN 场景，① 管不到）→
      //    layout.showRegion（LayoutController 新增面，AppFrame showRegion 的单槽
      //    包装，同时清 ①+②；保留 ① 让语义显式且防御未来实现变化）。
      // 跨 bundle 窄接口收窄（dev-conventions §2.4 红线 3）：editorCtx.layout 的
      // 类型面是官方基线 ILayout（无 showRegion），用局部能力接口 + 可选链
      // 防御——实现缺该面时静默跳过（编辑器仍可由用户手动点亮），不强耦合
      // ide-ui 实现包。原「setTimeout 50ms + 读 localStorage 字符串匹配 + 模拟
      // 点按钮」hack（6c43655c 引入）随本接口落地删除。
      editorCtx.layout.setRegionHidden('corum.editor', false)
      const layoutShowCapable = editorCtx.layout as unknown as ShowRegionCapableLayout
      layoutShowCapable.showRegion?.('corum.editor')
      // EditorColumn 挂载后 openFile 才写入 editorApiRef；未挂载时轮询等待
      if (editorApiRef.openFile !== null) {
        void editorApiRef.openFile(rel, { pin: true })
        return
      }
      // 轮询等待 EditorColumn 挂载（最多 3s）
      let attempts = 0
      const poll = (): void => {
        attempts++
        if (editorApiRef.openFile !== null) {
          void editorApiRef.openFile(rel, { pin: true })
          return
        }
        if (attempts < 30) {
          setTimeout(poll, 100)
        } else {
          console.warn('[corum-desktop] corum:open-in-editor: editor mount timeout', { path: rel })
        }
      }
      setTimeout(poll, 100)
    }
    window.addEventListener('corum:open-in-editor', onOpenInEditor)

    const dispose = editorCtx.slots.inject('corum.editor', () => editorCtx.slots.register(
      {
        name: 'corum.editor',
        inject: (): EditorColumnInjected => ({
          closeRegion: () => { editorCtx.layout.closeRegion('corum.editor') },
          showEditor: () => { editorCtx.layout.setRegionHidden('corum.editor', false) },
          editorApi: editorApiRef,
          explorer: {
            generation: connection.generation,
            workspaceRoot: workspaceRootSnapshot,
            listDir: async (path) => {
              const result = await connection.rpc.call('/api', 'corumFs/list', { args: { path } })
              return result as { ok: boolean; error?: { message?: string }; value?: { entries: FsEntry[] } }
            },
          },
          readFile: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/read', { args: { path } })
            return result as { ok: boolean; error?: { message?: string }; value?: { content: string; language: string } }
          },
          readBinary: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/readBinary', { args: { path } })
            return result as { ok: boolean; error?: { message?: string }; value?: { mime: string; base64: string } }
          },
          writeFile: async (path, content) => {
            const result = await connection.rpc.call('/api', 'corumFs/write', { args: { path, content } })
            return result as { ok: boolean; error?: { message?: string } }
          },
          mkdirp: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/mkdir', { args: { path } })
            return result as { ok: boolean; error?: { message?: string } }
          },
          deletePath: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/delete', { args: { path } })
            return result as { ok: boolean; error?: { message?: string } }
          },
          renamePath: async (from, to) => {
            const result = await connection.rpc.call('/api', 'corumFs/rename', { args: { from, to } })
            return result as { ok: boolean; error?: { message?: string } }
          },
          absolutePath: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/absolutePath', { args: { path } })
            return result as { ok: boolean; error?: { message?: string }; value?: { absolutePath: string } }
          },
          revealPath: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/reveal', { args: { path } })
            return result as { ok: boolean; error?: { message?: string } }
          },
          startWatch: async () => {
            const result = await connection.rpc.call('/api', 'corumFs/watch', { args: {} })
            return result as { ok: boolean; error?: { message?: string } }
          },
          pollChanges: async () => {
            const result = await connection.rpc.call('/api', 'corumFs/pollChanges', { args: {} })
            return result as { ok: boolean; error?: { message?: string }; value?: { changes: { path: string; kind: 'rename' | 'change' }[] } }
          },
          addToConversation: (path: string) => {
            // 方案 A（子代理调查结论）：@path 追加进当前会话草稿，与手打
            // @-mention 完全同构（发送时发路径文本，agent 侧工具自行读文件）。
            // conversation 是 cordis service（root 单例），sessions.scope 寻址
            // 当前会话——不碰红线（inject 获取，非 window 全局）。
            const sessionsSvc = editorCtx.get('sessions') as {
              scope: (id: string) => Context
              list: { getSnapshot: () => { current?: string } }
            } | undefined
            const currentId = sessionsSvc?.list.getSnapshot().current
            if (sessionsSvc === undefined || currentId === undefined || currentId === '') {
              return { ok: false as const, error: '当前没有打开的会话' }
            }
            const scoped = sessionsSvc.scope(currentId)
            const conversation = scoped.get('conversation') as {
              input: { for: (actx: Context) => { setDraft: (t: string) => void; state: { getSnapshot: () => { draft: string } } } }
            } | undefined
            if (conversation === undefined) {
              return { ok: false as const, error: '会话服务未就绪' }
            }
            const input = conversation.input.for(scoped)
            const draft = input.state.getSnapshot().draft
            input.setDraft(draft + (draft.endsWith(' ') || draft === '' ? '' : ' ') + `@${path} `)
            return { ok: true as const }
          },
        }),
      },
      EditorColumn,
    ))
    return () => {
      window.removeEventListener('corum:open-in-editor', onOpenInEditor)
      dispose()
    }
  })
}
