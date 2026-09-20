/**
 * fork（corum）权限合成回归网（2026-09-20 建立）。
 *
 * ## 为什么先写这张网（用户 2026-09-20 定调的执行顺序第 ① 步）
 *
 * 「只读 bash」的护栏被用户权限档位覆盖这件事，**之所以能上线**，就是因为当时没有这张网：
 * `applyTaskPermission`（写用户档位）与 `applyConductorMode`（写模式只读）各自「看起来都对」，
 * 而沙箱投影是 last-write-wins ⇒ 谁后写谁赢，**没有任何断言覆盖「两者相遇」的情形**。
 *
 * 所以先把**主体 × 用户档位**的全部组合的期望值钉死，再动拆分与合成。任何一步静默漂移
 * 都会在这里红。
 *
 * ## 期望值来源
 *
 * 用户 2026-09-20 原话：「用户选择工作区读写和完全权限**只能生效给 work 子 Agent**，
 * 但是**主 Agent 和 search 只读是必须要保证的**」。
 */
import { describe, expect, it } from 'vitest'
import {
  CONDUCTOR_SUBJECT_CONSTRAINTS,
  composeSandboxMode,
  conductorMainReadonlyGuard,
  detectBashWrite,
  subjectConstraintOf,
  type PermissionSubject,
  type SandboxMode,
} from '../src/permission-policy.ts'

const MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
const SUBJECTS: readonly PermissionSubject[] = ['main', 'worker', 'researcher']

/** 期望表：指挥模式下，主体 × 用户档位 → 有效档位。 */
const EXPECTED_IN_CONDUCTOR: Record<PermissionSubject, Record<SandboxMode, SandboxMode>> = {
  // 主 Agent：恒只读 —— 用户选完全权限也不例外（这是本网存在的理由）。
  main: { 'read-only': 'read-only', 'workspace-write': 'read-only', 'danger-full-access': 'read-only' },
  // research：同上。
  researcher: { 'read-only': 'read-only', 'workspace-write': 'read-only', 'danger-full-access': 'read-only' },
  // worker：唯一透传用户意图的一类（含完全权限）。
  worker: {
    'read-only': 'read-only',
    'workspace-write': 'workspace-write',
    'danger-full-access': 'danger-full-access',
  },
}

describe('权限合成：指挥模式（9 组合全覆盖）', () => {
  for (const subject of SUBJECTS) {
    for (const user of MODES) {
      const expected = EXPECTED_IN_CONDUCTOR[subject][user]
      it(`${subject} × 用户选 ${user} ⇒ ${expected}`, () => {
        expect(composeSandboxMode(user, subjectConstraintOf(subject, true))).toBe(expected)
      })
    }
  }

  it('★ 主 Agent 选完全权限仍然只读（本网的核心断言，漏洞的直接回归门禁）', () => {
    // 实测漏洞：会话 corum-task-e72b1a8f 里用户切 danger-full-access 后，
    // 主 Agent 的沙箱变成 danger-full-access（read-only 被 last-write-wins 覆盖）。
    expect(composeSandboxMode('danger-full-access', subjectConstraintOf('main', true))).toBe('read-only')
  })

  it('★ research 选完全权限仍然只读', () => {
    expect(composeSandboxMode('danger-full-access', subjectConstraintOf('researcher', true))).toBe('read-only')
  })

  it('★ worker 能拿到用户选的完全权限（用户明确要求的一类）', () => {
    expect(composeSandboxMode('danger-full-access', subjectConstraintOf('worker', true))).toBe('danger-full-access')
  })
})

describe('权限合成：非指挥模式（行为不得改变）', () => {
  for (const subject of SUBJECTS) {
    for (const user of MODES) {
      it(`${subject} × 用户选 ${user} ⇒ ${user}（透传）`, () => {
        expect(composeSandboxMode(user, subjectConstraintOf(subject, false))).toBe(user)
      })
    }
  }
})

describe('权限合成：边界', () => {
  it('用户未选档位 ⇒ undefined（不代填，交回官方全局默认）', () => {
    expect(composeSandboxMode(undefined, undefined)).toBeUndefined()
    // 即使指挥模式下主 Agent 有约束，仍返回约束（约束是确定的，不依赖用户选择）。
    expect(composeSandboxMode(undefined, subjectConstraintOf('main', true))).toBe('read-only')
  })

  it('约束表是单一事实源：主 Agent 与 research 必须为只读、worker 必须无约束', () => {
    expect(CONDUCTOR_SUBJECT_CONSTRAINTS.main).toBe('read-only')
    expect(CONDUCTOR_SUBJECT_CONSTRAINTS.researcher).toBe('read-only')
    expect(CONDUCTOR_SUBJECT_CONSTRAINTS.worker).toBeUndefined()
  })

  it('「约束赢」而非「取更严者」：worker 的完全权限不被降级', () => {
    // 若哪天有人把合成改成「取更严者」，用户要求的「完全权限生效给 worker」会被静默破坏。
    // 这条断言把该语义钉死。
    const workerMode = composeSandboxMode('danger-full-access', subjectConstraintOf('worker', true))
    expect(workerMode).toBe('danger-full-access')
    expect(workerMode).not.toBe('workspace-write')
  })
})

