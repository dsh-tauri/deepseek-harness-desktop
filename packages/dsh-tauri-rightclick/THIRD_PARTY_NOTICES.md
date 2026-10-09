# Third-party notices

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.1-alpha.1`
- Revision: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Source: `source/deepseek-harness`
- Catalog pin: `dsh:` → `0.2.1-alpha.1` (`pnpm-workspace.yaml`)
- License: MIT — Copyright (c) 2026 DeepSeek
- Not copied: the native-style context menu is this repo's own feature; where an action exists officially it is delegated to the official implementation first, with the plugin's own path as fallback.

Integration points:

- Official primitives popovers: menus and toasts run on the official primitives `Menu`; the plugin adds host capabilities and extra items (`src/client/register/context-menu.tsx:46`), and shortcut hints reuse the official menu item shape that accepts `ReactNode` (`context-menu.tsx:32`).
- Official actions first: rename, archive and fork call the official implementation with the service instance as receiver and fall back only when unavailable (`src/client/service/menu.ts:43,63,102,111`); pinning is offered only when the kernel provides it (0.1.7+), older kernels hide the entry (`menu.ts:77,90`).
- Official menu/row location: menu items and inline row action buttons are located through their official text and ARIA shape (`src/client/register/official-menu.ts:8`, `src/client/register/locate.ts:40,107`), including the official React-rendered action button that appears after hover.
- Official service surface: `src/client/types/index.ts:21,29,33` extends the official sessions / workspaces services with the capabilities this menu needs (`open` was removed in kernel 0.1.7 and is restored by the adapter compat bridge; the pinned-session set exists from 0.1.7).

## Compatibility `0.2.0-rc.2` → `0.2.1-alpha.1`

- The workspace navigation change adds optional draft initialization to `startSession`; session open, archive, fork, pinning, and official primitives menu shapes used here remain compatible.

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
