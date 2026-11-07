use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const HEADER_BYTES: u64 = 16;
const DATA_OFFSET_BASE: u64 = 8;

struct Entry {
    offset: u64,
    size: u64,
    unpacked: bool,
}

struct Catalog {
    tree: Value,
    data_start: u64,
}

const CATALOG_CACHE_LIMIT: usize = 4;

static CATALOGS: Mutex<Option<HashMap<PathBuf, (u64, u64, std::sync::Arc<Catalog>)>>> =
    Mutex::new(None);

fn stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos() as u64;
    Some((meta.len(), modified))
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn parse(path: &Path) -> Option<Catalog> {
    let mut file = File::open(path).ok()?;
    let mut header = [0u8; HEADER_BYTES as usize];
    file.read_exact(&mut header).ok()?;
    let header_size = u64::from(read_u32(&header, 4)?);
    let json_len = u64::from(read_u32(&header, 12)?);
    let length = file.metadata().ok()?.len();
    if read_u32(&header, 0)? != 4
        || header_size < 8
        || json_len == 0
        || json_len > header_size - 8
        || DATA_OFFSET_BASE.checked_add(header_size)? > length
    {
        return None;
    }
    let mut json = vec![0u8; usize::try_from(json_len).ok()?];
    file.seek(SeekFrom::Start(HEADER_BYTES)).ok()?;
    file.read_exact(&mut json).ok()?;
    let tree: Value = serde_json::from_slice(&json).ok()?;
    let data_start = DATA_OFFSET_BASE + header_size;
    if !valid_entries(&tree, length - data_start) {
        return None;
    }
    Some(Catalog { tree, data_start })
}

fn valid_entries(node: &Value, data_length: u64) -> bool {
    if let Some(files) = node.get("files").and_then(Value::as_object) {
        return files
            .values()
            .all(|entry| valid_entries(entry, data_length));
    }
    if node.get("unpacked").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if let Some(link) = node.get("link") {
        return link.as_str().is_some_and(|target| !target.is_empty());
    }
    node.get("offset")
        .and_then(Value::as_str)
        .and_then(|offset| offset.parse::<u64>().ok())
        .zip(node.get("size").and_then(Value::as_u64))
        .is_some_and(|(offset, size)| {
            offset
                .checked_add(size)
                .is_some_and(|end| end <= data_length)
        })
}

fn catalog(path: &Path) -> Option<std::sync::Arc<Catalog>> {
    let key = stamp(path)?;
    let mut guard = CATALOGS.lock().unwrap_or_else(|error| error.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some((length, modified, catalog)) = cache.get(path) {
        if (*length, *modified) == key {
            return Some(catalog.clone());
        }
    }
    let catalog = std::sync::Arc::new(parse(path)?);
    if cache.len() >= CATALOG_CACHE_LIMIT {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), (key.0, key.1, catalog.clone()));
    Some(catalog)
}

fn entry_at(tree: &Value, relative: &str) -> Option<Entry> {
    let mut node = tree.get("files")?.as_object()?;
    let segments: Vec<&str> = relative
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .collect();
    let (last, parents) = segments.split_last()?;
    for segment in parents {
        node = node.get(*segment)?.get("files")?.as_object()?;
    }
    let entry: &Map<String, Value> = node.get(*last)?.as_object()?;
    let size = entry.get("size")?.as_u64()?;
    let offset = entry
        .get("offset")?
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| entry.get("offset").and_then(Value::as_u64))?;
    Some(Entry {
        offset,
        size,
        unpacked: entry.get("unpacked").and_then(Value::as_bool) == Some(true),
    })
}

fn split_asar_path(path: &Path) -> Option<(PathBuf, String)> {
    let archive = super::runtime::asar_ancestor(path)?;
    let inner = path.strip_prefix(archive).ok()?;
    let inner = inner
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/");
    Some((archive.to_path_buf(), inner))
}

