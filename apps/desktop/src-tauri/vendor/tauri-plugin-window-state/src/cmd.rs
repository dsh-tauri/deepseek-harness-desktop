// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use crate::{AppHandleExt, StateFlags, WindowExt};
use tauri::{AppHandle, Manager, Runtime, command};

fn get_state_flags<R: Runtime>(
    app: &AppHandle<R>,
    flags: Option<u32>,
) -> std::result::Result<StateFlags, String> {
    let flags = if let Some(flags) = flags {
        StateFlags::from_bits(flags).ok_or_else(|| format!("Invalid state flags bits: {flags}"))?
    } else {
        let plugin_state = app.state::<crate::PluginState>();
        plugin_state.state_flags
    };
    Ok(flags)
}

#[command]
pub async fn save_window_state<R: Runtime>(
    app: AppHandle<R>,
    flags: Option<u32>,
) -> std::result::Result<(), String> {
    let flags = get_state_flags(&app, flags)?;
    app.save_window_state(flags).map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn restore_state<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    flags: Option<u32>,
) -> std::result::Result<(), String> {
    let flags = get_state_flags(&app, flags)?;
    app.get_webview_window(&label)
        .ok_or_else(|| format!("Couldn't find window with label: {label}"))?
        .restore_state(flags)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub fn filename<R: Runtime>(app: AppHandle<R>) -> String {
    app.filename()
}
