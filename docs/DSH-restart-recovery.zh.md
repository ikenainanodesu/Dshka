# DSH 重启失败：修复与日志回报手册

> 面向"接手修复的 agent"。目标：**先让 dsh 能起来**，再定位原因，并把证据按统一格式交回。
> 本手册中凡标 `[已实测]` 的结论都是在本机验证过的；标 `[源码]` 的是读 dsh 安装包源码/其报告得出、未逐字复现。

- 编写时间：<timestamp>
- 环境：`dsh 0.1.5-rc.1` / `Node v24.11.1` / `pnpm 12.4.1`，profile = `web`
- 相关插件：`dsh-experience-loop`，源码在**本仓库**的 `dsh-experience-loop/`

> **关于路径占位符**：本手册不写死本机路径。约定如下，请按自己的环境替换：
>
> | 占位符 | 含义 | Windows 默认值 |
> |---|---|---|
> | `%DSH_HOME%` | dsh 的数据根目录（读环境变量 `DSH_HOME`） | `%USERPROFILE%\.dsh` |
> | `<repo>` | **本仓库**的检出目录（即本文件上两级） | — |
> | `%APPDATA%` | Windows 漫游 AppData | `%USERPROFILE%\AppData\Roaming` |
>
> 下文命令块多为 PowerShell，其中应写 `$env:DSH_HOME` / `$env:APPDATA`；写在表格或散文里时用 `%DSH_HOME%` / `%APPDATA%` 的 cmd 写法，二者指同一变量。

---

## 0. 一分钟处理流程

```
重启 dsh 失败
  → ① 别改代码、别删数据目录
  → ② 运行 R0「只禁用插件行」（§3.1），再启动
       ├─ 起来了  → 是插件行的问题，按 §5 采集证据交回，插件保持禁用
       └─ 还起不来 → 与本插件无关，去查其它行 / 环境（§4）
  → ③ 按 §6 的模板回报
```

**绝对不要做的两件事**：删除 `%DSH_HOME%\experience-loop`（数据与启动失败无关）；编辑 `cordis.yml`（每次启动都会被重写为 `[]`）。

---

## 1. 出事前的基线（这些是"正常"的样子）

| 项 | 值 |
|---|---|
| 唯一被改动的文件 | `%DSH_HOME%\profiles\web\cordis.patch.yml` |
| 改动内容 | 在文件末尾追加**一个** `- insert:` 条目（见下），其余内容未动 |
| 改动前备份 | `cordis.patch.yml.bak-before-experience-loop-<timestamp>`（6019 字节） |
| 后续清理备份 | `cordis.patch.yml.bak-before-comment-cleanup-*` |
| 插件源码 | `<repo>\dsh-experience-loop\`（28 个文件） |
| 插件数据 | `%DSH_HOME%\experience-loop\`（纯 JSON + Markdown） |
| 未改动 | `cordis.yml`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` |

`cordis.patch.yml` 末尾的插件条目原文 `[已实测]`：

```yaml
- insert:
    - id: experience-loop
      name: '<repo>\dsh-experience-loop\index.mjs'
      config:
        inject:
          subagents: false
```

**关键机制 `[源码 + 已实测]`**：`dsh` 的 patch 加载器会把 `insert:` 行里**绝对路径**（或相对于该 patch 文件的 `./`、`../`）自动转换成 `file://` URL 再 import。最终生效值是
`file:///<repo>/dsh-experience-loop/index.mjs`（正斜杠形式）。

---

## 2. 先隔离，再定位

启动失败时**不要**尝试"一边修一边起"。顺序永远是：

1. 让插件行失效（R0 / R1，§3）
2. 确认 dsh 能起来
3. 采集证据（§5）
4. 再决定是回滚、修复还是交给上游

这样做的意义：把"插件行导致启动失败"这个假设**证伪或证实**，而不是在不可用的状态里边猜边改。

---

## 3. 回滚阶梯（侵入性从低到高）

所有对 `%DSH_HOME%\...` 的**写**操作都在会话工作区 `<repo>` 之外，沙箱下需要一次性 `danger-full-access` 批准；**读**（`Get-Content`）不需要。

### 3.1 R0 — 只禁用插件行（推荐第一步）

`enabled: false` 时插件的 `apply()` 立即返回：不注册工具、不注册 `/experience` 命令、不注册 system-prompt 段、不注册 skill provider、不挂任何 hook。**数据目录不受影响。**

用现成脚本（推荐，会先自动备份）：

