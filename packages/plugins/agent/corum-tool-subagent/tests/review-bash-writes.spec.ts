/**
 * 影子仓库 bash 写文件捕获的**纯解析器**单测（台账 `corum/review/capture-bash-writes`）。
 *
 * 覆盖：`packages/desktop/src/host/corum-bash-writes.ts` 里的
 *   - `parseBashWriteTargets` —— 重定向 / tee / sed -i / python heredoc / 嵌套壳；
 *   - `scanPythonOpenWrites` —— `open(path,'w')` 的保守识别边界；
 *   - `parsePorcelainPaths` / `selectUnionCandidates` —— 轮末并集兜底读的
 *     `git status --porcelain -z` 与「哪些路径算本轮动过」的纯策略。
 *
 * 为什么测试放在本包（corum-tool-subagent）而不是 desktop 包：desktop 没有 vitest
 * 装置，而本包是 host 侧已有 vitest 的包。被测模块是 desktop host 的实现细节，
 * **零 import 的纯函数**，所以用相对路径跨包 import 只产生「测试 → 实现」这一条
 * 依赖，不会给 desktop 增加任何运行时耦合（反向放会把插件包拖进 desktop 运行时）。
 *
 * 负例与正例同等重要：误报（把 `2>&1` / `/dev/null` / 变量路径当成文件写）比漏报
 * 更危险 —— 它会让 pre-image 抓错文件、让撤销动到不该动的文件。
 */
import { describe, expect, it } from 'vitest'
import {
  parseBashWriteTargets,
  parsePorcelainPaths,
  scanPythonOpenWrites,
  selectUnionCandidates,
} from '../../../../desktop/src/host/corum-bash-writes.ts'

/** 一条命令的目标列表。 */
function targets(command: string): string[] {
  return parseBashWriteTargets(command).targets
}

describe('parseBashWriteTargets — 重定向', () => {
  it('收 > / >> / >| / &> / &>> 与紧贴写法', () => {
    expect(targets('echo x > /tmp/t.txt')).toEqual(['/tmp/t.txt'])
    expect(targets('echo x >> notes.md')).toEqual(['notes.md'])
    expect(targets('echo x >out.txt')).toEqual(['out.txt'])
    expect(targets('cmd >| force.txt')).toEqual(['force.txt'])
    expect(targets('cmd &> all.log')).toEqual(['all.log'])
    expect(targets('cmd &>> all.log')).toEqual(['all.log'])
  })

  it('fd 前缀（N>）的目标照收', () => {
    expect(targets('cmd 2> err.log')).toEqual(['err.log'])
    expect(targets('cmd 1>out.log 2>&1')).toEqual(['out.log'])
    expect(targets('exec 3>fd.txt')).toEqual(['fd.txt'])
  })

  it('引号 / 转义的目标还原成路径原文', () => {
    expect(targets('cmd >"my file.txt"')).toEqual(['my file.txt'])
    expect(targets("cmd > 'a b.txt'")).toEqual(['a b.txt'])
    expect(targets('cmd > a\\ b.txt')).toEqual(['a b.txt'])
    expect(targets("cmd > $'lit.txt'")).toEqual(['lit.txt'])
  })

  it('多命令串联（&& / ; / |）逐条识别，不去重跨命令的同一个目标', () => {
    expect(targets('cmd && echo y > b.txt; echo z > c.txt')).toEqual(['b.txt', 'c.txt'])
    expect(targets('echo a > x.txt | tee y.txt')).toEqual(['x.txt', 'y.txt'])
    expect(targets('cmd > same.txt; cmd >> same.txt')).toEqual(['same.txt'])
  })

  it('heredoc 正文里的 > 不是命令，不算目标', () => {
    expect(targets("cat > file.txt <<'EOF'\n> not-a-target\nEOF")).toEqual(['file.txt'])
    expect(targets('cat > a.txt <<A > b.txt\nA\n')).toEqual(['a.txt', 'b.txt'])
  })

  it('注释与命令替换里的运算符不误报', () => {
    expect(targets('cmd > f.txt # > g.txt')).toEqual(['f.txt'])
    expect(targets('echo "a > b" > out.txt')).toEqual(['out.txt'])
    expect(targets('echo $(date) > f.txt')).toEqual(['f.txt'])
  })

  it('前置赋值与透明包装命令（sudo / env）不挡住命令词', () => {
    expect(targets('VAR=1 cmd > f.txt')).toEqual(['f.txt'])
    expect(targets('sudo tee /etc/x.conf')).toEqual(['/etc/x.conf'])
    expect(targets('env FOO=bar tee out.txt')).toEqual(['out.txt'])
    expect(targets('/usr/bin/tee f.txt')).toEqual(['f.txt'])
  })
})

