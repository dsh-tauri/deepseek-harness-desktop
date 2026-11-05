pub mod activation;
pub mod autostart;
pub mod builder;
pub mod deep_link;
#[cfg(unix)]
pub mod login_path;
pub mod payload;
pub mod pet;
pub mod pet_mouse;
#[cfg(all(windows, any(not(debug_assertions), test)))]
pub(crate) mod single_instance;
pub mod startup;
pub mod window;
pub mod zoom;

pub use builder::{builder, handler, setup, tray};

pub fn product_name<R: tauri::Runtime>(app: &crate::AppHandle<R>) -> &str {
    app.config()
        .product_name
        .as_deref()
        .unwrap_or(&app.package_info().name)
}

#[cfg(test)]
mod tests {
    use super::product_name;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn native_product_name_uses_the_build_config() {
        for name in ["DSH Tauri", "DSH Tauri Nightly"] {
            let mut context = mock_context(noop_assets());
            context.config_mut().product_name = Some(name.into());
            let app = mock_builder().build(context).unwrap();
            assert_eq!(product_name(app.handle()), name);
        }
    }

    #[test]
    fn native_product_name_falls_back_to_the_package_name() {
        let mut context = mock_context(noop_assets());
        context.config_mut().product_name = None;
        let app = mock_builder().build(context).unwrap();
        assert_eq!(product_name(app.handle()), app.package_info().name);
    }
}