```powershell
cd <repo>\dsh-experience-loop
node tools/profile-row.mjs show      # 先看清楚要改的是哪一块
node tools/profile-row.mjs disable   # 写入 config.enabled: false
node tools/validate-profile-row.mjs  # 校验（不需要启动 dsh）
```

`disable` / `enable` / `remove` 三个动作都会先写 `<原文件>.bak-before-<动作>-experience-loop-<时间戳>`。

### 3.2 R1 — 删掉整个插件条目

```powershell
cd <repo>\dsh-experience-loop
node tools/profile-row.mjs remove
node tools/validate-profile-row.mjs
```

注意 `[已实测]`：`remove` 只删 `- insert:` 那一段（YAML 条目），它**上方**的注释块会留下。那是无害的注释，可以手工删掉，也可以不管。

### 3.3 R2 — 恢复整份备份

```powershell
Copy-Item "$env:DSH_HOME\profiles\web\cordis.patch.yml.bak-before-experience-loop-<timestamp>" `
          "$env:DSH_HOME\profiles\web\cordis.patch.yml" -Force
```

副作用：会把该备份时间点（14:05）之后对**这个文件**的所有改动一起回退。经核对，14:05 之后只有本插件相关的改动，所以本例中这是安全的。

### 3.4 R3 — 校验（**不需要启动 dsh**）

```powershell
cd <repo>\dsh-experience-loop
node tools/validate-profile-row.mjs                       # 校验真实 profile
node tools/validate-profile-row.mjs --file <候选patch文件>  # 校验候选文件，先验后装
node tools/validate-profile-row.mjs --id hmr               # 查任意行，例如 hmr
```

它用 harness **自己的** `loadProfileDirectory` + `composeEntries` 解析组合结果，会打印：
`applyEntryPatches` 的 warnings、最终生效行、绝对路径是否被锚成 `file://`、目标文件是否存在。

**不要用 `dsh --profile web --dump-config` 做校验** `[已实测]`：它会重写 profile 目录里的 `cordis.yml`，在受限沙箱下以
`EPERM: operation not permitted, open '<%DSH_HOME%>\profiles\web\cordis.yml'` 失败 —— 报的是假错，会让你误判 patch 有问题。
---

## 4. 判定：到底是不是这个插件导致的

R0 之后：

| 观察 | 结论 | 下一步 |
|---|---|---|
| dsh 正常起来 | **是**本插件条目导致 | 保持禁用，按 §5 采集证据，按 §7 对照排查 |
| 仍然起不来 | **不是**本插件导致 | 恢复本插件条目与否都无所谓；去查其它 patch 行、MCP server、凭据、端口占用、环境变量 |

判定的另一半证据来自启动日志本身（§5、§7）。

补充一个容易误判的点 `[源码]`：`patchReload: live` 下，**dsh 运行中**把 patch 文件改坏，通常不会让**当前**实例崩掉（加载器记录错误并保留上一份可用配置）；但它会让**下一次启动**失败。所以"现在还能用"不代表 patch 文件没问题。

---

## 5. 日志与证据采集

### 5.1 事实：dsh 不写应用日志文件 `[已实测]`

在本机 `%DSH_HOME%` 下递归查找 `*.log` / `*.ndjson`，只找到
`%DSH_HOME%\profiles\web\.dsh-market\log.ndjson`（那是 **dshmarket 插件**的，不是 dsh 本身）。

**结论：启动/加载错误只出现在启动 dsh 的那个终端上。** 必须重定向捕获，否则证据会随终端一起消失。

### 5.2 捕获启动输出

在启动 dsh 的终端里，改成：

```powershell
dsh web --profile web *>&1 | Tee-Object -FilePath <repo>\dsh-boot.log
```

（`*>&1` 把 stderr 也并进管道，`Tee-Object` 同时显示在屏幕上并落盘。）

如果 dsh 是双击/快捷方式启动的，先找出它的启动方式再把输出引到文件；实在拿不到，就**在 R0 状态下重启一次**，把那次输出抓下来——那一次的输出已经足够区分"插件导致"与"非插件导致"。

### 5.3 必交的证据清单

在 `<repo>` 下依次执行，把输出一起交回：

