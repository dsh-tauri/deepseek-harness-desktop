#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: $(basename "$0") --max <glibc-version> <AppImage|deb>..." >&2
}

die() {
  echo "check-linux-glibc-abi: $*" >&2
  exit 1
}

max=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --max)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      max="$2"
      shift 2
      ;;
    --) shift; break ;;
    -*) usage; exit 2 ;;
    *) break ;;
  esac
done

[ -n "$max" ] && [ "$#" -gt 0 ] || { usage; exit 2; }
[[ "$max" =~ ^[0-9]+(\.[0-9]+)+$ ]] || die "invalid --max value: $max"

for artifact in "$@"; do
  [ -f "$artifact" ] || die "no such artifact: $artifact"
  case "$artifact" in
    *.AppImage|*.deb) ;;
    *) die "unsupported artifact type: $artifact (expected .AppImage or .deb)" ;;
  esac
done

command -v readelf >/dev/null 2>&1 || die "required tool not found: readelf (install binutils)"

version_gt() {
  [ "$1" != "$2" ] || return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | LC_ALL=C sort -V | tail -n 1)" = "$1" ]
}

# 把 readelf 的版本信息落到文件，GLIBC 上限与宿主接口符号两处复用同一份输出（#1407）。
read_version_report() {
  local file="$1" report="$2" status=0
  readelf --version-info --wide "$file" > "$report" 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    case "$(cat "$report")" in
      *"No version information found"*) ;;
      *)
        echo "::error::cannot read ELF version information: $file" >&2
        return 1
        ;;
    esac
  fi
  return 0
}

glibc_versions_from() {
  awk '
    /Version needs section/ { needs = 1; next }
    /Version (definition|symbols) section/ { needs = 0; next }
    needs && /Name: GLIBC_/ {
      for (i = 1; i <= NF; i++)
        if ($i ~ /^GLIBC_[0-9]+(\.[0-9]+)+$/) print $i
    }
  ' "$1" | sed 's/^GLIBC_//' | LC_ALL=C sort -V -u
}

# 需求段里的每个 Name: 都要记下来：GLIBC_ 之外还有 NSS_ / NSSUTIL_ / OPENSSL_ /
# gssapi_krb5_ 这类库自身版本符号，正是 #1407 与 #1299 的失败点。
host_symbols_from() {
  awk '
    /Version needs section/ { needs = 1; next }
    /Version (definition|symbols) section/ { needs = 0; next }
    needs {
      for (i = 1; i < NF; i++)
        if ($i == "Name:") print $(i + 1)
    }
  ' "$1"
}

elf_versions() {
  local file="$1" report
  report="$(mktemp -p "$work")"
  if ! read_version_report "$file" "$report"; then
    rm -f "$report"
    return 1
  fi
  glibc_versions_from "$report"
  rm -f "$report"
}

# control 的 Depends 是 deb 对宿主的全部承诺，闭合性判定必须读它而不是另抄一份白名单。
deb_depends() {
  dpkg-deb --field "$1" Depends 2>/dev/null || true
}