pub fn contains(path: &Path) -> bool {
    let Some((archive, inner)) = split_asar_path(path) else {
        return false;
    };
    catalog(&archive).is_some_and(|catalog| entry_at(&catalog.tree, &inner).is_some())
}

pub fn read_file(path: &Path) -> Option<Vec<u8>> {
    let (archive, inner) = split_asar_path(path)?;
    let catalog = catalog(&archive)?;
    let entry = entry_at(&catalog.tree, &inner)?;
    if entry.unpacked {
        return None;
    }
    let mut file = File::open(&archive).ok()?;
    let start = catalog.data_start.checked_add(entry.offset)?;
    if start.checked_add(entry.size)? > file.metadata().ok()?.len() {
        return None;
    }
    let mut buffer = vec![0u8; usize::try_from(entry.size).ok()?];
    file.seek(SeekFrom::Start(start)).ok()?;
    file.read_exact(&mut buffer).ok()?;
    Some(buffer)
}

pub fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&read_file(path)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_entry(tree: &mut Map<String, Value>, relative: &str, entry: Value) {
        let segments: Vec<&str> = relative.split('/').filter(|s| !s.is_empty()).collect();
        let (last, parents) = segments.split_last().unwrap();
        let mut node = tree;
        for segment in parents {
            node = node
                .entry((*segment).to_string())
                .or_insert_with(|| serde_json::json!({ "files": {} }))
                .get_mut("files")
                .and_then(Value::as_object_mut)
                .expect("directory node");
        }
        node.insert((*last).to_string(), entry);
    }

    fn write_archive(path: &Path, files: &[(&str, &[u8])]) {
        write_archive_with_links(path, files, &[]);
    }

    fn write_archive_with_links(path: &Path, files: &[(&str, &[u8])], links: &[(&str, &str)]) {
        let mut data: Vec<u8> = Vec::new();
        let mut tree = Map::new();
        for (name, content) in files {
            let offset = data.len();
            data.extend_from_slice(content);
            insert_entry(
                &mut tree,
                name,
                serde_json::json!({ "size": content.len(), "offset": offset.to_string() }),
            );
        }
        for (name, target) in links {
            insert_entry(&mut tree, name, serde_json::json!({ "link": target }));
        }
        let json = serde_json::to_vec(&serde_json::json!({ "files": tree })).unwrap();
        let header_size = json.len() + 8 + (4 - json.len() % 4) % 4;
        let mut out = Vec::new();
        out.extend_from_slice(&4u32.to_le_bytes());
        out.extend_from_slice(&(header_size as u32).to_le_bytes());
        out.extend_from_slice(&((header_size - 4) as u32).to_le_bytes());
        out.extend_from_slice(&(json.len() as u32).to_le_bytes());
        out.extend_from_slice(&json);
        out.resize(DATA_OFFSET_BASE as usize + header_size, 0);
        out.extend_from_slice(&data);
        std::fs::write(path, out).unwrap();
    }

    fn write_linux_arm_archive(path: &Path) {
        let links = [
            ("node_modules/.bin/acorn", "node_modules/acorn/bin/acorn"),
            (
                "node_modules/.bin/anthropic-ai-sdk",
                "node_modules/@anthropic-ai/sdk/bin/cli",
            ),
            (
                "node_modules/.bin/cordis",
                "node_modules/@deepseek-ai/cordis/bin.js",
            ),
            (
                "node_modules/.bin/dsh",
                "node_modules/@deepseek-ai/dsh/lib/bin.js",
            ),
            (
                "node_modules/.bin/dsoffice",
                "node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js",
            ),
            (
                "node_modules/.bin/is-docker",
                "node_modules/is-docker/cli.js",
            ),
            (
                "node_modules/.bin/is-inside-container",
                "node_modules/is-inside-container/cli.js",
            ),
            (
                "node_modules/.bin/js-yaml",
                "node_modules/js-yaml/bin/js-yaml.js",
            ),
            (
                "node_modules/.bin/node-which",
                "node_modules/which/bin/node-which",
            ),
            (
                "node_modules/.bin/pi-ai",
                "node_modules/@earendil-works/pi-ai/dist/cli.js",
            ),
            (
                "node_modules/.bin/semver",
                "node_modules/semver/bin/semver.js",
            ),
            (
                "node_modules/.bin/which-command",
                "node_modules/which-command/cli.js",
            ),
            ("node_modules/.bin/yaml", "node_modules/yaml/bin.mjs"),
            (
                "node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/.bin/cordis",
                "node_modules/@deepseek-ai/cordis/bin.js",
            ),
        ];
        let mut files: Vec<(&str, &[u8])> = links
            .iter()
            .map(|(_, target)| (*target, b"entry".as_slice()))
            .collect();
        files.push((
            "node_modules/@deepseek-ai/dsh/package.json",
            br#"{"name":"@deepseek-ai/dsh","version":"0.2.2-rc.1","bin":{"dsh":"lib/bin.js"}}"#,
        ));
        write_archive_with_links(path, &files, &links);
    }

    #[test]
    fn linux_arm_symlinks_do_not_hide_regular_manifest_and_entry() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("deepseek-harness-pkg-linux-arm64.asar");
        write_linux_arm_archive(&archive);
        let manifest = read_json(&archive.join("node_modules/@deepseek-ai/dsh/package.json"))
            .expect("regular manifest beside Linux package symlinks");
        assert_eq!(manifest["version"], "0.2.2-rc.1");
        let entry = archive.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        assert!(contains(&entry));
        assert_eq!(read_file(&entry).unwrap(), b"entry");
        let link = archive.join("node_modules/.bin/dsh");
        assert!(!contains(&link));
        assert!(read_file(&link).is_none());
    }

    #[test]
    fn linux_arm_symlinks_do_not_allow_truncated_payload() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("deepseek-harness-pkg-linux-arm64.asar");
        write_linux_arm_archive(&archive);
        let entry = archive.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        assert!(contains(&entry));
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&archive)
            .unwrap();
        file.set_len(file.metadata().unwrap().len() - 1).unwrap();
        assert!(!contains(&entry));
        assert!(read_file(&entry).is_none());
        assert!(read_json(&archive.join("node_modules/@deepseek-ai/dsh/package.json")).is_none());
    }

    #[test]
    fn malformed_link_metadata_is_rejected() {
        for target in [Value::Null, serde_json::json!(7), serde_json::json!("")] {
            assert!(!valid_entries(&serde_json::json!({ "link": target }), 0));
        }
    }

    #[test]
    fn truncated_archive_is_not_present_even_when_its_header_survives() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("core.asar");
        write_archive(&archive, &[("package.json", b"{}"), ("bin.js", b"entry")]);
        assert!(contains(&archive.join("bin.js")));
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&archive)
            .unwrap();
        file.set_len(file.metadata().unwrap().len() - 1).unwrap();
        assert!(!contains(&archive.join("bin.js")));
        assert!(!contains(&archive.join("package.json")));
    }

    #[test]
    fn reads_files_and_resolves_nested_entries_from_a_real_archive() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("core.asar");
        write_archive(
            &archive,
            &[
                ("package.json", br#"{"name":"pkg"}"#),
                (
                    "node_modules/@deepseek-ai/dsh/package.json",
                    br#"{"version":"0.2.2-rc.1"}"#,
                ),
            ],
        );

        let inside = archive.join("node_modules/@deepseek-ai/dsh/package.json");
        assert_eq!(read_json(&inside).unwrap()["version"], "0.2.2-rc.1");
        assert!(contains(&inside));
        assert!(!contains(
            &archive.join("node_modules/missing/package.json")
        ));
        assert!(read_file(&dir.path().join("package.json")).is_none());
    }
}
