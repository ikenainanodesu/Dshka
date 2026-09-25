# dsh-experience-loop

[English](README.md) · **简体中文** · [返回 DSHKA](../README.zh-CN.md)

面向 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) 的本地经验循环插件。

**执行 → 验证 → 复盘 → 提炼 → 复用 → 修订。**

将经过复盘的经验沉淀为可检查的记录，在相关任务开始前限额检索，并通过宿主技能目录提供可复用流程。目标是减少重复排查；效率提升**并非已经证明的结果**。这是检索与记录维护机制，不是模型训练。

## 安装到 DSH 配置档

DSHKA 是本插件的项目名，不是额外的安装器。需要兼容的 DeepSeek Harness 和 **Node.js `^22.19.0 || >=24`**。插件只使用 Node 内置模块，无运行时包依赖。

优先使用官方安装命令：

```sh
dsh plugin --profile web add github:ikenainanodesu/Dshka
```

本地源码可在仓库根目录运行 `dsh plugin --profile web add .`。根包导出当前目录中的实现，并声明其 bundle patch；子目录包仅为兼容旧的本地目录安装而保留。安装后重启目标配置档，再检查工具是否可用。

### 手工源码加载（仅供开发）

手工 `insert` 与 bundle 安装请择一，不要重复加载同一插件。切换到官方 bundle 安装时，应先备份并移除旧的手工行。

1. 克隆仓库，并保留 `dsh-experience-loop/` 子目录。
2. 备份 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（`DSH_HOME` 默认为 `$HOME/.dsh`），追加以下配置，将示例改成本机检出目录的**绝对路径**：

   ```yaml
   - insert:
       - id: experience-loop
         name: 'C:\work\Dshka\dsh-experience-loop\index.mjs'
         config:
           exposeSkills: all
           maxExposedSkills: 40
           candidateDescriptionChars: 160
           observeOutcomes: true
   ```

   类 Unix 系统可使用 `/path/to/Dshka/dsh-experience-loop/index.mjs`。实际配置中不要保留占位符。
3. 重启 DSH。配置重载与源码模块重载是不同机制，不能假定保存 `.mjs` 文件就会激活新代码。
4. 在新回合确认 `experience_query`、`experience_review` 可用，且 `/experience stats` 能响应。启动无错误、目录存在或退出码为 0，都不足以证明当前插件已经生效。

以下旧的子目录安装路径仍兼容同一个插件，但新安装建议使用仓库根目录：

```sh
dsh plugin --profile web add <checkout>/dsh-experience-loop
```

两种安装方式择一。卸载时移除相应 `insert` 行，或执行 `dsh plugin --profile web remove dsh-experience-loop`，再重载／重启配置档；已有存储不会随卸载删除。

## 存储什么

| 记录类型 | 用途 |
|---|---|
| **Memory · 记忆**（`memory`） | 关于用户、环境或项目的稳定事实。 |
| **Skill · 技能**（`skill`） | 可复用的操作流程、前置条件、检查与恢复步骤。 |
| **Failure · 失败经验**（`failure`） | 失败的方法、原因，以及避免再次失败的办法。 |
| **Validation · 验证方法**（`validation`） | 证明任务真正成功的可观察证据，而非只看进程退出码。 |

记录分为全局和项目作用域，状态为 `candidate`（候选）、`verified`（已验证）或 `deprecated`（已弃用）。复盘支持合并、取代旧记录及标记冲突；独立回合日志仅记录过程证据，不会自动变成经验。

## 有边界的复用

- 检索综合关键词相关性、环境兼容性、置信度、时效性和可靠性；已知平台或 shell 不匹配时会过滤记录。
- 默认每次最多 **4 条记录**、整个注入块最多 **1,800 字符**、**1 回合冷却期**、每个会话最多 **60 次注入**。默认不向子代理注入。
- 优先检索当前请求；没有命中时，才使用所选选项或上一条助手回复补充上下文，不用短输入长度阈值猜测语义。
- 技能正文按需加载。默认候选和已验证技能都可展示，已弃用技能不展示。
- 候选描述带 **`[candidate - unproven]`**，默认 **160 字符预算包含该标记**；默认最多展示 **40 个技能**，先按已验证状态、再按置信度排序。这与检索块的预算相互独立；目录条目本身也占上下文。

