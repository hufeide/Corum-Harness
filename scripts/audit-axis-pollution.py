#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""轴污染守卫 —— 静态检测 CSS 里「一个轴污染另一个轴」的形态。

## 为什么需要这个工具

本仓的「界面字号 / 界面密度 / 界面字体」各由**一个根级 CSS 变量**驱动：

| 轴 | 变量 |
|---|---|
| 字号 | `--corum-ui-font-scale` |
| 密度 | `--corum-density-scale` |
| 字族 | `--corum-ui-font-family` |

多轴系统有个**不留痕迹**的失效模式：**轴间污染**。
它**不产生残留、不报错**，只是让一个轴悄悄跟随另一个轴 ——
普通「grep 残留 = 0」的检查**永远发现不了**。

本项目实测踩过一次：批量迁移工具按**空白**切分值 token 时，把
`var(--dsh-content-font-size, 14px)` 拆成两段，导致 fallback 里的 `14px`
被包成 `calc(14px * var(--corum-ui-font-scale, 1))` ⇒
**「会话正文字号」的 fallback 跟着「界面字号」缩放了**。
（后改为按括号深度切分修复。）

## 本工具检测的形态

1. **他轴变量出现在 `var(...)` 的 fallback 位置**
   例：`var(--dsh-content-font-size, calc(14px * var(--corum-ui-font-scale, 1)))`
   ⇒ 会话正文字号的 fallback 被字号轴接管。
2. **他轴变量出现在同一 `calc(...)` 内、却属不同语义轴**
   例：`calc(14px + var(--dsh-content-font-delta, 0px)) * var(--corum-density-scale, 1)`
   （密度乘数套在字号轴上）

⚠️ **合法形态**（不得误报）：同一声明里**并列**使用不同轴，例如
`padding: calc(4px * var(--corum-density-scale, 1)) 0 calc(22px + var(--dsh-content-font-delta, 0px))` ——
它正是「各自归各自轴」的**正确**结果（本项目为此专门写过多条真机断言）。

## 用法

    python3 scripts/audit-axis-pollution.py           # 只报告（exit 0 = 无污染）
    python3 scripts/audit-axis-pollution.py --list    # 打印命中处
"""
import io
import os
import re
import sys

SKIP_DIRS = {'node_modules', 'lib', 'dist', '.git', 'build'}

# 本仓三个「轴」变量 → 轴名
AXIS_VARS = {
    '--corum-ui-font-scale': 'font-scale',
    '--corum-density-scale': 'density',
    '--corum-ui-font-family': 'font-family',
}

# 官方/上游的其他轴（若出现在 fallback 里说明被接管）
FOREIGN_AXES = ('--dsh-content-font-size', '--dsh-content-font-delta', '--dsw-font-family')

DECL = re.compile(r'(?P<prop>[a-z-]+)\s*:\s*(?P<val>[^;{}]+);')


def css_files(root):
    """Yield CSS paths under root, skipping build and dependency directories."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith('.css'):
                yield os.path.join(dirpath, name)


def find_pollution(value):
    """Return a list of pollution descriptions found in one declaration value."""
    hits = []
    # 形态 1：他轴变量 + 本仓轴变量同时出现在**同一个 var(...) 的 fallback 段**里。
    # 简化而可靠的近似：取每个 var( 的「逗号之后到匹配右括号」的片段，检查其中是否含本仓轴变量。
    i = 0
    while True:
        start = value.find('var(', i)
        if start < 0:
            break
        depth = 0
        # ⚠️ 必须从 `var(` 的**开括号之后**开始扫（start+4），
        # 否则会把 var 自己的括号也算进深度，导致顶层逗号永远找不到 ⇒ **漏检**。
        # （反向对照实测踩过：起点写成 start+3 时，污染形态 1 命中 0。）
        j = start + 4
        comma = -1
        while j < len(value):
            ch = value[j]
            if ch == '(':
                depth += 1
            elif ch == ')':
                if depth == 0:
                    break
                depth -= 1
            elif ch == ',' and depth == 0:
                comma = j
                break
            j += 1
        if comma > 0:
            # fallback 段 = 逗号后到该 var 的闭合括号
            k = comma + 1
            d = 0
            end = -1
            while k < len(value):
                if value[k] == '(':
                    d += 1
                elif value[k] == ')':
                    if d == 0:
                        end = k
                        break
                    d -= 1
                k += 1
            seg = value[comma + 1:end] if end > 0 else value[comma + 1:]
            for v in AXIS_VARS:
                if v in seg and value[start:comma].find(v) < 0:
                    outer = value[start:comma]
                    hits.append('%s 的 fallback 里含 %s' % (outer.strip(), v))
        i = start + 4
    # 形态 2：上游字号轴变量与本仓轴变量出现在同一个 calc(...) 里
    for m in re.finditer(r'calc\(([^()]*(?:\([^()]*\)[^()]*)*)\)', value):
        inner = m.group(1)
        if any(f in inner for f in FOREIGN_AXES) and any(v in inner for v in AXIS_VARS):
            hits.append('calc 内混用上游轴与本仓轴：%s' % inner.strip()[:80])
    return hits


def main():
    """Scan every stylesheet for cross-axis contamination."""
    show = '--list' in sys.argv
    total = 0
    files = set()
    rows = []
    for root in ['packages']:
        if not os.path.isdir(root):
            continue
        for path in css_files(root):
            text = io.open(path, encoding='utf-8', errors='replace').read()
            for m in DECL.finditer(text):
                hits = find_pollution(m.group('val'))
                for h in hits:
                    total += 1
                    files.add(path)
                    rows.append('  %s\n    %s: %s' % (path, m.group('prop'), h))
    print('轴污染检查（源文件，排除 %s）' % '/'.join(sorted(SKIP_DIRS)))
    print('  污染处数：%d（涉及 %d 个文件）' % (total, len(files)))
    if show:
        for r in rows[:40]:
            print(r)
    elif total:
        for r in rows[:10]:
            print(r)
    if total == 0:
        print('  ✅ 未发现轴污染（注意：本判据只覆盖已识别的两种形态）')
    return 0 if total == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
