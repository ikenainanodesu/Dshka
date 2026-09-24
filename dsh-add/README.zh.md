# dsh-add

[English](README.md) | **简体中文**

<img src="assets/logo/logo-readme-400.png" alt="dsh-add：Q 版 DeepSeek 鲸鱼娘从几只一模一样的插件方块里选中一个" width="300">

按**名字**安装 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) 插件。

```sh
npx dsh-add dsh-engram
```

它把「社区里叫这个名字的插件」解析成可安装的 spec，交给 DSH 自己的 `dsh plugin add` 执行。**不重新实现安装**，只解决「按名字」这一步。

## 为什么需要它

DSH 已经能装插件，但你要先知道 spec：

```sh
dsh plugin --profile web add github:CAI-MH/dsh-quality-review
```

社区插件注册表（[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)，2026-09-24 实测 **4279 条**）是按**名字**索引的，而名字**不唯一**：当天实测有 **186 组重名**，其中 `dsh-memory` 一个名字对应 **10 个不同插件**（`@furongjun1999/dsh-memory`、`@max-null/dsh-memory`、`dsh-git-memory`……），`dsh-engram` 对应 2 个。照着名字猜 spec，很容易装错东西还理直气壮。

`dsh-add` 把这一步做成可检验的决策：

| 环节 | 做法 |
|---|---|
| 解析 | 名字 / npm 包名 / `owner/repo` 四路精确匹配，另有模糊匹配兜底 |
| 排序 | 精确优先，再看下载量与 star（实测数据，不是猜测） |
| 消歧 | 头名下载量 ≥ 次名 2 倍才算「证据充分」自动选；否则**列候选让你选**，绝不替你猜 |
| 安装 | 永远调 `dsh plugin --profile <p> add <spec>`，spec 取自注册表作者的 `install` 字段 |
| 验证 | 读完装前后的 profile manifest，报告**实际变了什么**，而不是只看退出码 |

## 安装

```sh
# 免安装
npx dsh-add <名字>

# 或全局安装
npm install -g dsh-add
```

要求 Node.js `>=22.19.0`。零运行时依赖，只用 Node 内置模块。

## 用法

```sh
dsh-add dsh-engram                    # 唯一精确匹配，直接装
dsh-add dsh-memory --owner FuRongJun-1999   # 10 个同名，用作者消歧
dsh-add search engram                 # 搜注册表，按下载量排序
dsh-add info dsh-memory               # 只看候选和将执行的命令，不安装
dsh-add list                          # 列出每个 profile 已装的插件
dsh-add --spec ./my-plugin            # 本地开发中的插件，按路径装
```

常用选项：

| 选项 | 说明 |
|---|---|
| `--profile <名字>` | 装到指定 profile（默认自动选，并打印理由） |
| `--owner <作者>` | 用作者消歧 |
| `--spec <spec>` | 跳过名字解析，直接装该 spec（路径 / git / npm 名） |
| `--dry-run` | 只打印将执行的命令 |
| `--allow-build` | pnpm 拦住构建脚本时，自动写 `allowBuilds` 并重试 |
| `--refresh` | 忽略缓存重新拉注册表 |
| `--json` | 机器可读输出 |

输出语言跟随 `$DSH_ADD_LANG` 或 `$LANG`，含 `zh` 时用中文。

## profile 选哪个

按顺序取第一个可用项，并**把选择理由打印出来**：

1. `--profile`
2. `$DSH_PROFILE`
3. 唯一的 profile
4. 唯一装了插件的 profile
5. `web`

第 4 条先于 `web` 这个名字：`web` 是 DSH 默认名，若优先认名字，安装会被送进一个你可能从不启动的 profile。

## 装完到底生效了没有

退出码 0 **不等于**装成功——`dsh plugin` 在 pnpm 成功后即返回 0。所以 `dsh-add` 读 profile 的 `package.json` 前后对比，并明确报告三种结果：

- **已作为 profile 层激活**（`dsh.profile.bundles` 里有它）——重启 dsh 后加载
- **只作为普通依赖**（包没声明 `dsh.bundle`）——不会成为 profile 层
- **依赖没有变化**——退出码 0 也算失败，会返回非零退出码

包名不再靠 spec 推断：验证会读 profile 的 `node_modules` 实际安装了什么，并用「安装前的依赖集合」作基线，避免把本来就装着的包算成这次的成果。

## 已知限制

