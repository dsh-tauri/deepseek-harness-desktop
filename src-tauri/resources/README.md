# Resources

This directory is bundled into the installer as `resources/**`.

At runtime, the application downloads everything it needs into the OS user-data
directory (the Tauri app-data dir for identifier
`io.github.hairyf.deepseek-harness-desktop`, e.g. `%APPDATA%/io.github.hairyf.deepseek-harness-desktop/` on Windows):

- `runtime/` — the bundled Node.js runtime (downloaded on first run)
- `dependencies/dsh/` — the packaged DeepSeek Harness distribution (downloaded from the
  `dsh-tauri-desk/deepseek-harness-pkg` release feed)
- `data/dsh/` — **legacy** `$DSH_HOME` location (pre-migration builds only; see below)
- `logs/` — application and `dsh` service logs
- `.store.dat` — desktop settings (port, auto-start, language, etc.)

No manual Node.js or pnpm installation is required.

## Offline bundle resources

Alongside the regular installers, `.github/workflows/release-bundle.yml` publishes
an **offline** build (`Deepseek.Harness.Desktop_Bundle_<version>.<ext>`) for
machines without internet access. That build ships the runtime pieces the regular
installer would otherwise download, under this same directory:

- `node/` — the extracted Node.js distribution (`v22.22.0` and friends, see
  `NODE_VERSION` in `src-tauri/src/config/constants.rs`)
- `dsh/` — the extracted recommended dsh core, i.e. the built-in engine
  (`resources/version-recommend.json`)
- `pnpm/` — the extracted pnpm distribution
- `bundle.json` — build-time manifest (`node`, `pnpm`, `dsh.version`,
  `dsh.tag`, `dsh.commit`)

They are produced by `.github/actions/prepare-bundle-resources` and are **not**
committed (see `.gitignore`). Detecting `bundle.json` switches the app into
offline mode (`src-tauri/src/config/bundle.rs`):

- **Node and pnpm are used in place** — `resources/node` and `resources/pnpm`
  directly, skipping the local PATH install and the app-data copies. Both are
  read-only consumers, so nothing is copied.
- **The dsh core is materialized into `dependencies/dsh` with no bulk copy**
  (`src-tauri/src/service/bundle`), in one of two modes, re-decided on every launch
  by probing whether the bundled core directory is writable:

  - **Link** (writable — a Windows per-user install lands in `%LOCALAPPDATA%`):
    `dependencies/dsh` *is* a directory link to `resources/dsh`. The patch layer
    writes straight through into `resources/dsh`, so the file that gets loaded is
    the very file that was rewritten — zero extra disk, no patched-copy/core skew.
  - **Layer** (read-only — macOS `.app`, Linux AppImage/deb): a link layer whose
    patched subtrees are real copies and whose remaining directories are links.

  `src-tauri/src/service/patch::patched_paths()` is the single source of truth for
  what must be writable: `service::bundle::real_dirs()` derives the Layer's real
  directories from it, and both modes are verified right after materialization — if
  any patch target ends up behind a directory link, or cannot be opened for
  writing, materialization fails loudly instead of letting patches silently no-op.
  Layer mode costs ~1.4 MiB on top of `resources/dsh`; Link mode costs nothing.

  Core switching (`dependencies/dsh` ↔ `dependencies/<tag>`) is untouched — both
  forms rename fine. A user-downloaded core is never overwritten: when the active
  slot already holds a real core, the bundled one lands in its own tag slot as a
  normal switchable version instead.
- **The Node and pnpm directories are linked whole** (`{app_data}/runtime`,
  `{app_data}/dependencies/pnpm`): both are read-only consumers (pnpm keeps its
  store in `$DSH_HOME`), so one link each satisfies every existing convention —
  including the paths hardcoded in the generated CLI shims.

