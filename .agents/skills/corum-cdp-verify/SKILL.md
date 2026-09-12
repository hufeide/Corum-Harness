---
name: corum-cdp-verify
description: 在 corum Agent OS 桌面应用（kkc-desktop 仓库）里用 CDP 做实机功能验证与界面调试：启自己的验证实例（不碰用户主实例）、一份声明式规格跑完所有断言、截图留证。适用于改了 client 插件 / UI / 桌面功能后需要真实验证的场景；不适用于纯编译检查或官方 dsh 包内部开发。
---

# corum CDP 实机验证

在 kkc-desktop 仓库开发桌面应用功能后，用 Chrome DevTools Protocol 驱动真实运行的
Electron 应用做端到端验证。**只编译通过不算完成**——每个功能点都要经「RPC 驱动 +
事件日志核对 + UI DOM 断言」三层实机验证。

## 驱动方式：首选 chrome-devtools-mcp（MCP 工具），备选 cdp.mjs 脚本

DSH web profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 已配 `mcp-chrome-devtools`，
以**连接模式**挂到 corum 应用的 CDP 端口（`--browser-url=http://127.0.0.1:9222`）。
会话里的 `mcp__chrome_devtools__*` 工具（list_pages / evaluate_script / take_screenshot /
click / fill / take_snapshot / wait_for 等）直接驱动 corum 主窗口，是**默认首选**：

- `list_pages` → 找 corum 主窗口（`http://127.0.0.1:<ephemeral>/`，coding combo 标题
  为 DeepSeek Harness；dev-agent combo 为 corum 界面）。如有多个 page（floating 窗等），
  用 `select_page` 切到主窗口再操作。
- `evaluate_script` → 跑任意 JS，含 RPC 桥调用（见下「RPC 调用」）。**替代原
  `cdp.mjs eval/evalfile`**：把验证脚本作为 function body 传入即可，长脚本建议先写到
  临时文件再读出来传（避免一次次手拼）。
- `take_screenshot` → 截图。**注意**：`filePath` 参数受 DSH 工作区沙箱限制，写
  `/tmp/...` 会被拒；**省略 filePath** 让它内联返回图片即可。
- `take_snapshot` → a11y 树快照，适合做 DOM 结构断言和定位可交互元素 uid。
- `click` / `fill` / `fill_form` / `press_key` → 纯 UI 链路验证（React controlled input
  用这些工具，不要用 evaluate_script 直接 `el.value=`——不触发状态更新）。

**MCP 不可用时回退 `cdp.mjs`**（仓库 `scripts/cdp.mjs`，skill 快照版在
`<skill>/scripts/cdp.mjs`）：

```bash
node scripts/cdp.mjs evalfile /tmp/check.js   # 从文件执行 JS（推荐，免 shell 转义）
node scripts/cdp.mjs eval '<js表达式>'
node scripts/cdp.mjs shot <截图名>            # 截图到 /tmp/corum-cdp/shots/
```

- **沙箱拦截 localhost**：`127.0.0.1:9222` 在 bash 沙箱内必须 `require_escalated`
  运行，否则 `Operation not permitted` / `Connection refused`。（MCP 工具无此问题——
  MCP server 是独立进程，不走 bash 沙箱。）
- 依赖 `ws` 包：默认从 kkc-desktop/packages/desktop 解析；仓库在别处时设
  `CORUM_DESKTOP_PKG=<desktop 包 package.json 路径>`。
- 找不到页面报 `no main page` = 应用没起或端口不对。


---

# 【2026-09-12 新增】两实例纪律 + 声明式验证装置

> 这一节的由来：指挥模式实机测试实测 —— **实现 9.1 分钟，验证 98.8 分钟（占整轮 84%）**，
> 因为验证子 Agent 写了 **48 个一次性探针脚本**，每加一条断言就新写一个脚本 + 一次 bash
> 往返。同时它还要面对一个矛盾：主实例跑的是**启动期 bundle 快照**，改完 build 完也验不到
> UI；而让它去重启主实例，就是把用户正在用的应用整死（2026-09-11 真实事故）。
> 本节的两个装置就是为这两件事做的。

## 装置一：验证实例（`scripts/verify-instance.sh`）—— 你随便重启，主实例不动

