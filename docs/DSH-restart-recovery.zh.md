# DSH 重启失败：恢复与证据采集手册

目标：保留数据、缩小故障范围、恢复可用性，再用可区分的证据定位原因。
本文以本地 `dsh-experience-loop` 插件和 PowerShell 为例；宿主版本、安装方式、
profile 布局及热重载行为可能不同，必须以当前环境为准。

## 1. 先确认环境与权限

不要删除数据目录，不要同时改多处配置，也不要把整个 profile 或会话日志上传。
先记录启动命令、错误摘要、近期变更和版本：

```powershell
dsh --version
node --version
pnpm --version
Get-Command dsh | Select-Object Name, Source

# 以下占位符必须替换为本机值；变量仅用于当前终端。
$repo = '<仓库检出目录>'
$profile = '<profile名称>'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles/$profile"
$patch = Join-Path $profileDir 'cordis.patch.yml'
Set-Location (Join-Path $repo 'dsh-experience-loop')
```

默认数据根目录通常是用户目录下的 `.dsh`；如果启动器另设了 `DSH_HOME`，
以启动进程实际使用的值为准。命令路径、用户名及 profile 名称也可能是敏感信息，
对外报告时替换成一致的占位符。

写 profile 通常位于仓库之外，需要相应文件权限。遵守当前沙箱与审批规则；
被拒绝时停止，不要换一种工具绕过。审批禁用的会话应由有权限的操作者另行处理。

## 2. 最小化隔离：先禁用，再考虑移除

### R0：禁用插件逻辑

先在本地检查目标条目，确认它属于要处理的插件：

```powershell
node tools/profile-row.mjs show --file "$patch"
node tools/profile-row.mjs disable --file "$patch"
node tools/validate-profile-row.mjs --profile "$profile" --dsh-home "$dshHome"
```

`disable` 写入 `config.enabled: false` 并先生成备份。
这会让插件 `apply()` 不注册工具、提示词、技能 provider 或 hooks，保留数据。
但禁用逻辑**不一定绕过模块解析或导入错误**：宿主仍可能需要加载入口文件。

记录每次修改与启动结果。正常启动只表明插件配置、插件逻辑或其交互可能参与了问题，
不能证明插件是唯一原因。仍然失败也不能排除插件：可能是导入错误、配置未生效，
或同时存在另一个故障。

### R1：移除插件所在的插入条目

确认备份和条目内容后才执行：

```powershell
node tools/profile-row.mjs remove --file "$patch"
node tools/validate-profile-row.mjs --profile "$profile" --dsh-home "$dshHome"
```

脚本按包含目标 ID 的顶层条目定位，而不是完整 YAML 语义编辑器。
**如果同一个 `insert` 块含有其他插件，移除可能连同整个块一起删除。**
先看 `show` 输出和备份；有歧义时不要强行操作。相邻注释可能保留。

写操作的备份命名形式为：
`<patch文件>.bak-before-<动作>-experience-loop-<时间戳>`。
备份同样可能包含凭据，不应提交到仓库。

### R2：恢复选定备份

整份恢复会撤销备份之后该文件的所有变化，包括与插件无关的配置。
先在本地比较差异、保存当前版本并明确授权恢复范围：

```powershell
$backup = '<确认过的备份文件路径>'
$currentCopy = '<仓库外安全目录中的当前配置副本路径>'
Copy-Item -LiteralPath "$patch" -Destination "$currentCopy"
Copy-Item -LiteralPath "$backup" -Destination "$patch" -Force
node tools/validate-profile-row.mjs --profile "$profile" --dsh-home "$dshHome"
```

不要假设某个备份必然正确，也不要把占位符原样执行。

## 3. 不启动服务的配置校验

```powershell
node tools/validate-profile-row.mjs --profile "$profile" --dsh-home "$dshHome"
node tools/validate-profile-row.mjs --profile "$profile" --dsh-home "$dshHome" --file '<候选patch文件>'
node tools/validate-profile-row.mjs --profile "$profile" --dsh-home "$dshHome" --id '<其他条目ID>'
```

