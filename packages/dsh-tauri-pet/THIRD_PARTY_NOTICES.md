# Third-party asset notices

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.1-alpha.1`
- Revision: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Source: `source/deepseek-harness`
- License: MIT — Copyright (c) 2026 DeepSeek
- Not copied: the plugin mounts an official provider and consumes official client contracts.

Integration points:

- Skill provider instance: `cordis.patch.yml` inserts an official `@deepseek-ai/dsh-skill-filesystem` as row `dsh-tauri-pet-skills` (`providerName: dsh-tauri-pet`, `includeDefaultRoots: false`, `customSkillDirs` → this package's bundled `skills/`).
- Settings entry: clone of the official account menu entry inside the official primitives `Menu` (`src/client/constants/index.ts:37-39`, `src/client/register/settings-menu.utils.ts:24-33`, `src/client/register/settings-menu.ts:16-19`); styling inherited, no generated CSS-module hash hard-coded.
- Client services: official projections are read, not forked — `workspaces.list` and the official new-session target order (`src/client/service/pet.utils.ts:3,21`); declared client contracts `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-layout`, `@deepseek-ai/dsh-client-ui-renderer`, `@deepseek-ai/dsh-client-ui-slots`.

## PC2005-cloud/dsh-pet

- Repository: <https://github.com/PC2005-cloud/dsh-pet>
- Asset pin: `e1ff8c1e4001878cbb80441262d530e16541f138`
- License: MIT — Copyright (c) 2026 PC2005-cloud
- Streaming only: the pet media assets (WebM animations, preview GIFs, `config.jsonc`) are not bundled or downloaded; `pets.built-in` in `src-tauri/resources/manifest.jsonc` registers the remote URLs and the pet window streams them at play time.
- Asset terms (upstream `README.md` §许可): the animations, prompt recipes and source videos may be reused openly but **commercial use is forbidden**, and derivative works must credit <https://github.com/PC2005-cloud/dsh-pet> wherever they are introduced, shown or distributed. Those assets are still not bundled here; `skills/hatch-dsh-pet` only documents the upstream generation pipeline so users can produce their own material.

## dsh-tauri-desk/dsh-pet-mov

- Repository: <https://github.com/dsh-tauri-desk/dsh-pet-mov>
- Asset pin: `be0f3bb494cb71a4c73f916c0b92d25a3ab4d002`
- License: MIT
- Used: macOS reads this HEVC-alpha `.mov` mirror; it is our own re-encode of the upstream transparent WebM clips and carries no separate artwork.

## References (nothing shipped)

- `source/dsh-pet`: reference copy at `4c097297ca773abb173198b1384b3a11dcf89409`, not the source of the play-time assets above.
- `QCYTSN/dsh-dafeiyu`: referenced for text and status-priority behaviour only; no sprite or `legacy/` assets are bundled, downloaded or redistributed (see [`docs/sync-log.md`](./docs/sync-log.md)). Its own art was replaced upstream in `v0.1.10` by assets imported from `PC2005-cloud/dsh-pet`.

## Compatibility `0.2.0-rc.2` → `0.2.1-alpha.1`

- The skill provider, account-menu geometry, workspace list, and official primitives entry points remain compatible. The StateDot animation restart fix arrives through the official re-export.
- Asset pins and third-party pet implementations are independent of this Harness compatibility baseline and are not advanced.

## License

```text
MIT License

Copyright (c) 2026 PC2005-cloud

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
