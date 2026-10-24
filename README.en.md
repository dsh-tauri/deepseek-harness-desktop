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
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.2-4d6bfe" alt="Recommended DSH 0.2.1-rc.2" />
  <img src="https://img.shields.io/github/license/dsh-tauri/deepseek-harness-desktop" alt="MIT License" />
  <br>
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-desktop/total?&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/dsh-tauri/deepseek-harness-desktop?&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/contributors/dsh-tauri/deepseek-harness-desktop?&label=contributors&color=4D6BFE" alt="Contributors" />
  <img src="https://img.shields.io/github/commit-activity/m/dsh-tauri/deepseek-harness-desktop?&label=commits&color=4D6BFE" alt="Commit activity" />
</p>

<p align="center">
  <samp><a href="https://dshtauri.mintlify.site/en/installation">Download</a> · <strong>English</strong> · <a href="./README.es.md">Español</a> · <a href="./README.ko.md">한국어</a> · <a href="https://dshtauri.mintlify.site">Docs</a> · <a href="./README.md">中文</a></samp>
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
- 📱 **Remote connection** — Scan a QR code in the Android / iOS app to connect to your computer's DSH over LAN or a Cloudflare public tunnel.
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
- [DSH Tauri Remote](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-remote) — Remote Harness connections and sync over SSH, plus sharing the local Harness over LAN or a public tunnel
- [DSH Tauri Notification](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-notification) — Conversation notifications and actions

## Optional presets

Setup offers the following community plugins for installation on demand.

- [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — Per-session editor sidebar
- [Billion Context](https://github.com/ranxianglei/billion-context) — Context compression and history restoration
- [DSH Office Kit](https://github.com/hairyf/dsh-office-kit) — Office documents, PDF, presentations and spreadsheets
- [DSH Market](https://github.com/dsh-market/dsh-market) — Community plugin market
- [DSH Rewind](https://github.com/SiriLee/dsh-rewind) — Conversation rewind and workspace backups
- [DSH IM](https://github.com/xmanrui/dsh-im) — IM channels and bot management
- [DSH OPS](https://github.com/T-Auto/dsh-ops) — Low-level operations tools to reduce token usage and task execution time

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

On Fedora 43+ (x64 / ARM64) you can install from the Copr repository. Upgrades come through `dnf upgrade` and in-app updates are disabled. For prereleases install `dsh-tauri-beta` instead (it conflicts with `dsh-tauri`; switch with `sudo dnf swap dsh-tauri dsh-tauri-beta`):

```bash
sudo dnf copr enable fairyband/dsh-tauri
sudo dnf install dsh-tauri        # stable
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

## Mobile support

**DSH Mobile** accesses Harness on your computer over LAN or a public tunnel; it does not run a core on the phone.

- **Android**: download an APK from [Releases](https://github.com/dsh-tauri/deepseek-harness-desktop/releases).
- **iOS**: install the beta through the [TestFlight invitation](https://testflight.apple.com/join/kYXkpnp1), subject to approval and available slots. Unsigned IPAs in Releases require your own signing.

Enable sharing from **Share** in the desktop's top bar, then scan the QR code to pair. Keep the computer, Harness, and any tunnel online. Access is not read-only; keep QR and access codes private. See the [mobile remote access guide](https://dshtauri.mintlify.site/en/guides/mobile-remote-access).

The app is maintained only until an official mobile service launches. Development details are in the [mobile specification](docs/specs/native.md).

## Runtime

Windows startup failures show a native dialog with the underlying error. For `STARTUP_LOW_INTEGRITY`:

- The process runs below Medium integrity and cannot write normal user data; updates can inherit a folder's Low label.
- Inspect the folder and executable with `icacls`. Restore a trusted installation to Medium, or reinstall into a normal folder.
- Running as administrator does not remove the Low-label restriction. Keep sessions and `DSH_HOME` unchanged.

| Current baseline | Version |
| --- | --- |
| Recommended Harness core | `0.2.1-rc.2` |
| Minimum supported core | `0.1.7-rc.1`; not a compatibility guarantee for every plugin |

Older cores are no longer supported. Earlier compatibility records describe history, not the current support range.

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

## Community Picks

- [dsh-tauri-notify-webhook](https://github.com/iuuuuuuuu/dsh-tauri-notify-webhook) - Forward notifications to webhook, email (SMTP) or pushplus when a task stops abnormally or finishes by @iuuuuuuuu
- [dsh-pdf-reader](https://github.com/SkanderBog/dsh-pdf-reader) - Page-by-page PDF reading, local OCR, citations, search and visual cropping by @SkanderBog
- [dsh-context-manager](https://github.com/SkanderBog/dsh-context-manager) - Review context before applying, and choose per full-history group to keep, summarize or omit earlier content by @SkanderBog
- [@ryuu-64/dsh-find-all](https://github.com/Ryuu-64/dsh-find-all) - Ctrl+F in the current conversation to find saved history by @Ryuu-64

## Related

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — upstream `dsh` agent platform
- [deepseek-harness-pkg](https://github.com/dsh-tauri/deepseek-harness-pkg) — prebuilt Harness distributions and download source
- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) · [dsh-pet-mov](https://github.com/dsh-tauri/dsh-pet-mov) · [dsh-pet-component](https://github.com/dsh-tauri/dsh-pet-component) — pet assets and renderer
- [dsh-plugin-codex-pets](https://github.com/Skylarking/dsh-plugin-codex-pets) · [BongoCat](https://github.com/ayangweb/BongoCat) · [dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) · [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet) — pet reference projects

## Contributors

![Contributors](https://contrib.rocks/image?repo=dsh-tauri/deepseek-harness-desktop)

## License

[MIT](<./LICENSE>) with a [Non-Commercial Condition](<./LICENSE.details>) © deepseek-harness-desktop contributors
