# Harness 0.2.2-rc.2 兼容记录

推荐核心和开发依赖为 `0.2.2-rc.2`，最低支持为 `0.2.2-rc.1`。源码对照固定到 `dsh-v0.2.2-rc.2`（`ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`），历史派生来源保留。打包发行如实登记：rc.2 目前只有源码 prerelease `dsh-src-0.2.2-rc.2-43074821738`，正式 asar 打包发行尚未产出，最新正式打包仍是 `dsh-0.2.2-rc.1-41838008646`；推荐版本解析不到时回退 tag 仍指向它，不由版本号推算 build ID。

## 本轮变更范围

`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（82 条）与 `catalogs.dsh`（32 条）由 `0.2.2-rc.1` 推进到 `0.2.2-rc.2`；根 `THIRD_PARTY_NOTICES.md` 表格与各包 `THIRD_PARTY_NOTICES.md` 的 reference version / revision / support policy / catalog pin 同步到 rc.2。

最低支持基线未移动：`apps/desktop/src-tauri/resources/manifest.jsonc` 的 `engines.dsh.minimum`、各包 `package.json` 的 `"dsh": ">=0.2.2-rc.1"`、`config/vitest.unit.config.ts` 的 `__REMOTE_DSH_MINIMUM__` 仍是 `0.2.2-rc.1`。

## 契约核对边界

本轮没有在本地重做 rc.1 → rc.2 的逐字节核对：`source/deepseek-harness` 子模块指针尚未推进到 `ddac9676`。因此本文不声称任何宿主契约（`dshDesktop` 标记、index 注入行、鉴权闸门、`__DSH_BOOT__`）在 rc.2 有新增或变更，也不声称其逐字节未变；指针推进后需补一次对照。

## 验证范围

本轮重生成 `pnpm-lock.yaml`（rc.2 全部依赖解析成功），并在 rc.2 依赖上跑通仓库 typecheck 与 unit 全量（91 文件 / 800 用例）。rc.1 一轮的验证结论只对它自己的区间成立，见 [0.2.2-rc.1 兼容记录](<./compatibility-0.2.2-rc.1.md>)。

未验证真实模型请求、发布包压缩锚点与完整桌面浏览器交互，不能把源码对照等同于这些运行验证。
