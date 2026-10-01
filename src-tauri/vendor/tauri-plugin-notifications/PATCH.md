# Vendored patch: native notifications and macOS build output

`tauri-plugin-notifications` **0.5.0-rc.14**, copied verbatim from crates.io and wired in via
`[patch.crates-io]` in `src-tauri/Cargo.toml`. Changes cover Windows notification behavior,
shared model accessors, and macOS Swift build output discovery.

## macOS build output

Swift build artifacts remain under Cargo's `OUT_DIR`. The build script queries
`swift build --show-bin-path` with the same scratch path, target triple and configuration
used for compilation, then verifies the static library exists before registering the link
search path. This supports both SwiftPM's architecture directories and newer Xcode build
layouts such as `out/Products/Debug` without assuming their directory structure.

`swift-rs` discovers the selected toolchain's Swift library search paths so compatibility
archives required by older macOS deployment targets are available to the Rust linker.

The application's `src-tauri/build.rs` also adds `/usr/lib/swift` to the executable's
runtime search paths so linked Swift libraries, including concurrency support, are resolved
from macOS when running the application or Rust tests.

## Why

The upstream Windows backend cannot express the two notification shapes the DSH shell needs,
and it never activates at all in an unpackaged build.

1. **No text box.** `Action::input` / `input_button_title` / `input_placeholder` are
   deserialised and documented in `README.md`, but `build_toast_xml()` only ever emitted
   `<action content=… arguments=… activationType=…>`. Nothing ever wrote an `<input>`, so a
   question notification rendered without a box to type into and without the 回复 button.

2. **Button identity is lost on a cold activation.** Actions carried the bare action id in
   `arguments=`, and the notification's session identity only ever lived in the toast's
   `launch=` attribute — which the out-of-process COM activator never receives. A click on a
   toast in Action Center while the app was closed therefore arrived as a bare action id,
   with no way back to the originating session.

3. **The COM activator was packaged-only, and registered on the wrong apartment.**

   ```rust
   if packaged && let Some(clsid_str) = windows_config.toast_activator_clsid {
   ```

   DSH is not MSIX-packaged, so `is_packaged()` is `false` and the branch never ran: the
   process registered no `INotificationActivationCallback`, Windows had no AUMID mapping to
   activate, and every click degraded to a plain shortcut launch with no payload. Even for a
   packaged app the registration happened on the caller's thread, which is Windows'
   `CoInitializeEx` returning `RPC_E_CHANGED_MODE`; `CoRegisterClassObject` binds a class to
   the *calling* apartment, and an STA serves activation calls only while it pumps messages.

4. **Replies could never reach JS.** The in-process `Activated` handler hardcoded
   `"inputValue": null` and never called `ToastActivatedEventArgs::UserInput()`, and it was
   attached only when a `notificationClicked` listener existed — so a subscriber that only
   listened for `actionPerformed` (the reply button) got no handler at all.

