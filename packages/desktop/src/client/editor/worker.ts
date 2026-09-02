/**
 * Monaco language-worker dispatch for the desktop renderer.
 *
 * Workers are served from the loopback webserver at `/monaco/<name>.worker.js`
 * (registered in bridge.ts). Since the page is loaded from the same origin
 * (http://127.0.0.1:<port>), `new Worker(url)` succeeds without cross-origin
 * issues. The worker script text is fetched once and cached as a blob URL.
 *
 * Worker labels are Monaco's own vocabulary: `editorWorkerService` is the
 * editor core; `typescript`, `json`, `css`, `html` are language services.
 * @module corum-desktop/client/editor/worker
 */

/** HTTP base workers are served from (same origin as the page). */
function monacoWorkerBase(): string {
  const { origin } = globalThis.location ?? { origin: 'http://127.0.0.1:0' }
  return `${origin}/monaco`
}

/** The language labels Monaco dispatches to a dedicated worker script. */
const WORKER_SCRIPTS: Readonly<Record<string, string>> = {
  editorWorkerService: 'editor.worker.js',
  typescript: 'ts.worker.js',
  javascript: 'ts.worker.js',
  json: 'json.worker.js',
  css: 'css.worker.js',
  scss: 'css.worker.js',
  less: 'css.worker.js',
  html: 'html.worker.js',
  handlebars: 'html.worker.js',
  razor: 'html.worker.js',
}

/** Cache of blob URLs so we don't re-fetch the same worker script. */
const blobUrlCache = new Map<string, string>()

/** Pending fetch promises (the first time a script is requested). */
const pending = new Map<string, Promise<string>>()

/**
 * Fetch a worker script from `corumapp://` and create a same-origin blob URL.
 * The blob: URL inherits the page's origin (http://127.0.0.1:<port>), so
 * `new Worker(blobUrl)` succeeds without cross-origin SecurityError.
 */
async function fetchWorkerBlob(scriptName: string): Promise<string> {
  const cached = blobUrlCache.get(scriptName)
  if (cached !== undefined) return cached
  const url = `${monacoWorkerBase()}/${scriptName}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`failed to fetch worker ${scriptName}: ${String(response.status)}`)
  const text = await response.text()
  const blob = new Blob([text], { type: 'application/javascript' })
  const blobUrl = URL.createObjectURL(blob)
  blobUrlCache.set(scriptName, blobUrl)
  return blobUrl
}

/**
 * The one Monaco environment hook: answer every worker request with a Worker.
 * Because blob fetching is async and Monaco's `getWorker` is sync, we kick off
 * the fetch on the first call and return undefined — Monaco retries, and the
 * cached blob URL is ready by then (workers are requested lazily, well after
 * page load, so the first undefined return doesn't block rendering).
 * @param workerId - `workerMain.js` (Monaco's fixed worker entry id).
 * @param label - the worker descriptor label (see {@link WORKER_SCRIPTS}).
 * @returns a Worker for the label, or undefined when the fetch is still pending.
 */
export function getWorker(workerId: string, label: string): Worker | undefined {
  const script = WORKER_SCRIPTS[label] ?? WORKER_SCRIPTS.editorWorkerService
  // If the blob URL is already cached, create the Worker immediately.
  const cached = blobUrlCache.get(script)
  if (cached !== undefined) {
    return new Worker(cached, { type: 'classic', name: `monaco-${label}` })
  }
  // Kick off the fetch (idempotent — same script won't be fetched twice).
  if (!pending.has(script)) {
    pending.set(script, fetchWorkerBlob(script).catch((err) => {
      console.error('[corum-desktop] monaco worker fetch failed:', script, err)
      pending.delete(script)
      throw err
    }))
  }
  // Return undefined — Monaco will call getWorker again after a microtask.
  return undefined
}

/**
 * Install the Monaco worker environment. Idempotent; call once before the
 * first editor model is created.
 */
export function installMonacoWorkerEnvironment(): void {
  const existing = (globalThis as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment
  if (existing !== undefined) return
  ;(globalThis as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker,
  }
}
