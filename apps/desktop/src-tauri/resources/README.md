# Resources

This directory is bundled into the installer as `resources/**`.

The desktop supports the 0.2.2 core series, starting at `0.2.2-rc.1`.
Offline bundles select the newest compatible, non-draft, non-preview release
with uploaded, SHA-256-verifiable asar assets for all supported desktop targets.
RC tags are accepted unless GitHub marks the release as a prerelease.

At runtime, the application downloads everything it needs into the OS user-data
directory (the Tauri app-data dir for identifier `dsh-tauri`, e.g.
`%APPDATA%/dsh-tauri/` on Windows):

- `dependencies/dsh/` — the packaged DeepSeek Harness distribution (downloaded from the
  `dsh-tauri-desk/deepseek-harness-pkg` release feed)
- `data/dsh/` — **legacy** `$DSH_HOME` location (pre-migration builds only; see below)
- `logs/` — application and `dsh` service logs
- `.store.dat` — desktop settings (port, auto-start, language, etc.)

The installed Electron runtime runs dsh and pnpm in Node mode. No standalone
Node.js runtime is downloaded or bundled; historical `runtime/` copies are removed
on startup.

On the first launch after the identifier was shortened from
`io.github.hairyf.deepseek-harness-desktop` to `dsh-tauri`, the app **moves** the
whole legacy app-data directory (settings store, logs, downloaded runtime and
`dependencies/`) into the new one, so upgrades keep their configuration. The move
runs before the first-install check and is non-fatal on failure (legacy data stays
in place and the next launch retries).

## `$DSH_HOME` — shared with the official Node.js install

The user data directory (`$DSH_HOME`) used by the running `dsh` process follows
the **official dsh convention** (`${DSH_HOME:-$HOME/.dsh}`): the `DSH_HOME`
environment variable when set, otherwise `~/.dsh`
(`C:\Users\<you>\.dsh` on Windows). This way the desktop app and a
`npm i -g @deepseek-ai/dsh` install share the same profiles, sessions, settings
and credentials — no data switching needed.

The app no longer migrates data out of those legacy locations: it starts from
the current `$DSH_HOME` directly. Any data still sitting in an old
`%APPDATA%/.../data/dsh` (or under the pre-rename app-data identifier) is
neither read nor deleted.

## Resource manifest — `manifest.jsonc`

Every runtime resource catalog now lives in a single `manifest.jsonc` (JSONC:
`//` and `/* */` comments plus trailing commas are tolerated). It is parsed at
runtime by `src-tauri/src/config/manifest.rs` — **no Rust code change is needed
to add a preset, a built-in plugin, a deprecated id, or a dependency
mapping entry**.

```jsonc
{
  "engines": { "dsh": { "minimum": "0.2.2-rc.1" } },
  "dependencies": {
    "pnpm": {
      "engine": ">=11.7.0",
      "entry": "bin/pnpm.cjs",
      "managedRoot": "$AppData/dependencies/pnpm",
      "overridable": true
    }
  },
  "plugins": { "depercated": [], "built-in": [], "preset": [] }
}
```

`managedRoot` (and every recorded mapping value) accepts three forms:

| Form | Resolves to |
| ---- | ----------- |
| `$AppData/...` | the app data directory (its `dev` sibling in debug builds) |
| `$Resources/...` (legacy spelling: `resources/...`) | the installed app's resource root, falling back to app data when it cannot be probed |
| absolute path (`C:/anywhere/dsh`, `/opt/dsh`) | used verbatim — how a local bundle build points at a checkout |
| any other relative path | app data directory |

Prefixes are case-insensitive and require the `/` boundary (`$resourcesfoo` is a plain
relative path).

| Section | Purpose |
| ------- | ------- |
| `engines.dsh.minimum` | Lowest supported core (`0.2.2-rc.1`); only the 0.2.2 series is supported |
| `dependencies` | Dependency mapping spec: entry path per platform, default managed root, whether arbitrary overrides are allowed |
| `plugins.preset` | Community preset list shown by the first-run wizard / sidebar |
| `plugins.built-in` | Plugins shipped *with* the installer (auto-installed and auto-healed at startup) |
| `plugins.depercated` | Package names no longer offered that get uninstalled before launch (key spelling is kept for compatibility) |

### Dependency mapping

