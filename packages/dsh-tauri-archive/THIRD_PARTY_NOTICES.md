# Third-party notices

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.1-alpha.1`
- Revision: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Source: `source/deepseek-harness`
- Catalog pin: `dsh:` → `0.2.1-alpha.1` (`pnpm-workspace.yaml`)
- License: MIT — Copyright (c) 2026 DeepSeek
- Not copied: the official workspace browser and settings sidebar are extended through official slots, official primitives `Menu` entries and the official sessions / workspaces service surfaces.

Integration points:

- Archive entry: the official primitives menu item for "delete workspace" is cloned into an "archive workspace" entry inserted before it, the official item staying at the bottom (`src/client/register/workspace-patch.tsx:25-29`, `src/client/register/workspace-patch.utils.ts:52,63-64`); the official danger styling is overridden to a neutral menu item via a plugin attribute hook plus `!important` (`src/client/styles/workspace-menu.cssr.ts:6`).
- Official row/menu recognition: only official `itemWrap`-structured primitives entries are recognised, and workspace rows are matched by the official row title (`workspace-patch.utils.ts:13,32,52`).
- Official service surface: `src/client/types/runtime.ts:24-29` declares the official sessions (list subscription, refresh, open, bind, fork) and workspaces surfaces; `open` moved in kernel 0.1.7 and is restored by this repo's adapter instead of being re-implemented.
- Official archive action mirroring: a session archived through the official menu appears in this package's page immediately (`src/client/hooks/use-archive-view.ts:15`).

Deliberate difference:

- The official entry only unarchives; this package's "Archived chats" page adds search, sort, grouping, project filter, delete, and a "delete workspace" action rewritten into "archive workspace".

## Compatibility `0.2.0-rc.2` → `0.2.1-alpha.1`

- The sessions and workspaces integration still delegates to official services. Optional draft initialization on `uiWorkspace.startSession` does not replace the adapter open path.
- The official workspace menu and row shapes used by the archive-entry patch remain compatible; no removed invariant export is imported.

## License

```text
MIT License

Copyright (c) 2026 DeepSeek

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
