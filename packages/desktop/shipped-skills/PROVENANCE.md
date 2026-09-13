# shipped-skills — 随包分发的官方技能集

本目录随产品分发（打包时由 `packages/desktop/scripts/pack-macos.mjs` staging 到
host 运行时旁的 `<runtime>/shipped-skills/`，与 `shipped-presets/` 同款）。
用户在「设置 → 技能 → 导入内置技能」时，才由 `@corum/corum-skill-manager` 的
`importBuiltinSkills` 把这些技能装进 `<CORUM_HOME>/skills/`。

**应用启动期不写用户 home**：启动期写入会与用户既有技能抢目录、且难以回滚。
导入是显式动作，规则是「已存在一律不覆盖、用户删过的不复活」（见
`packages/plugins/agent/corum-skill-manager/src/shipped-skills.ts`）。

## 收录判定

判定动作：在官方检出 `/Users/kukucai/dsh` 里 `find . -name SKILL.md`，
**能在官方检出里找到同名 SKILL.md 的才算官方技能**。逐条结论：

| 目录 | 判定 | 官方来源 |
| --- | --- | --- |
| `dsh-archive-agent-notes` | 收录 | `.agents/skills/dsh-archive-agent-notes/` |
| `dsh-ci-test-reliability` | 收录 | `.agents/skills/dsh-ci-test-reliability/` |
| `dsh-code-review` | 收录 | `.agents/skills/dsh-code-review/` |
| `dsh-doc` | 收录 | `.agents/skills/dsh-doc/` |
| `dsh-find-simplifications` | 收录 | `.agents/skills/dsh-find-simplifications/` |
| `dsh-merging-stacked-prs` | 收录 | `.agents/skills/dsh-merging-stacked-prs/` |
| `dsh-pre-push-checks` | 收录 | `.agents/skills/dsh-pre-push-checks/` |
| `dsh-prose-standard` | 收录（内容有本机改造，见下） | `.agents/skills/dsh-prose-standard/` |
| `dsh-translate-docs` | 收录 | `.agents/skills/dsh-translate-docs/` |
| `dsh-trim-cot-leakage` | 收录（内容有本机改造，见下） | `.agents/skills/dsh-trim-cot-leakage/` |
| `record-browser-gif` | 收录 | `.agents/skills/record-browser-gif/` |
| `cordis-plugin-development` | 收录 | `packages/preset/agent-presets/presets/cordis/skills/cordis-plugin-development/` |
| `editing-cordis-compositions` | 收录 | `packages/preset/agent-presets/presets/cordis/skills/editing-cordis-compositions/` |
| `testSkill` | 排除 | 无官方同名内容；SKILL.md 自称「极简测试Skill，用于验证 Agent 是否正确加载」，是本机试验件 |
| `androidSkill` | 排除 | 无官方同名内容；SKILL.md 自称「安卓 Skill 隔离性对照」，是本机试验件 |
| `corum-cdp-verify` | 排除 | 源在本仓 `skills/corum-cdp-verify/`，是 corum 自有技能，不属官方 dsh 技能集 |
| `corum-dev-conventions` | 排除 | 源在本仓 `skills/corum-dev-conventions/SKILL.md`（已跟踪），同上 |

## 内容来源与已知偏离

内容从 `packages/desktop/.corum-dev-home/skills/` 复制，并剔除本机产物
（`.versions/`、`skill-versions.json`、`.git/`、`node_modules/`、`.DS_Store`、`*.tsbuildinfo`）。
剔除后整体 288K / 27 个文件，全部是文本，无大二进制
（最大文件 `cordis-plugin-development/SKILL.md` ≈ 21KB）。

10 个技能与官方检出**逐字节一致**（`diff -r` 无差异）。两个例外是
`dsh-prose-standard` 与 `dsh-trim-cot-leakage`——它们的 SKILL.md（以及后者
的 `references/recall-batteries.md`）在 2026-09-12 被改造成「corum 本地副本」，
把 dsh 专属的 `vendor/` 排除集、双语配对门禁、Agent Notes 引用换成了本仓的
`node_modules/` + `.dbg/` + `docs/dev-conventions.md §11`。

**这套偏离是已决事项（2026-09-13）**：随包发出去的是 **corum 适配版**，不是官方原文。
理由：那两处改造把 dsh 专属路径（`vendor/` 排除集、Agent Notes 引用）换成了本仓的
`node_modules/` + `.dbg/` + `docs/dev-conventions.md §11`，对 corum 用户才是可执行的指令；
发官方原文反而会给出指向另一套仓库布局的排除路径。
**升级纪律（重要）**：同步官方技能时**不要**用官方原文直接覆盖这两份——先
`diff /Users/kukucai/dsh/.agents/skills/<name>/ packages/desktop/shipped-skills/<name>/`，
把官方新增内容手工合并（否则会静默丢掉 corum 适配，与 `docs/fork-delta.md` 记录的
「整文件覆盖把定制删掉」事故同型）。

**不随包的技能（已决，2026-09-13）**：`corum-cdp-verify` 与 `corum-dev-conventions` **不随包**。
理由：它们是本仓开发向技能（实机验证装置 / 本仓开发规范），产品用户不需要；且源就在本仓
`skills/`（已跟踪），开发机按需用「设置 → 技能 → 导入技能」装入，无需再随包一份。

**tombstone 的可撤回出口（已决，2026-09-13，保留）**：用户删掉某个内置技能后，
「导入内置技能」永不把它装回来（这正是 tombstone 的目的）；但**显式**用
`skillManager/importFromFile|Text|Directory` 导入同名技能会撤回该名字的 tombstone
（`deleteSkill` 只对「随包同名」技能记账）。理由：否则用户误删内置技能后永久回不来、
按钮永远报「不复活」——死路一条；而显式导入本身就是「我现在就要它」的意图表达。

## 维护

新增/更新随包技能：把官方检出里的技能目录抄进本目录（同样剔除产物），
然后跑

```
pnpm --filter @corum/corum-skill-manager run build
pnpm --filter @corum/corum-skill-manager run check:shipped-skills
```

自检脚本会核验技能名单、frontmatter 与目录名一致性、产物残留，
并用临时目录夹具断言「首次导入 / 改过不覆盖 / 删过不复活」三条策略。