describe('parseBashWriteTargets — tee', () => {
  it('非开关参数全是目标，- 不算', () => {
    expect(targets('echo hi | tee out.txt')).toEqual(['out.txt'])
    expect(targets('echo hi | tee -a log.txt a.txt')).toEqual(['log.txt', 'a.txt'])
    expect(targets('echo hi | tee -- file.txt')).toEqual(['file.txt'])
    expect(targets('echo hi | tee -')).toEqual([])
  })

  it('2>&1 不是 tee 的目标（fd 前缀与重定向操作数都不算参数）', () => {
    expect(targets('echo hi | tee -a app.log 2>&1')).toEqual(['app.log'])
    expect(targets('make 2>&1 | tee build.log')).toEqual(['build.log'])
    // 顺序约定：同一条命令里**重定向目标先于命令参数**（见模块头「目标顺序」）
    expect(targets('cmd | tee out.txt > extra.log')).toEqual(['extra.log', 'out.txt'])
  })

  it('输入重定向的操作数不是 tee 的目标', () => {
    expect(targets('tee out.txt < input.txt')).toEqual(['out.txt'])
  })
})

describe('parseBashWriteTargets — sed -i', () => {
  it('GNU / BSD 变体都认，脚本本身不是文件', () => {
    expect(targets("sed -i 's/a/b/' f.ts")).toEqual(['f.ts'])
    expect(targets("sed -i '' 's/a/b/' f.ts")).toEqual(['f.ts'])
    expect(targets("sed -i.bak 's/a/b/' f.ts")).toEqual(['f.ts'])
    expect(targets("sed --in-place 's/a/b/' f.ts")).toEqual(['f.ts'])
    expect(targets("sed -i -e 's/a/b/' f.ts g.ts")).toEqual(['f.ts', 'g.ts'])
    expect(targets('sed -i -f script.sed f.ts')).toEqual(['f.ts'])
    expect(targets("sed -i -n '1p' f.ts")).toEqual(['f.ts'])
  })

  it('没有 -i 就是只读：不写文件', () => {
    expect(targets("sed 's/a/b/' f.ts")).toEqual([])
    expect(targets("sed -n '1p' f.ts")).toEqual([])
    expect(parseBashWriteTargets("sed 's/a/b/' f.ts").unresolved).toBe(0)
  })

  it('-i 之后的通配/变量目标算不确定，不猜', () => {
    expect(parseBashWriteTargets("sed -i 's/a/b/' src/*.ts")).toMatchObject({ targets: [], unresolved: 1 })
    expect(targets("sed -i 's/a/b/' $F")).toEqual([])
  })
})

describe('parseBashWriteTargets — python', () => {
  it('heredoc 正文里的 open(path, 写模式)', () => {
    expect(targets("python3 - <<'EOF'\nopen(\"out.txt\",\"w\").write(\"x\")\nEOF")).toEqual(['out.txt'])
    expect(targets("python3 - <<'PY'\nwith open('a.txt','a') as f:\n    f.write('x')\nPY")).toEqual(['a.txt'])
    expect(targets("python - <<EOF\nopen(file='k.txt', mode='w')\nEOF")).toEqual(['k.txt'])
  })

  it('-c 形式同样识别', () => {
    expect(targets('python3 -c "open(\'z.txt\',\'w\')"')).toEqual(['z.txt'])
    expect(targets("python3 -c 'open(\"q.txt\", \"wb\")'")).toEqual(['q.txt'])
  })

  it('只读 open / 注释 / 非 open 写法都不算', () => {
    expect(parseBashWriteTargets("python3 - <<'EOF'\nopen('r.txt')\nEOF").targets).toEqual([])
    expect(parseBashWriteTargets("python3 - <<'EOF'\nopen('r.txt','r')\nEOF").targets).toEqual([])
    expect(parseBashWriteTargets("python3 - <<'EOF'\n# open('c.txt','w')\nEOF").targets).toEqual([])
    expect(parseBashWriteTargets("python3 - <<'EOF'\nprint(open('x'))\nEOF").targets).toEqual([])
    expect(targets("python3 -c 'import pathlib; pathlib.Path(\"p.txt\").write_text(\"x\")'")).toEqual([])
  })

  it('路径不是字面量则计入 unresolved', () => {
    expect(parseBashWriteTargets("python3 - <<'EOF'\nopen(f'out.txt','w')\nEOF")).toMatchObject({ targets: [], unresolved: 1 })
    expect(parseBashWriteTargets("python3 - <<'EOF'\nopen(os.path.join(d,'x'),'w')\nEOF")).toMatchObject({ targets: [], unresolved: 1 })
  })
})