The manifest only describes **where a dependency's entry lives inside its root**.
Which root is actually used is recorded per machine in
`<app-data>/dependencies.json` (debug: `<app-data>/dev/dependencies.json`):

```json
{ "pnpm": null, "dsh": "C:/Users/you/AppData/Roaming/dsh-tauri/dependencies/dsh" }
```

* a path → that root is used (an absolute location anywhere on disk, or a
  `$AppData/...` / `$Resources/...` token as described above);
* `null` → the system environment satisfies this dependency; a managed copy is
  still downloaded into `managedRoot` if one is ever needed (and the mapping is
  rewritten then);
* a missing key → fall back to the manifest's `managedRoot` (under app data).

This is what makes a future "bundled core" build a manifest-only change:
point `managedRoot` (or the recorded root) at `$Resources/dsh` and no path logic
in `src-tauri` has to move.

### Offline bundle

`Build & Release (Offline Bundle)` prepares pnpm and the packaged asar core under
`resources/`. Electron is already provided by the desktop build.

| Directory | Bundled contents |
| --------- | ---------------- |
| `resources/pnpm` | pnpm distribution (`bin/pnpm.cjs`) |
| `resources/dsh` | `deepseek-harness-pkg-<platform>.asar` and any accompanying unpacked files |
| `resources/git` | MinGit, only with the `bundle_git` opt-in |

The action downloads `.asar.zip` assets, verifies the GitHub release SHA-256
digest, and unpacks them without extracting the asar itself. Names match
`config::runtime::dsh_core_asar_filename`: Windows x64 uses `windows`,
Windows ARM64 uses `windows-arm64`, Linux uses `linux` or `linux-arm64`,
and macOS uses `macos-x64` or `macos-arm64`. Windows ARM64 uses native
Electron and a matching core; the current Windows release workflow builds x64 only.

pnpm and optional MinGit use the SHA-256 pins in
`src-tauri/src/config/constants.rs`. The core tag is resolved from published
0.2.2 releases with the complete supported asar asset set, without pinning an
unreleased build. Missing assets or digests exclude a release from selection.
The action verifies the archive file on disk because its inner entry is read
through Electron, then rewrites `manifest.jsonc` in the build workspace:

```jsonc
{
  "dependencies": {
    "pnpm": { "entry": "bin/pnpm.cjs", "managedRoot": "$Resources/pnpm", "overridable": false },
    "dsh": { "entry": "node_modules/@deepseek-ai/dsh/lib/bin.js", "managedRoot": "$Resources/dsh", "overridable": true }
  }
}
```

The committed manifest keeps its `$AppData/...` defaults. Bundled pnpm and optional
MinGit are pinned to resources so stale dependency mappings cannot override them.
The core stays overridable: users can switch between its read-only bundled asar
and downloaded slots in app data. Core archives are loaded through Electron's
`client.node`; local npm directory cores remain supported separately.

Git is not needed to start dsh and is omitted by default. Git-backed features
(worktrees and `github:` plugins) need an existing Git installation or the opt-in
bundle. Community and preset plugin installation still needs network access;
the offline bundle only removes first-launch dependency downloads.

### Preset plugins — `plugins.preset`

To propose a new preset plugin, open a PR that adds one entry:

> **Note on "new preset" detection**: the manifest ships with the installer and
> is force-overwritten on every install, so the app records a fingerprint of the
> `plugins` section into the user-data settings after the wizard ends (install or
> skip) and re-opens the wizard on the next launch when that section differs. No
> extra action is needed when adding an entry.

```jsonc
{
  "id": "npm-package-name",
  "spec": "npm-package-name | github:owner/repo",
  "name": "Display name",
  "description": "English description. · 中文描述",
  "repo": "https://github.com/owner/repo",
  "recommended": true,
  "checked": true,
  "version": [{ "version": "^0.19.1", "dsh": "^0.1.7-rc.1" }]
}
```

