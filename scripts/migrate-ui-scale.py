#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""间距/字号「乘数变量」改造 —— 干跑工具（默认不改任何文件）。

把声明里的 px 值包成 `calc(<N>px * var(--corum-<axis>-scale, 1))`，
使「界面字号 / 界面密度」等设置能通过一个乘数变量统一驱动。

用法：
    python3 scripts/migrate-ui-scale.py                                  # 干跑 font-size（已完成，应 0 处）
    python3 scripts/migrate-ui-scale.py --property gap --diff-out F      # 干跑 gap
    python3 scripts/migrate-ui-scale.py --property padding,margin        # 干跑多个属性
    python3 scripts/migrate-ui-scale.py --property gap --apply           # 落盘（需先核对 diff）

## 轴与变量名
| 属性 | 变量 |
|---|---|
| `font-size` | `--corum-ui-font-scale` |
| `gap` / `padding` / `margin` | `--corum-density-scale` |

## 设计要点
- **全仓扫描 `packages`**（`node_modules` / `lib` / `dist` 除外）。
  第一版手挑了 5 个目录，结果只覆盖 420/676 处 —— **手挑范围 = 制造部分生效**，
  故一律全仓；详见台账 `settings.rework.ui-font-size-scale-migrated`。
- **多值声明**：`padding: 6px 16px 10px 16px` 里**每个 px 值各自包裹**，
  不能只包第一个 —— 否则会出现「上下随动、左右不动」的错位。
- **幂等**：已含目标变量的值跳过（避免 `calc(calc(...))` 双重包裹）。
- **不动** `0`（无单位）、`%`、`em`、`rem`、`var()`、`auto`。

⚠️ **计数与验证纪律**（本项目付过学费）：
任何「搜索某模式 = 0」的结论**必须配一次反向对照**（搜一个必然存在的串），
否则无法区分「真的没有」与「命令/模式本身失效」
（见台账 `lesson.verify.rg-does-not-exist-false-green`）。
⚠️ 本仓 **`rg` 不可用**（退出码 127），核验一律用 `grep` 或 grep 工具。
"""
import io
import os
import re
import sys

SKIP_DIRS = {'node_modules', 'lib', 'dist', '.git', 'build'}

# 全仓扫描 —— 见文件头「手挑范围 = 制造部分生效」。
DEFAULT_ROOTS = ['packages']

FONT_VAR = '--corum-ui-font-scale'
DENSITY_VAR = '--corum-density-scale'

# 属性名 → (CSS 变量, 是否单值)
PROPERTY_AXIS = {
    'font-size': (FONT_VAR, True),
    'gap': (DENSITY_VAR, True),
    'row-gap': (DENSITY_VAR, True),
    'column-gap': (DENSITY_VAR, True),
    'padding': (DENSITY_VAR, False),
    'padding-top': (DENSITY_VAR, False),
    'padding-right': (DENSITY_VAR, False),
    'padding-bottom': (DENSITY_VAR, False),
    'padding-left': (DENSITY_VAR, False),
    'margin': (DENSITY_VAR, False),
    'margin-top': (DENSITY_VAR, False),
    'margin-right': (DENSITY_VAR, False),
    'margin-bottom': (DENSITY_VAR, False),
    'margin-left': (DENSITY_VAR, False),
}

DECL = re.compile(r'(?P<prop>%s)\s*:\s*(?P<val>[^;{}]+);' % '|'.join(
    sorted(PROPERTY_AXIS, key=len, reverse=True)))
PX = re.compile(r'(?<![\w.-])(\d+(?:\.\d+)?)px\b')


def css_files(root):
    """Yield CSS paths under root, skipping build and dependency directories."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith('.css'):
                yield os.path.join(dirpath, name)


def wrap_values(prop, value, var):
    """Wrap every px value in one declaration value; skip if already wrapped.

    ⚠️ **值里含 `var(` 时整条跳过** —— 那些声明已由另一个轴驱动，例如
    `font-size: var(--dsh-content-font-size, 14px)` 属「会话正文字号」轴，
    若把它的 fallback 也乘上界面缩放，就会让两个本该独立的「面」互相污染。
    """
    if var in value or 'var(' in value:
        return value, 0
    count = [0]

    def repl(match):
        count[0] += 1
        return 'calc(%spx * var(%s, 1))' % (match.group(1), var)

    return PX.sub(repl, value), count[0]


def rewrite(text, props):
    """Return (new_text, changes) for the requested properties."""
    changes = []

    def on_decl(match):
        prop = match.group('prop')
        var, _single = PROPERTY_AXIS[prop]
        if prop not in props:
            return match.group(0)
        new_val, n = wrap_values(prop, match.group('val'), var)
        if n == 0:
            return match.group(0)
        changes.append('%s: %s;  →  %d 值' % (prop, match.group('val').strip(), n))
        return '%s: %s;' % (prop, new_val)

    return DECL.sub(on_decl, text), changes


def main():
    """Run the dry-run (or --apply) migration and report per-file counts."""
    apply = '--apply' in sys.argv
    diff_out = None
    if '--diff-out' in sys.argv:
        diff_out = sys.argv[sys.argv.index('--diff-out') + 1]
    props = {'font-size'}
    if '--property' in sys.argv:
        props = {p.strip() for p in sys.argv[sys.argv.index('--property') + 1].split(',') if p.strip()}
    unknown = props - set(PROPERTY_AXIS)
    if unknown:
        print('未知属性：%s' % ', '.join(sorted(unknown)))
        return 2

    total = 0
    touched = 0
    lines = []
    for root in DEFAULT_ROOTS:
        if not os.path.isdir(root):
            continue
        for path in css_files(root):
            src = io.open(path, encoding='utf-8').read()
            out, changes = rewrite(src, props)
            if not changes:
                continue
            total += len(changes)
            touched += 1
            lines.append('=== %s  (%d 处声明)' % (path, len(changes)))
            lines.extend('  ' + c for c in changes)
            if apply:
                io.open(path, 'w', encoding='utf-8').write(out)

    print('属性：%s' % ', '.join(sorted(props)))
    print('模式：%s' % ('落盘 (--apply)' if apply else '干跑（未改任何文件）'))
    print('合计：%d 处声明，涉及 %d 个 CSS 文件' % (total, touched))
    if diff_out:
        io.open(diff_out, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
        print('清单已写入：%s（%d 行）' % (diff_out, len(lines)))
    else:
        print('前 10 行样本：')
        for line in lines[:10]:
            print(line)
    return 0


if __name__ == '__main__':
    sys.exit(main())
