# 桌宠趣味窗口互动

Windows 设置中开启趣味互动后，桌宠会靠近最近的可用窗口边缘，并按概率执行互动。挤压与拉伸、移动窗口可以分别关闭。功能默认关闭，关闭或手动抓取桌宠会中止当前互动。

只选择当前显示器工作区内完整可见的普通窗口；排除 DSH 自身、最大化、最小化、无标题栏、工具窗口、被遮挡的接触点和无响应窗口。全屏前台应用或鼠标按住时暂停。没有目标时等待后重试。测试时应使用独立、未最大化的可调整尺寸窗口，避免用 DSH 主窗口作为目标。

## 动画与站位

视频桌宠的 `config.jsonc` 可添加以下字段。无需升级素材即可使用窗口互动；未配置或加载失败的动作使用待机动画。

```json
{
  "interactions": {
    "version": 1,
    "fallback": "待机-静态",
    "actions": {
      "walk": {
        "animation": null,
        "facing": "left",
        "mirror": true,
        "canvas": [500, 500],
        "foot": [0.5, 1],
        "contact": null,
        "offset": [0, 0],
        "directions": {}
      },
      "squeeze": { "animation": null },
      "stretch": { "animation": null },
      "move": { "animation": null }
    }
  }
}
```

`walk`、`squeeze`、`stretch`、`move` 分别对应行走、挤压、拉伸、整窗移动。`animation` 填现有动画资源名，不含扩展名；动作期间循环播放，结束后恢复原有动画。不同方向可以在 `directions.left/right/up/down` 中覆盖同名站位字段。行走按移动方向选择，其他动作按面向目标窗口的方向选择。

| 字段 | 含义 |
| --- | --- |
| `canvas` | 素材画布宽高，范围 1–8192，默认 `[500,500]`；须与视频比例一致 |
| `foot` | 脚底锚点，归一化坐标 0–1，默认 `[0.5,1]`，对齐宠物主体底部中心 |
| `contact` | 手部接触锚点，归一化坐标 0–1；非行走动作配置后优先对齐实际窗口边缘，允许脚底随之偏移 |
| `facing` | 素材原始朝向 `left/right/up/down` |
| `mirror` | 默认允许水平镜像；左右朝向相反时同时镜像画面与锚点，不自动旋转上下动作 |
| `offset` | 相对实际显示素材宽高的偏移，范围 -1–1，默认 `[0,0]`；正值向右、向下 |

站位计算包含等比缩放后的留白，仅调整视觉图层，不改变点击区域。素材应保留透明边距，避免偏移后被宠物视口裁切。待机兜底不应用动作的镜像与站位。兜底依次查找 `interactions.fallback`、`motions.idle`、`animations.motions.idle`、`animations.idle`，跳过已加载失败的资源。

## 自动化验证

在仓库根目录执行前端测试和类型检查：

```sh
pnpm exec vitest run --project unit src/pet packages/dsh-tauri-pet/src/client/components/pet-settings.test.tsx packages/dsh-tauri-pet/src/client/service/pet.test.ts --sequence.shuffle --sequence.seed=20261016
pnpm typecheck
```

在 `src-tauri` 执行原生测试：

```sh
cargo test --lib pet --quiet
```

前端覆盖开关、子项、概率持久化、动画槽位、镜像与锚点、缺失资源兜底、手动抓取优先级、异步结果过期与错误重试。Windows 原生测试包含独立窗口夹具，验证移动不改变尺寸、不抢焦点，挤压只修改接触边，尊重应用最小尺寸及固定窗口样式，并在用户改变窗口几何信息时停止。窗口夹具验证不等同于完整 DSH 端到端测试。

## 手动验收

1. 开启桌宠与趣味互动，把概率设为 100%，打开独立普通窗口并留出可见边缘；等待桌宠靠近后互动。
2. 仅开启移动窗口，确认窗口尺寸不变；仅开启挤压与拉伸，确认窗口尺寸变化且遵守最小尺寸限制。
3. 概率设为 0%，确认桌宠可接近但不操作窗口；关闭总开关，确认互动停止且概率控件隐藏。
4. 使用未配置动作素材的宠物，确认互动仍执行并显示待机；逐一配置四个动作，检查阶段切换、左右镜像、脚底与手部接触位置。
5. 在互动过程中手动抓取宠物、移动目标窗口或切换宠物，确认旧动作停止且不会继续修改旧目标。
