# Third-party notices

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.1-alpha.1`
- Revision: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Source: `source/deepseek-harness`
- Catalog pin: `dsh:` → `0.2.1-alpha.1` (`pnpm-workspace.yaml`)
- License: MIT — Copyright (c) 2026 DeepSeek
- Not copied: the per-turn Git snapshot and file restore path are this repo's own; only the input-dock chip mirrors the official deliverables row.

Mirrored official surface:

- Chip form and position: the "N files changed +x -y" chip reproduces the official deliverables row and disappears when the turn ends (`src/client/components/running-changes-chip.cssr.ts:7`).
- Count colours: `+N` green / `-M` red match the official deliverables row (`src/client/components/change-counts.tsx:5`, `src/client/styles/counts.cssr.ts:8`, `src/client/components/running-changes-chip.cssr.test.ts:26`).
- Dock order: the chip is ordered against the official dock rows (official `todo` = 0, `goal` = 10, `queue` = 20, worktree banner = -10); a negative order places it above the official task list and worktree banner (`src/client/constants/index.ts:12`, `src/client/register/running-chip.ts:5`).
- Official reference chips (`ctx.conversation.input` insertion path) → `src/client/register/paste-collapse.ts`: large pastes collapse into the official reference chip through the official public surface only.

## Compatibility `0.2.0-rc.2` → `0.2.1-alpha.1`

- The reference-insertion, source-codec, and revision-guarded span contracts used by paste collapse remain available. This package does not override the removed composer `stats` registration.
- The independent `activity` and `usage` dock entries are supplied by the target core; the running-changes chip keeps its separate registration and order.

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
