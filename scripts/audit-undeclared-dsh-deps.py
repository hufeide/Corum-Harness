#!/usr/bin/env python3
"""审计：`@corum/*` 包**运行时 import 但未声明**的官方 `@deepseek-ai/*` 依赖。

为什么需要：pnpm deploy 只按**声明的依赖图**物化闭包。工作区里未声明的官方包靠提升
（root node_modules）能解析，所以 dev 态一切正常；到打包闭包里就 `Cannot find package`
（2026-09-18 实测：`@corum/corum-tool-subagent` import `@deepseek-ai/dsh-subagent` 却未声明，
导致 agent preset 挂载失败 → 反复重试 → 每秒重启整套 MCP）。

用法：python3 scripts/audit-undeclared-dsh-deps.py
退出码 0 = 无缺口；1 = 有缺口（列出包名与缺失的官方包）。
"""
import glob
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMPORT_RE = re.compile(r"""from\s+['"](@deepseek-ai/[a-z0-9-]+)['"]""")

gaps = []
checked = 0
for pkg_json in sorted(glob.glob(f'{REPO}/packages/plugins/*/*/package.json')):
    pkg = json.load(open(pkg_json))
    name = pkg.get('name', '')
    if not name.startswith('@corum/'):
        continue
    root = os.path.dirname(pkg_json)
    declared = set()
    for section in ('dependencies', 'peerDependencies', 'optionalDependencies'):
        declared |= set(pkg.get(section, {}).keys())
    imported = set()
    for dirpath, _dirs, files in os.walk(root):
        if 'node_modules' in dirpath or '/lib' in dirpath or '/tests' in dirpath:
            continue
        for f in files:
            if not f.endswith('.ts'):
                continue
            try:
                text = open(os.path.join(dirpath, f)).read()
            except Exception:
                continue
            imported |= set(IMPORT_RE.findall(text))
    # 官方包名（跳过 corum 自己的名字空间，它们已按 workspace:* 声明）
    missing = sorted(i for i in imported if i not in declared)
    if missing:
        checked += 1
        gaps.append((name, missing))

# 兜底判据：这些缺口若已在 deploy root（desktop-host）声明，则打包闭包仍然完整
# —— deploy root 本来就是这个用途（见 pack-macos 的 DEPLOY_ROOT 注释）。
# 只有「既没在源码里声明、也没在 deploy root 声明」才是真缺口。
host_pkg = os.path.join(REPO, 'packages/desktop/desktop-host/package.json')
declared_at_root = set()
try:
    declared_at_root = set(json.load(open(host_pkg)).get('dependencies', {}).keys())
except Exception:
    pass

uncovered = [(n, [m for m in ms if m not in declared_at_root]) for n, ms in gaps]
uncovered = [(n, ms) for n, ms in uncovered if ms]

if not gaps:
    print(f'✅ 审计通过：{checked} 个包，无「import 却未声明」的官方依赖')
    sys.exit(0)
if not uncovered:
    total = sum(len(ms) for _n, ms in gaps)
    print(f'✅ 审计通过：{len(gaps)} 个包共 {total} 处「import 却未声明」的官方依赖，**均已在 deploy root'
          f'（packages/desktop/desktop-host）声明** ⇒ 打包闭包完整（源码级声明债仍建议逐步清偿）')
    sys.exit(0)

print(f'★ 真缺口：{len(uncovered)} 个包的官方依赖既未声明、也未在 deploy root 兜底：')
for name, missing in uncovered:
    print(f'  {name}')
    for m in missing:
        print(f'      - {m}')
sys.exit(1)
