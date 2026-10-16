# 官方仓库 TestFlight 签名发布

## 现有配置与需要补充的内容

配置目标是 `dsh-tauri/deepseek-harness-desktop`，不是个人 fork。检查时，官方仓库只有 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` 这五个仓库级 Secrets，尚未配置环境或 Variables。这里只读取了名称，GitHub 不允许读取已有 Secret 的明文值。

现有 macOS 流程使用证书及 Apple ID 完成签名、公证；iOS 的 App Store 分发不是 macOS 公证。保留原有 macOS Secrets，不要替换它们。

| Secret | 操作 |
| --- | --- |
| `APPLE_TEAM_ID` | 复用现有值，需与 iOS 证书、描述文件及 App Store Connect 团队一致 |
| `IOS_DISTRIBUTION_CERTIFICATE` | 新增，包含私钥的 Apple Distribution `.p12` 文件的 Base64；不要使用 Developer ID Application 证书 |
| `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | 新增，导出 `.p12` 时设置的密码 |
| `IOS_PROVISIONING_PROFILE` | 新增，`com.dshtauri.dshbridge` 对应的 App Store Connect 分发 `.mobileprovision` 的 Base64 |
| `APP_STORE_CONNECT_API_KEY` | 新增，App Store Connect 团队 API Key 下载的 `.p8` 原始文本，不是 Base64 |
| `APP_STORE_CONNECT_KEY_ID` | 新增，上述 API Key 的 Key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | 新增，团队 API Key 页面的 Issuer ID |

不要将证书、私钥、密码或描述文件提交到 Git，也不要粘贴到聊天、Issue、日志中。

## 苹果后台准备

1. 在“钥匙串访问 → 我的证书”找到 Apple Distribution 证书，展开后必须能看到私钥，导出为带密码的 `.p12`。只有 `.cer` 文件不够。若已有有效证书，不必重新生成或撤销。
2. 在 Apple Developer 的 Certificates, Identifiers & Profiles 中，确认 App ID 为 `com.dshtauri.dshbridge`。当前应用声明 Push Notifications entitlement，描述文件需支持相应能力。
3. 在 Apple Developer 门户手动创建 App Store Connect 分发描述文件，选择该 App ID 和刚导出的 Apple Distribution 证书。CI 使用手动签名，不能使用 Xcode 自动生成的 `iOS Team Store Provisioning Profile`（`IsXcodeManaged=true`），即使它能在本机通过自动签名上传。Development / Ad Hoc / Enterprise 描述文件也不能代替它。苹果描述文件可同时列出 iOS、xrOS、visionOS，包含 iOS 即可。
4. 在 App Store Connect → Users and Access → Integrations → App Store Connect API 创建团队 API Key，仅上传时通常 Developer 足够；启用外部 Beta 自动送审时使用 App Manager（App 管理），按团队权限策略配置。保存 `.p8`、Key ID、Issuer ID；私钥只能下载一次。这里不使用个人 API Key。
5. 确认 App Store Connect 中已有相同 Bundle ID 的 iOS 应用记录，且开发者会员、协议均有效。

## GitHub 配置

使用官方仓库 Settings → Secrets and variables → Actions 下的 Repository secrets，不依赖独立 Environment。自动发布由现有移动端发行流程调用，手动 TestFlight 工作流只能从 `main` 启动，构建提交还须通过官方 main 历史校验。仓库级密钥没有 Environment 审批和部署分支限制，务必保护 main 与工作流修改权限；工作流内的检查不能替代仓库访问控制。

以下命令将新增密钥放到仓库级 Secrets。命令中的文件名均为示例，请替换为本机实际文件；不要开启 shell 的 `set -x`。示例使用 macOS 的 `base64 -i`：

```bash
base64 -i distribution.p12 | gh secret set IOS_DISTRIBUTION_CERTIFICATE --repo dsh-tauri/deepseek-harness-desktop
base64 -i app-store.mobileprovision | gh secret set IOS_PROVISIONING_PROFILE --repo dsh-tauri/deepseek-harness-desktop
gh secret set IOS_DISTRIBUTION_CERTIFICATE_PASSWORD --repo dsh-tauri/deepseek-harness-desktop
gh secret set APP_STORE_CONNECT_API_KEY --repo dsh-tauri/deepseek-harness-desktop < AuthKey_EXAMPLE.p8
gh secret set APP_STORE_CONNECT_KEY_ID --repo dsh-tauri/deepseek-harness-desktop
gh secret set APP_STORE_CONNECT_ISSUER_ID --repo dsh-tauri/deepseek-harness-desktop
```

未传入值的命令会交互式询问；不要把密码写在命令行参数中。`APPLE_TEAM_ID` 沿用现有仓库级 Secret。管理 Secrets 与创建 Environment 的权限不同，应以实际 API 返回结果为准。

合入工作流并配置好密钥后，开启仓库级 Variable：

```bash
gh variable set IOS_TESTFLIGHT_ENABLED --body true --repo dsh-tauri/deepseek-harness-desktop
```

关闭此开关会停止后续自动 TestFlight 任务，不改变原有 APK / unsigned IPA 发布。手动运行不依赖此开关，可用于首次验证，但仍受官方仓库、main 分支和可信提交校验约束。

## 触发与产物

