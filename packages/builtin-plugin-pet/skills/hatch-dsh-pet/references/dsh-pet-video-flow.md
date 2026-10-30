# 上游 dsh-pet 素材生成流程（逐条转述）

来源：<https://github.com/PC2005-cloud/dsh-pet>，取证 commit `d73a2bb`（`git clone --depth 1`）。
出处：`README.md:430-528`「从零生成你自己的宠物（完整流程）」、`README.md:530-534`「许可」、`README.md:195-242`「方式四：额外宠物（pet pack）」、`dsh-pet/README.md:32`（macOS 使用 mov）与 `:134`（额外宠物）。

上游仓库**没有 `skills/` 目录**：生成流程就是 `prompts/` + `scripts/` + `video/` 三件套，本文是它们的书面转述。命令与约束都以这里的出处为准，改动前回去核对原文。

## 取用上游仓库

仅从零生成且确实需要上游提示词/脚本时才获取仓库；用户已提供可用透明素材时跳过 clone 与绿幕链。`web_fetch` 在部分网络环境下会被拒（DNS 落到代理段，报 `non-public IP address`），可改用 git：

```sh
git clone --depth 1 https://github.com/PC2005-cloud/dsh-pet
```

## ① 提示词 → 源视频

用 AI 视频生成工具（如可灵、Runway、豆包等，上游素材即由豆包生成），按 `prompts/桌面宠物 10 秒动作提示词.md` 的配方，**一个动作生成一段 10 秒绿幕视频**：

- 视频比例 16:9，背景纯绿幕（`#00FF00`）
- 人物位置/大小固定（头顶 ~20% 高度、脚底 ~85% 高度）
- 动作全程在画幅内，首尾帧为标准正面站立
- 每段动画按秒分解（0-10s 各阶段动作）

生成结果按动作各存一个 mp4，放入 `video/`。

源视频为控制仓库体积**不入 git**；上游 Release 提供 `assets-videos.zip`（全部源视频压缩包，中文名 mp4，解压后放回 `video/`）。

`prompts/桌面宠物 10 秒动作提示词.md` 的结构（2702 行）：

- 开头 `## 通用前缀`：强制约束清单 —— 16:9、纯 `#00FF00` 且无阴影杂物、人物头顶≈20% / 脚底≈85% / 左右边缘≈25% 与 75%、不同视频之间大小位置完全一致、画幅任意一边 10% 安全缓冲、双脚落点恒为屏幕正中且禁止 X/Y 平移、大物件构图规则、道具「无→有→无」闭环、侧身互动只能原地轴转、**首帧与第 10 秒末帧都必须是同一张标准正面站立**、各视频绿幕色值完全一致。
- 之后每个动作一节：`## <动作名>` + `**动作概述**` + `**按秒分割画面**`（0~3s / 3~7s / 7~10s 分段）。

写本机宠物的提示词时直接复用「通用前缀」，再按目标动作改写按秒分段即可。

## ② 源视频 → 透明动画（素材链）

step02（透明视频）有两条路线，产出同一级 `step02/`，后续步骤完全一致：

```sh
cd scripts
# 路线 A（默认）：自动绿幕抠像（HSV 色相，无需人工）
python watermark_step01.py   # 水印遮罩填充 → step01/
python chroma_step02.py      # 绿幕抠像转透明 → step02/

# 路线 B（可选）：PR 手工抠像覆盖（针对含第三方物品/自动抠像效果不佳的动作）
#   1. 在 PR 里手工抠像，导出带 alpha 的透明 .mov（如 ProRes 4444 with Alpha）
#   2. 放入 pr/，文件名与动作名一致（如 吃白饭.mov）
python pr_import_step02.py   # pr/*.mov → step02/（透明 webm，覆盖该动作自动抠像结果）

# 后续步骤两条路线共用：
python normalize_step03.py   # 归一化 2160×1215 统一站立居中 → step03/
python encode_thumbs.py      # 转码 640×360 播放变体 → step04/
```