is_elf() {
  [ "$(head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]
}

violations=0
extract_failures=0
closure_failures=0
unreadable_elf=0
elf_count=0
versioned_count=0
host_symbol_count=0
host_symbols=""

# 需求段里的每个 Name: 都记进 host_symbols，交给 linux_host_abi_ceiling.py 按契约判定。
record_symbols_from() {
  local report="$1" label="$2" symbol
  while IFS= read -r symbol; do
    [ -n "$symbol" ] || continue
    printf '%s\t%s\n' "$label" "$symbol" >> "$host_symbols"
    host_symbol_count=$((host_symbol_count + 1))
  done < <(host_symbols_from "$report")
}

record_host_symbols() {
  local file="$1" label="$2" report
  report="$(mktemp -p "$work")"
  if read_version_report "$file" "$report"; then
    record_symbols_from "$report" "$label"
  fi
  rm -f "$report"
}

check_elf() {
  local file="$1" label="$2" report versions file_max
  CHECK_MAX=""
  is_elf "$file" || return 0
  elf_count=$((elf_count + 1))
  report="$(mktemp -p "$work")"
  if ! read_version_report "$file" "$report"; then
    rm -f "$report"
    unreadable_elf=$((unreadable_elf + 1))
    return 0
  fi
  record_symbols_from "$report" "$label"
  versions="$(glibc_versions_from "$report")"
  rm -f "$report"
  [ -n "$versions" ] || return 0
  versioned_count=$((versioned_count + 1))
  file_max="$(printf '%s\n' "$versions" | tail -n 1)"
  CHECK_MAX="$file_max"
  if version_gt "$file_max" "$max"; then
    violations=$((violations + 1))
    echo "::error::${label}: requires GLIBC_${file_max} (> ${max}); required versions: $(printf '%s' "$versions" | tr '\n' ' ')"
  fi
}

scan_elf_tree() {
  local root="$1" kind="$2" list file rel tree_elf=0 tree_high=""
  [ -d "$root" ] || die "extracted ${kind} tree is missing: $root"
  list="$(mktemp -p "$work")"
  if ! find "$root" -type f -print0 > "$list"; then
    echo "::error::cannot enumerate files under ${kind}: $root" >&2
    extract_failures=$((extract_failures + 1))
    rm -f "$list"
    return 0
  fi
  while IFS= read -r -d '' file; do
    rel="${file#"$root"/}"
    check_elf "$file" "${kind}/${rel}"
    [ -n "$CHECK_MAX" ] || continue
    tree_elf=$((tree_elf + 1))
    if [ -z "$tree_high" ] || version_gt "$CHECK_MAX" "$tree_high"; then
      tree_high="$CHECK_MAX"
    fi
  done < "$list"
  rm -f "$list"
  echo "scanned ${tree_elf} ELF files with GLIBC requirements under ${kind}; highest: ${tree_high:-none} (limit ${max})"
}

# #1407：镜像里每个 ELF 的 DT_NEEDED 要么由镜像内同名 soname 解析，要么由宿主白名单提供；
# 两者都不满足就是极简系统上的 cannot open shared object file。复用上面已解包的树，不重复解压。
# AppImage 额外要求宿主接口库不得被打包；deb 只查闭合性，因为它本来就没跑过剔除脚本。
check_closure() {
  local root="$1" kind="$2"
  shift 2
  [ -d "$root" ] || return 0
  if ! python3 -B "$script_dir/appimage_lib_closure.py" --root "$root" "$@"; then
    echo "::error::${kind}: ELF dependency closure is broken (see ELF_CLOSURE_* above)" >&2
    closure_failures=$((closure_failures + 1))
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
host_symbols="$work/host-symbols.tsv"
: > "$host_symbols"
index=0

for artifact in "$@"; do
  artifact="$(cd "$(dirname "$artifact")" && pwd)/$(basename "$artifact")"
  index=$((index + 1))

  case "$artifact" in
    *.AppImage)
      elf_count=$((elf_count + 1))
      record_host_symbols "$artifact" "AppImage runtime $(basename "$artifact")"
      runtime_versions="$(elf_versions "$artifact")"
      if [ -n "$runtime_versions" ]; then
        versioned_count=$((versioned_count + 1))
        runtime_max="$(printf '%s\n' "$runtime_versions" | tail -n 1)"
        echo "AppImage runtime ${artifact}: highest GLIBC requirement GLIBC_${runtime_max} (limit ${max})"
        if version_gt "$runtime_max" "$max"; then
          violations=$((violations + 1))
          echo "::error::${artifact} (AppImage runtime): requires GLIBC_${runtime_max} (> ${max}); required versions: $(printf '%s' "$runtime_versions" | tr '\n' ' ')"
        fi
      else
        echo "AppImage runtime ${artifact}: no GLIBC version requirement"
      fi

      extract="$work/extract-$index"
      mkdir -p "$extract"
      if ! ( cd "$extract" && "$artifact" --appimage-extract >/dev/null 2>&1 ); then
        echo "::error::${artifact}: embedded AppImage runtime did not extract the payload"
        extract_failures=$((extract_failures + 1))
        continue
      fi
      scan_elf_tree "$extract/squashfs-root" "AppImage $(basename "$artifact")"
      check_closure "$extract/squashfs-root" "AppImage $(basename "$artifact")"
      ;;
    *.deb)
      command -v dpkg-deb >/dev/null 2>&1 || die "required tool not found: dpkg-deb (install dpkg)"
      target="$work/deb-$index"
      if ! dpkg-deb -x "$artifact" "$target"; then
        echo "::error::${artifact}: dpkg-deb failed to extract the package"
        extract_failures=$((extract_failures + 1))
        continue
      fi
      scan_elf_tree "$target" "deb $(basename "$artifact")"
      depends="$(deb_depends "$artifact")"
      [ -n "$depends" ] || die "deb declares no Depends: $(basename "$artifact")"
      check_closure "$target" "deb $(basename "$artifact")" --allow-host-owned-libs --depends "$depends"
      ;;
  esac
done

[ "$elf_count" -gt 0 ] || die "no ELF file was found in the supplied artifacts"
[ "$versioned_count" -gt 0 ] || die "no ELF file declares a GLIBC version requirement; refusing to pass a vacuous check"
[ "$host_symbol_count" -gt 0 ] || die "no ELF file declares a library version requirement; refusing to pass a vacuous check"

# #1407：GLIBC 之外，NSS_ / NSSUTIL_ / OPENSSL_ / gssapi_krb5_ 这些库自身版本符号同样
# 会让旧发行版加载失败，且镜像内的提供者一旦被剔除就必须由宿主满足。
if ! python3 -B "$script_dir/linux_host_abi_ceiling.py" < "$host_symbols"; then
  violations=$((violations + 1))
fi

if [ "$violations" -gt 0 ] || [ "$extract_failures" -gt 0 ] || [ "$closure_failures" -gt 0 ] || [ "$unreadable_elf" -gt 0 ]; then
  echo "::error::host ABI check failed: ${violations} violating ELF file(s), ${closure_failures} tree(s) with broken NEEDED closure, ${extract_failures} artifact extraction failure(s), ${unreadable_elf} ELF file(s) without readable version information, GLIBC limit ${max}" >&2
  exit 1
fi

echo "host ABI check passed: ${elf_count} ELF files (${versioned_count} with GLIBC requirements <= ${max}, ${host_symbol_count} host-interface version symbols), NEEDED closure intact"
