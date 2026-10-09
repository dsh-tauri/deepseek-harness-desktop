# Third-party notices

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.1-alpha.1`
- Revision: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Source: `source/deepseek-harness`
- Catalog pin: `dsh:` → `0.2.1-alpha.1` (`pnpm-workspace.yaml`)
- License: MIT — Copyright (c) 2026 DeepSeek
- Not copied: the per-session Git worktree is this repo's own feature; only the official Host and client contracts below are relied on.

Integration points:

- Official session title: `sessionTitle.refresh()` is the explicit entry point when the kernel's automatic title generation did not run, right after the first request header lands; its absence or failure never affects the task (`src/host/service/title.ts:21`, `src/host/events/session-event.ts:9`).
- Official attachments service: attachment descriptors are handed back to the official collection, and a missing capability only falls back, never blocks (`src/client/service/attachments.ts:5`, `src/client/service/attachments.test.ts:115`).
- Official composer DOM: send interception depends on the official composer's private DOM because no pre-submit hook exists (`src/client/components/mode-select.tsx:104`); file uploads wait for readiness exactly as the official composer disables send while it is not ready.
- Ordinary session titles: refreshed once per session via the official entry, matching the kernel's own timing.

## Compatibility `0.2.0-rc.2` → `0.2.1-alpha.1`

- The target preserves semantic drafts as text plus reference identities. Worktree transfer and rollback now capture the resident input shell draft before clearing the source, restore the complete semantic document, and flush the mounted persistence action when present.
- Structured input is detected by `SessionInputShell.draftSnapshot`; when the composer exposes `persistDraft` but its semantic snapshot is unavailable, transfer stops before creating the target or clearing the source. Old kernels retain the plain-text action path. Attachments remain under their existing owner and retain the existing capture/recreate/upload checks.
- Ordinary reference insertion is not used to replay saved references: its spans use detect coordinates and it may append a space, whereas saved draft spans use clipboard coordinates.

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