- **依赖**：Python 3 + ffmpeg + numpy + scipy（脚本自动用工作区 `.tools/` 下的 ffmpeg）。
- **上游全部动作采用路线 B**：对含第三方物品、透明边缘复杂的动作，自动 HSV 抠像易残边或误抠，手工遮罩更精细；`chroma_step02.py` 保留为自动化兜底。
- 同目录还有 `encode_preview_gifs.py`（预览 GIF）、`check_alpha.py`（alpha 自检）、`fill_nn.py`、`make_mask_black.py`、`encode_hevc_alpha.sh`、`hevc_alpha_encoder.swift`，以及 `video/watermark_mask_v5.mkv`（水印遮罩素材）。
- 中间产物 `step01~04/` 由脚本生成、不入仓库；`video/` 源视频与 `scripts/` 入库维护。

## ②.5 macOS / Safari 的 HEVC-alpha mov

插件默认只发布 `.webm`（VP9-alpha），Safari/WKWebView 不认 webm alpha（黑底），macOS 需要官方转码的 **HEVC-with-Alpha `.mov`**：

1. 下载 <https://github.com/PC2005-cloud/dsh-pet/releases/tag/assets-mov>（固定 tag，zip 解压后文件名与 webm 一一对应）。
2. 放进 `$DSH_HOME/dsh-pet/main-animation/mov/`（pet pack 宠物则是 `pet/<种类名>-animation/mov/`）。
3. 搜 `ANIMATION_EXT`，把 `.webm` 改成 `.mov`：npm 包改产物 `lib/client.js`（桌面端还需 `runtime/electron-helper/shared-core.js`），自构建改源码 `src/shared/constants.ts` 后重建。

宿主路由已固定双扩展名兜底（白名单 `webm|mov`、MIME、素材根按扩展名分派），无需改宿主。

**本机 Pets 视频包也有这个平台限制**：有原生 HEVC-alpha MOV 才填写 `macUriPath` 与 `ext.mac: "mov"`；ProRes 4444 alpha MOV 只是归档/转码源，不是 WKWebView 播放格式。Windows 不能产出原生 HEVC-alpha 时明示，不用普通 HEVC 冒充。没有可播文件就省略 `macUriPath`，明确本包不支持 macOS；只有用户明确选 Codex 时，PNG/WebP 图集分支不涉及视频解码。上面修改 ANIMATION_EXT 的步骤属于上游插件安装，不适用于本机视频包，也不是授权修改安装文件。

## ③ 动画 → 插件（上游落点）

```sh
# 把 step04 的播放变体同步进插件包（webm 直接 cp）
cp step04/*.webm dsh-pet/assets/webm/   # 播放格式（VP9-alpha）

# 本地安装插件（--profile 填实际在用的：桌面应用 desktop、dsh web → web）
dsh plugin --profile desktop add file:D:/path/to/dsh-pet/dsh-pet
```

发布：单一 npm 包、单一素材格式（webm），`npm publish --tag latest` 触发 `prepare.js`（构建产物 + 收敛 `files`：lib / src / assets/webm / runtime/electron-helper / assets/fonts / assets/pic / assets/config.jsonc / scripts/ensure-electron.mjs / cordis.patch.yml）。

**本机 `dsh-tauri-pet` 不用这条插件安装流程**：将完整透明 WebM、实际方形 GIF 与配置整理为 `<DSH_HOME>/pets/<petId>/` 的 `kind: "dsh"` 视频包，见 SKILL.md。不要为了导入已有透明素材构建或重新安装上游插件。

## 上游的另一种宠物：pet pack（方式四）

上游插件支持在 `$DSH_HOME/dsh-pet/` 下自建素材目录来添加新「种类」（`README.md:195-242`）：

```
$DSH_HOME/dsh-pet/
├── main-config.jsonc            # 主配置（用户层覆盖项）
├── main-animation/webm/*.webm   # 主体动画
├── pet/<种类名>-config.json     # 一个文件定义一个种类（动画池 + 素材目录）
└── pet/<种类名>-animation/*.webm
```

