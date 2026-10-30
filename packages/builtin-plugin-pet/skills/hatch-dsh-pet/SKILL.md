---
name: hatch-dsh-pet
description: Create, hatch, import, replace or repair a custom desktop pet for dsh-tauri-pet. Default to a local Pets video package (pet.json, config.jsonc, transparent WebM animations and a square GIF preview), reuse supplied transparent assets, or follow the upstream green-screen generation flow when needed. Use an 8-column sprite atlas only when the user explicitly requests Codex. Validate the package and state host-version and macOS playback limitations honestly.
metadata:
  author: Hairyf
  version: "2026.10.12"
---

# Hatch DSH Pet

默认交付 **Pets 视频宠物**，不是 Codex 图集。保留完整动画时序；不要把十秒视频抽成六帧图集后声称是完整动画。只有用户明确要求 Codex 才读 `references/atlas-layout.md` 与 `references/atlas-compose.md`。

## 先确认能力与素材

1. 确认当前宿主支持本地 `kind: "dsh"` 契约。旧宿主不支持时明确报出阻塞，不能自行改成交付 Codex。修改宿主须先获用户许可；修技能本身不等于获准改宿主。
2. 清点用户已提供的透明 WebM/MOV、动作与许可。可复用的透明素材直接整理、校验和生成预览，不要无谓 clone 上游、重新生成绿幕或重复抠像。
3. 只有从零生成或绿幕抠像时才读 `references/dsh-pet-video-flow.md`；沿用其中有用的提示词、Python/ffmpeg 抠像与归一化流程。缺视频生成工具或转码能力就明示，不用生图图集冒充视频。
4. 确认落点、id 与覆盖许可。环境注入的非空 `DSH_HOME` 优先，否则发行版通常用 `~/.dsh`；调试宿主可能用 `~/.dsh.dev`，以正在运行的宿主实际数据目录为准，不猜安装盘符。

## Pets 视频包契约

宿主枚举 `<DSH_HOME>/pets/` 的直接子目录，不要再套一层。id 为 1~64 个 ASCII 字母、数字、`-`、`_`，列表限定 id 为 `chat:<id>`。

```text
<DSH_HOME>/pets/my-pet/
├── pet.json
├── config.jsonc
├── webm/
│   ├── idle.webm
│   └── working.webm
└── preview/
    └── preview.gif
```

```json
{
  "kind": "dsh",
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "透明视频桌宠；本包不支持 macOS",
  "configPath": "config.jsonc",
  "uriPath": "webm",
  "previewPath": "preview/preview.gif",
  "ext": { "default": "webm", "mac": "webm" },
  "size": 220
}
```

`size` 可省略，是大于 0 且不超过 4096 的渲染宽度，而非文件大小；视频包必须声明 `ext.default: "webm"`。`pet.json` 用严格 JSON；`config.jsonc` 为对象，允许注释与尾逗号。所有文件/目录路径为包内正斜杠相对路径，不允许绝对路径、`..`、反斜杠、冒号或符号链接越界。清单最多 64 KiB、配置 1 MiB、每个视频 512 MiB、GIF 8 MiB 且边长 1~4096 像素。清单、配置、预览与配置所引用的视频均须实际存在。

新包优先使用 `motions`，每个动作值为动作名字符串或非空字符串数组；动作名不带扩展名，宿主在 `uriPath` 下按 `ext.default` 找到视频：

```jsonc
{
  "motions": {
    "idle": "idle",
    "working": ["working"],
  }
}
```

也兼容上游传统 `animations` 池（`idle`、`turn`、`drag`、`clicks`、`moves.actions`、`categories[].actions`、`events`），不必为了导入已有素材重写整个池。只配置真实存在的动作；缺少丰富动作时可以交付一个静态待机视频，明确它不会动，而不是伪造完整动作。鼠标方向变化不应切换待机素材或触发转向；不要为了追踪鼠标把多份待机/turn 素材塞入包。

## 编码与平台支持

- Windows/Linux 播放资产：透明 **WebM VP9-alpha**，保留真实动作的完整帧与时序。仅文件后缀、容器头或 `pix_fmt` 标签不能证明 alpha 解码正确，须在目标播放器实测。
- **MOV ProRes 4444 alpha** 可以作高质量透明归档/转码源，但不是 macOS WKWebView 的 **HEVC-with-Alpha MOV** 播放替代品；不要把归档目录填入 `macUriPath`。
- 真正有 mac 可播 HEVC-alpha 文件时，添加 `macUriPath: "mov"` 与 `ext.mac: "mov"`，按相同动作名放 `mov/<动作>.mov`，并在目标 macOS 宿主验证。Windows 无法产出原生 HEVC-alpha 时直说；不要用普通 HEVC、ProRes 或改后缀冒充。
- 没有 mac 可播文件就**省略 `macUriPath`**，在包描述与交付说明明确「本包不支持 macOS」。无 mac 素材时可显式 `ext.mac: "webm"` 避免组件缺省在 WebM 目录请求 MOV，但不代表 WKWebView 能播放其透明通道；扩展名约定本身不证明可播。
- `previewPath` 必须是真正的**方形 GIF**（宽等于高），不是 PNG 改名或 16:9 视频截图。预览可裁切或补边，不改变播放视频构图；生成后检查 GIF 头尺寸和实际预览效果。

## 完成与验证

先在本地暂存目录整理，再校验；写入真实宠物目录前取得覆盖许可。运行：

```sh
node "<skill 基目录>/references/validate-pet.mjs" "<宠物目录>"
```

校验器兼容旧 Codex 清单，视频模式检查 JSONC 配置、方形 GIF、引用路径、文件存在与大小和越界。它**不是播放器**，通过仅代表静态包校验通过，不代表视频可解码、透明度已验证或 mac 可播。把真实输出与目标播放器实测结果分别报告，不混为一谈。

打开 设置 → 宠物 → Pets，确认列表、GIF 预览、选择与播放。无法显示时检查实际宿主版本、数据目录、配置引用与平台编码；不要改模式掩盖不支持，也不要擅改宿主/前端/内置资源清单。Codex `.zip` 导入走设置页 Codex 标签，不动 `~/.codex/pets`。

如果使用上游素材/提示词，遵守 `references/dsh-pet-video-flow.md` 的许可与署名约定；用户自有素材不自动套用上游许可。

本目录是**技能源码**，修改不会自动更新已安装技能。需要通过安装更新让新版本生效；未经许可不直接修改安装目录。

## 明确要求 Codex 时

使用 `pet.json` 的 `spritesheetPath` 与可选 `spriteVersionNumber: 1|2`，保留旧图集契约：8 列，v1 为 9 行、v2 为 11 行，PNG/WebP，最多 8 MiB、单边 16384 像素、总像素 64 Mi。新图集推荐 v2、1536×2288；布局与烘焙参考只适用于这个分支。转为固定帧图集会丢失视频帧数与原始时序，须明确告知，不能声称与完整视频等价。
