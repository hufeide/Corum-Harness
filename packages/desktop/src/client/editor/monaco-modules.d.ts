/**
 * Type shims for monaco-editor's ESM subpaths.
 *
 * The package `exports` maps `"./*"` to `./esm/vs/*.js` WITHOUT a `types`
 * condition, so TypeScript cannot resolve deep subpaths on its own. The
 * desktop editor imports Monaco via the package root (`monaco-editor` →
 * `esm/vs/index.js`), which carries its own `index.d.ts` — no shim needed
 * for the root. Only the worker subpath shims remain (worker.ts constructs
 * Workers from `/monaco/<name>.worker.js`, the scripts themselves are not
 * imported as modules).
 * @module corum-desktop/client/editor/monaco-modules
 */

// zh-cn 语言包（纯副作用，设置 globalThis._VSCODE_NLS_MESSAGES）。
declare module 'monaco-editor/nls/lang/zh-cn.js' {}