describe('parseBashWriteTargets — 嵌套 shell', () => {
  it('bash -c 的载荷仍按命令解析（继承外层 cd 事实）', () => {
    expect(targets(`bash -c 'echo x > nested.txt'`)).toEqual(['nested.txt'])
    expect(targets('sh -c "echo x >> nested.txt"')).toEqual(['nested.txt'])
    expect(parseBashWriteTargets('cd sub && bash -c "echo x > rel.txt"')).toMatchObject({ targets: ['rel.txt'], cwdSteps: ['sub'] })
    expect(parseBashWriteTargets('cd sub && bash -c "echo x > /abs/rel.txt"').targets).toEqual(['/abs/rel.txt'])
  })
})

describe('parseBashWriteTargets — cd 链', () => {
  it('字面量 cd 后续的相对目标仍确定，cwdSteps 交给调用方依次 resolve', () => {
    expect(parseBashWriteTargets('cd /tmp && cmd > rel.txt')).toMatchObject({ targets: ['rel.txt'], unresolved: 0, cwdSteps: ['/tmp'] })
    expect(parseBashWriteTargets("cd sub; sed -i 's/a/b/' f.ts")).toMatchObject({ targets: ['f.ts'], cwdSteps: ['sub'] })
    expect(parseBashWriteTargets('cd a && cd b && cmd > f.txt')).toMatchObject({ targets: ['f.txt'], cwdSteps: ['a', 'b'] })
    expect(parseBashWriteTargets('cmd > f.txt')).toMatchObject({ targets: ['f.txt'], cwdSteps: [] })
  })

  it('算不出的 cd → 相对目标放弃并计数，绝对目标照收', () => {
    const cases = [
      'cd $DIR && cmd > rel.txt',
      'cd - && cmd > rel.txt',
      'cd && cmd > rel.txt',
      'cd .. && cd sub && popd && cmd > rel.txt',
      'cd /tmp | tee rel.txt',
      '( cd /tmp && cmd > rel.txt )',
    ]
    for (const command of cases) {
      const scan = parseBashWriteTargets(command)
      expect(scan.cwdSteps, command).toBeNull()
      expect(scan.targets, command).toEqual([])
      expect(scan.reasons.cd, command).toBe(1)
    }
    expect(parseBashWriteTargets('cd $DIR && cmd > /abs/f.txt')).toMatchObject({ targets: ['/abs/f.txt'], cwdSteps: null })
    // 命令词不认识不影响重定向：`cd /tmp && xargs … > rel.txt` 的目标确实在 /tmp 下
    expect(parseBashWriteTargets('cd /tmp && xargs cmd > rel.txt')).toMatchObject({ targets: ['rel.txt'], cwdSteps: ['/tmp'] })
  })

  it('嵌套 shell 继承外层 cwd，但自己的 cd 不外泄', () => {
    const scan = parseBashWriteTargets('cd sub && bash -c "cd deep && echo x > inner.txt" && cmd > outer.txt')
    expect(scan.cwdSteps).toEqual(['sub'])
    expect(scan.targets).toEqual(['inner.txt', 'outer.txt'])
    expect(scan.unresolved).toBe(0)
  })
})

