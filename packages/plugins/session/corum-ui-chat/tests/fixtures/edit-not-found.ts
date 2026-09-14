/**
 * 共享 fixture：corum-fs-local fork 产出的**真实** FS_EDIT_NOT_FOUND 错误文本
 * （2026-09-13 由 packages/plugins/agent/corum-fs-local/src/fsio.ts 的
 * applyLiteralEdit 实际抛出，逐字拷贝；生成脚本见本文件末尾注释）。
 *
 * 用途：UI 解析器（src/client/toolviews/edit-not-found.ts）的契约测试——
 * fork 改文案格式时这里会红，防止 UI 悄悄失配。
 */

/** ① 单行锚点 + 重复代码合并（line 66 与 80 完全相同的真实场景）。 */
export const FIXTURE_SINGLE_DUP = `old_string was not found in "src/order/query.ts"
Closest places in the file (informational only — nothing has been changed):
  lines 66, 80:   if (items.length === 0) return emptyResult()  [98% similar]  [these lines are identical to each other (duplicate code)]
Retry with the exact text from one of those lines (the file is "src/order/query.ts"); if you already applied this edit successfully, the anchor no longer exists in that form.
<<<corum-edit-not-found:v1 {"version":1,"reason":"anchor-miss","anchorLines":1,"candidates":[{"line":66,"span":1,"text":"  if (items.length === 0) return emptyResult()","similarity":0.9772727272727273,"duplicates":[80]}]}`

/** ② 多行锚点 + 块级候选 + 真正的失配行。 */
export const FIXTURE_MULTI_BLOCK = `old_string was not found in "src/order/query.ts"
Closest 3-line blocks in the file (informational only — nothing has been changed):
  lines 1-3 (3 lines): export function buildQuery(filters) {  [81% similar]
First mismatch vs the block at line 1:
  anchor line 3:   return { where }
  file line 3:   return { where, order: defaultOrder }  [43% similar]
Retry with the whole 3-line block copied exactly (the file is "src/order/query.ts"); replacing only one line of a multi-line anchor can edit the wrong place.
<<<corum-edit-not-found:v1 {"version":1,"reason":"anchor-miss","anchorLines":3,"candidates":[{"line":1,"span":3,"text":"export function buildQuery(filters) {","similarity":0.8108108108108109}],"mismatch":{"anchorLine":3,"anchorText":"  return { where }","fileLine":3,"fileText":"  return { where, order: defaultOrder }","similarity":0.43243243243243246}}`

/** ③ 完全没有候选（降级态：reason=insufficient-context + 空候选）。 */
export const FIXTURE_NO_CANDIDATES = `old_string was not found in "src/other.ts"
Nothing in the file is close to that old_string — read the file (or the region) and copy the exact text; do not retry the same anchor.
<<<corum-edit-not-found:v1 {"version":1,"reason":"insufficient-context","anchorLines":1,"candidates":[]}`

/** ④ 官方（无 fork 提示）错误文本——回落路径：无标记也无人读块 → 纯文本。 */
export const FIXTURE_OFFICIAL_PLAIN = `old_string was not found in "src/plain.ts"`

/** ⑤ 旧 fork（第一版人读块、无标记行）——回落路径：人读块解析候选。 */
export const FIXTURE_LEGACY_NO_MARKER = `old_string was not found in "src/x.ts"
Closest places in the file (informational only — nothing has been changed):
  line 8:     const sum = items.reduce((a, b) => a + b.price, 0)  [same text, different indentation/leading whitespace]
  line 3:   const sum = items.reduce((a, b) => a + b.price, 0)  [100% similar]
Retry with the exact text from one of those lines (the file is "src/x.ts"); if you already applied this edit successfully, the anchor no longer exists in that form.`

/** ⑥ 标记行 JSON 损坏（截断）——不崩，回落人读块。 */
export const FIXTURE_BROKEN_MARKER = `old_string was not found in "src/x.ts"
Closest places in the file (informational only — nothing has been changed):
  line 8:     const sum = items.reduce((a, b) => a + b.price, 0)  [100% similar]
Retry with the exact text from one of those lines (the file is "src/x.ts").
<<<corum-edit-not-found:v1 {"version":1,"reason":"anchor-miss","candidates":[{"line":8`

// 生成脚本（在 packages/plugins/agent/corum-fs-local 下执行）：
//   node --experimental-strip-types -e '
//     import { applyLiteralEdit } from "./src/fsio.ts"
//     // …按 FIXTURE_SINGLE_DUP / FIXTURE_MULTI_BLOCK / FIXTURE_NO_CANDIDATES 的场景构造
//     //   文件与锚点，catch FsError 取 e.message 逐字拷贝。
//   '