该工具调用安装环境中的 `loadProfileDirectory`、`composeEntries` 等宿主解析器，
显示组合警告、生效条目、文件 URL 与目标是否存在。找不到宿主包或 API 不兼容时，
这属于校验工具的前提不满足，不等于 patch 已损坏。

本地未发布插件的示例条目：

```yaml
- insert:
    - id: experience-loop
      name: '<仓库绝对路径>/dsh-experience-loop/index.mjs'
      config:
        enabled: true
        inject:
          subagents: false
```

支持此机制的宿主会把 `insert[].name` 中绝对路径或 patch 相对路径锚定为
`file://` URL。Windows 裸盘符路径直接交给 ESM `import()` 可能失败。

不要把 `dsh --dump-config` 当作纯只读校验：某些宿主版本会重写 profile 中的
`cordis.yml`，受限环境可能产生权限错误。这类错误是权限线索，不是 YAML 错误的证明。
`cordis.yml` 在部分版本中是生成文件；先查宿主行为，不要把持久修复写进生成产物。

## 4. 启动输出与隐私保护

先确认原服务是否仍在运行，避免重复启动造成端口冲突。
需要受控重启时，由有权限的操作者协调停启；不要在承载当前 Web 会话的进程里
擅自终止服务。保持同一启动命令和环境，尽量每次只改变一个变量。

以下捕获命令写到**仓库外的安全位置**：

```powershell
$bootLog = '<仓库外安全目录>/dsh-boot.log'
dsh web --profile "$profile" *>&1 | Tee-Object -FilePath "$bootLog"
```

启动错误可能在终端、服务管理器或宿主配置的日志目标中，不能假设所有安装都不写日志。
保留原始证据在本地；对外只分享与问题相关的最小脱敏片段。

分享前手工检查并替换：

- API 密钥、令牌、Cookie、授权头、密码、连接串及带签名 URL；
- 用户名、机器名、私有项目名、绝对路径及私有服务地址；
- 会话/记录 ID、用户对话正文、业务数据和不必要的精确时间信息。

保留错误类型、调用阶段与相对事件顺序；必要时用 `T+…` 表示时间差。
自动脱敏只能辅助，不能保证覆盖所有敏感信息。
**不要直接粘贴完整 `cordis.patch.yml`、完整日志、数据目录清单或整个会话记录。**
校验工具及 `status` 的输出也可能含路径和记录正文，分享前同样检查。

## 5. 会话日志与当前运行验证

会话日志通常位于：
`<DSH_HOME>/sessions/<工作目录标识>/<session-id>/session.v3.jsonl.zstd`。
通过实际目录确认位置，不要仅凭目录命名推断。

```powershell
node tools/read-session-log.mjs '<会话日志路径>' 'Experience Loop'
node tools/status.mjs --store '<插件存储目录>' --sessions '<会话根目录>'
```

日志可能由多个独立 zstd 帧拼接；只解第一帧会漏事件。仓库工具按帧读取，
应检查解码错误和命中事件类型。关键字可能来自用户消息、工具参数或引用文字，
这些不是插件已注册的证据。

辅助线索：

- `system/message` 包含 `## Experience Loop`；
- `request/header` 的工具列表包含 `experience_review`、`experience_query`；
- 写入后出现插件存储目录。

这些线索可能属于历史进程。提示词和工具元数据只在变化时追加的日志格式，
尤其容易让“最新事件”仍指向重启之前。

在**当前会话**调用 `experience_query {action: "stats"}`，确认工具可调用；
代码更新则还需要一个安全的、能区分新旧行为的探针。优先使用只读探针或离线测试，
不要为测试而改动真实记录。如果工具报输出校验错误，写入可能已经发生，
重试前先查询状态，避免重复记录。

