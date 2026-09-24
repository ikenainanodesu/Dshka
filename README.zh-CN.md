# DSHKA

[English](README.md) | **简体中文**

面向 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) 的本地经验循环插件。将经过复盘的经验沉淀为可复用、可检查的记录，而不是把每次工具调用都当成知识。

**执行 → 验证 → 复盘 → 提炼 → 复用 → 修订。**

目标是减少重复排查、避免重蹈覆辙。效率提升是目标，**并非已经证明的结果**。这是检索与记录维护机制，不是模型训练。

## 存储什么

| 记录类型 | 用途 |
|---|---|
| **Memory · 记忆**（`memory`） | 关于用户、环境或项目的稳定事实。 |
| **Skill · 技能**（`skill`） | 可复用的操作流程、前置条件、检查及恢复步骤。 |
| **Failure · 失败经验**（`failure`） | 失败的方法、原因，以及避免再次失败的办法。 |
| **Validation · 验证方法**（`validation`） | 证明任务真正成功的可观察证据，而非仅凭进程正常退出。 |

记录分为全局或项目作用域，状态为 `candidate`（候选）、`verified`（已验证）或 `deprecated`（已弃用）。复盘支持合并、取代旧记录及标记冲突；独立的回合日志记录过程证据，不会自动变成经验。

## 有边界的复用

- 检索综合关键词相关性、环境兼容性、置信度、时效性和可靠性；已知平台或 shell 不匹配时会过滤记录。
- 默认每次最多注入 **4 条记录**，整个注入块最多 **1,800 字符**，有 **1 回合冷却期**，每个会话最多 **60 次注入**。默认不向子代理注入。
- 优先按当前请求检索；没有命中时，才尝试用所选选项或上一条助手回复补充上下文。
- 学到的技能接入宿主的常规技能目录，正文按需加载。默认候选和已验证技能均可展示，已弃用技能不展示。
- 候选描述带有 **`[candidate - unproven]`** 标记，默认 **160 字符描述预算包含该标记**。目录默认最多 **40 个技能**，先按已验证状态、再按置信度排序。目录预算与检索注入预算相互独立；目录条目本身也占用上下文。

可用 `exposeSkills: verified` 或 `none` 收紧目录可见性。被隐藏或被数量上限排除的候选技能，可能无法通过模型的常规技能查询加载。

## 安装到 DSH 配置档

需要已安装兼容的 DeepSeek Harness，以及插件 `package.json` 声明的 **Node.js `^22.19.0 || >=24`**。插件仅使用 Node 内置模块，无运行时包依赖，不需要安装依赖。

1. 将仓库克隆到 `<checkout>`。
2. 备份 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（`DSH_HOME` 默认为 `$HOME/.dsh`），追加以下配置，并将示例替换为检出目录的**绝对路径**：

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

   类 Unix 系统可使用 `/path/to/Dshka/dsh-experience-loop/index.mjs` 这样的绝对路径。实际配置中不要保留 `<checkout>` 等占位符。
3. 按宿主配置重新加载或重启配置档。不要假定保存插件源码就会重载运行中的模块；要可靠地启用源码变更，请重启 DSH。
4. 在新回合中确认 `experience_query`、`experience_review` 可用，且 `/experience stats` 能响应。复盘写入后检查存储文件。启动没有报错，并不足以证明插件已生效。

卸载时删除插入的配置行，再重新加载或重启配置档。已存数据不会随卸载删除，需要另行明确移除。

## 复盘与检查

- **`experience_query`**：搜索、列出及查看记录；查询统计、冲突、待复盘回合、审计记录和重复任务指标。
- **`experience_review`**：在任务接近结束时进行一次持久经验提炼。用 `mergeInto` 改进已有记录，用 `outcomes` 报告成功或失败证据。不要保存凭据、原始对话或猜测。
- **`/experience`**：供用户检查、置顶、验证、弃用、删除、导出及导入记录的控制命令。

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
| 回合以 `aborted`、`interrupted`、`blocked` 或 `max-tokens` 结束 | 不计成功或失败。 |
| 记录仅出现在检索注入块中 | 仅增加展示计数，不计成功或失败。 |

**加载技能后完成回合，不代表技能有帮助，也不代表结果正确。基础设施故障可能被错误归因到技能。** `verified` 是生命周期标签，不是质量保证。应优先依靠针对任务的检查和明确证据。

如需关闭自动结果评分，设置 **`observeOutcomes: false`**。这也会关闭**展示记录账本（surface ledger）**，并非只关闭成功／失败归因；仍可通过复盘显式报告结果。

## 本地测试

在仓库根目录运行：

```sh
cd dsh-experience-loop
node tools/run-tests.mjs
node tools/smoke.mjs
```

测试入口在单进程中导入测试集，避免为每个文件创建子进程。冒烟演示使用真实插件入口和**模拟宿主**，不调用模型、不联网。两者都不能替代在实际 DSH 配置档中的集成检查。可用 `DSH_TEST_TMP` 指定测试临时目录。

## 隐私边界

- 默认存储位置为 `$DSH_HOME/experience-loop`；未设置 `DSH_HOME` 时为 `$HOME/.dsh/experience-loop`。可通过 `storeRoot` 覆盖。记录、回合证据、审计数据及生成的 Markdown 都是本地文件，**不是加密保险库**。
- 插件自身不调用模型，但检索记录和技能正文会进入宿主的模型上下文，可能被发送到宿主配置的模型服务商。
- 基于模式的秘密信息脱敏可以降低意外暴露风险，**不保证匿名化或完整移除所有凭据**。路径、项目名、请求文本和元数据仍可能敏感。共享前应检查存储及导出内容；不要把真实秘密输入脱敏演示。
- 不要将经验库、会话日志、导出数据、凭据和本地配置档纳入版本控制。忽略规则不会清除已跟踪文件或 Git 历史。
- 经验仅是参考数据，不授予权限，不覆盖当前用户请求，也不能绕过沙箱或审批边界。

## 局限

关键词检索可能漏掉不同措辞表达的同类问题。重复记录和未解决冲突需要维护。经验提炼依赖代理调用复盘工具，没有后台模型整理器或跨设备同步机制。即使不加载技能，其目录条目仍会增加上下文开销。

`/experience metric` 比较可比重复请求的工具调用次数，需要足够的重复数据。它是观察性诊断指标，**不是受控基准、因果证明或回答质量提升的证据**。

## 仓库结构

- [`dsh-experience-loop/`](dsh-experience-loop/)：插件入口、源码、测试和运维工具。
- [`dsh-experience-loop/README.md`](dsh-experience-loop/README.md)：详细配置及实现说明。
- [`docs/`](docs/)：运维指南。