/**
 * 只读门禁的**命令判据**（2026-09-20）。
 *
 * 两个方向都要钉住：
 * - **必须拦住**：一切会把字节写进仓库/磁盘的 bash 形态（否则「只读」是空话）；
 * - **必须放过**：只读命令（否则指挥者每步撞墙、白烧往返 —— 与 worker 反复找工具链同款浪费）。
 */
describe('detectBashWrite — 必须拦住的写形态', () => {
  const writes: readonly [string, string][] = [
    ['重定向建文件', 'echo hi > /tmp/x'],
    ['追加重定向', 'echo hi >> /tmp/x'],
    ['heredoc 重定向', "cat > f.ts <<'EOF'\nx\nEOF"],
    ['sed 就地编辑', "sed -i '' 's/a/b/' f.ts"],
    ['perl 就地编辑', "perl -pi -e 's/a/b/' f.ts"],
    ['touch 建文件', 'touch /tmp/probe'],
    ['mkdir', 'mkdir -p /tmp/x'],
    ['rm 删除', 'rm -f /tmp/x'],
    ['mv 移动', 'mv a.ts b.ts'],
    ['cp 复制', 'cp a.ts b.ts'],
    ['git commit', 'git commit -m "x"'],
    ['git add', 'git add -A'],
    ['git checkout', 'git checkout -- f.ts'],
    ['git apply', 'git apply p.patch'],
    ['git stash', 'git stash push'],
    ['pnpm install', 'pnpm install'],
    ['npm run build 里的 add', 'npm add lodash'],
    ['chmod', 'chmod +x f.sh'],
    ['tee', 'echo x | tee f.txt'],
    ['python 内联写', "python3 -c \"open('f','w').write('x')\""],
    ['node 内联写', "node -e \"require('fs').writeFileSync('f','x')\""],
    ['管道后接写命令', 'git log | head -3 && rm -f f'],
    ['命令前有环境变量', 'FOO=1 touch f'],
    ['sudo 前缀后写', 'sudo rm -f f'],
    ['绝对路径命令', '/bin/rm -f f'],
  ]
  for (const [label, command] of writes) {
    it(`拦住：${label}`, () => {
      expect(detectBashWrite(command), command).toBeDefined()
    })
  }
})

describe('detectBashWrite — 必须放过的只读形态', () => {
  const reads: readonly [string, string][] = [
    ['ls', 'ls -la'],
    ['pwd', 'pwd'],
    ['git log', 'git log --oneline -5'],
    ['git diff', 'git diff HEAD'],
    ['git status', 'git status --short'],
    ['git show', 'git show HEAD:f.ts'],
    ['cat', 'cat package.json'],
    ['grep', 'grep -rn "foo" src/'],
    ['read 命令名出现在参数里', 'grep -rn "rm -rf" .'],
    ['sed 不带 -i', "sed -n '1,20p' f.ts"],
    ['fd 重定向到 stderr', 'ls 2>&1'],
    ['重定向到 /dev/null', 'ls > /dev/null'],
    ['管道组合', 'git log | head -3'],
    ['&& 串联只读', 'cd /repo && git status'],
    ['wc', 'wc -l f.ts'],
    ['find 只列', 'find . -name "*.ts"'],
    ['环境变量加只读', 'CORUM_HOME=/x ls'],
  ]
  for (const [label, command] of reads) {
    it(`放过：${label}`, () => {
      expect(detectBashWrite(command), command).toBeUndefined()
    })
  }
})

describe('conductorMainReadonlyGuard — 只作用于 bash', () => {
  it('非 bash 工具一律放行（write/edit 已由 tools.restrict 摘除）', () => {
    const guard = conductorMainReadonlyGuard()
    expect(guard({ name: 'read', arguments: { path: 'f' } })).toBeUndefined()
    expect(guard({ name: 'grep', arguments: { pattern: 'x' } })).toBeUndefined()
    expect(guard({ name: 'subagent', arguments: { prompt: 'x' } })).toBeUndefined()
  })

  it('bash 写命令被拒，且拒绝文案指向「该委派」而不是只说禁止', () => {
    const guard = conductorMainReadonlyGuard()
    const reason = guard({ name: 'bash', arguments: { command: 'touch /tmp/x' } })
    expect(reason).toBeDefined()
    expect(reason).toContain('read-only')
    expect(reason).toContain('delegate')
  })

  it('bash 只读命令放行', () => {
    const guard = conductorMainReadonlyGuard()
    expect(guard({ name: 'bash', arguments: { command: 'git log --oneline -5' } })).toBeUndefined()
  })

  it('arguments 缺失或形状异常时不误拦（fail-open，避免污染合法调用）', () => {
    const guard = conductorMainReadonlyGuard()
    expect(guard({ name: 'bash' })).toBeUndefined()
    expect(guard({ name: 'bash', arguments: null })).toBeUndefined()
    expect(guard({ name: 'bash', arguments: { command: 42 } })).toBeUndefined()
  })
})
