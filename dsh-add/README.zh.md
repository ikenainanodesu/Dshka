# dsh-add

[English](README.md) | **简体中文**

<img src="assets/logo/logo.png" alt="dsh-add：Q 版 DeepSeek 鲸鱼娘从几只一模一样的插件方块里选中一个" width="320">

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

`assets/logo/` 里的定稿图是 Q 版造型：`logo.png`（512px 主图）、`logo-512/256/128.png`。

- 生成走 OpenAI Codex 订阅（本项目硬规则：出图只用 Codex，本地模型不参与出图）。
- 角色为社区二创形象「DeepSeek 鲸鱼娘」，身份锚点取自本地 `PERSONA.md`；**角色设计与立绘版权属原作者**（CC-BY-NC-SA 4.0），自用可以，**商用需另行授权**。
- 头身比用 `headcount_proof.py` 实测：颅顶→脚底约 1050 px，头高约 280 px，**约 3.75 头身**。注意项目自带的自动检测器在这张图上给出 14.15 头身，是错的——该读数已弃用，改为画标定线目视核对后才得出上述数字。
- `ref-q3.png` 是用 `build_proportion_ref.py` 合成的比例权威图（左＝设计权威，右＝按头数算出的骨架），`contract-icon.txt` 是生成时用的最高优先约束。

### 透明背景版

`logo-nobg.png`（1254px）与 `logo-nobg-512/256/128.png` 是透明背景版：`remove_bg.py` 把米白画布抠掉，只留画面内容。

关键点：**不能用按颜色抠图**。这张图的围裙是 `rgb(247,243,249)`、与背景 `rgb(248,248,232)` 只差 3，肤色也贴得很近——按「离背景色多远」设阈值会把围裙和脸抠出洞。背景是**与画布边缘连通**的那一块，所以判定用洪水填充，不是颜色阈值。边缘只在切口内外几像素做半透明过渡（alpha 直方图：全透明 54.45%、部分透明 2.59%、不透明 42.97%）。

那两只虚化的插件方块**留在了透明版里**，这是实测结论而不是疏忽——它们与人物无法自动分离：

| 尝试 | 实测结果 |
|---|---|
| 连通域分析 | 方块与人物同属最大连通域（虚化边缘相接） |
| 饱和度判据 | 方块 S≈23，但围裙 S≈3、画布 S≈22，分不开 |
| alpha 判据 | 方块是「画得低对比」而非半透明，alpha 同样是 255 |
| 形态学腐蚀 20/30px | 腐蚀后仍只有 1 个连通域——腰部是宽连接而非细桥 |
| 逐行分段 | 左侧仅 385/770 行存在间隙；右侧 589 行**完全没有**间隙 |

强行按行切割会切掉头发，所以没有这么做。需要纯人物版只能重新生成一张不含方块的图。

### 水彩版（低饱和）

`logo-watercolor*.png` 是低饱和水彩风格版，三档强度：

| 文件 | 色彩保留 | 说明 |
|---|---|---|
| `logo-watercolor.png` | 100% | 模型直出的水彩原图 |
| `logo-watercolor-desat70.png` | 70% | **推荐**：饱和度明显降低，水彩冷暖层次与蓝调身份仍在 |
| `logo-watercolor-desat50.png` | 50% | 更灰更闷，慎用 |

每档都有 512/256/128 三个方形尺寸（等比缩放后居中在纸底上，不裁切、不变形）。

- 重出时把「背景不得出现任何方块/星星/粒子，只允许人物与手中那一个方块」写进了约束，所以**水彩版背景是干净的**——上一版卡住的「方块与人物焊死无法分离」在这里绕过了。
- 降饱和用保持明度的混合 `out = gray + (c − gray) × k`，不是直接压 HSV 的 S（后者会连带压亮度、显得脏）。
- 水彩的晕染、纸纹、颜料飞溅是**画出来的**，滤镜做不出来：降饱和滤镜只能降颜色，不会产生水彩质感，所以这一版是重新生成的而不是后处理。
- 方形版带纸底，**深色背景上会显示为米色方块**；需要透明版要另行去背（水彩晕染外溢，去背会损失一部分效果）。

## 许可

MIT
