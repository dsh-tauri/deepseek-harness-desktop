# Third-party notices

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.1-alpha.1`
- Revision: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Source: `source/deepseek-harness`
- License: MIT — Copyright (c) 2026 DeepSeek

Derived (upstream → this package):

- `apps/desktop/src/main.ts` — `platformLoginUrl()`, `welcomeBackend.account.watch(...)`, `shell.openExternal(...)` while `attempt.phase === 'waiting-browser'` → `src/client/register/account.ts`: the watch → open flow, run in the embedded UI and opened through the shell's `open_external_url`.
- `packages/client/ui-settings-account/src/client/index.ts` — `ctx.remote.$stream({ name: 'account', open: signal => ctx.remote.account.watch(signal) })` consuming `frame.value` / `frame.accept()`, gated by `'dshDesktop' in globalThis` → `src/client/register/account.ts`: the account-stream consumption pattern and carrier gate.
- `apps/desktop/src/preload-app.ts` — `contextBridge.exposeInMainWorld('dshDesktop', <app origin> ? createProductApi() : { protocolVersion: 1 })` → `src/host/apply.ts`: the carrier marker; `protocolVersion: 1` plus `deviceInfo()` returning `navigator.userAgent` are published, no Electron product API (`browser`, `updates`) is faked.
- `packages/host/webserver` — structured index-injection rows (`global`, `script`, `script-src`, …) → `src/host/types/harness.ts` (`IndexInjectRow`; upstream exports the same union as `IndexInjection`).
- `apps/desktop/src/main.ts` — `app.setAsDefaultProtocolClient('dsh')` + `open-url` handling that focuses the primary window for `dsh://open` → `src-tauri/src/desktop/deep_link.rs` (app shell).

Not derived:

- `src/host/service/gate.ts` adapts this repo's embedded-WebView authentication constraints; upstream only defines the `connection` gate semantics it overrides.

Note:

- The account-stream carrier gate and the sidebar/DOM contracts mirrored here survived `0.2.0-rc.1` → `0.2.0-rc.2` unchanged; `dshDesktop` still reports `protocolVersion: 1` with the optional `deviceInfo` member, and `DESKTOP_HOST_PROTOCOL_VERSION` stays `4`.

## Compatibility `0.2.0-rc.2` → `0.2.1-alpha.1`

- The account watch, carrier marker, index injection union, and connection authentication gates remain unchanged from `0.2.0-rc.2` to `0.2.1-alpha.1`.
- The target still uses desktop product protocol `1` and desktop host protocol `4`; no Electron product API is added to the Tauri marker.

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

## primer/primitives

- Repository: <https://github.com/primer/primitives>
- Revision: `f48bc063f7bc0fb3e447386a8c259650ce46dea8`
- License: MIT — Copyright (c) 2018 GitHub Inc.
- Derived: GitHub palette constants in `src/shared/appearance.ts`, from `src/tokens/base/color/{dark,light}` and `src/tokens/functional/color/{bgColor,fgColor,borderColor}.json5`.
- Adaptation: GitHub Dimmed uses the standard GitHub light palette in light mode. Its dark link blue is brightened to meet 4.5:1 on all three DSH surfaces. High Contrast text meets 7:1 on opaque palette surfaces; transparency depends on the background behind the window. Only color constants are bundled, with no Primer runtime dependency.

```text
The MIT License (MIT)

Copyright (c) 2018 GitHub Inc.

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
