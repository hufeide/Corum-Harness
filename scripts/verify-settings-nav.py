#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从源码解析 SECTION_DEFS + NAV_GROUP_BY_ID，模拟设置导航的实际投影顺序。

用途：核验代码侧导航是否等于设计稿的「21 项 / 5 组」（2026-09-16 移除 profiles + 拆散 general 后）。
跨 bundle 分区（不由 SECTION_DEFS 注册）在此显式补入，取自各自源码实测值：
- general  order 0   （corum-ide-ui/src/client/index.tsx）
- models   order 10  （corum-ui-settings-models/src/client/index.ts，NAV_GROUP_BY_ID 固定归 agent）
- ollama   order 195 （corum-ollama/src/client/index.tsx）
- artgen   order 197 （corum-artgen/src/client/index.tsx）
"""
import io, re, sys

SRC = 'packages/plugins/ui/corum-ide-ui/src/client/settings/SettingsSections.tsx'
LOC = 'packages/plugins/ui/corum-ide-ui/src/client/settings-locales.ts'

src = io.open(SRC, encoding='utf-8').read()

# SECTION_DEFS 中的注册项
defs = []
for m in re.finditer(r"\{\s*id:\s*'([^']+)',\s*order:\s*(\d+),\s*label:\s*'([^']+)',\s*navGroup:\s*'([^']+)'", src):
    defs.append({'id': m.group(1), 'order': int(m.group(2)), 'label': m.group(3), 'group': m.group(4)})

# 跨 bundle / 单独注册分区（不在 SECTION_DEFS 里，来源见 docstring）
# ⚠️ 2026-09-16：原 `general` 分区已拆散删除（通用页回归应用级），不再补入；
#    `appearance` 因需窄类型 renderSlot 改由 index.tsx 单独注册（仍归 general 组），补入。
defs += [
    {'id': 'appearance', 'order': 10, 'label': '外观',            'group': 'general'},
    {'id': 'models',  'order': 10,  'label': '(models t(nav))', 'group': 'agent'},
    {'id': 'ollama',  'order': 195, 'label': 'Ollama',          'group': 'extensions'},
    {'id': 'artgen',  'order': 197, 'label': '本地文生图',        'group': 'extensions'},
]

# 中英 locale 表
loc = io.open(LOC, encoding='utf-8').read()
def zh_of(key):
    m = re.search(r"'%s':\s*'([^']*)'" % re.escape(key), loc)
    return m.group(1) if m else key

GROUP_ORDER = ['general', 'agent', 'data', 'extensions', 'advanced']
GROUP_ZH = {
    'general': '通用', 'agent': '智能体', 'data': '数据与隐私',
    'extensions': '扩展', 'advanced': '高级',
}

print('解析到 SECTION_DEFS 注册项：%d 条（含跨 bundle 补入 4 条）' % len(defs))
print()
total = 0
for g in GROUP_ORDER:
    items = sorted([d for d in defs if d['group'] == g], key=lambda d: d['order'])
    total += len(items)
    print('【%s】%d 项' % (GROUP_ZH[g], len(items)))
    for d in items:
        print('   %-5d %-18s %s' % (d['order'], d['id'], zh_of(d['label'])))
print()
print('合计：%d 项' % total)

# 与设计稿目标对照
# ⚠️ 2026-09-16 用户裁定：profiles（配置档案）分区移除——本地「设置快照/切换」不做，
#    未来走账号登录 + 云端保存。设计稿 design.pen 侧的「配置档案」节点同步待用户 ⌘S。
TARGET = {
    'general': ['appearance', 'editor', 'terminal', 'notifications', 'shortcuts'],
    'agent': ['models', 'agent-settings', 'memory', 'permissions', 'hooks', 'agent-presets'],
    'data': ['account', 'privacy', 'data'],
    'extensions': ['extensions', 'mcp', 'skills', 'ai-polish', 'ollama', 'artgen'],
    'advanced': ['advanced'],
}
print()
print('=== 与设计稿目标对照 ===')
ok = True
for g in GROUP_ORDER:
    actual = [d['id'] for d in sorted([d for d in defs if d['group'] == g], key=lambda d: d['order'])]
    want = TARGET[g]
    if actual == want:
        print('  ✓ %-12s 完全一致' % g)
    else:
        ok = False
        print('  ✗ %-12s' % g)
        print('      实际: %s' % ', '.join(actual))
        print('      目标: %s' % ', '.join(want))
print()
print('结论：', '导航与设计稿完全一致' if ok else '仍有差异（见上）')
sys.exit(0 if ok else 1)