```powershell
# 1. 环境
dsh --version; node --version; pnpm --version

# 2. 启动日志（§5.2 抓到的文件内容，全文，不要截断）

# 3. patch 文件当前内容
Get-Content "$env:DSH_HOME\profiles\web\cordis.patch.yml" -Raw

# 4. 组合校验（不需要启动 dsh）
cd <repo>\dsh-experience-loop
node tools/validate-profile-row.mjs
node tools/validate-profile-row.mjs --id hmr

# 5. 插件静态自检（完全不需要 dsh）
node tools/run-tests.mjs                     # 期望：tests 48 / pass 48 / fail 0
Get-ChildItem -Recurse -File -Filter *.mjs | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { "SYNTAX FAIL: $($_.FullName)" } }

# 6. 插件数据目录（确认不是数据问题）
Get-ChildItem -Recurse -Force "$env:DSH_HOME\experience-loop" | Select-Object FullName,Length

# 7. 现有备份列表
Get-ChildItem "$env:DSH_HOME\profiles\web" -File | Select-Object Name,Length,LastWriteTime
```

### 5.4 读会话日志（dsh 起不来也能读）

会话日志：`%DSH_HOME%\sessions\--<cwd-slug>--\<session-id>\session.v3.jsonl.zstd`

> `--<cwd-slug>--` 这一层是**会话工作目录**按 `/`、`\`、`:` 替换成 `-` 后的名字。例如在 `C:\work\example-project` 里开的会话，目录就是 `--C-work-example-project--`。你从哪个目录启动 dsh，就用那个目录去推。

`[已实测]` 它是**多个独立 zstd 帧拼接**而成（一帧 = 一批追加），**单个解压器只会返回第一帧**（即会话头），并且**不报错**。必须按魔数逐帧解：

```powershell
cd <repo>\dsh-experience-loop
node tools/read-session-log.mjs "<上面的文件路径>" "Experience Loop"
```

这条命令还能回答"插件**以前**是否真的加载过"（§7）。

⚠️ **关键字搜索会同时命中你和用户自己的对话正文**（`[已实测]`：写这份手册的会话里 `"## Experience Loop"` 命中 22 条，绝大多数是工具调用参数里的文本，不是 `system/message`）。
所以**必须看命中行前面的类型标记**：只有 `--- system/message seq=… ---` 才是证据；出现在 `assistant/message`、`tool/call`、`user/message` 里都不算。

### 5.5 回报模板（直接复制填写）

```markdown
### 症状
- dsh 重启后：[起不来 / 起来了但插件无效 / 起来了但对话报错]
- 报错首次出现时间：
- 是否已执行 R0（禁用插件行）：[是/否]；R0 之后 dsh：[能起/仍不能起]

### 复现步骤
1. ...
2. ...

### 启动日志（全文粘贴，含 stderr）
```
<粘贴 dsh-boot.log>
```

### 组合校验输出
```
<粘贴 node tools/validate-profile-row.mjs 的完整输出>
```

### 静态自检
- `node tools/run-tests.mjs`：[通过 x/y]
- 语法检查：[全部通过 / 下列文件失败：...]

### patch 文件
```
<粘贴 cordis.patch.yml 全文>
```

### 已尝试的动作与结果
| 动作 | 结果 |
|---|---|
| R0 disable | ... |
| R1 remove | ... |
| R2 恢复备份 | ... |

### 期望 vs 实际
- 期望：插件加载后，工具列表出现 `experience_review` / `experience_query`，system prompt 出现 `## Experience Loop`
- 实际：...

### 环境
dsh=0.1.5-rc.1  node=v24.11.1  pnpm=12.4.1
```

---

## 6. 常见启动错误 → 含义 → 处理

`[源码]` 标记的字符串来自加载器源码（`@deepseek-ai/dsh-app-boot`、`cordis-plugin-loader`）及其报告，未逐字复现。

| 启动输出里看到什么 | 含义 | 处理 |
|---|---|---|
| YAML 解析异常 / `loadOptionalPatches` 抛错 | patch 文件语法坏了（缩进、引号、`!!js`） | R2 恢复备份；或修好后用 `validate-profile-row.mjs --file` 先验再装 |
| `patch: entry "experience-loop" not found` `[源码]` | 写成了扁平的 `- id: experience-loop` 顶层条目，而插件行必须放在 `insert:` 列表里 | 改成 `- insert:` 形式（见 §1 原文） |
| `Cannot find module ... dsh-experience-loop\index.mjs` / `ERR_MODULE_NOT_FOUND` | 插件目录被移动或删除 | 确认 `<repo>\dsh-experience-loop\index.mjs` 存在；否则 R1 删行 |
| `ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'd:'` `[已实测]` | 绝对路径**没有**被锚成 `file://`，通常意味着这条行写在了不会被锚定的位置（例如 `cordis.yml`） | 必须写在 `cordis.patch.yml` 的 `insert:` 里 |
| `experience-loop: pending (waiting for service(s): X)` `[源码]` | 插件 `inject` 的某个服务在当前组合里不存在 | 记下 X 交回。插件声明的 inject 列表：`agents, sessions, tools, commands, systemPrompt, skills`。临时解法是 R0 |
| `experience-loop: tool "<name>" registration failed: ...` | 工具名冲突或 schema 不被支持。插件内部 try/catch 捕获，**会继续运行但少一个工具** | 把该行日志交回；插件当前注册 `experience_review`、`experience_query` 两个工具 |
| `experience-loop: command registration failed` / `prompt section registration failed` / `skill provider registration failed` | 同上，缺一个能力但插件仍加载 | 同上 |
| dsh 起来了，但一发消息就报错 | 可能是 `agent/pre-step` hook。插件对检索、episode 采集、flush **都有 try/catch**，理论上不应抛出 | 把 stderr + 会话日志一起交回，并先 R0 恢复可用性 |
| 数据目录里 JSON 坏了 | **不会**导致启动失败 `[已实测]`：读到坏文件时降级为该 scope 的空视图并打一条 warn | 如需重置，改名保留而不是删除 |