describe('parseBashWriteTargets — 负例（宁可漏，不可猜错）', () => {
  it('fd 复制与设备文件不是文件写，且不计入 unresolved', () => {
    for (const command of [
      'cmd 2>&1',
      'cmd >&2',
      'cmd > /dev/null',
      'cmd >> /dev/null 2>&1',
      'cmd > /dev/tty',
      'cmd < input.txt',
      'cat a.txt',
      'cmd 2>&1 | tee /dev/stderr',
    ]) {
      const scan = parseBashWriteTargets(command)
      expect(scan.targets, command).toEqual([])
      expect(scan.unresolved, command).toBe(0)
    }
  })

  it('变量 / 命令替换 / 通配 / 家目录 / cd 之后的相对路径 → 只计数不返回', () => {
    const cases: [string, keyof ReturnType<typeof parseBashWriteTargets>['reasons']][] = [
      ['cmd > $OUT', 'variable'],
      ['cmd > "$OUT/x.txt"', 'variable'],
      ['cmd > $(dirname x)/f.txt', 'variable'],
      ['cmd > `pwd`/f.txt', 'variable'],
      ['tee $F', 'variable'],
      ['cmd > *.txt', 'glob'],
      ['cmd >> src/*.md', 'glob'],
      ['cmd > ~/x.txt', 'other'],
      ['cmd > ""', 'other'],
    ]
    for (const [command, reason] of cases) {
      const scan = parseBashWriteTargets(command)
      expect(scan.targets, command).toEqual([])
      expect(scan.unresolved, command).toBe(1)
      expect(scan.reasons[reason], command).toBe(1)
    }
  })

  it('不认识的形态直接跳过（xargs / 空命令）', () => {
    expect(parseBashWriteTargets('xargs sed -i s/a/b/').targets).toEqual([])
    expect(parseBashWriteTargets('xargs sed -i s/a/b/').unresolved).toBe(0)
    expect(parseBashWriteTargets('').targets).toEqual([])
    expect(parseBashWriteTargets('   ').targets).toEqual([])
    expect(parseBashWriteTargets('git status --porcelain').targets).toEqual([])
  })

  it('绝对路径不受 cd 影响', () => {
    const scan = parseBashWriteTargets('cd sub && cmd > /abs/f.txt && cmd > rel.txt')
    expect(scan.targets).toEqual(['/abs/f.txt', 'rel.txt'])
    expect(scan.cwdSteps).toEqual(['sub'])
    expect(scan.unresolved).toBe(0)
  })

  it('同一条命令里重复的目标只报一次', () => {
    expect(targets('cmd > f.txt >> f.txt')).toEqual(['f.txt'])
  })
})

describe('scanPythonOpenWrites', () => {
  it('只认字面量路径 + 含写标志的模式', () => {
    expect(scanPythonOpenWrites("open('a.txt','w')")).toEqual({ paths: ['a.txt'], unresolved: 0 })
    expect(scanPythonOpenWrites('open("a.txt", "w+")')).toEqual({ paths: ['a.txt'], unresolved: 0 })
    expect(scanPythonOpenWrites('open("a.txt", mode="ab")')).toEqual({ paths: ['a.txt'], unresolved: 0 })
    expect(scanPythonOpenWrites('open(r"a.txt", "w")')).toEqual({ paths: ['a.txt'], unresolved: 0 })
    expect(scanPythonOpenWrites("open('a.txt')")).toEqual({ paths: [], unresolved: 0 })
    expect(scanPythonOpenWrites("open('a.txt','r')")).toEqual({ paths: [], unresolved: 0 })
  })

  it('多个调用去重、注释被屏蔽', () => {
    expect(scanPythonOpenWrites("open('a','w'); open('b','a'); open('a','w')")).toEqual({ paths: ['a', 'b'], unresolved: 0 })
    expect(scanPythonOpenWrites("# open('c','w')\nopen('d','w')  # open('e','w')")).toEqual({ paths: ['d'], unresolved: 0 })
  })

  it('表达式路径计入 unresolved', () => {
    expect(scanPythonOpenWrites('open(p, "w")')).toEqual({ paths: [], unresolved: 1 })
    expect(scanPythonOpenWrites("open(f'{d}/x', 'w')")).toEqual({ paths: [], unresolved: 1 })
  })
})