可用 `exposeSkills: verified` 或 `none` 收紧可见性。被隐藏或超出数量上限的技能，可能无法通过常规技能查询加载。完整配置项和实现细节见 [英文指南](README.md#configuration)。

## 复盘与检查

- **`experience_query`**：搜索、列出和查看记录；查询统计、冲突、待复盘回合、审计及重复任务指标。
- **`experience_review`**：任务接近结束时提炼持久经验。用 `mergeInto` 改进已有记录，用 `outcomes` 报告成功／失败证据；需要替换列表时使用 `replaceLists: true`。不要存凭据、原始对话或猜测。
- **`/experience`**：供用户检查、置顶、验证、弃用、删除、导出和导入记录。

```text
/experience search <topic>
/experience show <record-id>
/experience pending
/experience conflicts
/experience audit
/experience metric
/experience help
```

### 自动评分只是启发式判断

`observeOutcomes: true` 为默认设置。当前实现将回合结束状态归因到该回合加载过的经验技能：

| 信号 | 当前处理 |
|---|---|
| 技能已加载，回合以 `completed` 结束 | 记为成功，可能提升记录状态。 |
| 技能已加载，回合以 `error` 结束 | 记为失败，可能降低置信度或弃用记录。 |
| 回合以 `aborted`、`interrupted`、`blocked` 或 `max-tokens` 结束 | 不计成功／失败。 |
| 记录仅出现在检索注入块中 | 仅增加展示计数，不计成功／失败。 |

**加载技能后完成回合，不代表技能有帮助或结果正确。基础设施失败可能被错误归因到技能。** `verified` 是生命周期标签，不是质量保证。应优先依靠针对任务的检查与明确证据。

设置 **`observeOutcomes: false`** 可关闭自动结果评分，也会关闭**展示记录账本（surface ledger）**；显式复盘结果仍可使用。

## 隐私边界

- 默认存储为 `$DSH_HOME/experience-loop`；未设置 `DSH_HOME` 时为 `$HOME/.dsh/experience-loop`。可用 `storeRoot` 覆盖。记录、回合证据、审计和生成的 Markdown 是本地文件，**不是加密保险库**。
- 插件自身不调用模型，但检索内容与技能正文会进入宿主模型上下文，可能发送到配置的模型服务商。
- 基于模式的脱敏**不保证匿名化或完整移除凭据**。路径、项目名、请求内容和元数据仍可能敏感；共享前检查存储与导出内容，不要用真实秘密测试脱敏。
- 经验库、会话日志、导出、凭据和本地配置档不应纳入版本控制。忽略规则不能清除已跟踪文件或 Git 历史。
- 经验仅供参考，不授予权限，不覆盖用户请求，不绕过沙箱或审批。

## 测试与局限

在仓库根目录执行：

```sh
node dsh-experience-loop/tools/run-tests.mjs
node dsh-experience-loop/tools/smoke.mjs
```

测试入口在单进程中导入测试集；冒烟演示使用真实插件入口和**模拟宿主**，不调用模型、不联网。两者不能替代实际 DSH 配置档中的集成检查。可用 `DSH_TEST_TMP` 指定测试临时目录。

关键词检索可能漏掉不同措辞的同类问题。重复记录和未解决冲突需要维护；经验提炼依赖代理调用复盘工具，没有后台模型整理器或跨机器同步。技能目录即使没有加载正文，也有上下文成本。

`/experience metric` 比较可比重复请求的工具调用次数，需要足够重复数据。它是观察性诊断，**不是受控基准、因果证明或回答质量提升的证据**。

---

[完整配置与实现说明](README.md) · [重启恢复指南](../docs/DSH-restart-recovery.zh.md) · [返回仓库总览](../README.zh-CN.md)
