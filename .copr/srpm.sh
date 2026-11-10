#!/bin/bash
set -euo pipefail

outdir=$1
name=$2
top=$(cd "$(dirname "$0")/.." && pwd)

fail() {
  echo "$1" >&2
  exit 1
}

case $name in
  dsh-tauri) conflicts=dsh-tauri-beta ;;
  dsh-tauri-beta) conflicts=dsh-tauri ;;
  *) fail "SRPM_PACKAGE_INVALID: '$name' (expected dsh-tauri or dsh-tauri-beta)" ;;
esac

command -v git >/dev/null 2>&1 || dnf -y install git-core
command -v rpmbuild >/dev/null 2>&1 || dnf -y install rpm-build

repo() {
  git -c safe.directory='*' -C "$top" "$@"
}

field() {
  value=$(sed -n "$2" "$top/$1" | head -n 1)
  [ -n "$value" ] || fail "SRPM_FIELD_MISSING: $3 not found in $1"
  printf '%s' "$value"
}

raw=$(field package.json 's/^  "version": "\([^"]*\)",$/\1/p' version)

release=
for tag in $(repo tag --points-at HEAD); do
  if [ "$tag" = "v$raw" ]; then
    n=1
  else
    n=${tag#"copr/$raw-"}
    case $n in "$tag" | '' | *[!0-9]*) continue ;; esac
  fi
  [ -n "$release" ] && [ "$release" -ge "$n" ] || release=$n
done
[ -n "$release" ] || fail "SRPM_NOT_RELEASE: HEAD has no v$raw or copr/$raw-<N> tag"

case $raw in
  *-*) [ "$name" = dsh-tauri-beta ] || fail "SRPM_PRERELEASE_SKIPPED: $raw is a prerelease, only dsh-tauri-beta builds it" ;;
esac

version=$(printf '%s' "$raw" | tr '-' '~')
appname=$(field apps/desktop/src-tauri/tauri.conf.json 's/^  "productName": "\([^"]*\)",$/\1/p' productName)
binname=$(field apps/desktop/src-tauri/Cargo.toml '2s/^name = "\([^"]*\)"$/\1/p' 'package name')
summary=$(field apps/desktop/src-tauri/Cargo.toml 's/^description = "\([^"]*\)"$/\1/p' description)
description=$summary
scheme=$(field apps/desktop/src-tauri/tauri.conf.json '/"schemes": \[/,/\]/{s/^[[:space:]]*"\([a-z][a-z0-9+.-]*\)"[,]\{0,1\}$/\1/p;}' 'deep-link scheme')
node_version=$(field packages/builtin-plugin-remote/src/host/utils/assets.ts "s/^export const NODE_VERSION = '\(v[0-9.]*\)'$/\1/p" NODE_VERSION)
packager=$(repo log -1 --format='%an <%ae>')

work=$(mktemp -d "${TMPDIR:-/tmp}/dsh-copr.XXXXXX")
prefix="$name-$version"

modules="crates/tauri-runtime-electron crates/electron-rs crates/tauri-plugin-notifications"
repo submodule update --init -- $modules
repo ls-files -z --cached --others --exclude-standard -- . \
  ':(exclude)archive' ':(exclude)source' ':(exclude)crates' ':(exclude).temp*' > "$work/files"
for module in $modules; do
  git -c safe.directory='*' -C "$top/$module" ls-files -z --cached -- . ':(exclude)source' \
    | while IFS= read -r -d '' file; do printf '%s\0' "$module/$file"; done >> "$work/files"
done
tar -C "$top" --null --no-recursion -T "$work/files" \
  --transform "flags=r;s|^|$prefix/|" -czf "$work/$prefix.tar.gz"

sed -e "s|@NAME@|$name|" \
    -e "s|@CONFLICTS@|$conflicts|" \
    -e "s|@VERSION@|$version|" \
    -e "s|@RELEASE@|$release|" \
    -e "s|@APPNAME@|$appname|" \
    -e "s|@BINNAME@|$binname|" \
    -e "s|@SUMMARY@|$summary|" \
    -e "s|@DESCRIPTION@|$description|" \
    -e "s|@SCHEME@|$scheme|" \
    -e "s|@NODE_VERSION@|$node_version|" \
    -e "s|@PACKAGER@|$packager|" \
    -e "s|@DATE@|$(LC_ALL=C date '+%a %b %d %Y')|" \
    "$top/.copr/dsh-tauri.spec.in" > "$work/$name.spec"
! grep -n '@[A-Z_]*@' "$work/$name.spec" || fail "SRPM_TEMPLATE_UNFILLED: placeholders left in spec"

mkdir -p "$outdir"
rpmbuild -bs \
  --define "_sourcedir $work" \
  --define "_srcrpmdir $outdir" \
  "$work/$name.spec"