describe('selectUnionCandidates — 轮末并集的候选筛选', () => {
  const ROOT = '/ws'
  /** 用一张「路径 → mtime」表造探针；目录用 `children` 表描述（键容忍尾斜杠）。 */
  function probe(files: Record<string, number>, dirs: Record<string, { name: string; dir: boolean }[]> = {}) {
    const get = (key: string): number | null => files[key] ?? files[`${key}/`] ?? null
    return {
      fileMtime: (abs: string) => get(abs),
      parentMtime: (abs: string) => {
        const cut = abs.lastIndexOf('/')
        return cut < 0 ? null : get(abs.slice(0, cut))
      },
      children: (abs: string) => dirs[abs] ?? dirs[`${abs}/`] ?? [],
    }
  }
  const options = (files: Record<string, number>, dirs?: Record<string, { name: string; dir: boolean }[]>) => ({
    root: ROOT, floor: 1000, maxPaths: 10, maxDirDepth: 2, probe: probe(files, dirs),
  })

  it('只收「本轮动过」的（mtime ≥ floor），旧的脏文件一律不要', () => {
    const entries = [
      { status: ' M', path: 'fresh.txt' },
      { status: ' M', path: 'stale.txt' },
    ]
    expect(selectUnionCandidates(entries, options({ '/ws/fresh.txt': 1500, '/ws/stale.txt': 500 })))
      .toEqual(['/ws/fresh.txt'])
  })

  it('被删的文件看父目录 mtime（文件自己的 mtime 已经不存在）', () => {
    const entries = [{ status: ' D', path: 'gone.txt' }]
    expect(selectUnionCandidates(entries, options({ '/ws': 1500 }))).toEqual(['/ws/gone.txt'])
    expect(selectUnionCandidates(entries, options({ '/ws': 500 }))).toEqual([])
  })

  it('忽略项（!!）不进候选', () => {
    expect(selectUnionCandidates([{ status: '!!', path: 'dist/x.js' }], options({ '/ws/dist/x.js': 9999 }))).toEqual([])
  })

  it('折叠的未跟踪目录：目录旧 → 整条丢；目录新 → 有界展开，只收新文件', () => {
    const entries = [{ status: '??', path: 'out/' }]
    const dirs = { '/ws/out': [{ name: 'a.js', dir: false }, { name: 'old.js', dir: false }, { name: 'sub', dir: true }] }
    const dirs2 = { ...dirs, '/ws/out/sub': [{ name: 'b.js', dir: false }] }
    expect(selectUnionCandidates(entries, options({ '/ws/out': 500 }))).toEqual([])
    expect(selectUnionCandidates(entries, options({ '/ws/out': 1500, '/ws/out/a.js': 1600, '/ws/out/old.js': 100, '/ws/out/sub': 1500, '/ws/out/sub/b.js': 1700 }, dirs2)))
      .toEqual(['/ws/out/a.js', '/ws/out/sub/b.js'])
  })

  it('条数与深度双封顶（工作区再脏也不能把一轮拖住）', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ status: ' M', path: `f${i}.txt` }))
    const files: Record<string, number> = {}
    for (let i = 0; i < 30; i += 1) files[`/ws/f${i}.txt`] = 2000
    const capped = selectUnionCandidates(entries, { ...options(files), maxPaths: 3 })
    expect(capped).toHaveLength(3)
    // 深度：maxDirDepth=1 只展开直接子项（sub/ 里的文件拿不到）；0 = 根本不往里看
    const deep = { '/ws/out': [{ name: 'a.js', dir: false }, { name: 'sub', dir: true }], '/ws/out/sub': [{ name: 'b.js', dir: false }] }
    const fresh = { '/ws/out': 1500, '/ws/out/a.js': 1600, '/ws/out/sub': 1500, '/ws/out/sub/b.js': 1600 }
    expect(selectUnionCandidates(
      [{ status: '??', path: 'out/' }],
      { ...options(fresh, deep), maxDirDepth: 1 },
    )).toEqual(['/ws/out/a.js'])
    expect(selectUnionCandidates(
      [{ status: '??', path: 'out/' }],
      { ...options(fresh, deep), maxDirDepth: 0 },
    )).toEqual([])
  })
})

describe('parsePorcelainPaths', () => {
  it('解析 -z 记录（含空格路径与首字符状态位）', () => {
    expect(parsePorcelainPaths(' M src/a.ts\0?? new file.txt\0 D gone.txt\0')).toEqual([
      { status: ' M', path: 'src/a.ts' },
      { status: '??', path: 'new file.txt' },
      { status: ' D', path: 'gone.txt' },
    ])
  })

  it('空输出与畸形记录都不抛', () => {
    expect(parsePorcelainPaths('')).toEqual([])
    expect(parsePorcelainPaths('nonsense\0')).toEqual([])
    expect(parsePorcelainPaths('\0\0')).toEqual([])
  })

  it('重命名防御：吃掉额外的原路径字段', () => {
    expect(parsePorcelainPaths('R  new.txt\0old.txt\0 M other.txt\0')).toEqual([
      { status: 'R ', path: 'new.txt' },
      { status: ' M', path: 'other.txt' },
    ])
  })
})
