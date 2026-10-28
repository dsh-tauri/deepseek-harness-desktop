use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "serde_json::Value")]
pub struct Appearance {
    pub palette: String,
    pub terminal: bool,
    pub transparency: bool,
    pub opacity: u8,
    pub blur: bool,
    pub sidebar_only: bool,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            palette: "default".into(),
            terminal: false,
            transparency: false,
            opacity: 100,
            blur: false,
            sidebar_only: false,
        }
    }
}

impl From<serde_json::Value> for Appearance {
    fn from(value: serde_json::Value) -> Self {
        let opacity = value["opacity"]
            .as_f64()
            .filter(|value| value.is_finite())
            .map(|value| value.round().clamp(20.0, 100.0) as u8)
            .unwrap_or(100);
        let mut appearance = Self {
            palette: value["palette"].as_str().unwrap_or("default").to_owned(),
            terminal: value["terminal"].as_bool().unwrap_or(false),
            transparency: value
                .get("transparency")
                .map_or(opacity < 100, |value| value.as_bool().unwrap_or(false)),
            opacity,
            blur: value["blur"].as_bool().unwrap_or_else(|| {
                value["blur"]
                    .as_f64()
                    .is_some_and(|value| value.is_finite() && value > 0.0)
            }),
            sidebar_only: value["sidebarOnly"].as_bool().unwrap_or(false),
        };
        appearance.normalize();
        appearance
    }
}

impl Appearance {
    pub fn native_blur_enabled(&self) -> bool {
        self.transparency && self.blur
    }

    pub fn normalize(&mut self) {
        if !matches!(
            self.palette.as_str(),
            "default"
                | "nord"
                | "solarized"
                | "forest"
                | "amber"
                | "github"
                | "github-dimmed"
                | "github-high-contrast"
        ) {
            self.palette = "default".into();
        }
        self.opacity = self.opacity.clamp(20, 100);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_appearance_fields_preserve_the_original_window() {
        let appearance: Appearance = serde_json::from_str("{}").unwrap();
        assert_eq!(appearance, Appearance::default());
        assert_eq!(appearance.opacity, 100);
        assert!(!appearance.terminal);
    }

    #[test]
    fn transparency_migrates_once_and_is_independent_of_opacity() {
        for (value, expected) in [
            (serde_json::json!({"opacity": 70}), true),
            (
                serde_json::json!({"opacity": 70, "transparency": false}),
                false,
            ),
            (
                serde_json::json!({"opacity": 100, "transparency": true}),
                true,
            ),
            (
                serde_json::json!({"opacity": 70, "transparency": "true"}),
                false,
            ),
        ] {
            let appearance: Appearance = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(appearance.transparency, expected, "{value}");
            let saved = serde_json::to_value(&appearance).unwrap();
            assert_eq!(saved["transparency"], expected);
            assert_eq!(
                serde_json::from_value::<Appearance>(saved).unwrap(),
                appearance
            );
        }
        let appearance: Appearance =
            serde_json::from_value(serde_json::json!({"sidebarOnly": true})).unwrap();
        assert!(appearance.sidebar_only);
        assert_eq!(
            serde_json::to_value(appearance).unwrap()["sidebarOnly"],
            true
        );
    }

    #[test]
    fn opacity_decoding_rounds_and_clamps_numeric_values() {
        for (value, expected) in [
            (serde_json::json!(77.49), 77),
            (serde_json::json!(77.5), 78),
            (serde_json::json!(20), 20),
            (serde_json::json!(100), 100),
            (serde_json::json!(-300), 20),
            (serde_json::json!(300), 100),
            (serde_json::json!(1e300), 100),
        ] {
            let appearance: Appearance = serde_json::from_value(serde_json::json!({
                "opacity": value
            }))
            .unwrap();
            assert_eq!(appearance.opacity, expected, "{value}");
        }
    }

    #[test]
    fn blur_decoding_accepts_the_switch_and_migrates_positive_preview_values() {
        for (value, expected) in [
            (serde_json::json!(false), false),
            (serde_json::json!(true), true),
            (serde_json::json!(-1), false),
            (serde_json::json!(0), false),
            (serde_json::json!(1), true),
            (serde_json::json!(40), true),
        ] {
            let appearance: Appearance = serde_json::from_value(serde_json::json!({
                "blur": value
            }))
            .unwrap();
            assert_eq!(appearance.blur, expected, "{value}");
        }
    }

    #[test]
    fn native_blur_requires_both_window_transparency_and_the_blur_switch() {
        for (transparency, blur, expected) in [
            (false, false, false),
            (false, true, false),
            (true, false, false),
            (true, true, true),
        ] {
            let appearance = Appearance {
                transparency,
                blur,
                ..Default::default()
            };
            assert_eq!(appearance.native_blur_enabled(), expected);
        }
    }

    #[test]
    fn invalid_opacity_preserves_the_other_appearance_fields() {
        for value in [
            serde_json::json!(null),
            serde_json::json!("70"),
            serde_json::json!(true),
            serde_json::json!([]),
            serde_json::json!({}),
        ] {
            let appearance: Appearance = serde_json::from_value(serde_json::json!({
                "palette": "nord", "terminal": true, "opacity": value
            }))
            .unwrap();
            assert_eq!(
                appearance,
                Appearance {
                    palette: "nord".into(),
                    terminal: true,
                    opacity: 100,
                    ..Default::default()
                },
                "{value}"
            );
        }
    }

    #[test]
    fn github_palettes_survive_saving_and_reloading() {
        for palette in ["github", "github-dimmed", "github-high-contrast"] {
            let appearance: Appearance = serde_json::from_value(serde_json::json!({
                "palette": palette, "terminal": true, "transparency": true,
                "opacity": 78, "blur": true, "sidebarOnly": true
            }))
            .unwrap();
            assert_eq!(appearance.palette, palette);
            let saved = serde_json::to_value(&appearance).unwrap();
            assert_eq!(
                serde_json::from_value::<Appearance>(saved).unwrap(),
                appearance
            );
        }
    }

    #[test]
    fn invalid_palette_and_opacity_are_normalized() {
        let mut appearance = Appearance {
            palette: "unknown".into(),
            terminal: true,
            opacity: 0,
            ..Default::default()
        };
        appearance.normalize();
        assert_eq!(appearance.palette, "default");
        assert_eq!(appearance.opacity, 20);
        assert!(!appearance.blur);
        assert!(appearance.terminal);
        appearance.opacity = 255;
        appearance.normalize();
        assert_eq!(appearance.opacity, 100);
    }
}
