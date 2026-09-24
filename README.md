<p align="center">
  <img src="packages/desktop/assets/icon.png" alt="corum Agent OS" width="160">
</p>

<h1 align="center">corum Agent OS</h1>

<p align="center">
  基于 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 底座构建的
  <b>Agent 桌面发行版</b>——自由编排的插件式工作台 + 多 Agent 团队协作。
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-blue">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-11.7.0-orange">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="Status" src="https://img.shields.io/badge/status-early%20development-yellow">
</p>

---

## 这是什么

corum Agent OS 把 DeepSeek Harness 从一个 **Agent 运行时**，扩展成一个**可直接使用的桌面产品**：
Electron 承载层 + 38 个自研插件（IDE 界面、会话、Agent 能力、编排、记忆…）+ 一套默认配置。

> **定位类比**：DeepSeek Harness 是「Linux 内核」（Cordis 插件框架 + agent loop + capability seam），
> 本项目是「发行版」（桌面环境 + 插件 + 默认配置）。**不改内核，只做用户空间。**

底座能力（context 管理、工具系统、LLM 适配、会话存储、subagent 机制）全部继承自 dsh；
本项目的价值集中在**桌面形态**与**面向真实工作流的 Agent 编排**。

---

## 核心理念：区域组合 = 工作流 = Agent 团队

传统 IDE 把「界面」和「能力」写死在一起。corum Agent OS 认为三者应当统一且**由用户自由编排**：

| 维度 | 含义 |
|---|---|
| **区域组合** | 拖拽分割窗格，组成自己的工作台 |
| **= 工作流** | 一个「编码工作流」= 编辑器 + 文件树 + 终端 + 对话区 |
| **= Agent 团队** | 每个 Combo 绑定一套 Agent 预设与 MCP 工具集 |

- **壳只定义几何，不含业务**：外壳只提供区域划分与**运行时动态注册**的槽位表，任何插件都能注册新槽位。
- **凡有 UI 的插件都能进界面**：底座通过 `package.json` 的 `dsh.client` 字段 + `exports["./client"]` 判定插件是否有 UI，扫描加载图即可发现全部可挂载区域。
- **功能与 UI 同包**（dual-face package）：一个 `apply()` 注册 host 端能力（tools / commands / settings），同时提供 client bundle——这是常规模式，而非例外。
- **Combo 布局预设**：窗格四边 split、中心 swap、脱出为浮动窗、sash 调宽、布局持久化；把当前编排存为 Combo，切换 Combo 即切换整个工作上下文。

---

## 功能概览

### 桌面工作台（IDE 形态）

- **编辑器**：Monaco 编辑器 + 差异视图 + 只读预览，经 `corumFs` RPC 读写工作区
- **资源管理器 / 底部面板 / 状态栏**：可关闭、可拖拽、可重组
- **插件中心**：查看、开关、配置已安装插件
- **多会话 + 任务模式**：任务泳道、子 Agent 卡片、编排进度可见

### Agent 基础模式

在底座的标准模式之外，corum 提供 **指挥模式（Conductor Mode）** 作为一等的基础模式
（`baseMode: 'conductor'`，与 `standard` / `ptc` / `minimal` / `cordis` 并列）——
它把「一个 Agent 干完全部活」换成「一个技术负责人带一支队伍」：

- **指挥者是技术负责人，不是调度员**：负责判断问题是什么、该怎么解、结果是否真的达标。
- **不给写工具，只给只读 shell**：无法改文件，是刻意的——价值不在打字。
  可跑 `git log` / `git diff` / `ls` / 查进程与端口，但任何写操作**被机制层拒绝**
  （约束走 agent-scoped 门禁，而不是可被用户权限档位覆盖的沙箱状态）。
- **必须自己做的三件事**：定方案（精确到文件 / API / 改动形状 + 要避的坑）、
  验收（子 Agent 的报告是**主张**不是证据，要亲自看 diff）、收尾最后一公里。