---

## 7. 如何确认插件"真的加载了"

三条硬证据，缺一不可：

1. 会话日志里**最新的** `system/message` 事件包含 `## Experience Loop`
2. 会话日志里**最新的** `request/header` 事件的 `tools` 数组包含 `experience_review`、`experience_query`
3. 第一次写入后 `%DSH_HOME%\experience-loop` 目录出现

检查 1、2：

```powershell
node tools/read-session-log.mjs "<会话日志路径>" "Experience Loop"
# 或者一条命令汇总全部：store 计数、各会话的提示词段/工具/注入，以及「修复是否生效」判别
node tools/status.mjs
```

（再次提醒：关键字会命中对话正文，**只认 `--- system/message ... ---` 抬头的命中**。）

⚠️ **还有一个更容易踩的陷阱** `[已实测]`：`request/header` 与 `system/message` **只在内容变化时才追加**。
重启之后如果工具集与提示词渲染没有变化，**这两个事件的"最新一条"仍然是重启前的那条**——看到 PRESENT 可能只是历史痕迹。
（实测：本机重启后最新的 `system/message` 仍是重启前那条，seq 644。）
真正有区分力的证据是：**直接调用插件工具并拿到结果**，以及**找一个只有新代码才能通过的调用**。

**反例（都不构成证明）**：进程退出码 0；"没有报错"；`--dump-config` 成功；插件目录存在；**"某个关键字在日志里出现过"**——这最后一条正是本次开发中真实发生过的误判：当时用"上下文里没出现注入块"推断"配置没送达插件"，但那个观察在两种假设下都成立，因此不具区分力。**要断言某个机制失败，先找出两种假设下取值不同的观察。**

一次成功加载的基线 `[已实测]`：

```
system/message 字符数   7124 → 8661   （新增段含 "## Experience Loop"）
request/header tools     50 → 52      （新增 experience_query、experience_review）
```

---

## 8. 重启后的验收探针（本次有 5 个修复等待生效）

磁盘上的代码比**当前运行中的实例**新。重启的目的就是让这 5 个修复生效。

**判别探针**：调用 `experience_review`，payload 里带一个指向**已存在**记录的 `supersedes` 字段。

- 旧代码（当前运行中的）：宿主会拒绝回包，报
  ```
  Error: tool "experience_review" returned invalid output: missing required property "value.superseded[0].type";
  missing required property "value.superseded[0].scope"; "value.superseded[0].by" is not a declared property
  (additionalProperties: false)
  ```
  ⚠️ **注意：写入其实已经落库**，只是回包被拒。重试前先查状态，否则会造重复记录。
- 新代码：正常返回，输出里出现 `Superseded:` 一行。

辅助探针：`experience_query {action:"stats"}` 的 `Injections` 在长请求下应开始增长（旧代码因相关性算法缺陷会一直是 0）。

### 待生效的 5 个修复

| 文件 | 修复内容 |
|---|---|
| `lib/rank.mjs` | 相关性改为"重叠词数的饱和函数"。旧算法用 query coverage，长任务提示词会被整体过滤 → **永不注入** |
| `lib/surface.mjs` | `superseded` 输出 schema 与运行时实际产出的值对齐（就是上面那个报错） |
| `lib/review.mjs` | 复盘发生在回合**内部**时，回合结束时补上"证据 ↔ 记录"关联（旧代码此处永远关联不上） |
| `lib/retrieve.mjs` | `extractAsk` 额外接受 `agent-message`（子代理任务的真实来源），并排除 `catalog/snapshot/recall/instructions` 以免自我反馈 |
| `lib/util.mjs` + `lib/review.mjs` | 技能名在**词边界**截断，不再出现 `...-plugin-witho` 这种断词 |

