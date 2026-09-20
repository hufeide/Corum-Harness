# @corum/corum-memory — corum 通用记忆底座

事实级记忆组织插件：为 Agent 记忆与项目库记忆提供**通用底座**，只承载「组织形式」，
不绑定任何记忆来源。

## 核心设计

- **最小单元是「事实」而非消息/文档**：一条带元数据的原子断言
  （`entity` / `relation` / `fact` / `importance` / 时间窗 / `scope` / 证据链 / 作者）。
- **「失效 ≠ 忘记」（对齐 Graphiti 的时间知识图语义）**：一条事实有**三个正交维度**——
  - **适用窗口**（`validAt` → `invalidAt`）：事实断言何时为真；
  - **适用性**（`applicable`）：当前是否成立、该驱动行为；到期 → 不再适用；
  - **留存**（`retained`）：作为「发生过的事」是否还被记住；到期**永不**自动忘记，
    忘记只来自**显式删除**。
  - 例：用户要求「10月31日前每天提醒日程」→ 11/1 后不再 `applicable`（不提醒），
    但作为记忆仍 `retained`、可被 `recall` 检索召回。
- **四杠杆**（记忆区别于「存文件」的本质）：
  - **重要性** importance（0-100）：写入门槛 + 分层 + 衰减的单一事实源；
  - **合并** merge：同 `scope+entity+relation` 的 recency-wins，标失效不物理删（`supersedes` 溯源）；
  - **衰减** decay：**读时降权**（指数半衰期，分层定半衰期，访问强化抗衰），无后台任务；
    度量「记忆强度」，**不因到期归零**；
  - **驱逐** eviction：`invalidAt` 失效标记（可逆）+ 硬删除（仅合规/用户显式要求）。
- **分层** `transient / session / long / archival`：**只由 importance 决定**，不落库。
- **检索双模式**：`applicable`（默认，只返回当前适用的事实，驱动当前行为）/
  `recall`（返回全部含到期，回忆「发生过什么」）。
- **持久化**：复用官方 `dsh-storage-domain`（单域 `corum_memory`、单表 `facts`），
  默认路由到全局 SQLite（`$CORUM_HOME/storages`）。

「记什么」由写入方决定，底座只提供能力面：`ctx.memory`（cordis 服务）+ `/api/memory/*` RPC，
外加「设置 → 扩展 → 记忆」面板做**人工管理**（浏览 / 失效标记 / 重要性调整 / 硬删除）。

## 目录

```
src/
├─ memory-entities.ts   事实 schema 与存储域声明
├─ memory-policy.ts     纯函数：分层派生 / 读时降权衰减 / 适用·留存判定 / 合并失效
├─ memory-service.ts    MemoryService（cordis 服务 + RPC 端点）
├─ index.ts             host apply
└─ client/index.tsx     「设置 → 扩展 → 记忆」面板
tests/
└─ memory-policy.spec.ts 衰减/分层/合并契约测试
```

## 第三方开源软件与致谢

本插件站在众多开源项目的肩膀上。按其贡献方式如实区分三类：

### 基于 dsh（DeepSeek Harness）fork 版本构建

本插件运行在 **corum Agent OS** 之上——corum 是官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（dsh）的 fork 版本。插件的服务装配（cordis）、领域存储（dsh-storage / dsh-storage-domain）、
RPC 端点（dsh-typert-protocol）与设置面板挂载（dsh-client-ui-*）均复用 **dsh fork 侧**的官方
基线能力，**不列作第三方依赖**；corum 侧的 fork 偏离详见仓库 `docs/fork-delta.md`。

### 直接使用的第三方开源库（运行时/编译期依赖，均 MIT 许可）

| 库 | 仓库 | 用途 |
| --- | --- | --- |
| [zod](https://github.com/colinhacks/zod) | `colinhacks/zod` | 事实记录的落盘 schema 校验 |
| [React](https://github.com/facebook/react) | `facebook/react` | 记忆面板 UI（由桌面壳提供） |

### 设计灵感来源的开源项目（架构思想借鉴，未直接引用其代码）

底座的分层记忆、四杠杆巩固（importance / merge / decay / eviction）、时间窗失效语义，
源于对以下项目的研读与借鉴。**本插件未直接使用它们的代码**，但若无这些先行者的工作，
这套「事实级 + 巩固策略」的组织形式不会这么清晰地成形：

- **[MemGPT / Letta](https://github.com/cpacker/MemGPT)**（`cpacker/MemGPT`）——「把 LLM 当操作系统管理记忆」的分层记忆架构（工作 / recall / archival），启发了本底座的分层思想。
- **[Hindsight](https://github.com/vectorize-io/hindsight)**（`vectorize-io/hindsight`）——「事实级存储 + 实体解析写时做 + 四杠杆 consolidation」的框架，以及「好的巩固让删除变得不必要」的洞见，直接塑造了本底座的合并 / 衰减 / 驱逐策略。
- **[Graphiti](https://github.com/getzep/graphiti)**（`getzep/graphiti`）——时间知识图上 `valid_at` / `invalid_at` / `expired_at` 的失效时间窗语义，启发了本底座用「时间戳失效标记」取代物理删除的设计。

### 致谢

向以上所有项目的作者与维护者致以诚挚感谢——开源世界里「把最难的部分做对、再公开出来」
的慷慨，让后来者得以少走弯路。特别感谢 **MemGPT / Letta 团队**、**Vectorize (Hindsight) 团队**
与 **Zep (Graphiti) 团队**对 Agent 记忆这一难题的扎实工作；也感谢 **colinhacks** 提供的
`zod` 与 **React 团队**长期稳定的 UI 底座。
