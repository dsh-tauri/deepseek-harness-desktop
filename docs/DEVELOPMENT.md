# Development

[English](<./DEVELOPMENT.md>) · [中文](<./DEVELOPMENT.zh.md>) · [README](<../README.en.md>)

Tauri 2 + React 19: UI in [`src/`](<../src/>), Rust backend in [`src-tauri/`](<../src-tauri/>), plugins in [`packages/`](<../packages/>). Recommended Harness core: `0.2.1-rc.4`; minimum supported core: `0.2.1-rc.4`. Older core versions are unsupported; earlier compatibility logs record history, not the current support policy. See the [current compatibility record](<../packages/dsh-tauri/docs/compatibility-0.2.1-rc.4.md>).

Read [AGENTS.md](<../AGENTS.md>) and the [routed specifications](<./specs/devlopment.md>) before changes. Do not inspect the restricted archive directory or run builds during plugin work.

## Requirements

| Tool | Requirement / source |
| --- | --- |
| Node.js | `22.22.0+` for the managed runtime; CI uses Node 22.x ([manifest](<../src-tauri/resources/manifest.jsonc>), [CI setup](<../.github/actions/setup-node-pnpm/action.yml>)) |
| pnpm | `11.7.0`, pinned by [package.json](<../package.json>) |
| Rust | `1.93+`; current stable recommended. The patched [notification crate](<../src-tauri/vendor/tauri-plugin-notifications/Cargo.toml#L14>) sets this minimum. |

| Platform | Toolchain |
| --- | --- |
| Windows | MSVC C++ build tools and WebView2 |
| macOS | Xcode 16+ with Swift 6; Command Line Tools alone are insufficient for the notification backend ([Cargo.toml](<../src-tauri/Cargo.toml#L46-L48>)) |
| Linux | WebKit2GTK 4.1 headers; CI installs `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` ([CI](<../.github/workflows/ci.yml>)) |

macOS runtime minimum is 12+, while the web UI requires Safari 17.4+ capabilities. Linux runtime workarounds are in the [online docs](https://dshtauri.mintlify.site).

## Development commands

Run from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install workspace dependencies |
| `pnpm dev` | Vite frontend only |
| `pnpm dev:plugins` | Watch plugins; reuse an existing watcher during edits |
| `pnpm tauri dev` | Debug desktop; starts Vite through `beforeDevCommand` |
| `pnpm dev:desktop` | Combined watcher/desktop helper; shell-dependent `&` syntax |
| `pnpm typecheck` | Frontend TypeScript check |
| `pnpm lint` | ESLint |

For portable desktop/plugin development, use separate terminals for the plugin watcher and `pnpm tauri dev`.

`pnpm typecheck` checks workspace package sources through `tsconfig.typecheck.json`, so a fresh checkout needs only `pnpm install`, without generated declarations or a running plugin watcher. Build and runtime resolution still use package exports; CI builds the shared packages and tests their packaged entrypoints separately.

**Build protection:** [AGENTS.md](<../AGENTS.md>) forbids builds during plugin changes. `pnpm build:plugins`, `pnpm build`, `pnpm build:debug`, and `pnpm tauri build` are deliberate artifact-preparation/release actions; `pnpm build` also invokes the plugin prebuild.

## Validation

The scripts in [package.json](<../package.json>) map to these explicit, non-watch commands ([testing standard](<./specs/testing.md>)):

| Script | Direct invocation |
| --- | --- |
| `test` | `node node_modules/vitest/vitest.mjs run` |
| `test:unit` | `node node_modules/vitest/vitest.mjs run --project unit` |
| `test:e2e:plugin` | `node node_modules/vitest/vitest.mjs run --project plugin` |
| `test:e2e:desktop` | `node node_modules/vitest/vitest.mjs run --project desktop` |

E2E requires prepared fixtures/runtime and, for desktop tests, a debug binary. Follow the [plugin test guide](<./specs/plugin.test.md>) and [desktop test guide](<./specs/desktop.test.md>); do not trigger builds just to validate documentation or plugin edits.

Rust checks from the repository root:

```bash
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --all-features --locked
```

Use `git diff --check` for documentation-only edits. Tests must use isolated data, never real user profiles.

## Reduced motion for chat following

At desktop startup, the [patch](<../src-tauri/src/service/patch/scroll_follow.rs>) for compatible managed chat bundles ([#1114](https://github.com/dsh-tauri/deepseek-harness-desktop/issues/1114)) makes chat and process-group following use the existing `jump` path when the DSH document root has `data-reduce-motion` or the system requests `prefers-reduced-motion: reduce`. This also cancels an active smooth scroll. Normal startup, early startup and `--patch-core` are covered; missing files or changed upstream anchors are logged and skipped without rewriting unknown versions.

The deployment owns the root attribute. This patch does not disable motion by default, inject CSS, or implement `?reduce-motion=0` / browser persistence. Official pages without the attribute retain smooth behavior unless the system requests reduced motion. Set the attribute inside the **DSH page / frame**; for a temporary check, run `document.documentElement.setAttribute('data-reduce-motion', '')` in that frame's console. Values `0` and `false` still count as present. Restore motion with `document.documentElement.removeAttribute('data-reduce-motion')` and a non-reduced system preference. Manual changes do not survive refresh and are read on the next follow call.

The [regression tests](<../test/scroll-follow-patch.test.ts>) compare the released class with the production replacement; Rust tests run the same JavaScript contract on the actual `apply_at` file output. These are logic checks, not M5 / multi-display GPU measurements or full browser pagination coverage. Performance claims still need a same-device before/after comparison.

## Chat follow anchor

[#1187](https://github.com/dsh-tauri/deepseek-harness-desktop/issues/1187) reports laggy scrolling and pointer movement in macOS WKWebView while the same page is fine in Chrome. The compatible chat bundle keys `overflow-anchor: none` off `[data-conversation-scroll]:has(.EvIC1a_root[data-chat-following-tail])`; WebKit re-runs selector matching over the whole conversation subtree on every node removal inside that scrollport, and the follow path removes and re-inserts nodes continuously. The [patch](<../src-tauri/src/service/patch/chat_follow_anchor.rs>) mirrors the committed follow intent onto the enclosing `[data-conversation-scroll]` from `ScrollFollow.bind`/`setFollowing` and switches the rule to a plain attribute selector. A scrollport can host several followers (main conversation and process groups), so the attribute reflects whether any of them is still following and is written only when that result changes, uses the same best-effort/idempotent/anchor-skip semantics as above, and the [regression tests](<../test/chat-follow-anchor-patch.test.ts>) replay the mirroring contract against the released and patched class.

## Runtime isolation

| Mode | Harness data | Store | Default loopback port |
| --- | --- | --- | --- |
| Debug | `~/.dsh.dev` | `.store.dev.dat` | `3081` |
| Release | `~/.dsh` | `.store.dat` | `3080` |

- Debug runtime, core, and dependencies live under `<AppData>/dev/`; the log is `<AppData>/dev/logs/dsh-web.dev.log`.
- Debug ignores inherited `DSH_HOME`, uses `~/.dsh.dev`, and does not migrate release data or modify the production CLI PATH.
- The release data directory is the user-level `DSH_HOME` variable (`~/.dsh` when unset). The Windows installer can set it; on every platform **Settings → Data Directory** copies the data, verifies the copy, renames the old directory aside, and rewrites the variable; rollback restores the previous location from that renamed directory.
- How that variable is persisted is platform-specific: Windows writes `HKCU\Environment`; macOS writes a `~/Library/LaunchAgents/dsh-tauri.env.plist` LaunchAgent that replays `launchctl setenv` at login (the plist's own `EnvironmentVariables` key would not reach a Finder/Dock-launched app); Linux writes `~/.config/environment.d/dsh-tauri.conf` plus a marked block in `~/.profile`. A GUI app started by launchd or by the display manager inherits no login-shell environment, so the app also reads the variable back from disk at startup.
- Ports are configurable and may fall back when occupied; side-by-side launches need not use those exact values.
- Profiles separate configuration, not OS permissions.

## Release references

- [Built-in plugin/resource guide](<../src-tauri/resources/README.md#built-in-internal-plugins>) — registration and bundled resources
- [macOS workflow](<../.github/workflows/build-macos.yml>) and [release workflow](<../.github/workflows/release.yml>) — Developer ID signing, notarization, and CI secrets
- [Resource manifest](<../src-tauri/resources/manifest.jsonc>) — runtime versions, plugin inventory, and preset compatibility rules