主实例（用户在用，CDP **:9222**，`CORUM_HOME=.corum-dev-home`）**永远不要碰**：
不要 kill / pkill / 重启任何不是你启动的进程，不要 `dev-ide.sh start`
（它的兜底清理是 `pgrep -f "<repo>/packages/desktop/lib"`，会把主实例一起杀掉）。

你有自己的实例，可以自由重启：

```bash
./scripts/verify-instance.sh start|restart|stop|status
# CORUM_HOME=packages/desktop/.corum-verify-home  CDP=:9333；userData 按端口分目录，
# 单实例锁不与主实例冲突；PID 文件在自己的 home 下，只杀自己那棵树。
```

改完 client 插件后**必须** `restart` 才能看到新产物（bundle 是启动期加载的）：

```bash
pnpm --filter <包名> run build && ./scripts/verify-instance.sh restart
```

## 装置二：声明式断言跑器（`scripts/ui-verify.mjs`）—— 一轮验证 = 一份规格 + 一次调用

**不要**再「一条断言写一个脚本」。写一份 JSON 规格，跑一次，拿一份 PASS/FAIL 报告：

```json
{
  "port": 9333,
  "before": [ { "click": "button[aria-label='插件中心']" }, { "wait": 1500 } ],
  "assert": [
    { "label": "浮层已打开", "selector": "[data-plugin-manager-overlay]", "exists": true },
    { "label": "标题正确",   "selector": "[class*=panel]", "textContains": "插件中心" },
    { "label": "圆角 24",    "selector": "[class*=panel]", "style": { "borderRadius": "24px" } },
    { "label": "市场截图",   "screenshot": "market-overlay" }
  ]
}
```

```bash
node scripts/ui-verify.mjs /tmp/market.spec.json      # 退出码 0=全 PASS，1=有 FAIL，2=连接/规格错
```

- `before` 步骤：`click`（CSS 选择器，或 `text:显示文字` 按可见文字找按钮）、`wait`（毫秒）、`eval`（原始 JS）。
- `assert` 断言：`exists` / `count` / `textContains` / `textEquals` / `style`（计算样式精确匹配）/
  `screenshot`（存 `<CDP_OUT>/<名>.png`，默认 `/tmp/corum-cdp/shots`）。
- **失败即非零退出**，可直接当验收门禁；报告逐条给实际值，便于判断是「真失败」还是「断言语写错」。
- 端口默认 9333（验证实例）。要打主实例就显式 `port: 9222`（一般不需要）。

### 一轮 UI 验证的标准动作（照抄即可）

```bash
pnpm --filter <包名> run build          # 1. 产物
./scripts/verify-instance.sh restart    # 2. 你自己的实例吃上新 bundle
cat > /tmp/spec.json <<'JSON'           # 3. 一份声明式规格（全部断言写在一起）
{ "before": [ {"click": "text:插件"} ], "assert": [ {"selector": "[data-plugin-manager-overlay]", "exists": true} ] }
JSON
node scripts/ui-verify.mjs /tmp/spec.json   # 4. 一次调用拿 PASS/FAIL
```

## 启动 / 重启应用：用 `scripts/cdp.sh`（安全、记录 PID、不误杀微信）

**两种方式共用同一个启动脚本**——MCP server 是连接模式，自己不启动应用；
每次验证前先确认应用在跑：

```bash
./scripts/cdp.sh start     # 清理旧实例 + 后台启动（秒回），CDP 就绪需数秒
./scripts/cdp.sh status    # 探测存活 + CDP 可达性；Electron 就绪后自动补记 PID
./scripts/cdp.sh stop      # 精确清理本实例（含子进程树）
./scripts/cdp.sh pid       # 打印当前记录的 Electron 主进程 PID
./scripts/cdp.sh restart   # = start（预留接 build 的位置）
```

- **combo**：默认 `coding`（IDE 壳）。要 dev-agent 壳：把脚本里 `COMBO_ID` 改 `dev-agent`，
  或复制一份调 `--combo=dev-agent`。