- **上下文是最稀缺资源**：三阶段调研漏斗——入门自己看（有界）→ 深入交给 research 子 Agent →
  收尾只做点读验收，避免自己一路 grep 到跑偏。
- **纵深防御**：主 Agent 与 research 子 Agent 恒只读，用户选的权限档位**只对 worker 生效**。

> 一句话：指挥模式让「人类指挥 + AI 执行」这套协作范式成为可选的 Agent 形态，而不只是一句提示词。

### Agent 能力

- **多 Agent 编排**：并行 / 隔离 / 委派，`orchestrate` 声明式 fan-out，子 Agent 在独立 git worktree 中工作并自动集成
- **指挥模式**：见上（基础模式之一），配套只读门禁 + 三阶段调研 + 委派闸门
- **Agent 预设（persona）**：岗位、人格、职责、域边界、模型路由（主 / 子 / 调查三档独立配置）
- **记忆底座**：事实级存储、存续期与衰减、三维星云可视化（设置中心可配）
- **MCP 集成**：MCP 服务管理与授权，工具自动装配进 Agent
- **技能库**：可绑定的可复用技能（含项目自带开发规范技能）
- **本地模型**：支持 Ollama 等本地 provider，云端 / 本地随配置切换
- **文生图**：本地文生图能力（`corum-artgen`）

### 工程化

- **插件化发行**：38 个插件包按 `ui` / `session` / `agent` 分组，能力与界面同包
- **零内核篡改**：官方包一律从 npm registry 引用，不 fork、不 vendored、不改源码；所有定制通过「写插件 + overlay 覆盖行」完成
- **可验证性优先**：CDP 实机验证技能 + 声明式断言跑器，界面改动必须跑真机三层验证（渲染 / 行为 / 零控制台错误）

---

## 快速开始

**环境要求**：Node `^22.19.0 || >=24.0.0`，pnpm `11.7.0`。

```sh
pnpm install

# 开发态启动桌面应用
pnpm shell:dev                       # = pnpm --filter corum-desktop run start

# 或使用一键脚本（清残留 + 全量构建 + 启动）
./scripts/dev-ide.sh                 # 默认 restart（清理 + 全量编译 + 启动）
./scripts/dev-ide.sh start           # 只启动，不编译
./scripts/dev-ide.sh stop            # 清理旧实例

# 打包 macOS 应用（.app / .dmg）
pnpm pack
```

> **平台说明**：当前打包链路面向 **macOS（Apple Silicon）**；跨平台（Windows / Linux）
> 尚在规划中，见 `docs/TODO.md`。

### 构建与检查

```sh
pnpm build          # 全量构建（packages/**）
pnpm typecheck      # 全量类型检查
pnpm shell:smoke    # 冒烟启动

# 测试（各插件包内）
pnpm --filter @corum/corum-agent run test

# fork 与官方基线的漂移守卫（改 fork 包后必跑）
./scripts/verify-fork-drift.sh
```

---

## 仓库结构

```
packages/
├── desktop/                  # Electron 桌面承载层（壳 + 宿主桥 + 打包）
│   ├── src/host/              #   host 侧：桥接、IPC、打包闭包
│   ├── src/client/            #   renderer 侧：壳、编辑器、布局
│   └── assets/                #   品牌与图标资源
└── plugins/                  # 38 个插件包，按能力分组
    ├── ui/        (12)        #   界面区域：IDE 面板、插件中心、主题基座
    ├── session/   (11)        #   会话与交互：对话、审批、提问、模型选择
    └── agent/     (15)        #   Agent 能力：编排、子 Agent、记忆、MCP、工具

profile/corum/                # 发行版 profile 清单
cordis.patch.yml              # 发行版 overlay（覆盖官方默认行 + 插入插件行）
docs/                         # 开发规范、经验沉淀、方案与交接文档
scripts/                      # 开发 / 验证 / 打包 / 审计脚本
skills/                       # 项目自带技能（开发规范、CDP 实机验证）
```

