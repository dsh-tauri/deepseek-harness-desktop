//! 补丁层 YAML 的整份读写。serde_yaml 把 `!!js` 解析成 `tag:yaml.org,2002:js`，
//! 既不当核心类型也不留成 `Value::Tagged`，直接降成普通字符串，回写后 loader 只会
//! 拿到字面量。解析时把 `!!` 句柄映射到私有前缀，只给 `!!js` 节点保留标签，写回时还原。

use serde_yaml::Value;

const SECONDARY_HANDLE: &str = "%TAG !! !dsh-secondary-\n";
const JS_TAG: &str = "!dsh-secondary-js";

pub(crate) fn parse_patch_layer(raw: &str) -> Result<Value, serde_yaml::Error> {
    let plain = serde_yaml::from_str(raw)?;
    if !raw.contains("!!") {
        return Ok(plain);
    }
    let body = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let explicit_start = body
        .lines()
        .find(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .is_some_and(|line| {
            line.starts_with('%')
                || line
                    .strip_prefix("---")
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '\t']))
        });
    let remapped = if explicit_start {
        format!("{SECONDARY_HANDLE}{body}")
    } else {
        format!("{SECONDARY_HANDLE}---\n{body}")
    };
    Ok(keep_js_tags(plain, serde_yaml::from_str(&remapped)?))
}

pub(crate) fn render_patch_layer(value: &Value) -> Result<String, serde_yaml::Error> {
    serde_yaml::to_string(value).map(|rendered| rendered.replace(JS_TAG, "!!js"))
}

fn keep_js_tags(plain: Value, tagged: Value) -> Value {
    match (plain, tagged) {
        (plain, Value::Tagged(mut node)) if node.tag == JS_TAG => {
            node.value = plain;
            Value::Tagged(node)
        }
        (Value::Sequence(plain), Value::Sequence(tagged)) => Value::Sequence(
            plain
                .into_iter()
                .zip(tagged)
                .map(|(plain, tagged)| keep_js_tags(plain, tagged))
                .collect(),
        ),
        (Value::Mapping(plain), Value::Mapping(tagged)) => Value::Mapping(
            plain
                .into_iter()
                .zip(tagged)
                .map(|((key, plain), (_, tagged))| (key, keep_js_tags(plain, tagged)))
                .collect(),
        ),
        (Value::Tagged(mut plain), Value::Tagged(tagged)) => {
            plain.value = keep_js_tags(plain.value, tagged.value);
            Value::Tagged(plain)
        }
        (plain, _) => plain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rewrite(raw: &str) -> String {
        render_patch_layer(&parse_patch_layer(raw).unwrap()).unwrap()
    }

    #[test]
    fn rewrite_keeps_js_expressions() {
        assert_eq!(
            rewrite("- id: x\n  name: !!js \"process.env.X ? 'a' : 'b'\"\n  config:\n    token: !!js process.env.TOKEN\n    port: !!js 0x10\n    dirs:\n      - !!js process.cwd()\n"),
            "- id: x\n  name: !!js 'process.env.X ? ''a'' : ''b'''\n  config:\n    token: !!js process.env.TOKEN\n    port: !!js '0x10'\n    dirs:\n    - !!js process.cwd()\n"
        );
    }

    #[test]
    fn other_secondary_tags_keep_plain_values() {
        let parsed = parse_patch_layer("- !!str 123\n- !!int '7'\n").unwrap();
        assert_eq!(
            parsed,
            Value::Sequence(vec![Value::String("123".into()), Value::Number(7.into())])
        );
    }

    #[test]
    fn local_tags_keep_nested_js_expressions() {
        assert_eq!(
            rewrite("- !custom {a: !!js y}\n"),
            "- !custom\n  a: !!js y\n"
        );
    }

    #[test]
    fn document_markers_and_bom_keep_js_expressions() {
        for raw in [
            "---\n- !!js a\n",
            "# c\n--- # start\n- !!js a\n",
            "%YAML 1.1\n---\n- !!js a\n",
            "\u{feff}- !!js a\n",
            "\u{feff}# c\n---\n- !!js a\n",
        ] {
            assert_eq!(rewrite(raw), "- !!js a\n", "{raw:?}");
        }
    }

    #[test]
    fn layers_without_secondary_tags_parse_like_serde_yaml() {
        for raw in [
            "# comment only\n",
            "[]\n",
            "- !custom {a: 1}\n",
            "- id: x\n",
        ] {
            assert_eq!(
                parse_patch_layer(raw).unwrap(),
                serde_yaml::from_str::<Value>(raw).unwrap(),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn syntax_errors_report_the_original_line() {
        let error =
            parse_patch_layer("- id: a\n  config:\n    token: !!js process.env.T ? a : b\n")
                .unwrap_err();
        assert_eq!(error.location().map(|location| location.line()), Some(3));
    }

    #[test]
    fn redefined_secondary_handle_is_refused() {
        assert!(parse_patch_layer("%TAG !! tag:yaml.org,2002:\n---\n- !!js a\n").is_err());
    }
}
