#!/bin/sh
# 生成 Copr 用的 SRPM，只构建发布版。HEAD 须带上游发布 tag `v<package.json 版本>`（Release 1），
# 或打包修复 tag `copr/<版本>-<N>`（Release N，同一版本补打包时递增）。
# Version 里不能出现 `-`（dnfdragora 等前端会因此无法启动），预发布的 `-beta.1` 改写成
# `~beta.1`，排序在正式版之前。同一 Copr 项目里有两个互斥的包：dsh-tauri 只构建正式版，遇到
# 预发布版直接拒绝；dsh-tauri-beta 正式版与预发布版都构建。
set -eu

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

# Copr 在 mock 里以 root 处理别的用户克隆的仓库，git 会因 safe.directory 拒绝工作
repo() {
  git -c safe.directory='*' -C "$top" "$@"
}

# 只读格式固定的单行字段，读不到就报错，避免把空值写进 spec
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
appname=$(field src-tauri/tauri.conf.json 's/^  "productName": "\([^"]*\)",$/\1/p' productName)
binname=$(field src-tauri/Cargo.toml '2s/^name = "\([^"]*\)"$/\1/p' 'package name')
summary=$(field src-tauri/tauri.conf.json 's/^    "shortDescription": "\([^"]*\)",$/\1/p' shortDescription)
description=$(field src-tauri/tauri.conf.json 's/^    "longDescription": "\([^"]*\)"$/\1/p' longDescription)
scheme=$(field src-tauri/tauri.conf.json 's/^        "schemes": \["\([a-z][a-z0-9+.-]*\)"\]$/\1/p' 'deep-link scheme')
node_version=$(field src-tauri/src/config/constants.rs 's/^pub const NODE_VERSION: &str = "\(v[0-9.]*\)";$/\1/p' NODE_VERSION)
packager=$(repo log -1 --format='%an <%ae>')

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
prefix="$name-$version"

# 打包工作区而非 HEAD：本地验证时未提交的改动也能进 SRPM；Copr 上两者一致
repo ls-files -z --cached --others --exclude-standard \
  | tar -C "$top" --null --no-recursion --ignore-failed-read -T - \
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
