# Third-party notices

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.1-alpha.1`
- Revision: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Source: `source/deepseek-harness`
- Catalog pin: `dsh:` → `0.2.1-alpha.1` (`pnpm-workspace.yaml`)
- License: MIT — Copyright (c) 2026 DeepSeek
- Not copied: a Tauri-flavoured refork of the official client UI — official components are re-exported as-is where both kernel generations agree, reforked locally where only the newer kernel implements or exports them; no official source file is vendored.

Derived (upstream → this package):

- `packages/client/ui-primitives/src/` (version `0.1.7-alpha.1`, ≥ `0.1.5-rc.1`) → `src/client/components/official.tsx`: pass-through re-export of `Button`, `Switch`, `Tag`, `Pill`, `Menu`, `Input`, `Tooltip`, `Toast`, `Modal`, `HoverCard`, `DisclosureRow`, `StateDot`, `ConnectionIndicator`, `BrandWordmark`, `FishLogo`; `Button` / `Tag` are taken over per-variant by `button.tsx` / `tag.tsx` (official variant → official implementation, local variant → refork style).
- `packages/client/ui-primitives/src/` icons barrel → deliberately not re-exported (export names differ between kernel generations).
- `packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css` → `src/client/ui/panel-page.cssr.ts`, `src/client/ui/panel-page.tsx`: the plugin panel is laid out line-by-line on the official plugin page geometry.
- `packages/client/ui-sidebar`, `ui-workspace`, `ui-chat`, `ui-settings-models`, `ui-agent-preset`, `ui-permission-presets`, `ui-goal` CSS Modules → `src/client/components/registry.ts` (`UI_COMPONENT_REGISTRY`, `kind: 'reexport' | 'refork'`, `mappedClass`) plus `src/client/components/*.cssr.ts`: reforked geometry and official class mapping on this repo's `css-render` stack; official `.module.css` files are not copied.
- Official sidebar branding row and its collapse toggle → `src/client/styles/global.cssr.ts`: hiding rule for the duplicated official entry, keyed off the official class shape (`clsx(brand, wide)`) and `aria-label` dictionaries instead of hashed class names.
- Official slot `conversation.hero.workspace` (single/root, declared by `ui-workspace`, official `WorkspacePicker` at default priority) → `src/client/register/hero-workspace.ts`, `src/client/ui/hero-workspace.*`: takeover at a lower priority so the official registration stays in place; the official `WorkspacePickFlow` "add workspace" item id is reused verbatim.
- Official settings launcher seat (`ui-settings-general` `SettingsRoot` rendering the account menu) → `src/client/constants/index.ts` (`SETTINGS_TRIGGER_PRIORITY`), `src/client/ui/settings-trigger.tsx`: seat takeover keeping a host for the official account UI, plus the official dictionary strings for the sidebar "new session" button and the ungrouped workspace-group `+` (`new-session.utils.ts`, official `UNGROUPED_KEY`).
- Official primitives variants `PermissionRow.selector`, `PermissionSelect`, `AgentPresetSeat` → `src/client/components/chip.tsx`: per-variant wrapping and the official `@container` query that `css-render` can only emit as a top-level raw rule.

## hongweifei/dsh-chat-content-visibility-auto

- Repository: <https://github.com/hongweifei/dsh-chat-content-visibility-auto>
- Version: `1.0.0`
- License: MIT — Copyright (c) 2026 dsh-chat-content-visibility-auto contributors
- Not vendored, not installed: the external client plugin stays out of this repo's manifests. Its converged windowing rule — `content-visibility: auto` + `contain-intrinsic-size: auto 320px` on `[data-chat-flow] > [data-chat-anchor-key]` — is reimplemented on this repo's own `css-render` stack in `src/client/styles/global.cssr.ts`, keyed off the official chat DOM contract (`ChatView` column `[data-chat-flow]` → node rows `[data-chat-anchor-key]`).

## Compatibility `0.2.0-rc.2` → `0.2.1-alpha.1`

- The official primitives re-exports receive the StateDot restart fix without a local fork. InlineEditor is additive; no existing primitive export used here is removed.
- The target adds the optional `shell.bottom` seat without changing the settings launcher, hero workspace, or panel seats used here. The composer `stats` split has no local replacement registration.

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