5. **Permission checks block the first unpackaged toast (desktop issue #812).**
   `ToastNotifier::Setting()` can return `ERROR_NOT_FOUND` (`0x80070490`) before Windows
   creates per-app notification settings for an unpackaged AUMID. The pre-send permission
   check then drops every toast, so the settings profile never gets created.

One toast click also reaches Windows through *two* independent routes — the in-process
`Activated` handler and the out-of-proc COM activator — so a naive fix delivers every click
twice.

## What changed

- `src/models.rs` — three accessors on `Action` so the XML builder can see the fields the
  frontend already sends: `input()`, `input_placeholder()`, `input_button_title()`.
- `Cargo.toml` — the Windows feature list gains `Foundation_Collections` (required by
  `ToastActivatedEventArgs::UserInput`), `Win32_Security` (required by `RegCreateKeyExW`) and
  `Win32_System_Registry` / `Win32_UI_WindowsAndMessaging`.
- `src/windows.rs`
  - `notification_permission()` — allows the first toast attempt only when an unpackaged
    notifier's settings query returns `ERROR_NOT_FOUND`. Explicit disabled settings remain
    denied; packaged apps and other failures still propagate their errors. Windows still
    controls actual delivery, and `show()` errors are not suppressed.
  - `input_element_id()` / `action_arguments()` — helpers for the `<input id>` naming scheme
    (`input-<action id>`) and for the JSON `arguments=` payload.
  - `build_toast_xml()` — emits one `<input id="input-<action id>" type="text"
    placeHolderContent=…>` per `action.input()` **before** the `<action>` elements (Windows
    only accepts a `hint-inputId` that already exists), sets `hint-inputId` on the submitting
    action, captions that button from `input_button_title()`, and writes `arguments=` as
    `{"actionId": …, "data": <extra>}` so the session identity survives a cold activation.
  - `decode_activation()` — a new first branch decodes that JSON `arguments=` payload (the
    existing `is_object` heuristic would otherwise misread it as a body tap); the three legacy
    arms now carry `extra` too.
  - warm `Activated` handler — reads the typed text through `read_user_input()` and reports it
    as `inputValue`, derives button-vs-tap from the presence of `actionId` instead of
    `is_object`, and surfaces `extra` next to `notification`.
  - `activation_signature()` / `DELIVERED` / `claim_activation()` — collapse the
    in-process handler and the COM activator into exactly one event per click. Identical
    arguments within `DEDUP_WINDOW` (1500 ms) are considered the same activation; a poisoned
    lock or clock anomaly **fails open**, because a duplicate event is preferable to a
    silently swallowed click.
  - `show()` — attaches the in-process handler when *either* `notificationClicked` or
    `actionPerformed` has a listener.
  - `register_unpackaged_app_id()` — writes `HKCU\Software\Classes\AppUserModelId\<app_id>`
    (`DisplayName`, `IconUri`, `CustomActivator={CLSID}`) and
    `HKCU\Software\Classes\CLSID\{CLSID}\LocalServer32` = the current executable, which is the
    AUMID mapping an unpackaged build needs. `IconUri` uses the resolved PNG resource
    configured by `plugins.notifications.windows.iconPath`; Windows does not extract
    the toast header icon from an EXE. The resource is explicitly included in
    `bundle.resources`. Best-effort: failures are logged and the in-process path
    still works while the app is running.
  - `plain_icon_path()` — Tauri resolves `BaseDirectory::Resource` through
    `tauri_utils::platform::current_exe`, which canonicalizes the executable, and Windows
    canonicalization hands back the `\\?\` verbatim form. The toast platform silently ignores
    an `IconUri` in that form and renders the notification with no app logo, so the prefix is
    stripped (verbatim UNC mapped back to `\\server\share`) before the value is written.
    Without this, `iconPath` is configured correctly and still has no visible effect.
  - `spawn_toast_activator()` — register `ToastActivatorFactory` on a dedicated
    single-threaded-apartment thread that then blocks in `GetMessageW` /
    `TranslateMessage` / `DispatchMessageW` for the life of the process, and is registered
    whenever a CLSID is configured rather than only for packaged builds.

The CLSID itself comes from `src-tauri/tauri.conf.json`
(`plugins.notifications.windows.toastActivatorClsid`) and must stay in sync with any MSIX
manifest's `ToastActivatorCLSID` / `com:Class Id`.

## Tests

The crate is a member of the `src-tauri` workspace so its native unit tests share the
application's lockfile. Windows CI runs from `src-tauri`:

```sh
cargo test -p tauri-plugin-notifications --lib --no-default-features --locked
```

Disabling default features is required: `notify-rust` selects the alternative desktop
backend and excludes `src/windows.rs`, including its permission regression tests.

## Removal

Delete this directory and its `[patch.crates-io]` entry plus its comment and workspace
membership in `src-tauri/Cargo.toml`. Remove the Windows native notification test step from
`.github/workflows/ci.yml`. `Cargo.lock` regains the `source` + `checksum` lines for the
registry copy. Drop the `plugins.notifications` block in `src-tauri/tauri.conf.json` if
upstream also ships unpackaged registration.

Upstream issue: <https://github.com/Choochmeque/tauri-plugin-notifications/issues>
(text-box support and unpackaged activation; drop this directory once they ship).
