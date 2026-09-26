# Resources

This directory is bundled into the installer as `resources/**`.

At runtime, the application downloads everything it needs into the OS user-data
directory (the Tauri app-data dir for identifier `dsh-tauri`, e.g.
`%APPDATA%/dsh-tauri/` on Windows):

- `runtime/` — the bundled Node.js runtime (downloaded on first run)
- `dependencies/dsh/` — the packaged DeepSeek Harness distribution (downloaded from the
  `dsh-tauri/deepseek-harness-pkg` release feed)
- `data/dsh/` — **legacy** `$DSH_HOME` location (pre-migration builds only; see below)
- `logs/` — application and `dsh` service logs
- `.store.dat` — desktop settings (port, auto-start, language, etc.)

No manual Node.js or pnpm installation is required.

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

On the first launch of a build that introduced this change, the app
**migrates** any existing legacy data from `%APPDATA%/.../data/dsh` into the
new `$DSH_HOME` (recursive merge, newer mtime wins; `node_modules` trees are
skipped — they are regenerated on boot). The legacy directory is removed after
a successful migration, and the one-shot migration is recorded in `.store.dat`
(`dsh_home_migrated`). Migration failures are non-fatal: legacy data stays in
place and the migration retries on the next launch.

## Resource manifest — `manifest.jsonc`

Every runtime resource catalog now lives in a single `manifest.jsonc` (JSONC:
`//` and `/* */` comments plus trailing commas are tolerated). It is parsed at
runtime by `src-tauri/src/config/manifest.rs` — **no Rust code change is needed
to add a preset, a built-in plugin, a deprecated id, a pet, or a dependency
mapping entry**.

```jsonc
{
  "engines": { "dsh": { "recommend": "0.1.7-rc.2", "minimum": "0.1.5-rc.1" } },
  "dependencies": {
    "node": {
      "engine": ">=22.22.0",
      "entry": { "windows": "node.exe", "default": "bin/node" },
      "managedRoot": "$AppData/runtime",
      "overridable": true
    }
  },
  "plugins": { "depercated": [], "built-in": [], "preset": [] },
  "pets": { "built-in": [] }
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
| `engines.dsh.recommend` | Recommended core version (update hints, "above recommended" marks) |
| `engines.dsh.minimum` | Lowest supported core; older local cores are not preferred |
| `dependencies` | Dependency mapping spec: entry path per platform, default managed root, whether arbitrary overrides are allowed |
| `plugins.preset` | Community preset list shown by the first-run wizard / sidebar |
| `plugins.built-in` | Plugins shipped *with* the installer (auto-installed and auto-healed at startup) |
| `plugins.depercated` | Ids of presets that are no longer offered and get uninstalled at startup (key spelling is kept for compatibility) |
| `pets.built-in` | Preset pet catalog |

### Dependency mapping

The manifest only describes **where a dependency's entry lives inside its root**.
Which root is actually used is recorded per machine in
`<app-data>/dependencies.json` (debug: `<app-data>/dev/dependencies.json`):

```json
{ "node": "C:/Users/you/AppData/Roaming/dsh-tauri/runtime", "pnpm": null, "dsh": "C:/Users/you/AppData/Roaming/dsh-tauri/dependencies/dsh" }
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

`Build & Release (Offline Bundle)` (`.github/workflows/release-bundle.yml`) produces a
second set of installers that need no network on first launch. Its
`.github/actions/prepare-bundle-resources` step unpacks the runtime into `resources/`:

| Directory | Bundled contents |
| --------- | ---------------- |
| `resources/node` | Node.js runtime (`node.exe` / `bin/node`) |
| `resources/pnpm` | pnpm distribution (`bin/pnpm.cjs`) |
| `resources/dsh` | packaged DeepSeek Harness core (`node_modules/@deepseek-ai/dsh/lib/bin.js`) |
| `resources/git` | MinGit — **not** bundled by default (`bundle_git` opt-in) |

Only what running `dsh` itself needs is bundled. Git is deliberately left out: it is not
required to start the harness, only git-backed features (worktree, `github:` plugins) are,
and an air-gapped machine can never provision it later. A bundled build therefore stops
treating Git as a startup prerequisite (see `config::dependencies::bundled_core_dir`),
so the install screen is never entered for a download that cannot succeed.

Every asset is SHA-256 verified before unpacking (Node against the official
`SHASUMS256.txt`, the core against its GitHub release digest, pnpm/MinGit against the
pins in `src-tauri/src/config/constants.rs`). Versions and download prefixes are read from
that same file, and the core version from this manifest's `engines.dsh.recommend`, so the
bundle never drifts from what the app would otherwise download.

The step then rewrites **this file** so every bundled dependency resolves through the
installer's own resources:

```jsonc
{
  "dependencies": {
    "node": { "entry": { "windows": "node.exe", "default": "bin/node" }, "managedRoot": "$Resources/node", "overridable": false },
    "dsh": { "entry": "node_modules/@deepseek-ai/dsh/lib/bin.js", "managedRoot": "$Resources/dsh", "overridable": true }
  }
}
```

The rewrite only ever touches the build output — the committed manifest keeps its
`$AppData/...` defaults. `overridable` is per dependency:

* `node` / `pnpm` (and MinGit, when bundled) are pinned (`false`): they ship with the
  installer, and a stale `<app-data>/dependencies.json` (written by an earlier,
  non-bundled install and possibly pointing at deleted directories) must not win over
  them. `config::dependencies::active_root` additionally ignores a recorded root whose
  path no longer exists.
* `dsh` stays overridable (`true`): the bundled core is the core panel's pinned **本地**
  entry, and switching cores works by pointing the `dsh` dependency root elsewhere —
  either at a downloaded slot in `<app-data>/dependencies/<tag>` or back at
  `$Resources/dsh`. Downloaded cores therefore keep landing in app data; the install
  directory is never written to and never loses its bundled core (unlike a directory
  swap, which would move `resources/dsh` into app data on every switch).

`resource_root()` strips the Windows `\\?\` verbatim prefix that Tauri's
`resource_dir()` carries (it canonicalizes the exe path). Without that, `$Resources/dsh`
resolves to a verbatim path, which is handed to node as its main module — and node's
`resolveMainPath` fails on it with `EISDIR: illegal operation on a directory, lstat 'C:'`,
so the bundled core could never start.

The bundled core is used in place, so the install directory must stay writable for the
desktop's startup patches and plugin entry links — true for the per-user NSIS install, not
for `/usr/lib/**` in the Linux deb (documented limitation). Community/preset plugins are
still installed from the network; the offline bundle only removes the *first-launch*
dependency downloads.

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
  "version": [{ "version": "^0.19.1", "dsh": "^0.1.5-rc.1" }]
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
an ascending ladder, and older rules usually stay open-ended (`^0.1.5-rc.1` covers
all of `0.1.x`), so a release core can match several entries at once. That single
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