签名任务使用 `macos-26` ARM64 runner，固定 Xcode `26.4.1`，与已成功归档的本机工具链一致。当前 ExpoModulesJSI 在 Intel macOS 15 runner 的 Xcode 26.3 上有 Swift/C++ 互操作编译错误，不能仅为避开排队而回退到该工具链；未来调整 Xcode 版本须重新验证完整归档。

- 桌面正式发版成功后，现有 `Release Mobile Apps (Native)` 解析发行提交；新增独立 TestFlight 任务签名并上传该提交。
- 原有 Android 和 unsigned iOS 任务保持不变，GitHub Release 的既有资产不因 TestFlight 上传失败而被阻止。
- 手动试跑命令：

```bash
gh workflow run release-testflight.yml --repo dsh-tauri/deepseek-harness-desktop --ref main
```

- 只允许官方仓库执行；输入提交必须是官方 `main` 历史中的完整 SHA，不能给任意 PR / fork 代码提供签名凭据。
- 每次运行重新生成 iOS 构建号：将自 2020-01-01 UTC 起的 10 秒计数拆成最多 4、2、2 位的三段数字，共用串行并发组，并在生成后持有完整的 10 秒窗口，避免同一次任务重跑复用编号；此编码上限在 2051 年。首次接入时确认苹果后台没有人为设置过更大的构建号，不能混用其他不协调的编号方案。预发布版本会规范化为三段数字营销版本，例如 `0.24.0-beta.1` 对应 `0.24.0`。仓库版本文件不会被 CI 提交回去。
- 仅可发布包含签名脚本的提交；不要用新流程回放不含脚本的历史 tag。保留原有历史版本发布方式。
- IPA 是 App Store 分发签名包，用于 TestFlight / App Store，不是任意设备可直接侧载的 Ad Hoc 包。
- 上传成功仅代表苹果接收，仍需等待处理；外部 Beta 审核自动化可单独开启，见下一节。流程不提交 App Store 正式审核或自动上架，不添加测试员，也不修改公开邀请链接。
- 部分预编译框架可能缺少 dSYM；此前本机上传已有此类非阻断警告。保留符号产物便于后续排查，不能把“上传成功”当作真机验收通过。

## 自动外部 Beta 审核与通知

在成功上传后，`ios-beta-review.py` 最多等待约 30 分钟查到本次应用、营销版本和构建号完全匹配的有效构建，不会选取“最新构建”代替目标。通过预检查后写入中文测试说明、开启 `buildBetaDetails.autoNotifyEnabled`、按状态提交外部 Beta 审核，并关联明确指定的外部测试组。审核完成后的通知由苹果执行，CI 不等待数小时或数天的人工审核；送审成功不代表审核已通过或通知已发出。

需要以下仓库级 Variables，顺序是先配置目标组再启用：

```bash
gh variable set TESTFLIGHT_BETA_GROUP_ID --body e699950f-b4ce-4a0c-a1df-1da6866326bd --repo dsh-tauri/deepseek-harness-desktop
gh variable set IOS_BETA_REVIEW_ENABLED --body true --repo dsh-tauri/deepseek-harness-desktop
```

该 ID 为用户确认的 `Beta` 外部测试组；其现有公开邀请链接保持不变，组内通过链接加入的测试员同样可获得新构建。关闭 `IOS_BETA_REVIEW_ENABLED` 只停止后续自动送审，不取消已提交审核或已交给苹果的通知设置。

测试说明模板为“请测试主机发现、扫码连接、会话交互及 iPad 横竖屏”，并附本次版本、构建号和官方源码提交链接。审核联系人、Beta 应用说明、反馈邮箱及所需合规信息由 App Store Connect 后台维护；脚本不编造演示账号、隐私政策链接或加密合规声明。DSH Mobile 依赖桌面服务，没有可访问的演示服务或清楚的操作说明可能影响审核。

已处于审核中、已批准或正在外部测试的目标构建不会重复送审；被拒绝或缺失合规信息时直接报出需要人工处理的状态，不通过重试规避审核。苹果限制同一版本同时在审的构建数量，且有每日 Beta 送审限额，遇到此类限制不会撤销其他构建的审核。

若上传已成功而送审后续步骤失败，使用 `Review Existing TestFlight Build` 工作流补跑，准确填写原上传的营销版本、构建号和源码提交；该任务只使用 API Key，不访问分发证书、不重新上传 IPA。它同样要求官方 main 与审核开关开启，并与签名上传共用串行并发组：

```bash
gh workflow run review-testflight.yml --repo dsh-tauri/deepseek-harness-desktop --ref main \
  -f ios_version="${IOS_VERSION:?}" -f build_number="${BUILD_NUMBER:?}" -f source_sha="${SOURCE_SHA:?}"
```

读取测试组成员关系应使用 `/v1/betaGroups/{id}/relationships/builds`；苹果不支持对 `/v1/builds/{id}/betaGroups` 执行 GET，会返回 403，即使密钥职能足够。403 不一定意味着需要升级密钥权限。

官方要求参考：[邀请外部测试员](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)。需要 App Manager、Admin 或账户持有人权限；只给 Developer 的上传密钥可能在送审或测试组管理接口返回 403。替换密钥时同步更新 `.p8`、Key ID 与 Issuer ID，验证成功前不要撤销旧密钥。

## 验证边界

本地可验证工作流结构、脚本语法和配置校验逻辑。真正的证书导入、苹果认证、IPA 导出与上传必须在补齐密钥后的官方 macOS runner 首跑验证；没有这些凭据时，不能声称签名 CI 已运行通过。
