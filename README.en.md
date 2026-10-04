<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop">
    <img src="public/favicon.svg" width="96" alt="DeepSeek Harness Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Desktop</h1>

<p align="center">
  Run <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> on your desktop —<br />
  no manual Node.js, pnpm, or Docker setup; standard installs may need network initialization on first launch.
</p>

<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/dsh-tauri/deepseek-harness-desktop?style=flat-square&label=release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-desktop/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/dsh-tauri/deepseek-harness-desktop?style=flat-square&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/license/dsh-tauri/deepseek-harness-desktop?style=flat-square&label=license&color=4D6BFE" alt="MIT License" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
  <img src="https://img.shields.io/badge/dsh-0.2.0--rc.2-4D6BFE?style=flat-square" alt="dsh 0.2.0-rc.2" />
</p>

<p align="center">
  <samp><strong>English</strong> · <a href="./README.es.md">Español</a> · <a href="https://dshtauri.mintlify.site">Docs</a> · <a href="./README.md">中文</a></samp>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/151676?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-151676" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/151676/daily?language=Rust" alt="dsh-tauri%2Fdeepseek-harness-desktop | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="docs/PREVIEW.md">
    <img src="./docs/images/hero-en.png" width="100%" alt="DSH Desktop English promotional banner" />
  </a>
</p>

## Features

- 🪶 **Native desktop** — Tauri 2 + React 19, embedding the local Harness web UI.
- 🔄 **Runtime management** — Install dependencies, select core versions, and access desktop/core updates.
- 🧩 **Plugin management** — 11 built-in plugins, plus community plugin installation, upgrades, removal, and error details.
- 🗂️ **Profile configuration** — Separate plugin/settings configurations; profiles are not an OS security sandbox.
- ⌨️ **CLI integration** — Managed `dsh` / `pnpm` shims, not a global npm core installation.
- 🐾 **Desktop pets** — Pets / Codex resources, pack imports, and conversation activity; preset media comes from remote hosts.
- 🎨 **Personalization** — 8 palettes, terminal mode, and native transparency, with one-click restore to defaults.

## Built-in plugins

The 11 first-party plugins distributed with desktop resources:

| Plugin | Package | Purpose |
| --- | --- | --- |
| [DSH Tauri](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri) | `dsh-tauri` | Desktop shell / Harness communication |
| [DSH Tauri UI](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-ui) | `dsh-tauri-ui` | Desktop settings UI |
| [DSH Tauri Worktree](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-worktree) | `dsh-tauri-worktree` | Session Git worktrees and checkout |
| [DSH Tauri Extension](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-extension) | `dsh-tauri-extension` | Skills, skill sources, and MCP management |
| [DSH Tauri Scheduler](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-scheduler) | `dsh-tauri-scheduler` | Scheduled tasks and run history |
| [DSH Tauri Archive](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-archive) | `dsh-tauri-archive` | Chat archiving and restoration |
| [DSH Tauri Pet](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-pet) | `dsh-tauri-pet` | Pets and activity states |
| [DSH Tauri Rightclick Menu](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-rightclick) | `dsh-tauri-rightclick` | Session, workspace, and text context menus |
| [DSH Tauri Model](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-model) | `dsh-tauri-model` | Model selection and parameters |
| [DSH Tauri SSH](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-ssh) | `dsh-tauri-ssh` | Remote Harness connections and sync over SSH |
| [DSH Tauri Notification](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-notification) | `dsh-tauri-notification` | Conversation notifications and actions |

`dsh-tauri-experimental` is optional, disabled by default, and not included in the built-in count.

## Optional presets

Setup offers these 6 community plugins for installation on demand. The first 5 are recommended; Billion Context is opt-in.

| Plugin | Package | Purpose |
| --- | --- | --- |
| [DSH Market](https://github.com/dsh-market/dsh-market) | `dshmarket` | Community plugin market |
| [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | `dsh-better-sidebar` | Per-session editor sidebar |
| [DSH Rewind](https://github.com/SiriLee/dsh-rewind) | `dsh-rewind-plugin` | Conversation rewind and workspace backups |
| [DSH Bridge](https://github.com/wenbin-wb/dsh-bridge) | `@wenbin_wb/dsh-bridge` | Remote access, tunnels, and bot connections |
| [DSH IM](https://github.com/xmanrui/dsh-im) | `@xmanrui/dsh-im` | IM channels and bot management |
| [Billion Context](https://github.com/ranxianglei/billion-context) | `billion-context` | Context compression and history restoration |

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
- Use a `Bundle` only when that release actually publishes runtime/core assets in it. **v0.20.0-beta.1 has no Bundle assets**.
- Local execution is not fully offline: model services, plugin installation, updates, and preset pet media can still use network.
- For Linux display, Wayland, AppImage, and permission workarounds, see the [installation and troubleshooting docs](https://dshtauri.mintlify.site).

- In the startup window, open **Configuration → Network** to set an HTTP, HTTPS, SOCKS5 or SOCKS5H proxy for desktop runtime/core downloads, update checks and plugin metadata queries. Leave it empty to inherit system/environment proxy settings. Changes apply to new requests; retry failed downloads after saving. SOCKS5H resolves destination names through the proxy, and loopback connections stay direct. This setting does not change Harness model requests or plugin subprocess networking.

The proxy URL, including any credentials, is stored in the local desktop configuration. Prefer an HTTPS proxy when authenticating to a remote proxy: an HTTP proxy connection does not encrypt proxy credentials, even when the destination website uses HTTPS.

## Runtime

| Current baseline | Version |
| --- | --- |
| Desktop | `0.20.0-beta.1` |
| Recommended Harness core | `0.2.0-rc.2` |
| Declared minimum core | `0.1.5-rc.1`; not an all-plugin compatibility guarantee |
| Node.js runtime | `22.22.0` |
| pnpm | `11.7.0` |

- The Rust backend manages dependencies and the Harness process; the React WebView embeds its UI. Release defaults to `http://127.0.0.1:3080`, with port fallback when occupied.
- Core and preset selection follow the [resource manifest](<./src-tauri/resources/manifest.jsonc>) and declared plugin version ranges, not a promise of compatibility with arbitrary latest upstream releases.
- CLI integration is enabled by default in release: Windows updates user PATH; macOS / Linux may add a managed PATH block to Bash / Zsh configuration. Reopen your terminal; other shells may need manual setup.

## Community

- [Join the Discord community](https://discord.gg/RT9As6Cj8B)

<table>
  <tr>
    <td align="center"><strong>QQ Group</strong><br /><img src="./docs/images/community/qq-qrcode.jpg" width="360" alt="QQ group QR code" /></td>
    <td align="center"><strong>WeChat Group</strong><br /><img src="./docs/images/community/wx-qrcode.png" width="360" alt="WeChat group QR code" /></td>
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
- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) · [dsh-pet-mov](https://github.com/dsh-tauri/dsh-pet-mov) · [dsh-pet-component](https://github.com/hairyf/dsh-pet-component) — pet assets and renderer
- [dsh-plugin-codex-pets](https://github.com/Skylarking/dsh-plugin-codex-pets) · [BongoCat](https://github.com/ayangweb/BongoCat) · [dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) · [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet) — pet reference projects

## License

[MIT](<./LICENSE>) with a [Non-Commercial Condition](<./LICENSE.details>) © deepseek-harness-desktop contributors
