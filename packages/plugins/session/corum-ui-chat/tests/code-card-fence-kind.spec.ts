/**
 * 围栏卡分档单测（2026-09-15 用户定调后新增）。
 *
 * 两条用户要求：
 *   ① 「**在终端运行**」按钮**只应在「输出纯脚本类型」时出现** ——
 *      场景是「给用户一些脚本操作建议」（典型：**受沙箱限制 Agent 无法自己操作**，
 *      于是把命令交给用户去跑）。代码片段（给人读的代码）**不该**有执行入口。
 *   ② **代码片段默认不折叠**（注意与文件卡 read/edit/write 的「默认收起」刻意相反）。
 *
 * 判据取**围栏语言**：markdown 里「这段是脚本」这一意图**没有别的表达方式**，
 * info string 是唯一稳定信号 ⇒ 故 `isScriptFence` 是这一分档的**单一事实源**，
 * 必须逐例钉住，避免将来被「顺手统一成一律显示」。
 */
import { describe, expect, it } from 'vitest'
import { isScriptFence } from '../src/client/chat/code-fence-kind.ts'

describe('isScriptFence — 脚本片段 vs 代码片段的唯一判据', () => {
  it('脚本类语言 ⇒ true（这些是「给用户去跑的」）', () => {
    for (const lang of ['bash', 'sh', 'shell', 'zsh', 'fish', 'ksh', 'console', 'powershell', 'ps1', 'cmd', 'bat', 'dos']) {
      expect(isScriptFence(lang), `${lang} 应判为脚本`).toBe(true)
    }
  })

  it('大小写/空白不敏感（模型写的 info string 常带空格或大写）', () => {
    expect(isScriptFence('BASH')).toBe(true)
    expect(isScriptFence('  Bash  ')).toBe(true)
    expect(isScriptFence('PowerShell')).toBe(true)
  })

  it('**普通代码语言 ⇒ false**（不得出现「在终端运行」）', () => {
    for (const lang of ['ts', 'typescript', 'tsx', 'js', 'javascript', 'python', 'go', 'rust', 'java', 'json', 'yaml', 'sql', 'html', 'css', 'md']) {
      expect(isScriptFence(lang), `${lang} 不应判为脚本`).toBe(false)
    }
  })

  it('无语言 / 空串 ⇒ false（无法判断时**不**给执行入口——宁可少给，不可误给）', () => {
    expect(isScriptFence(undefined)).toBe(false)
    expect(isScriptFence('')).toBe(false)
    expect(isScriptFence('   ')).toBe(false)
  })

  it('不把「看起来像脚本」的近似名误判（避免误给执行入口）', () => {
    // `basics` / `shellscript-note` 这类不是脚本语言名，不该命中。
    expect(isScriptFence('basics')).toBe(false)
    expect(isScriptFence('shell-note')).toBe(false)
    expect(isScriptFence('bashrc')).toBe(false)
  })
})
