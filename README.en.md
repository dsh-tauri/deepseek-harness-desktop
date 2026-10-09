<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop">
    <img src="public/deepseek-harness-desktop-tauri.svg" width="96" alt="DeepSeek Harness Tauri Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Tauri Desktop</h1>

<p align="center">
  Run <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> on your desktop —<br />
  no manual Node.js, pnpm, or Docker setup; standard installs may need network initialization on first launch.
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB0PSIxNzI2MzA1OTcxMDA2IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9IjE1NDgiIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4Ij48cGF0aCBkPSJNNTI3LjI3NTU1MTYxIDk2Ljk3MTAzMDEzdjM3My45OTIxMDY2N2g0OTQuNTEzNjE5NzVWMTUuMDI2NzU3NTN6TTUyNy4yNzU1NTE2MSA5MjguMzIzNTA4MTVsNDk0LjUxMzYxOTc1IDgwLjUyMDI4MDQ5di00NTUuNjc3NDcxNjFoLTQ5NC41MTM2MTk3NXpNNC42NzA0NTEzNiA0NzAuODMzNjgyOTdINDIyLjY3Njg1OTI1VjExMC41NjM2ODE5N2wtNDE4LjAwNjQwNzg5IDY5LjI1Nzc5NzUzek00LjY3MDQ1MTM2IDg0Ni43Njc1OTcwM0w0MjIuNjc2ODU5MjUgOTE0Ljg2MDMxMDEzVjU1My4xNjYzMTcwM0g0LjY3MDQ1MTM2eiIgcC1pZD0iMTU0OSIgZmlsbD0iI2ZmZmZmZiI+PC9wYXRoPjwvc3ZnPg==" />
  <img alt="MacOS" src="https://img.shields.io/badge/-MacOS-black?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Linux" src="https://img.shields.io/badge/-Linux-yellow?style=flat-square&logo=linux&logoColor=white" />
</p>

<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/dsh-tauri/deepseek-harness-desktop?&label=Release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/badge/DSH-0.2.0--rc.2%2B-4d6bfe" alt="DSH 0.2.0-rc.2" />
  <img src="https://img.shields.io/github/license/dsh-tauri/deepseek-harness-desktop" alt="MIT License" />
  <br>
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-desktop/total?&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/dsh-tauri/deepseek-harness-desktop?&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/contributors/dsh-tauri/deepseek-harness-desktop?&label=contributors&color=4D6BFE" alt="Contributors" />
  <img src="https://img.shields.io/github/commit-activity/m/dsh-tauri/deepseek-harness-desktop?&label=commits&color=4D6BFE" alt="Commit activity" />
</p>

<p align="center">
  <samp><a href="https://dshtauri.mintlify.site/en/installation">Download</a> · <strong>English</strong> · <a href="./README.es.md">Español</a> · <a href="https://dshtauri.mintlify.site">Docs</a> · <a href="./README.md">中文</a></samp>
</p>

<p align="center">
  <a href="https://trendshift.io/developers/13307?utm_source=developer-badge&amp;utm_medium=badge&amp;utm_campaign=badge-developer-13307" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/developers/13307" alt="hairyf | Trendshift" width="250" height="55"/></a>
  <a href="https://trendshift.io/repositories/151676?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-151676" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/151676/daily?language=Rust" alt="dsh-tauri%2Fdeepseek-harness-desktop | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <img src="./docs/images/hero-en.png" width="100%" alt="DSH Desktop banner" />
</p>

## Features

- 🪶 **Native desktop** — Tauri 2 + React 19 + HeroUI 3, embedding the local Harness UI.
- 🔄 **Runtime management** — Install dependencies, select core versions, and access desktop/core updates.
- 🧩 **Plugin management** — 12 built-in plugins, plus local-directory installs, built-in disabling, community plugin installation, upgrades, removal, and error details.
- 🗂️ **Profile configuration** — Separate plugin/settings configurations, with one-click profile data migration, backup, and cloning.
- 💽 **Data directory** — Pick where data lives during installation (Windows); migrate or roll it back later in Settings on Windows, macOS, and Linux.
- ⌨️ **CLI integration** — Managed `dsh` / `pnpm` commands via shims, not a global npm core installation.
- 🐾 **Desktop pets** — Pets / Codex resources, pack imports, and conversation activity; preset media comes from remote hosts.
- 🎨 **Personalization** — 8 palettes, local UI scaling, terminal mode, adjustable opacity, and optional frosted blur.

## Built-in plugins

First-party plugins distributed with desktop resources:

- [DSH Tauri](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri) — Core plugin: desktop-to-Harness communication, version adapters, and plugin dependency management
- [DSH Tauri UI](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-ui) — Desktop settings UI, native core components, themes, and palettes
- [DSH Tauri Mobile UI](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-mobile-ui) — Touch layouts and mobile preferences
- [DSH Tauri Worktree](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-worktree) — Session-level Git worktrees and checkout
- [DSH Tauri Extension](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-extension) — Official plugin manager, plugin market, Skills, and MCP
- [DSH Tauri Scheduler](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-scheduler) — Scheduled tasks and run history
- [DSH Tauri Archive](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-archive) — Chat archiving and restoration
- [DSH Tauri Pet](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-pet) — Desktop pet and activity state settings
- [DSH Tauri Rightclick Menu](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-rightclick) — Session, workspace, and text context menus
- [DSH Tauri Model](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-model) — Model selection, parameters, and automatic configuration
- [DSH Tauri SSH](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-ssh) — Remote Harness connections and sync over SSH
- [DSH Tauri Notification](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-notification) — Conversation notifications and actions

