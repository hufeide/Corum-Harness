#!/usr/bin/env python3
"""设计 token 对账器（corum fork）。

用途：改 CSS 里的 `--dsw-*` token 前后各跑一次，回答两个问题：
  ① **有没有名字根本不存在的 token**（写错名 ⇒ 静默 fallback ⇒ 主题色永不生效）；
  ② **有没有给正确名字挂了多余硬编码 fallback**（死代码 + 误导读者）。
另列出「刻意保留」的类别，避免把有意的回退语义当垃圾清掉。

权威口径（三源并集）：
  · 官方 `/Users/kukucai/dsh/packages/client/ui-theme/src/styles/design-platform.css`
    与其编译产物 `lib/client.js`（运行时真正生效的那份）
  · corum 侧覆盖 `packages/plugins/ui/corum-ide-ui/src/client/theme-layer.ts`（键名即 token 名）
  · 本仓 CSS/TS 里自己声明过的 token

⚠️ 与 docs/LESSONS.md 的口径一致：**正确名字会被 corum 按主题覆盖**，所以给正确名字
再挂硬编码 fallback 永不生效；而**不存在的名字**取值为空串 ⇒ fallback 就是最终渲染值。
两者的区别决定「改名」还是「只删 fallback」。

用法：
  python3 scripts/audit-dsw-tokens.py [--repo <checkout 根>] [--dsh <官方 checkout 根>] [--json <输出路径>]
退出码：0 = A 类（不存在的 token）为 0；1 = 仍有不存在的 token（可当门禁）。
"""
from __future__ import annotations

import argparse
import collections
import difflib
import json
import os
import re
import sys

SKIP_PARTS = (
    '/dist/', '/build/', '/node_modules/', '/.corum-dev-home/', '/.corum-verify-home/',
    '/.corum-worktrees/', '/lib/style.css',   # 旧式构建残留，非当前产物
)


def collect_defined(dsh: str, repo: str) -> tuple[set[str], set[str], set[str]]:
    """返回 (官方定义, corum 覆盖, 本仓声明)。"""
    official: set[str] = set()
    for rel in ('packages/client/ui-theme/src/styles/design-platform.css',
                'packages/client/ui-theme/lib/client.js'):
        p = os.path.join(dsh, rel)
        if os.path.exists(p):
            official |= set(re.findall(r'(--dsw-[a-z0-9-]+)\s*:', open(p, encoding='utf-8', errors='replace').read()))

    corum: set[str] = set()
    p = os.path.join(repo, 'packages/plugins/ui/corum-ide-ui/src/client/theme-layer.ts')
    if os.path.exists(p):
        corum |= set(re.findall(r"'(--dsw-[a-z0-9-]+)'\s*:", open(p, encoding='utf-8').read()))
    return official, corum, set()


def scan(repo: str) -> tuple[dict, set[str]]:
    """返回 {token: [{file,line,fb}]} 与「本仓声明过的 token」。"""
    usage: dict[str, list[dict]] = collections.defaultdict(list)
    declared: set[str] = set()
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', 'build', '.git', '.corum-worktrees')]
        for fn in files:
            if not fn.endswith(('.css', '.tsx', '.ts', '.mjs')):
                continue
            fp = os.path.join(root, fn)
            if any(s in fp for s in SKIP_PARTS):
                continue
            text = open(fp, encoding='utf-8', errors='replace').read()
            rel = os.path.relpath(fp, repo)
            declared |= set(re.findall(r'(--dsw-[a-z0-9-]+)\s*:', text))
            # var(--token) / var(--token, fallback) —— fallback 段取到第一个顶层右括号
            for m in re.finditer(r'var\((--dsw-[a-z0-9-]+)\s*(,[^()]*(?:\([^()]*\)[^()]*)*)?\)', text):
                rest = (m.group(2) or '').strip()
                line = text[:m.start()].count('\n') + 1
                usage[m.group(1)].append({
                    'file': rel, 'line': line,
                    'fb': rest[1:].strip() if rest.startswith(',') else None,
                })
    return usage, declared


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default=os.environ.get('CORUM_REPO', os.getcwd()))
    ap.add_argument('--dsh', default=os.environ.get('DSH_REPO', '/Users/kukucai/dsh'))
    ap.add_argument('--json', default=None)
    args = ap.parse_args()

    repo, dsh = os.path.abspath(args.repo), os.path.abspath(args.dsh)
    if not os.path.exists(os.path.join(repo, 'packages/desktop/package.json')):
        sys.stderr.write(f'[audit] {repo} 不像 corum checkout（缺 packages/desktop/package.json）；'
                         '用 --repo 指定。\n')
        return 2

    official, corum, _ = collect_defined(dsh, repo)
    usage, declared = scan(repo)
    known = official | corum | declared

    undefined = {t: v for t, v in usage.items() if t not in known}
    # 真正带 fallback 的（排除纯 var(--token)）
    real_fb = {t: [x for x in v if x['fb']] for t, v in usage.items() if t in known}
    real_fb = {t: v for t, v in real_fb.items() if v}

    print(f'权威可知 token：官方 {len(official)} + corum 覆盖 {len(corum)} + 本仓声明 {len(declared)}'
          f' → 并集 {len(known)}')
    print()
    print(f'=== A. 不存在的 token（必须改名）：{len(undefined)} 个 / '
          f'{sum(len(v) for v in undefined.values())} 处 ===')
    for t in sorted(undefined, key=lambda k: -len(undefined[k])):
        cand = difflib.get_close_matches(t, sorted(known), n=3, cutoff=0.72)
        print(f'  {t}  ×{len(undefined[t])}   建议→ {cand}')
        for x in undefined[t][:10]:
            print(f'      {x["file"]}:{x["line"]}')
    print()
    print(f'=== B. 正确名挂了 fallback：{len(real_fb)} 个 token / '
          f'{sum(len(v) for v in real_fb.values())} 处 ===')
    for t in sorted(real_fb, key=lambda k: -len(real_fb[k])):
        vals = collections.Counter(x['fb'] for x in real_fb[t])
        nested = sum(c for v, c in vals.items() if v.startswith('var('))
        stack = sum(c for v, c in vals.items() if 'monospace' in v or 'serif' in v)
        hard = sum(vals.values()) - nested - stack
        print(f'  {t}  ×{len(real_fb[t])}   硬编码 {hard} / 嵌套var {nested} / 字体栈 {stack}')
        if hard:
            print(f'      硬编码值: { {v: c for v, c in vals.items() if not v.startswith("var(") and "monospace" not in v and "serif" not in v} }')
    print()
    print('说明：嵌套 var（`var(--a, var(--b))`）与字体栈是**有意的防御性回退**，'
          '不属于「多余 fallback」，不要机械删除。')

    if args.json:
        json.dump({'undefined': undefined, 'withFallback': real_fb, 'known': sorted(known)},
                  open(args.json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'明细 → {args.json}')

    hard_total = 0
    for v in real_fb.values():
        for x in v:
            fb = x['fb']
            if fb and not fb.startswith('var(') and 'monospace' not in fb and 'serif' not in fb:
                hard_total += 1
    print(f'\n结论：不存在的 token {sum(len(v) for v in undefined.values())} 处；'
          f'多余硬编码 fallback {hard_total} 处。')
    return 1 if undefined else 0


if __name__ == '__main__':
    raise SystemExit(main())