- **依赖第三方注册表。** 名字到 spec 的映射来自 `awesome-dsh-plugin.com`，该站点不可用时只能用本地缓存；两者都没有则命令失败并说明原因。缓存默认 12 小时，可用 `$DSH_HOME/cache/dsh-add` 或 `$DSH_ADD_CACHE` 指定位置。
- **`stable` 判据是下载量。** 头名下载量不足次名 2 倍（或两者都没有下载数据）时不自动安装，改为询问；非交互环境下会列候选并失败，而不是猜。
- **`search` 是子串匹配**，不是语义检索，只按下载量排序。
- **`--allow-build` 是显式动作。** 它允许一个包在你的机器上执行构建脚本，所以默认不做，必须你显式加参数。自动重试需要能读取 pnpm 输出；在禁止创建管道的沙箱里无法读取，此时会提示你手动加参数重跑。
- **注册表里的非 bundle 包**装了也不会成为 profile 层，这与 DSH 自身行为一致。

## 实测记录

| 场景 | 结果 |
|---|---|
| 本地路径 `--spec D:\...\dsh-experience-loop` | 装成功，自动进入 bundles，验证报告「已作为 profile 层激活」 |
| 按名字装 GitHub 插件（沙箱外） | 装成功，自动进入 bundles |
| 沙箱内管道被禁 | 自动降级为继承终端输出，pnpm 输出完整可见 |
| git 插件构建脚本被拦 | 解析出被折行打印的 `allowBuilds` key（照抄会得到截断的 key） |
| 单元测试 | `node test/resolve.test.mjs` — 18 项全部通过 |

测试与在线验证是两件事：上表前 4 行是真实调用 `dsh plugin` 的端到端结果，最后一行只是单元测试。

## Logo 与素材

**项目 logo 是 `logo-readme.png` 系列**（低饱和水彩、四周透明渐隐，README 顶部用的就是它）：

| 文件 | 说明 |
|---|---|
| `logo-readme.png` | 主图 960×1528 |
| `logo-readme-800/400/200.png` | 等比缩放，400 是 README 实际使用的宽度 |
| `logo-readme-square-512/128.png` | 方形版（透明底居中），用于头像/包页 |

四周渐隐是为了同时适配 GitHub 的浅色与深色主题：纸底被抠成透明（只抠**与画布边缘连通**的纸色区域，水彩飞溅与晕染都保留），再在四周 9% 的范围做 alpha 渐隐，让画面化进页面背景而不是贴一个矩形。实测：全透明 52.2%、部分透明 4.9%、不透明 42.9%，两种主题下均无硬边。

**四周渐隐不能用距离变换实现**：画面内部的浅色区域（围裙、肤色）会被误判成纸，距离场于是测的是"到这些内部洞的距离"，把人物大片压成半透明（实测部分透明高达 26.2%）。改用坐标渐隐后降到 4.9%。

### 其它版本（保留备选）

`assets/logo/` 下还有生成过程中的几版，均可作为备选：

- **`logo-watercolor-desat70.png`**：本项目 logo 的来源图（水彩 + 降一档饱和），带纸底。
- `logo-watercolor.png`：水彩原图，未降饱和。
- `logo-nobg*.png`：旧版（赛璐璐风）的透明背景版，**背景里那两只虚化方块仍在**——它们与人物焊死，无法分离。
- `logo.png`：最初的赛璐璐风主图。

生成与处理脚本：`contract-watercolor.txt`（水彩版约束）、`remove_bg.py`（去背）、`fade_edges.py`（四周渐隐）、`headcount_proof.py`（头身比标定）、`finalize_logo.py`（缩放）。

- 生成走 OpenAI Codex 订阅（本项目硬规则：出图只用 Codex，本地模型不参与出图）。
- 角色为社区二创形象「DeepSeek 鲸鱼娘」，身份锚点取自本地 `PERSONA.md`；**角色设计与立绘版权属原作者**（CC-BY-NC-SA 4.0），自用可以，**商用需另行授权**。
- 头身比用 `headcount_proof.py` 实测：颅顶→脚底约 1050 px，头高约 280 px，**约 3.75 头身**。注意项目自带的自动检测器在这张图上给出 14.15 头身，是错的——该读数已弃用，改为画标定线目视核对后才得出上述数字。
- `ref-q3.png` 是用 `build_proportion_ref.py` 合成的比例权威图（左＝设计权威，右＝按头数算出的骨架）。

## 许可

MIT
