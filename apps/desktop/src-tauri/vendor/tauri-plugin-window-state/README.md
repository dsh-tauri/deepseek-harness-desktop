![plugin-window-state](https://github.com/tauri-apps/plugins-workspace/raw/v2/plugins/window-state/banner.png)

Save window positions and sizes and restore them when the app is reopened.

| Platform | Supported |
| -------- | --------- |
| Linux    | ✓         |
| Windows  | ✓         |
| macOS    | ✓         |
| Android  | x         |
| iOS      | x         |

## Install

_This plugin requires a Rust version of at least **1.90**_

There are three general methods of installation that we can recommend.

1. Use crates.io and npm (easiest, and requires you to trust that our publishing pipeline worked)
2. Pull sources directly from Github using git tags / revision hashes (most secure)
3. Git submodule install this repo in your tauri project and then use file protocol to ingest the source (most secure, but inconvenient to use)

Install the Core plugin by adding the following to your `Cargo.toml` file:

`src-tauri/Cargo.toml`

```toml
[dependencies]
tauri-plugin-window-state = "2.0.0"
# alternatively with Git:
tauri-plugin-window-state = { git = "https://github.com/tauri-apps/plugins-workspace", branch = "v2" }
```

You can install the JavaScript Guest bindings using your preferred JavaScript package manager:

```sh
pnpm add @tauri-apps/plugin-window-state
# or
npm add @tauri-apps/plugin-window-state
# or
yarn add @tauri-apps/plugin-window-state
```

## Usage

First you need to register the core plugin with Tauri:

`src-tauri/src/lib.rs`

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Afterwards all windows will remember their state when the app is being closed and will restore to their previous state on the next launch.

Optionally you can also tell the plugin to save the state of all open window to disk by using the `save_window_state()` method exposed by the `AppHandleExt` trait:

```rust
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

// `tauri::AppHandle` now has the following additional method
app.save_window_state(StateFlags::all()); // will save the state of all open windows to disk
```

or through Javascript

```javascript
import { saveWindowState, StateFlags } from '@tauri-apps/plugin-window-state'

saveWindowState(StateFlags.ALL)
```

To manually restore a windows state from disk you can call the `restore_state()` method exposed by the `WindowExt` trait:

```rust
use tauri_plugin_window_state::{WindowExt, StateFlags};

// all `Window` types now have the following additional method
window.restore_state(StateFlags::all()); // will restore the windows state from disk
```

or through Javascript

```javascript
import {
  restoreStateCurrent,
  StateFlags
} from '@tauri-apps/plugin-window-state'

restoreStateCurrent(StateFlags.ALL)
```

## Contributing

PRs accepted. Please make sure to read the Contributing Guide before making a pull request.

## Partners

<table>
  <tbody>
    <tr>
      <td align="center" valign="middle">
        <a href="https://crabnebula.dev" target="_blank">
          <img src="https://github.com/tauri-apps/plugins-workspace/raw/v2/.github/sponsors/crabnebula.svg" alt="CrabNebula" width="283">
        </a>
      </td>
    </tr>
  </tbody>
</table>

For the complete list of sponsors please visit our [website](https://tauri.app#sponsors) and [Open Collective](https://opencollective.com/tauri).

## License

Code: (c) 2015 - Present - The Tauri Programme within The Commons Conservancy.

MIT or MIT/Apache 2.0 where applicable.
