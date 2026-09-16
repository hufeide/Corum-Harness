#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""界面字号「乘数变量」改造 —— 干跑工具（默认不改任何文件）。

把 `font-size: <N>px` 变为 `font-size: calc(<N>px * var(--corum-ui-font-scale, 1))`，
使「界面字号」设置能通过一个乘数变量统一驱动界面文字大小。

用法：
    python3 scripts/migrate-ui-font-size.py                # 干跑：只报告 + 打印样本
    python3 scripts/migrate-ui-font-size.py --diff-out F   # 干跑并把全部改动写入 F 供核对
    python3 scripts/migrate-ui-font-size.py --apply        # 真正落盘（需先核对 diff）

设计要点（为什么用乘数变量而不是 px→rem，见台账
`settings.rework.ui-font-size-scope-measured`）：
- 纯机械变换，可脚本化，无需人工换算；
- 不依赖根字号；未被匹配的声明**保持原样**；
- **可一次性覆盖全部处** ⇒ 不存在「部分生效」的中间态。

⚠️ 幂等：已含 `--corum-ui-font-scale` 的声明会被跳过，重复运行安全。
"""
import io
import os
import re
import sys

SKIP_DIRS = {'node_modules', 'lib', 'dist', '.git', 'build'}

# 只匹配「恰好是 px 字面量」的声明；不动 var()/calc()/rem/em/% 等。
PATTERN = re.compile(r'font-size:\s*(\d+)px\b')

DEFAULT_ROOTS = [
    'packages/plugins/ui/corum-ide-ui',
    'packages/plugins/session/corum-ui-chat',
    'packages/plugins/session/corum-ui-conversation',
    'packages/plugins/ui/corum-ide-panel-bottom-ui',
    'packages/desktop/src/client',
]

MARKER = '--corum-ui-font-scale'


def css_files(root):
    """Yield CSS file paths under root, skipping build/dependency dirs."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith('.css'):
                yield os.path.join(dirpath, name)


def rewrite(text):
    """Return (new_text, changes) where changes is a list of (old, new) pairs."""
    changes = []

    def repl(match):
        line_start = text.rfind('\n', 0, match.start()) + 1
        line_end = text.find('\n', match.start())
        line = text[line_start:line_end if line_end >= 0 else len(text)]
        if MARKER in line:
            return match.group(0)
        old = match.group(0)
        new = 'font-size: calc(%spx * var(%s, 1))' % (match.group(1), MARKER)
        changes.append((old, new))
        return new

    return PATTERN.sub(repl, text), changes


def main():
    """Run the dry-run (or --apply) migration and report counts."""
    apply = '--apply' in sys.argv
    diff_out = None
    if '--diff-out' in sys.argv:
        diff_out = sys.argv[sys.argv.index('--diff-out') + 1]

    total = 0
    touched_files = 0
    per_root = {}
    lines = []

    for root in DEFAULT_ROOTS:
        if not os.path.isdir(root):
            continue
        root_count = 0
        for path in css_files(root):
            src = io.open(path, encoding='utf-8').read()
            out, changes = rewrite(src)
            if not changes:
                continue
            root_count += len(changes)
            touched_files += 1
            lines.append('=== %s  (%d 处)' % (path, len(changes)))
            for old, new in changes:
                lines.append('  - %s' % old)
                lines.append('  + %s' % new)
            if apply:
                io.open(path, 'w', encoding='utf-8').write(out)
        per_root[root] = root_count
        total += root_count

    print('模式：%s' % ('落盘 (--apply)' if apply else '干跑（未改任何文件）'))
    print()
    for root, count in per_root.items():
        print('  %-52s %d' % (root, count))
    print()
    print('合计：%d 处，涉及 %d 个 CSS 文件' % (total, touched_files))
    if diff_out:
        io.open(diff_out, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
        print('改动清单已写入：%s（%d 行）' % (diff_out, len(lines)))
    elif not apply:
        print()
        print('前 12 行样本：')
        for line in lines[:12]:
            print(line)
    return 0


if __name__ == '__main__':
    sys.exit(main())