- **CORUM_REPO**：skill 快照版（`~/.agents/skills/corum-cdp-verify/scripts/cdp.sh`）在仓库外，
  运行时须先 `export CORUM_REPO=/Users/kukucai/work/kkc-desktop`；仓库内 `scripts/cdp.sh`
  自动定位仓库根，无需设。

### 为什么用这个脚本（三条红线都踩过）

1. **start 必须秒回**：本脚本常被 Agent 工具以「带超时的 bash 调用」执行。若脚本内
   等 CDP/PID（>10s），外层超时会 SIGTERM **整个进程组**、连带刚起的 Electron
   （GPU/network 崩溃退出，`exit_code=15`）。所以 start 只做 cleanup + 后台 spawn +
   立刻 exit 0；PID 记录/CDP 就绪交给 status 补。
2. **spawn 必须切断与脚本的 fd 血缘**：后台 Electron 若继承脚本的 stdout/stderr fd，
   脚本退出时 shell 会等该 fd 关闭而 **hang**（又触发外层超时连坐）。脚本用独立
   子 shell 包裹 `nohup ... >log 2>&1 </dev/null & disown`，三重 fd 全断。
3. **清理必须精确、绝不误杀微信开发者工具**：微信开发者工具也是 Electron，命令行
   含 `electron`/`node`。**绝不用** `grep -iE "electron|lib/(bridge|main).js"` 这类宽
   pattern——它会匹配微信。脚本只按「PID 文件记录 + `is_self` 校验 cmdline 必含
   本仓库 `packages/desktop` 绝对路径」双保险杀进程；微信路径
   （`/Applications/wechatwebdevtools.app` / `/Applications/微信.app`）绝不含此子串。
4. **is_self 用 pgrep 不用 ps**：Agent 工具 sandbox 里 `/bin/ps` 被禁
   （Operation not permitted），`ps -p <pid> -o command=` 取空会让 is_self 永远 false、
   cleanup 静默全跳过（2026-08-28 四实例残留事故的根因）。改用
   `pgrep -f "$SELF_MARK"` 集合判定，目标 pid 在集合内即 self。

### 手动启动（备用，需 tty 持久会话）

```bash
cd packages/desktop && CORUM_DEBUG_PORT=9222 CORUM_HOME=$PWD/.corum-dev-home CORUM_DEV_HMR=500 \
  node lib/cli.js --combo=coding
```

- **必须用 tty 持久会话方式启动**（进程挂在会话里）；`nohup ... &` / 后台管道方式
  会在命令结束时被杀，应用秒退。
- `CORUM_DEBUG_PORT=9222` 开启 CDP（壳在 main.ts 里读这个 env 加 remote-debugging）。
- dev home 是 `packages/desktop/.corum-dev-home`（测试数据持久在此；清场重测时
  mv 走 `.agent-presets/* teams/* projects/* agent-profiles`，不要用 rm）。

host 侧插件（corum-agent-dev 等）改动必须重启应用才生效；renderer 侧（UI 包）
改动 HMR 自动热更（但 host 已挂起恢复的循环不会重装配新工具，仍建议重启）。

## RPC 调用（scripts/rpc-helper.js）

renderer 页面里有 `window.corumDesktop.unary` IPC 桥（**仅 dev-agent combo**；
coding combo 主窗口是 DSH Web GUI 本身，无此桥）。把仓库 `scripts/rpc-helper.js`
（或 skill 快照版）的 `call/callRaw` 两个函数复制进你的 evaluate_script / evalfile
脚本顶部即可调全部 host 服务（端点清单见该文件头注释）：

```js
const { projects } = await call('corumProject', 'listProjects', {})
await call('corumRuntime', 'enqueue', { projectId: 'project', profileId: 'dev', type: 'general', summary: '...' })
const events = await call('corumRuntime', 'getDomainEvents', { projectId: 'project', fromSeq: 0 })
```

- 验证**拒绝路径**用 `callRaw`（不抛错，拿 `{ok:false, error}`）。
- RPC 与 UI 表单走同一 IPC 桥同一端点——RPC 驱动 ≈ UI 操作，但关键 UI 链路仍应
  补一次纯点击验证（用 MCP 的 click/fill 工具，或 evaluate_script 里 native setter +
  `input` 事件赋值；直接 `el.value=` 不触发 React 状态更新）。

