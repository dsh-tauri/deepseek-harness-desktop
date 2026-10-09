# Third-party notices

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.1-alpha.1`
- Revision: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Source: `source/deepseek-harness`
- License: MIT — Copyright (c) 2026 DeepSeek

Derived (upstream `packages/client/ui-settings-models/` → this package `src/`):

- `src/index.ts` → `host/apply.ts`
- `src/onboarding-config.ts`, `src/onboarding-copy.ts` → `shared/onboarding-config.ts`, `shared/onboarding-copy.ts`
- `src/client/index.ts` → `client/register/models.ts`, `client/index.ts`
- `src/client/ModelsSection.tsx` → `client/models/ModelsSection.tsx`
- `src/client/DeepSeekModelsEditor.tsx` → `client/models/DeepSeekModelsEditor.tsx`
- `src/client/DeepSeekOnboardingDialog.tsx` → `client/models/DeepSeekOnboardingDialog.tsx`
- `src/client/ProviderEditor.tsx` → `client/models/ProviderEditor.tsx`
- `src/client/CustomProviderCard.tsx` → `client/models/CustomProviderCard.tsx`
- `src/client/ModelListEditor.tsx`, `ModelRow.tsx`, `ModelInputTypes.tsx`, `EditorFooter.tsx` → `client/models/` (same names)
- `src/client/OnboardingModal.tsx`, `WelcomeNotice.tsx` → `client/models/` (same names)
- `src/client/apiKey.ts`, `protocol-label.ts`, `operations.ts`, `schema-operations.ts`, `slot-contract.ts`, `store.ts`, `welcome-store.ts`, `locales.ts` → `client/models/` (same names)

Synced `0.2.0-rc.1` → `0.2.0-rc.2`:

- `ui-settings-models/` — this package's derived source — carries no code change across the range; only its `package.json` version string moves.
- The release's third-party model-catalog and compatibility refresh (`pi-ai` 0.87.1) needs nothing here: no `pi-ai` compat field is named in this package (`deferredToolsMode`, `supportsToolReferences`, `supportsMidConvo*`, `sessionAffinityFormat`, `mistral-conversations` are all absent), `model-compat.ts` keeps writing `thinkingFormat` / `chatTemplateKwargs` / `supportsDeveloperRole`, and the preset catalog is sourced from the live LiteLLM index instead of `pi-ai`'s bundled model ids.
- `ModelListEditor.tsx`: the fetched-model picker takes the release's model-picker search posture. `rankByName` from `@deepseek-ai/dsh-client-ui-primitives` replaces the substring filter, and the search field gains ArrowUp / ArrowDown (wrapping), Home / End, Enter to toggle the active row, and Escape to close, with the active row scrolled into view and highlighted.

Synced `0.1.7-alpha.1` → `0.1.7-rc.2`:

- `store.ts`: the account route (`deepseek-account`) is joined out of the credential space — no `apiKeyEnv`, no credential read, availability from `session/modelCatalog()`; hidden while signed out; `providerUsable` answers through `accountAvailable`.
- `store.ts`: account and official routes sort first, in that order.
- `ModelsSection.tsx`: `needsSetup` never renders the account row as a setup card; the account row shows the localized `deepSeekAccount` name; the delete dialog's initial focus moves to `data-modal-autofocus`.
- `ProviderEditor.tsx` / `CustomProviderCard.tsx`: the account route edits only its model catalog (no key field, no credential describe); every key input uses `autoComplete="new-password"`.
- `ModelListEditor.tsx`: candidate ids carry `title={name ?? id}`.
- `register/models.ts` + `client/index.ts`: `remote.session` joins the inject list; `credentials/record-updated` refreshes the page; the internal-testing notice step is no longer registered on the desktop carrier.
- `styles.ts`: the upstream CSS token migration (radius scale, settings-card fill and stroke, focus-ring token, business-state ink) plus the candidate-id ellipsis.

Kept from upstream:

- The slot and remote contracts are unchanged: `settings.section`, `settings.onboarding`, `settings.models.sign-in`, the `llm-deepseek` settings namespace, and the `credentialOnboarding` gate published through the `webserver/index-inject` global.
- The `'dshDesktop' in globalThis` precondition of the official credential onboarding is preserved, so the local API-key flow never competes with the official account flow.
- The DeepSeek credential-onboarding step stays registered on the desktop carrier (upstream registers it there too); only its automatic posture is gated.

Re-implemented instead of copied:

- Styling runs on this repo's `css-render` stack (`client/models/styles.ts`, `client/models/styles.overrides.ts`); upstream `.module.css` files are not copied.
- `client/register/styles.ts`, `client/models/remote.ts`, `client/models/settings-forms.ts`, `client/types/remotes.ts`, `client/constants/index.ts` are this repo's own glue.

## Compatibility `0.2.0-rc.2` → `0.2.1-alpha.1`

- The derived `packages/client/ui-settings-models/src/` tree is byte-for-byte unchanged across this corridor, including onboarding, credential events, provider forms, model compatibility fields, and slots.
- The new Cordis release needs its matching Include, Loader, and Group peers. They are pinned in the workspace so the fork shares the same augmented `Context` as the official client packages.

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