## Optional presets

Setup offers the following community plugins for installation on demand.

- [DSH Market](https://github.com/dsh-market/dsh-market) — Community plugin market
- [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — Per-session editor sidebar
- [Billion Context](https://github.com/ranxianglei/billion-context) — Context compression and history restoration
- [DSH Rewind](https://github.com/SiriLee/dsh-rewind) — Conversation rewind and workspace backups
- [DSH Bridge](https://github.com/wenbin-wb/dsh-bridge) — Remote access, tunnels, and bot connections
- [DSH IM](https://github.com/xmanrui/dsh-im) — IM channels and bot management

Request new or updated presets via [Issues](https://github.com/dsh-tauri/deepseek-harness-desktop/issues). Available versions follow the manifest's core compatibility rules.

## Quick Start

Download the installer for your platform and architecture from [Releases](https://github.com/dsh-tauri/deepseek-harness-desktop/releases):

| Platform | Requirements | Installer |
| --- | --- | --- |
| Windows | Windows 10+, WebView2 | x64 `.exe` / `.msi` |
| macOS | macOS 12+; web UI requires Safari 17.4+ capabilities | Intel / Apple Silicon `.dmg` |
| Linux | WebKit2GTK 4.1 runtime libraries | x64 `.AppImage` / `.deb` |

macOS also supports Homebrew installation:

```bash
brew install dsh-tauri/desktop/deepseek-harness
```

- Standard installers need network on first launch to download missing runtime/core components. Git features require an available Git.
- Names with a `Bundle` suffix are offline installers (`_Bundle_*.exe`, `_Bundle_*.deb`, and two `_Bundle_*.dmg`).
- Local execution is not fully offline: model services, plugin installation, updates, and preset pet media can still use network.
- For Linux display, Wayland, AppImage, and permission workarounds, see the [installation and troubleshooting docs](https://dshtauri.mintlify.site/en/help/troubleshooting).

### Desktop proxy

- Set an HTTP, HTTPS, SOCKS5, or SOCKS5H proxy in **Configuration → Application → Proxy URL**.
- Applies only to desktop runtime/core downloads, update checks, and plugin metadata—not model requests or plugin subprocess networking.
- Leave empty to inherit system/environment settings. Saved changes apply to new requests; retry failed downloads afterward.
- SOCKS5H resolves destination names through the proxy; loopback connections stay direct.

## Runtime

Windows startup failures show a native dialog with the underlying error. For `STARTUP_LOW_INTEGRITY`:

- The process runs below Medium integrity and cannot write normal user data; updates can inherit a folder's Low label.
- Inspect the folder and executable with `icacls`. Restore a trusted installation to Medium, or reinstall into a normal folder.
- Running as administrator does not remove the Low-label restriction. Keep sessions and `DSH_HOME` unchanged.

| Current baseline | Version |
| --- | --- |
| Recommended Harness core | `0.2.0-rc.2` |
| Declared minimum core | `0.1.5-rc.1`; not a compatibility guarantee for every plugin |

- Core and preset selection follow the [resource manifest](<./src-tauri/resources/manifest.jsonc>) and declared plugin version ranges, not a promise of compatibility with arbitrary latest upstream releases.
- CLI integration is enabled by default in release: Windows / macOS / Linux update PATH automatically. Reopen your terminal; other shells may still need manual setup.

## Community

<table>
  <tr>
    <td align="center"><img src="./docs/images/community/qq.png" width="180" height="180" alt="QQ group QR code" /><br /><strong>QQ Group</strong></td>
    <td align="center"><img src="./docs/images/community/wechat.png" width="180" height="180" alt="WeChat group QR code" /><br /><strong>WeChat Group (full, add me on WeChat first) →</strong></td>
    <td align="center"><img src="./docs/images/community/wechat-hairy.png" width="180" height="180" alt="WeChat QR code" /><br /><strong>WeChat</strong></td>
  </tr>
</table>

## Development

See the [English development guide](<./docs/DEVELOPMENT.md>) or [Chinese development guide](<./docs/DEVELOPMENT.zh.md>). Feature details are in the [online docs](https://dshtauri.mintlify.site).

## Notes

> [!WARNING]
> **Developer preview** — upstream `dsh` evolves quickly and may introduce breaking changes; check compatibility before upgrading.

> [!NOTE]
> **Security** — `dsh` can execute code locally. For learning / research / testing only; run it in a trusted, isolated environment.

## Related

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — upstream `dsh` agent platform
- [deepseek-harness-pkg](https://github.com/dsh-tauri/deepseek-harness-pkg) — prebuilt Harness distributions and download source
- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) · [dsh-pet-mov](https://github.com/dsh-tauri/dsh-pet-mov) · [dsh-pet-component](https://github.com/dsh-tauri/dsh-pet-component) — pet assets and renderer
- [dsh-plugin-codex-pets](https://github.com/Skylarking/dsh-plugin-codex-pets) · [BongoCat](https://github.com/ayangweb/BongoCat) · [dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) · [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet) — pet reference projects

## Contributors

![Contributors](https://contrib.rocks/image?repo=dsh-tauri/deepseek-harness-desktop)

## License

[MIT](<./LICENSE>) with a [Non-Commercial Condition](<./LICENSE.details>) © deepseek-harness-desktop contributors
