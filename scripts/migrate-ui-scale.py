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
    """Wrap plain px value tokens; leave calc()/var() tokens untouched.

    ⚠️ **跳过判定的粒度必须是「单个值 token」，不是「整条声明」。**
    早期版本写成「值里含 `var(` 就整条声明跳过」，对**单值**声明是对的
    （如 `font-size: var(--dsh-content-font-size, 14px)` 必须整体不动），
    但对**多值**声明过宽 —— 实测漏掉 7 处**有意混用**的声明，例如
    `padding: 8px calc(var(--side-clearance) + 16px) 12px`：
    其中 `8px` / `12px` 是普通间距（应随密度缩放），
    中间的 `calc(var(...))` 是与布局相关的计算（不应缩放）。

    规则：
    - 值 token 是纯 `<N>px` → 包裹
    - 值 token 含 `(`（calc / var 等）→ 原样保留
    """
    if var in value:
        return value, 0
    count = [0]

    def repl_token(tok):
        if '(' in tok:
            return tok
        def one(m):
            count[0] += 1
            return 'calc(%spx * var(%s, 1))' % (m.group(1), var)
        return PX.sub(one, tok)

    # ⚠️ **必须按括号深度在顶层切分**，不能按空白切分：
    # `var(--dsh-content-font-size, 14px)` 内部有空格，空白切分会被拆成
    # `var(--dsh-content-font-size,` 与 `14px)` 两个 token ⇒ 后者不含 `(`
    # ⇒ fallback 里的 14px 被包裹 ⇒ **把「会话正文字号」轴污染成随界面字号缩放**。
    # 实测踩过这个坑，故改为深度感知的顶层切分。
    out = []
    depth = 0
    buf = ''
    for ch in value:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch.isspace() and depth == 0:
            if buf:
                out.append(repl_token(buf))
                buf = ''
            out.append(ch)
        else:
            buf += ch
    if buf:
        out.append(repl_token(buf))
    return ''.join(out), count[0]


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

    # ── 字族模式：`--family` ────────────────────────────────────────────
    # 把「UI 字族栈」的整条值改为 `var(--corum-ui-font-family, <原栈>)`。
    # ⚠️ **必须排除代码字族**（含 mono / Menlo / Consolas 的栈）——
    # 它们属编辑器与终端两个「面」，混改会破坏那两处（四面独立）。
    # ⚠️ 值必须保留为**整栈**（不能只留一个字族名），否则用户选到本机不存在的
    # 字族时**没有回退候选**，会渲染成方框。
    if '--family' in sys.argv:
        fam_var = '--corum-ui-font-family'
        fam_decl = re.compile(r'font-family\s*:\s*(?P<val>[^;{}]+);')
        mono_markers = ('mono', 'menlo', 'consolas', 'courier')
        total = 0
        touched = 0
        lines = []
        for root in DEFAULT_ROOTS:
            if not os.path.isdir(root):
                continue
            for path in css_files(root):
                src = io.open(path, encoding='utf-8').read()
                changes = []

                def on_fam(match):
                    val = match.group('val').strip()
                    low = val.lower()
                    if fam_var in val:
                        return match.group(0)
                    if any(m in low for m in mono_markers):
                        return match.group(0)   # 代码字族：不属本面，跳过
                    if 'var(' in val:
                        return match.group(0)   # 已由 token 驱动，跳过
                    changes.append('font-family: %s' % val)
                    return 'font-family: var(%s, %s);' % (fam_var, val)

                out = fam_decl.sub(on_fam, src)
                if not changes:
                    continue
                total += len(changes)
                touched += 1
                lines.append('=== %s  (%d 处)' % (path, len(changes)))
                lines.extend('  ' + c for c in changes)
                if apply:
                    io.open(path, 'w', encoding='utf-8').write(out)
        print('模式：字族（%s）' % ('落盘' if apply else '干跑'))
        print('合计：%d 处声明，涉及 %d 个 CSS 文件' % (total, touched))
        if diff_out := (sys.argv[sys.argv.index('--diff-out') + 1] if '--diff-out' in sys.argv else None):
            io.open(diff_out, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
            print('清单已写入：%s（%d 行）' % (diff_out, len(lines)))
        else:
            for line in lines[:8]:
                print(line)
        return 0

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

    # ⚠️ 按**轴族**展开：用户写 `gap` 时应同时覆盖 `row-gap` / `column-gap`；
    # 写 `padding` 时应覆盖四向；`margin` 同理。
    # 这不展开会导致**极隐蔽的部分生效**：实测遗漏过 `column-gap: 10px`
    # （因为过滤是 `prop not in props`，而 `column-gap` 不等于 `gap`）。
    expanded = set()
    families = {
        'gap': ['gap', 'row-gap', 'column-gap'],
        'padding': ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
        'margin': ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
        'font-size': ['font-size'],
    }
    for p in props:
        expanded.update(families.get(p, [p]))
    props = expanded

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