## 验证三层结构

1. **RPC 驱动**：call 构造场景（建项目/拉团队/派任务/干预）。
2. **事件日志核对**：读 `packages/desktop/.corum-dev-home/projects/<id>/scheduler-events.jsonl`，
   事件链（assigned→started→completed 等）是调度事实源，逐条核对类型/载荷/causedBy。
   也可 `call('corumRuntime','getDomainEvents',...)` 拿结构化数据。
3. **UI DOM 断言**：evaluate_script 读 `document.body.innerText` / take_snapshot 查
   a11y 树验证渲染；查布局溢出用 `scrollWidth>clientWidth`。截图用 take_screenshot。

## 测试数据与场景构造经验

- dev home 已有：项目 `project`/`fresh-check`、团队 `team`、profiles `pm`/`dev`/`qa`
  （pm 是系统兜底统筹角色，删了会在建项目时重建）。
- **flash 模型执行极快**（10s 内完成简单任务）——验证卡住/干预/执行中状态，
  用 `sleep 300` 这类**真实耗时命令**构造执行窗口；编造「逐个创建 50 个文件」
  会被模型用循环命令秒杀。
- 验证阻塞链：任务摘要里声明「关键信息只有 X 知道，不知道就 report_blocked」。
- 长任务（真实编码）要耐心：`runPromptForType` 等 PM 回复可能 2-5 分钟，
  轮询事件日志确认推进（最后活动时间在涨 = 活着）。
- 警惕模型「跑偏」：自测类任务容易陷入本地环境纠缠（起 dev server/杀进程），
  这本身可用于卡住感知验证；验收时看产出物文件而非只听汇报。

## 常见坑

| 症状 | 原因 | 解法 |
|---|---|---|
| 事件流同一任务多条 started | 双 host 残留 | `./scripts/cdp.sh stop` 清干净再 start |
| tsc 报 Cannot find type definition 'node' | node_modules 被 pnpm verify-deps 剥离 | `CI=true pnpm install --no-frozen-lockfile` 恢复；之后直接用 .bin/tsc 别用 pnpm run |
| UI 改了不生效 | HMR 只热 renderer；host 插件要重启 | 重启应用 |
| 会话恢复后工具缺失 | 已存活 Agent 的 setup 不重跑 | 重启应用（resume 重跑 setup） |
| cdp.mjs evalfile 里模板字符串/展开语法报错 | shell 转义 | 一律 evalfile 从文件读，别用 eval 内联长代码；MCP evaluate_script 无此问题 |
| 启动脚本 hang 住不返回 / Electron 起后秒退（GPU exit_code=15） | 后台 Electron 继承脚本 stdout/stderr fd，或脚本内等 CDP 超时被外层 SIGTERM 连坐 | 用 `scripts/cdp.sh`：spawn 独立子 shell + 三重 fd 重定向；start 秒回不等 CDP |
| 清理时误杀微信开发者工具 | 用 `grep -iE "electron\|node\|lib/main.js"` 宽 pattern 匹配进程 | 用 `scripts/cdp.sh`：`is_self` 校验 cmdline 必含本仓库 `packages/desktop` 绝对路径 |
| `is_self` 永远 false、cleanup 静默全跳过 | sandbox 里 /bin/ps 被禁，cmdline 取空 | cdp.sh 已改用 pgrep 集合判定（2026-08-28 修复） |
| MCP take_screenshot 写 filePath 报 Access denied | DSH 工作区沙箱限制 filePath 必须在工作区内 | 省略 filePath 让截图内联返回 |
| MCP 工具报 "Could not connect to Chrome" | corum 应用没在跑，或 9222 端口被别的实例占用 | `./scripts/cdp.sh status` 确认；没在跑就 `start` |
| shell 脚本报 `VAR�: unbound variable`（带乱码） | 变量后紧跟全角字符（`$VAR（中文`），bash 把全角字符当变量名一部分 | 一律写 `${VAR}（中文`，变量用花括号显式界定 |
| macOS 无 `setsid` 命令 | `setsid` 是 Linux 的，macOS 没有 | 用独立子 shell + `nohup ... & disown` + fd 重定向脱离（见 cdp.sh） |