- 扁平命名前缀配对（`<种类名>-config.json` ↔ `<种类名>-animation/`），自动扫描，设置页不列出文件宠物。
- 一个 `-config.json` 的 `pets[]` 可含多个实例；`animations`（`idle`/`turn`/`drag`/`clicks`/`moves`/`categories`/`events`）与 `animationWeights` 必须写全，素材地址形如 `/thumb/<前缀>/<名>.webm`，缺文件即 404；与 `main-animation` 严格隔离，配置出错会被告警并跳过。
- `events.workStatus` 是 6 档数组（0 thinking / 1 working / 2 result / 3 waiting / 4 success / 5 error），**勿在中间插档**。

本机 `dsh-tauri-pet` **不消费这套目录**，不要把它当作本机宠物的落点。

## 上游动作名对照（`dsh-pet/assets/config.jsonc`，供映射参考）

| 池 | 键 / 索引 | 动作名 |
| --- | --- | --- |
| 待机 | `animations.idle` | `待机呼吸休闲` |
| 转向 | `animations.turn` | `东张西望` |
| 拖拽 | `animations.drag` | `被鼠标拖拽悬空反馈` |
| 点击回应 | `animations.clicks` | `点击回应-开心跃动`、`点击回应-害羞惊讶`、`点击回应-傲娇生气`、`点击回应-挠痒咯咯笑`、`点击回应-元气挥手` |
| 移动 | `animations.moves.actions` | `螃蟹走路`、`原地漂浮踏步`、`原地左转奔跑` |
| 随机小动作 | `animations.categories[]` | 「小动作 / 玩耍 / 吃什么 / 时节 / 文字」五类共 100+ 个（`写代码`、`摇扇纳凉`、`鲸鱼吐泡泡特效`…） |
| 工作状态 | `events.workStatus[0..5]` | `工作状态-思考冒泡`、`工作状态-忙碌点按`、`工作状态-清点归档`、`工作状态-原地踱步张望`、`工作状态-雀跃庆祝`、`工作状态-垂头叹气冒汗` |
| 余额 | `events.balance[0..5]` | `余额-钱袋满溢`、`余额-金袋叮当`、`余额-钱袋如常`、`余额-数金皱眉`、`余额-袋空如洗`、`余额-分文不剩` |
| 碎碎念 | `events.whisper[]` | `碎碎念-擦桌碎碎念`、`碎碎念-发呆碎碎念`、`碎碎念-对屏碎碎念` |

本机 Pets 视频包可复用传统 animations 池或 motions 映射，只保留实际提供的动作引用；静态待机视频也可用，鼠标方向不同不切换待机。只有明确选择 Codex 图集时才受固定动作行限制。

## 上游项目结构

```
├── prompts/           # ① 动画生成提示词配方（绿幕规范 + 按秒分解）
├── video/             # ② 素材源视频（绿幕 mp4；不入库，Releases 提供压缩包）
├── scripts/           # ② 素材生成链（Python/ffmpeg：水印 → 抠像 → 归一化 → 转码 → GIF 预览）
├── step01~04/         # ② 素材链中间产物（不入库）
├── pr/  prproj/       # ② 路线 B：PR 手工抠像输入与工程（本地工作数据，不入库）
├── tools/             # 开发小工具（素材链各阶段预览等）
├── assets/            # 仓库展示用截图
├── .github/workflows/ # CI：Safari/HEVC 转码流水线（macOS runner，手动触发 → 发布 assets-mov）
└── dsh-pet/           # ③ 插件（可独立 npm 发布）
```

## 许可

- 代码：MIT
- 素材（动画 / 提示词 / 源视频）：允许开源使用，**禁止商用**
- **二次创作约定**：基于上游的衍生 / 改版 / 换皮作品，在**任何介绍、展示、分发该作品的地方**，须附上原作者 GitHub 地址 <https://github.com/PC2005-cloud/dsh-pet>
