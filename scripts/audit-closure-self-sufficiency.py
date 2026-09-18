#!/usr/bin/env python3
"""闭包自足性检查：闭包里每个包的依赖，是否都能**在闭包内**解析。

为什么需要（2026-09-18 打包版 agent 起不来的根因）：
`.app` 在仓库里，而 Node 解析 bare import 时会**逐级向上**找 `node_modules` —— 所以闭包里缺的包
会静默地从**工作区**解析到。后果不是「报缺包」，而是**两棵树的模块实例混用**：agent-loop 从工作区
拿一份 `dsh-scope`，agent-presets 从闭包拿另一份，两个模块的 `kScope` symbol 不同 ⇒
`scopeOf(agentCtx)` 返回 undefined ⇒ agent 挂载抛
「refusing to compose an unscoped context」（实测）。在**干净机器**上（.app 不在仓库里）同一缺陷
表现为直接 `Cannot find package`。

用法：
  python3 scripts/audit-closure-self-sufficiency.py <闭包 node_modules 路径>
退出码 0 = 自足；1 = 有缺口（列出缺失包与引用者）。
"""
import json
import os
import sys

nm = sys.argv[1] if len(sys.argv) > 1 else 'packages/desktop/build/host/node_modules'
if not os.path.isdir(nm):
    print(f'✗ 闭包目录不存在：{nm}')
    sys.exit(2)

# 收集闭包内所有包（含嵌套副本）
packages = {}  # name -> dir
for dirpath, dirnames, filenames in os.walk(nm):
    if 'package.json' not in filenames or os.path.basename(dirpath) == 'node_modules':
        continue
    try:
        pkg = json.load(open(os.path.join(dirpath, 'package.json')))
    except Exception:
        continue
    name = pkg.get('name')
    if name:
        packages.setdefault(name, dirpath)

def resolvable(name, from_dir):
    """从 from_dir 出发按 Node 规则向上找 name。"""
    cur = from_dir
    while True:
        candidate = os.path.join(cur, 'node_modules', name)
        if os.path.exists(candidate):
            return True
        parent = os.path.dirname(cur)
        if parent == cur:
            return False
        cur = parent

missing = {}
for name, dirpath in sorted(packages.items()):
    try:
        pkg = json.load(open(os.path.join(dirpath, 'package.json')))
    except Exception:
        continue
    deps = set(pkg.get('dependencies', {}).keys()) | set(pkg.get('peerDependencies', {}).keys())
    for dep in deps:
        if dep.startswith('@deepseek-ai/dsh-') and dep.endswith('-in-process-driver'):
            pass
        if not resolvable(dep, dirpath):
            missing.setdefault(dep, []).append(name)

if not missing:
    print(f'✅ 闭包自足：{len(packages)} 个包，依赖均可在闭包内解析')
    sys.exit(0)

print(f'★ 闭包不自足：{len(missing)} 个包无法在闭包内解析（会从仓库/其它树解析 ⇒ 模块实例混用）：')
for dep, owners in sorted(missing.items()):
    print(f'  {dep}')
    print(f'      被 {len(owners)} 个闭包内包引用，例如: {", ".join(owners[:4])}')
sys.exit(1)
