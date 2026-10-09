# Third-party notices

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.1-alpha.1`
- Revision: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Source: `source/deepseek-harness`
- Catalog pin: `dsh:` → `0.2.1-alpha.1` (`pnpm-workspace.yaml`)
- License: MIT — Copyright (c) 2026 DeepSeek
- Not copied: a development-only playground that renders the component registry of `dsh-tauri-ui`, so it shows — but does not copy — official client UI components.

Official surface referenced:

- Registry semantics: the `reexport` (official implementation forwarded as is, styles from the official CSS Modules) and `refork` (official CSS reproduced locally because only the newer kernel implements or exports the component) distinctions, including the official class each refork maps to (`src/client/ui/components-playground/ui-components.tsx:112,128-130,252`).
- Official `Menu`: wired into the chip triggers so selection state, chevron rotation and popover placement behave like the shipped UI (`ui-components.tsx:57`).
- Icons: two kernel generations export the official icons barrel under different names, so icons are consumed through `@gravity-ui/icons` re-exported by `dsh-tauri-ui/client` (`ui-components.tsx:262`).
- Derivation table of those official components: `packages/dsh-tauri-ui/THIRD_PARTY_NOTICES.md`.

## Compatibility `0.2.0-rc.2` → `0.2.1-alpha.1`

- The playground continues to consume the shared registry and official primitives through `dsh-tauri-ui/client`; the additive InlineEditor and shell seat need no local component migration.

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