---

## 9. 给接手 agent 的硬约束

1. **不要编辑 `cordis.yml`** —— `prepareProfile` 每次启动都把它重写成 `[]`，它只是给 Loader 提供 `baseUrl` 锚点。
2. **不要在 dsh 运行中手改** `%DSH_HOME%\experience-loop\*.json` —— 插件内存里有缓存，下一次 flush 会整份覆盖你的编辑。要手改先停 dsh。
3. **写工作区之外的路径需要一次性 `danger-full-access` 批准**（工作区是 `<repo>`）。
4. **不要用 `node --test test/`** —— 沙箱下它会 `spawn EPERM`（跑测试的进程需要管道 stdio）。用 `node tools/run-tests.mjs`，它在**同一个进程**里跑完全部 48 个测试。
5. **插件刻意不 import 任何 `@deepseek-ai/*` 包** —— 所以"peer 依赖解析失败"不是这里的失败原因。看到模块找不到，查的是插件自己的相对路径。
6. **模块热重载无效** `[已实测]`：启用 `hmr` 行并把所有模块就地重写，运行时**依然**执行旧代码。不要在"热重载"上浪费时间，直接重启。
7. **本会话无法执行重启** —— 正在为 Web GUI 提供服务的进程就是被重启的那个；重启需要人来操作。

### 可用的现成工具（都在 `dsh-experience-loop\tools\`，都不需要 dsh 在跑）

| 命令 | 用途 |
|---|---|
| `node tools/validate-profile-row.mjs [--file <候选>] [--id <行>]` | 用 harness 自己的解析器校验 patch 组合；替代会 EPERM 的 `--dump-config` |
| `node tools/profile-row.mjs show\|disable\|enable\|remove` | 安全地改/删某一个 patch 条目，自动备份 |
| `node tools/run-tests.mjs` | 48 个测试，单进程 |
| `node tools/read-session-log.mjs <log> [关键字]` | 按魔数逐帧解 zstd 会话日志 |
| `node tools/check-retrieval.mjs --store <root> --cwd <dir> --ask '<文本>'` | 回答"为什么没有注入"：逐条打印重叠数/相关性/得分/被哪条阈值刷掉 |
| `node tools/check-retrieval.mjs --from-session <log>` | 把**真实**记录过的回合重放进检索管线 |
| `node tools/smoke.mjs` | 离线端到端演示，打印全部产物 |

---

## 附录 A：路径速查

```
profile 目录            %DSH_HOME%\profiles\web\
用户 patch 文件         %DSH_HOME%\profiles\web\cordis.patch.yml
根配置（会被重写）      %DSH_HOME%\profiles\web\cordis.yml
harness 安装            %APPDATA%\npm\node_modules\@deepseek-ai\dsh\
host 包（hoisted）      %DSH_HOME%\profiles\node_modules\@deepseek-ai\
会话日志                %DSH_HOME%\sessions\--<cwd-slug>--\<session-id>\session.v3.jsonl.zstd
插件源码                <repo>\dsh-experience-loop\
插件数据                %DSH_HOME%\experience-loop\
```

## 附录 B：本次修复过程中固化的结论（供接手时少走弯路）

1. `insert:` 行里的绝对路径会被自动锚成 `file://` URL —— 这是本地未发布插件能免安装加载的原因。`[已实测]`
2. `config:` 改动**会**到达已加载的插件（`apply()` 会用新配置重跑，实测同一进程内某配置值 25 → 7 → 25）。`[已实测]`
3. 插件**自身 `.mjs`** 的改动**不会**生效，启用 `hmr` 也不行。重启是唯一可靠手段。`[已实测]`
4. `dsh` 不写应用日志文件，日志只在启动它的终端。`[已实测]`
5. 会话日志是 zstd **多帧拼接**，单次解压只得到第一帧且不报错。`[已实测]`
6. `dsh --dump-config` 在受限沙箱下会因重写 `cordis.yml` 而 EPERM，是假错。`[已实测]`
7. 沙箱下 `node --test test/` 会 `spawn EPERM`。`[已实测]`
8. 插件读到损坏的 JSON 数据文件时降级为空视图并 warn，不会导致启动失败。`[已实测]`
