/**
 * fork（corum）：`settings.yaml` 的**布尔键预检**（2026-09-15 真实故障的防线）。
 *
 * ## 事故（本模块存在的全部理由）
 * 用户在 `:9333` 配置自定义模型时被拒：`settings namespace "llm-pi-ai" is not registered`，
 * 且「**经常反复出现**」。根因**不在装配、不在代码**，而在用户数据的一个 YAML 键：
 * `settings.yaml` 的 `llm-pi-ai` 段里，`reasoningEfforts` 的合法键 `off` 被写成了 **`false`**：
 *
 * ```yaml
 * reasoningEfforts:
 *   false: null      # ← 被 YAML 解析成**布尔键**，不在合法键集 {off,low,…,max} 内
 * ```
 * ⇒ 段内容**校验失败** ⇒ 插件 `installSection` 抛错 ⇒ **整个 settings 段注册不上**
 * ⇒ UI 报「namespace not registered」。
 *
 * **判据**：dsh 用 **YAML 1.2 core schema** —— 其中 `off` 是**字符串**、只有 `true`/`false`
 * 才是布尔（`on`/`yes` 在 1.2 里也是字符串，故**只有 `true:` / `false:` 形态有风险**）。
 *
 * ## 恶性循环（为什么它难查、且会反复）
 * 段一坏就注册不上 ⇒ **而修它又必须经这个段** ⇒ 用户**无法在 UI 里修复** ⇒ 只能反复重试失败。
 * 且报错说的是「**段不存在**」，**完全没有指向那个非法键** —— 误导性极强，实测让我先排除了
 * 7 个结构层假设才回头怀疑用户数据。
 *
 * ## 本模块做什么
 * 启动时扫一遍 `settings.yaml`，把**会被解析成非字符串标量的映射键**找出来，
 * 以**可执行**的形式告警：文件名 + 行号 + 所在段 + 键名 + 为什么会炸 + 怎么改。
 * 只读、不改写用户数据（修复权留给用户）。
 *
 * @module @corum/corum-agent/settings-yaml-guard
 */

/** 一处可疑的映射键（会在 YAML 里解析成非字符串标量）。 */
export interface SuspiciousKeyHit {
  /** 1-based 行号（便于用户直接跳过去）。 */
  readonly line: number
  /** 顶层段名（缩进 0 的那个键）；无法判定时为 undefined。 */
  readonly section: string | undefined
  /** 出问题的键名（原文，未加引号）。 */
  readonly key: string
  /** 该键被 YAML 解析成的类型描述（用于告警文案）。 */
  readonly parsedAs: string
}

/**
 * 会被 YAML 1.2 core schema 解析成**非字符串**的映射键。
 *
 * 只列**真的会导致类型错位**的：`true`/`false` → 布尔，`null`/`~` → 空值。
 * 刻意**不含** `on`/`off`/`yes`/`no`/`y`/`n` —— 那些是 **YAML 1.1** 的布尔，
 * 1.2 core schema 里是普通字符串（`off` 合法，收进来会误报）。
 */
const NON_STRING_SCALAR_KEYS: ReadonlyMap<string, string> = new Map([
  ['true', 'boolean true'],
  ['false', 'boolean false'],
  ['null', 'null'],
  ['~', 'null'],
])

/** 映射项：`键: 值`（键不含引号、不含空格——含引号/空格的键是安全的，不该报）。 */
const MAPPING_KEY = /^(\s*)([^\s#:'"]+)\s*:(\s|$)/

/**
 * 扫一份 YAML 文本，找出会被解析成非字符串的映射键。
 *
 * 刻意用**逐行正则**而不是 YAML 解析器：出问题的文件恰恰可能**解析失败或类型错位**，
 * 用解析器做预检会在最需要它的场景下失效。逐行扫描对语法不敏感、永不抛错。
 * @param text - `settings.yaml` 的原文。
 * @returns 命中清单（按行号升序）；无命中为空数组。
 */
export function scanSuspiciousYamlKeys(text: string): readonly SuspiciousKeyHit[] {
  const hits: SuspiciousKeyHit[] = []
  let section: string | undefined
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const match = MAPPING_KEY.exec(line)
    if (match === null) continue
    const [, indent, key] = match
    // 顶层段（缩进 0）用于给告警定位；它自己也可能命中（那更糟，单独报）。
    if ((indent ?? '').length === 0 && (key ?? '') !== '') section = key
    const parsedAs = NON_STRING_SCALAR_KEYS.get((key ?? '').toLowerCase())
    if (parsedAs === undefined) continue
    hits.push({
      line: i + 1,
      section: (indent ?? '').length === 0 ? undefined : section,
      key: key ?? '',
      parsedAs,
    })
  }
  return hits
}

/**
 * 把命中清单渲染成**可执行**的告警文本（含解释与修法）。
 * @param file - `settings.yaml` 的绝对路径（进文案，便于用户直达）。
 * @param hits - {@link scanSuspiciousYamlKeys} 的结果。
 * @returns 多行告警文本；无命中时为空串。
 */
export function describeSuspiciousYamlKeys(
  file: string,
  hits: readonly SuspiciousKeyHit[],
): string {
  if (hits.length === 0) return ''
  const where = hits
    .map(hit => `  ${file}:${hit.line}  ${hit.section === undefined ? '' : `[${hit.section}] `}key "${hit.key}" parses as ${hit.parsedAs}`)
    .join('\n')
  return [
    `settings.yaml has ${hits.length} mapping key(s) that YAML parses as non-strings:`,
    where,
    '',
    'Why this breaks settings: a plugin validates its own section against a key set. A key that is not a',
    'string never matches, the section is rejected, and the plugin\'s settings namespace is then NOT',
    'registered at all — so the UI reports the misleading "settings namespace <ns> is not registered"',
    'instead of naming this key. That also traps you: fixing the section needs the very namespace that',
    'its own corruption prevented from registering.',
    '',
    'How to fix: make the key a plain string — e.g. change `false: null` to `off: null` (dsh uses the',
    'YAML 1.2 core schema, where only true/false/null are non-strings; off/on/yes/no are plain strings).',
  ].join('\n')
}