**插件是怎么被加载的**：每个插件包自带 `cordis.patch.yml` 声明挂载行，发行版
`cordis.patch.yml` 只放跨包覆盖；新增插件须同时登记进 `packages/desktop/package.json`
与 `packages/desktop/desktop-host/package.json`（打包闭包按后者补齐，遗漏会导致
**仅打包态**功能缺失）。

---

## 插件开发

新增一个插件 = 在 `packages/plugins/<组>/` 下建包 + 在 overlay 加一行。
包模板与步骤见 [`docs/plugin-template.md`](docs/plugin-template.md)。

动手前请先读这两份沉淀（**分工不同，不要混放**）：

| 文档 | 内容 |
|---|---|
| [`docs/dev-conventions.md`](docs/dev-conventions.md) | **规则唯一家**：必须 / 禁止、决策树、证据索引 |
| [`docs/LESSONS.md`](docs/LESSONS.md) | **经验唯一家**：现象 → 根因 → 做法 + 验证手法 |
| [`docs/fork-delta.md`](docs/fork-delta.md) | fork 差异台账与官方升级 runbook（改 fork 前必读） |

### 三条必须知道的红线

1. **跨 bundle 共享状态一律用 cordis 服务**，不要挂 window 全局或模块级单例
   （bundle 各自内联 `@corum/*` 源码，模块级状态会被复制成多份且永不收敛）。
2. **不要随意 external 化 `@corum/*`**：底座的共享模块表只有 8 个硬编码种子，
   自建共享模块走 `dsh.client` 路径会导致白屏——用 cordis 服务绕开。
3. **host 插件改动必须重启应用**（renderer 改动才走 HMR）；跨包状态 / 壳 / 调度器
   改动必须过 **CDP 实机三层验证**（UI 渲染 + 行为 + 零控制台错误）。
   **「编译通过」不等于「做完了」。**

---

## 与 DeepSeek Harness 的关系

| | DeepSeek Harness | corum Agent OS |
|---|---|---|
| 角色 | Agent 运行时内核 | 桌面发行版 |
| 提供 | Cordis 框架、agent loop、工具系统、capability seam | 桌面壳、38 个插件、默认配置、工作流编排 |
| 依赖方式 | — | 全部从 npm registry 引用官方包（`@deepseek-ai/dsh-*`），**不 fork、不改源码** |

本项目维护少量必要的 **fork 包**（用于修补底座在上层暴露的能力缺口），差异全部登记在
[`docs/fork-delta.md`](docs/fork-delta.md)，并有 `scripts/verify-fork-drift.sh` 守卫字节级一致性。

---

## 开源范围

本项目采用 **open core** 模式：

- **开源（本仓库）**：**任务模式（Task Mode）**——单任务泳道 + 指挥模式 + 完整的 Agent
  能力面（编排、子 Agent、记忆、MCP、技能、IDE 工作台）。
- **闭源（独立维护）**：**项目模式（Project Mode）**——项目制工作区、多 Agent 团队协作、
  需求 / 任务 / BUG 管理与项目级知识治理。**开源发行版只呈现任务模式**，不提供项目模式入口。

> **过渡期说明**：项目模式的实现目前仍在本仓库内（`corum-ide-project-ui` 插件、
> `corum-agent` 的 `project-*` 模块）。它将在版本发布流程中剥离到闭源发行版，
> 届时本仓库不再包含相关代码。在此之前，你在本仓库仍可能读到指向项目模式的实现与文档锚点——
> 它们不影响任务模式的构建与运行。

## 项目状态

**早期开发阶段**，接口与配置仍在快速演进，尚未发布稳定版本（当前 `0.1.0`）。
欢迎通过 Issue 反馈问题与建议。

## 许可证

[Apache License 2.0](LICENSE)。

选择 Apache-2.0 而非 MIT 的原因：它**显式授予专利许可**（第 3 节），对商业使用与
企业贡献者更友好，同时保留商标条款（第 6 节）。上游 DeepSeek Harness 为 MIT，
与本许可证兼容。

## 致谢

本项目构建于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与
[Cordis](https://github.com/deepseek-ai/cordis) 之上，感谢底座团队的工作。