| Field         | Required | Meaning                                                                 |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `id`          | yes      | Unique front-end key; must be a legal npm dependency name               |
| `spec`        | yes      | Dependency form passed to `dsh plugin add` (npm name or `github:owner/repo`) |
| `package`     | no       | Real npm package name when it differs from `id`                          |
| `name`        | yes      | Display name                                                            |
| `description` | yes      | Shown in the wizard; bilingual (`en. · 中文`) is encouraged             |
| `repo`        | yes      | Repository page, opened via the "open repo" button                      |
| `recommended` | no       | Green "recommended" chip (defaults to `false`)                          |
| `fix`         | no       | Yellow "fix" chip, checked by default — reserved for Windows minimal-mode fixes (defaults to `false`) |
| `checked`     | no       | Pre-checked in the first-run wizard (defaults to `false`)                |
| `winOnly`     | no       | Only listed on Windows (defaults to `false`)                            |
| `version`     | no       | Version-range declaration: a plain string (e.g. `"latest"`) or a matrix of `{ "version": <plugin range>, "dsh": <core range> }` pairs |

`id` must be unique across the section. The plugin itself is **not** vendored
into this repository — it is installed on the user's machine from `spec` at
setup time, so the PR only needs to add the JSON entry.

### Core-driven automatic removal

For a given active core version, the **last** `version` matrix entry whose `dsh`
range matches the core decides the compatible plugin version range — the matrix is
an ascending ladder, and rules may overlap (`^0.1.7-rc.1` also covers later
`0.1.x` release cores), so a core can match several entries at once. The desktop
support floor still applies; a preset range does not restore support for earlier
cores. That single
matching entry drives both the UI compatibility mark and core-driven cleanup:

* no matrix entry matches the running core → the preset is marked
  "unsupported by the current core" and installed copies inside any declared
  plugin range are removed;
* a matching entry exists but the installed plugin version falls outside its
  `version` range → the installed copy is removed so it can be reinstalled at a
  compatible version;
* a plain string declaration (or no declaration) never triggers removal.

The separate `plugins.depercated` list is unaffected and continues to remove
listed plugins independently of these ranges.

### Retiring a deprecated plugin

`plugins.depercated` is matched against the **package names actually present in
the profile** (`package.json` dependencies + bundles, plus any `node_modules`
entry). That is deliberately independent of `plugins.preset`: once a plugin drops
out of the preset list it also loses its `package` declaration, so the deprecated
entry must spell the name the profile really uses. Sibling packages that only
share a prefix or a scope-local basename are never touched.

Retirement reuses the offline uninstall path (rewrite the profile manifest, drop
the `node_modules` entry, strip matching `cordis.patch.yml` entries — including
`insert` lists). Built-in plugins (`plugins.built-in`) are skipped: they belong
to the shell, and removing them would only fight the startup self-healing.

### Built-in (internal) plugins

Plugins that must ship *with* the installer and are treated as part of the app
(auto-installed and auto-healed at startup) live in `plugins.built-in`. Add a
`package` field when the real npm name differs from `id`. The entries are
bundled at build time by `scripts/build-plugins.ts` (via `pnpm deploy` of the
workspace packages listed in `packages/dsh-tauri-bundle`) into
`resources/node_modules/<name>` (via `bundle.resources`) and never appear in the
first-run checklist. On startup the app removes the legacy
`resources/preset-plugins/` directory left by upgrades. In debug builds the
workspace packages under `packages/*` are discovered directly, so a new built-in
plugin only needs its `dsh` field and a `plugins.built-in` entry for release
builds.

Unlike `plugins.preset`, a built-in entry declares **no `description`**: the text
shown in the desktop plugin dialog is read from the plugin's own
`package.json` (`resources/node_modules/<name>/package.json` in release builds,
the workspace package in debug builds), so it stays in sync with what the package
publishes instead of being maintained twice. Every built-in plugin package must
declare a `description`.

The deployed tree also carries native optional dependencies for the platforms
`dsh-tauri-remote` can provision, not only the build host: `pnpm deploy` runs with
`--os current,linux,darwin --cpu x64,arm64 --libc glibc`, and
`build-plugins.ts` fails the build when a binding the remote matrix needs is
absent. That tree is shipped verbatim to the remote over SSH, so a Windows build
that held only `oxide-win32-x64-msvc` made every remote instance die with
`Cannot find native binding` (issue #1389).

Only **glibc** bindings are shipped, never musl: the remote matrix is glibc hosts
only, and a musl `.node` drags Linux AppImage packaging down — linuxdeploy runs
`ldd` on every ELF in the AppDir, and a musl shared object on a glibc host fails
with `libc.so: invalid ELF header`, aborting the bundle (`failed to run linuxdeploy`).
`pnpm deploy`'s `--libc` does not reliably exclude them, so `build-plugins.ts`
removes the musl platform packages explicitly after deploy.