配置热重载不等于模块代码热重载。更新 `.mjs` 后，受控重启并执行区分探针是可靠基线；
不要把文件保存、进程退出码 0、“未报错”或历史关键字命中当作代码已激活的证明。

## 6. 常见错误与排查方向

| 现象 | 可能原因及下一步 |
|---|---|
| YAML 解析异常 | 检查缩进、引号和条目结构；先校验候选文件，再考虑恢复备份。 |
| `entry ... not found` | 更新了不存在的 ID；检查新条目是否应放在 `insert` 中。 |
| `ERR_MODULE_NOT_FOUND` | 确认入口和相对导入目标是否存在；检查安装方式与版本。 |
| `ERR_UNSUPPORTED_ESM_URL_SCHEME` | 检查 Windows 路径是否经宿主正确锚定为文件 URL。 |
| `waiting for service(s)` | 检查当前组合是否提供插件依赖的服务。插件声明 `agents, sessions, tools, commands, systemPrompt, skills`。 |
| 工具/命令/提示词/provider 注册失败 | 某项能力可能缺失但插件仍运行；保存相关错误片段，排查冲突与 API 兼容性。 |
| 启动正常，发送消息后报错 | 查看对应 hook 与原始事件顺序，隔离插件后复测；不能仅靠时间接近归因。 |
| JSON 数据损坏警告 | 插件可能降级为空视图。保留原文件与备份，停止写入后再恢复，避免空视图覆盖损坏数据。 |
| `EPERM` / access denied | 检查实际被拒绝的操作及当前权限；不要绕过限制，也不要直接认定配置语法错误。 |

## 7. 离线检查与辅助工具

从插件目录执行：

```powershell
node tools/run-tests.mjs
node --check index.mjs
```

测试结果以当次输出为准，不固定测试总数。单进程 runner 适合禁止子进程管道的沙箱；
普通 `node --test test/` 在这类环境可能失败。离线通过不代表当前宿主已加载更新。

| 工具 | 用途 |
|---|---|
| `tools/profile-row.mjs` | 查看、禁用、启用或移除条目，写入前备份 |
| `tools/validate-profile-row.mjs` | 用安装的宿主解析器校验组合，不启动服务 |
| `tools/read-session-log.mjs` | 解码会话日志并按关键字搜索 |
| `tools/check-retrieval.mjs --store <root> --cwd <dir> --ask '<文本>'` | 解释检索分数和筛选原因 |
| `tools/check-retrieval.mjs --store <root> --from-session <log>` | 离线重放已记录请求；输入和输出可能敏感 |
| `tools/smoke.mjs` | 用临时数据运行离线演示 |

不要在插件运行时手工修改它缓存的数据文件：后续 flush 可能覆盖编辑。
不要为了恢复启动删除凭据、会话或经验存储。任何清理都应另行确认范围并先备份。

## 8. 最小脱敏回报模板

```text
症状：启动失败 / 插件不可用 / 发消息失败
环境：dsh=<版本>，Node=<版本>，系统=<平台>，profile=<占位符>
启动方式：<脱敏命令>
近期变更：<相关变更摘要>
事件顺序：<相对顺序，不附私人时间线>
复现步骤：<最小步骤>

尝试与结果：
- 禁用：未执行 / 成功 / 失败；确认生效方式：...
- 移除：未执行 / 成功 / 失败；影响范围：...
- 恢复备份：未执行 / 成功 / 失败；备份占位符：...

相关错误：<最小脱敏片段，保留错误类型和阶段>
配置：<仅相关条目的脱敏片段，不贴完整 profile>
组合校验：<脱敏摘要或错误>
离线检查：<通过/失败及实际汇总>
当前会话探针：<调用与结果摘要；或明确未验证>
结论：<已观察到什么、仍不能排除什么>
隐私检查：已手工审查 / 尚未完成（未完成则不要分享材料）
```
