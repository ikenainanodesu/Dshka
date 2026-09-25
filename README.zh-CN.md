<p align="center">
  <a href="assets/logo/logo.png"><img src="assets/logo/logo-waist.png" alt="DSHKA 吉祥物：DeepSeek 鲸鱼娘腰像" width="420"></a>
</p>
<h1 align="center">DSHKA</h1>
<p align="center"><strong>让每次任务，留下值得复用的经验。</strong></p>
<p align="center">面向 <a href="https://deepseek-harness.github.io/deepseek-harness/develop/basic/">DeepSeek Harness</a> 的 <code>dsh-experience-loop</code> 经验循环插件。</p>
<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong><br>
  <a href="#功能">功能</a> · <a href="#安装">安装</a> · <a href="dsh-experience-loop/README.zh-CN.md">配置说明</a> · <a href="#开发">开发</a>
</p>

---

**执行 → 验证 → 复盘 → 提炼 → 复用 → 修订。**

DSHKA 只做一件事：将任务中经过复盘的经验沉淀为本地、可检查的记录，在后续工作中检索和复用。**DSHKA 是项目名，`dsh-experience-loop` 是插件／包名。** 它不是插件管理器，也不替代 DSH 的安装命令。

## 功能

| 能力 | 用途 |
|---|---|
| **记住稳定事实** | 保存有关用户、环境或项目的持久信息。 |
| **复用操作技能** | 将经过复盘的流程接入宿主原生技能目录。 |
| **避免重复踩坑** | 记录失败的方法、原因与恢复措施。 |
| **验证真实结果** | 保留任务确实成功的证据，而非只看退出码。 |

记录分为全局和项目作用域，生命周期为 `candidate`（候选）、`verified`（已验证）、`deprecated`（已弃用）。支持合并、取代和标记冲突。原始回合证据另行记录，不会自动变成经验。

## 安装

需要兼容的 **DeepSeek Harness** 和 **Node.js `^22.19.0 || >=24`**，插件无运行时包依赖。

直接使用 DSH 官方插件命令：

```sh
dsh plugin --profile web add github:ikenainanodesu/Dshka
```

将 `web` 替换为你的配置档名称。仓库根目录声明了 DSH bundle，无需额外安装器，也不要求先发布到 npm。

### 从本地源码安装

```sh
git clone https://github.com/ikenainanodesu/Dshka.git
cd Dshka
dsh plugin --profile web add .
```

如果此前通过手工 `insert` 行加载本插件，切换到 bundle 安装时请先备份配置档 patch，再移除旧行，避免重复加载。实现目录没有移动，旧的绝对路径引用仍然有效。

### 验证与卸载

重启目标 DSH 配置档，在新回合确认 `experience_query`、`experience_review` 可用，并检查：

```text
/experience stats
```

包管理器正常退出不等于插件已经加载。卸载命令：

```sh
dsh plugin --profile web remove dsh-experience-loop
```

已有经验不会随卸载删除，主动清理前请先备份。

## 如何使用

- **`experience_query`**：检索和检查经验、冲突、待复盘回合及诊断信息。
- **`experience_review`**：在任务接近结束时提炼持久经验；优先完善已有记录，而不是反复新增相同内容。
- **`/experience`**：供用户检查、置顶、验证、弃用、导出和删除记录。

```text
/experience search <topic>
/experience pending
/experience conflicts
/experience help
```

### 有边界地复用

默认每次检索最多 **4 条记录**、整个注入块最多 **1,800 字符**，有 **1 回合冷却期**，每个会话最多 **60 次注入**。默认不向子代理注入。技能接入宿主目录，候选描述带 **`[candidate - unproven]`** 标记，正文按需加载。

[配置、生命周期与诊断说明 →](dsh-experience-loop/README.zh-CN.md)

## 使用边界

- 这是**检索与记录维护，不是模型训练**。减少重复工作是目标，并非已证明的结果。
- 本地存储不是加密保险库。检索内容会进入宿主模型上下文；模式脱敏只能降低风险，不能保证完整移除秘密。
- `verified` 是生命周期标签，不代表独立验证过正确性。自动结果评分是启发式判断，可能错误归因。
- 经验始终只是参考，不能覆盖当前用户请求，不能绕过沙箱或审批。

## 开发

```sh
# 在仓库根目录执行
npm test
npm run smoke
```

冒烟演示使用模拟宿主，不是运行中的 DSH 配置档；测试无需模型或网络调用。

```text
Dshka/
├── package.json              # 可安装的 dsh-experience-loop bundle
├── README.md / README.zh-CN.md
├── assets/logo/              # 保留原图与尺寸变体，另加腰像
├── dsh-experience-loop/      # 插件实现；保留旧路径兼容性
│   ├── index.mjs             # 插件入口
│   ├── cordis.patch.yml      # Bundle 层
│   ├── lib/                  # 检索、复盘与存储
│   ├── test/                 # 测试
│   └── tools/                # 诊断工具与冒烟演示
└── docs/                     # 运维文档
```

子目录中的包描述仅为兼容已有本地目录安装而保留；两个入口加载的是**同一个插件**，不是两个产品。新安装请使用仓库根目录。

[重启恢复指南](docs/DSH-restart-recovery.zh.md) · [详细插件文档](dsh-experience-loop/README.zh-CN.md)

## 许可与素材

代码采用 [MIT](LICENSE)。页头腰像直接裁自原始大图，不重绘、不修改透明通道；点击可查看完整原图，其他尺寸资源也保留。素材单独适用其授权，原始署名来源尚不完整，代码许可不授予图片使用权，详见 [素材说明](assets/logo/README.zh-CN.md)。