Windows MinGit is deliberately **not** bundled: the offline build treats the Git
dependency as satisfied and never tries to fetch it (`config::is_offline_bundle`),
so a machine without Git still boots normally — only plugin installs from
`github:`/`git+ssh:` specs fail, at the point of use, instead of blocking startup.

`bundle.json` also drives the core panel: the version it names is pinned to the
top of the「核心引擎」list with a **内置核心 / Built-in** chip and cannot be
uninstalled, so an offline machine always keeps a usable engine.

## `$DSH_HOME` — shared with the official Node.js install

The user data directory (`$DSH_HOME`) used by the running `dsh` process follows
the **official dsh convention** (`${DSH_HOME:-$HOME/.dsh}`): the `DSH_HOME`
environment variable when set, otherwise `~/.dsh`
(`C:\Users\<you>\.dsh` on Windows). This way the desktop app and a
`npm i -g @deepseek-ai/dsh` install share the same profiles, sessions, settings
and credentials — no data switching needed.

On the first launch of a build that introduced this change, the app
**migrates** any existing legacy data from `%APPDATA%/.../data/dsh` into the
new `$DSH_HOME` (recursive merge, newer mtime wins; `node_modules` trees are
skipped — they are regenerated on boot). The legacy directory is removed after
a successful migration, and the one-shot migration is recorded in `.store.dat`
(`dsh_home_migrated`). Migration failures are non-fatal: legacy data stays in
place and the migration retries on the next launch.

## Preset plugins — `preset-plugins.json`

The first-run wizard / sidebar preset list is driven by `preset-plugins.json`
(loaded at runtime by `src-tauri/src/service/plugin/mod.rs` — **no Rust code
change needed to add a preset**). To propose a new preset plugin, open a PR
that adds one entry to the JSON array:

> **Note on "new preset" detection**: the file ships with the installer and is
> force-overwritten on every install, so the app records a fingerprint of its
> content into the user-data settings after the wizard ends (install or skip)
> and re-opens the wizard on the next launch when the content differs. No extra
> action is needed when adding an entry.

```json
{
  "id": "npm-package-name",
  "spec": "npm-package-name | github:owner/repo",
  "name": "Display name",
  "description": "English description. · 中文描述",
  "repoUrl": "https://github.com/owner/repo",
  "recommended": true,
  "fix": false,
  "winOnly": false
}
```

| Field         | Required | Meaning                                                                 |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `id`          | yes      | Unique front-end key; must be a legal npm dependency name               |
| `spec`        | yes      | Dependency form passed to `dsh plugin add` (npm name or `github:owner/repo`) |
| `name`        | yes      | Display name                                                            |
| `description` | yes      | Shown in the wizard; bilingual (`en. · 中文`) is encouraged             |
| `repoUrl`     | yes      | Repository page, opened via the "open repo" button                      |
| `recommended` | no       | Green "recommended" chip, checked by default (defaults to `false`)      |
| `fix`         | no       | Yellow "fix" chip, checked by default — reserved for Windows minimal-mode fixes (defaults to `false`) |
| `winOnly`     | no       | Only listed on Windows (defaults to `false`)                            |

`id` must be unique across the file. The plugin itself is **not** vendored into
this repository — it is installed on the user's machine from `spec` at setup
time, so the PR only needs to add the JSON entry.

### Built-in (internal) plugins

Plugins that must ship *with* the installer and are treated as part of the app
(auto-installed and auto-healed at startup) live in `internal-plugins.json`,
separate from the community preset list. Add an extra `package` field when the
real npm name differs from `id`. The entries are bundled at build time by
`scripts/build-plugins.ts` (via `pnpm deploy` of the workspace packages listed in
`packages/dsh-tauri-bundle`) into `resources/node_modules/<name>` (via
`bundle.resources`) and never appear in the first-run checklist. On startup the
app removes the legacy `resources/preset-plugins/` directory left by upgrades.
See the [built-in plugin guide](../../docs/BUILTIN_PLUGINS.md) for the full
workflow.