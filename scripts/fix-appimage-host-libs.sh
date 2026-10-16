#!/usr/bin/env bash
#
# 剔除 AppImage 内过度打包的「宿主接口」显示栈库（上游 tauri#15976，本仓 #620）。
#
# Tauri 固定使用的 linuxdeploy 会把构建镜像（ubuntu-22.04）的
# libwayland-*、libxkbcommon、libxcb-{randr,render,shm}、libXau、libXdmcp
# 一并塞进 usr/lib，而 AppRun.wrapped 又把 $APPDIR/usr/lib 放在 LD_LIBRARY_PATH
# 首位。较新发行版（Arch/CachyOS、Fedora 44…）的宿主 Mesa 因此加载到这些旧库，
# EGL 协商失败；WebKit 把 eglGetDisplay 失败当作致命错误直接 abort()，于是
# WebKitWebProcess 以 SIGABRT 退出、主窗口从未出现，用户侧看不到任何运行日志。
# 宿主安装包（.deb/.rpm）用系统 WebKit + 系统库，因此不受影响。
#
# 这 10 个库是「宿主 ↔ 驱动」的接口，必须用宿主版本（ABI 上向下兼容的落地替换，
# tauri#15976 已用同一份最小集合复现修复）。libEGL/libGL/libgbm/libdrm 不在剔除
# 之列：linuxdeploy 自带的 excludelist 本来就没有打包它们，误删反而会破坏渲染。
#
# 重打包复用原 AppImage 自带的 runtime 前缀（head -c <offset>），不调用
# appimagetool：既不用额外下载，也不依赖上游 floating tag，结果可复现。
set -euo pipefail

readonly EXCLUDED_LIBS=(
  libwayland-client.so.0
  libwayland-cursor.so.0
  libwayland-egl.so.1
  libwayland-server.so.0
  libxkbcommon.so.0
  libxcb-randr.so.0
  libxcb-render.so.0
  libxcb-shm.so.0
  libXau.so.6
  libXdmcp.so.6
)

# 与 linuxdeploy 产出的 squashfs 对齐（实测 zstd / 128K block / 单一 root id）。
readonly SQUASHFS_COMPRESSION=zstd
readonly SQUASHFS_BLOCK_SIZE=131072
readonly GTK_HOOK=apprun-hooks/linuxdeploy-plugin-gtk.sh
readonly GDK_OVERRIDE_PATTERN='^[[:space:]]*export[[:space:]]+GDK_BACKEND=x11([[:space:]]+#.*)?[[:space:]]*$'

# 在镜像中扫描 squashfs 4.0 superblock：magic "hsqs"，版本字段 s_major/s_minor == 4/0，
# block_size 为 2 的幂且在 [4096, 1048576]，compression 在 1..6，block_log 与 block_size 自洽。
# Type-2 AppImage 的尾部是 ELF runtime，正文里还可能出现字面量 "hsqs"，因此必须逐个按
# superblock 字段校验，而不是命中第一个 magic 就返回（实测镜像里第一个 "hsqs" 是误报）。
detect_squashfs_offset() {
  local file="$1"
  python3 - "$file" <<'PY'
import struct
import sys

path = sys.argv[1]
with open(path, 'rb') as handle:
    data = handle.read()

start = 0
while True:
    index = data.find(b'hsqs', start)
    if index < 0:
        break
    start = index + 1
    if index + 32 > len(data):
        continue
    (magic, _inodes, _mtime, block_size, _fragments, compression, block_log,
     _flags, _no_ids, s_major, s_minor) = struct.unpack_from('<IIIIIHHHHHH', data, index)
    if magic != 0x73717368:
        continue
    if s_major != 4 or s_minor != 0:
        continue
    if block_size < 4096 or block_size > 1048576 or block_size & (block_size - 1):
        continue
    if compression < 1 or compression > 6:
        continue
    if (1 << block_log) != block_size:
        continue
    print(index)
    sys.exit(0)
sys.exit(1)
PY
}

usage() {
  echo "usage: $(basename "$0") [--require-removal] <path-to.AppImage>" >&2
}

# CI 用 --require-removal：linuxdeploy 升级后若不再过度打包这些库，剔除会静默变成
# no-op，届时 #620 会悄悄回归。要求「至少剔掉一个」把这种退化变成构建失败。
require_removal=0
if [ "${1:-}" = "--require-removal" ]; then
  require_removal=1
  shift
fi

appimage="${1:-}"
if [ -z "$appimage" ]; then
  usage
  exit 2
fi
if [ ! -f "$appimage" ]; then
  echo "fix-appimage-host-libs: no such file: $appimage" >&2
  exit 1
fi

appimage="$(cd "$(dirname "$appimage")" && pwd)/$(basename "$appimage")"

for tool in mksquashfs unsquashfs; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "fix-appimage-host-libs: required tool not found: $tool (install squashfs-tools)" >&2
    exit 1
  fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$appimage" "$work/in.AppImage"
chmod +x "$work/in.AppImage"

# 先让 AppImage 自带 runtime 报出 squashfs 偏移并解包（不挂载 FUSE，容器里可直接跑）。
# runtime 不可执行时（noexec 挂载等）退回扫描 superblock + unsquashfs -o。
offset=""
if offset="$("$work/in.AppImage" --appimage-offset 2>/dev/null)" && [ -n "$offset" ]; then
  case "$offset" in
    *[!0-9]*)
      echo "fix-appimage-host-libs: unexpected AppImage offset: $offset" >&2
      exit 1
      ;;
  esac
else
  # 注意 set -e：赋值里的命令替换失败会直接终止脚本，因此必须用 `|| true` 兜住，
  # 否则扫描失败时既拿不到下面的明确报错，也看不到自己写的诊断信息。
  offset="$(detect_squashfs_offset "$work/in.AppImage" || true)"
  if [ -z "$offset" ]; then
    echo "fix-appimage-host-libs: runtime unusable and no squashfs superblock found in $appimage" >&2
    exit 1
  fi
  echo "fix-appimage-host-libs: runtime unusable, scanned squashfs offset $offset"
fi

tree="$work/squashfs-root"
if ! (
  cd "$work"
  ./in.AppImage --appimage-extract >/dev/null 2>&1
) || [ ! -d "$tree" ]; then
  rm -rf "$tree"
  if ! unsquashfs -o "$offset" -d "$tree" "$work/in.AppImage" >/dev/null; then
    echo "fix-appimage-host-libs: extraction failed (runtime and unsquashfs)" >&2
    exit 1
  fi
fi
if [ ! -d "$tree" ]; then
  echo "fix-appimage-host-libs: extraction produced no root directory" >&2
  exit 1
fi

removed=()
for lib in "${EXCLUDED_LIBS[@]}"; do
  while IFS= read -r found; do
    rm -f "$found"
    removed+=("${found#"$tree"/}")
  done < <(find "$tree" -name "$lib" -print)
done

hook_changed=0
# #789：在启动钩子处删除上游强制值，保留用户的 GDK_BACKEND 与其余 GTK 环境。
if [ -f "$tree/$GTK_HOOK" ] && grep -Eq "$GDK_OVERRIDE_PATTERN" "$tree/$GTK_HOOK"; then
  sed -Ei "/$GDK_OVERRIDE_PATTERN/d" "$tree/$GTK_HOOK"
  hook_changed=1
fi

if [ "${#removed[@]}" -eq 0 ]; then
  if [ "$require_removal" -eq 1 ]; then
    echo "fix-appimage-host-libs: none of the host-interface libs were bundled, but" >&2
    echo "  --require-removal was requested: the over-bundling this guards against (#620)" >&2
    echo "  is no longer happening, or the bundler changed. Re-verify before dropping the fix." >&2
    exit 1
  fi
  if [ "$hook_changed" -eq 0 ]; then
    echo "fix-appimage-host-libs: no host-interface libs or forced GTK backend, nothing to do"
    exit 0
  fi
fi

if [ "${#removed[@]}" -gt 0 ]; then
  echo "fix-appimage-host-libs: removed from AppDir:"
  printf '  %s\n' "${removed[@]}"
fi
if [ "$hook_changed" -eq 1 ]; then
  echo "fix-appimage-host-libs: removed GTK hook's forced GDK_BACKEND=x11"
fi

head -c "$offset" "$work/in.AppImage" > "$work/out.AppImage"
mksquashfs "$tree" "$work/fs.squashfs" \
  -comp "$SQUASHFS_COMPRESSION" \
  -b "$SQUASHFS_BLOCK_SIZE" \
  -all-root -mkfs-time 0 -no-xattrs -noappend -no-progress -quiet
cat "$work/fs.squashfs" >> "$work/out.AppImage"
chmod +x "$work/out.AppImage"

# 交付前自检：库确实消失、AppRun 与主程序仍在、新镜像仍能被 runtime 解析。
# 在独立目录解包，避免与已剔除的 $tree 混在一起而看漏残留库。
verify="$work/verify"
mkdir -p "$verify"
verdict=0
if (
  cd "$verify"
  ../out.AppImage --appimage-extract >/dev/null 2>&1
) && [ -d "$verify/squashfs-root" ]; then
  verified="$verify/squashfs-root"
else
  rm -rf "$verify/squashfs-root"
  if unsquashfs -o "$offset" -d "$verify/squashfs-root" "$work/out.AppImage" >/dev/null 2>&1; then
    verified="$verify/squashfs-root"
  else
    echo "fix-appimage-host-libs: verification failed, repacked image cannot be extracted" >&2
    exit 1
  fi
fi

for lib in "${EXCLUDED_LIBS[@]}"; do
  if find "$verified" -name "$lib" -print -quit | grep -q .; then
    echo "fix-appimage-host-libs: verification failed, $lib is still bundled" >&2
    verdict=1
  fi
done
if [ -f "$verified/$GTK_HOOK" ] && grep -Eq "$GDK_OVERRIDE_PATTERN" "$verified/$GTK_HOOK"; then
  echo "fix-appimage-host-libs: verification failed, GTK hook still forces GDK_BACKEND=x11" >&2
  verdict=1
fi
if [ "$hook_changed" -eq 1 ] && [ ! -f "$verified/$GTK_HOOK" ]; then
  echo "fix-appimage-host-libs: verification failed, GTK hook is missing" >&2
  verdict=1
fi
for required in AppRun AppRun.wrapped; do
  if [ ! -e "$verified/$required" ]; then
    echo "fix-appimage-host-libs: verification failed, $required is missing" >&2
    verdict=1
  fi
done
if [ ! -e "$verified/usr/lib/libwebkit2gtk-4.1.so.0" ]; then
  echo "fix-appimage-host-libs: verification failed, bundled WebKit is missing" >&2
  verdict=1
fi
if ! find "$verified/usr/bin" -type f -perm -u+x -print -quit | grep -q .; then
  echo "fix-appimage-host-libs: verification failed, no executable remained in usr/bin" >&2
  verdict=1
fi
[ "$verdict" -eq 0 ] || exit 1

mv "$work/out.AppImage" "$appimage"
echo "fix-appimage-host-libs: repacked $(basename "$appimage") (${#removed[@]} host-interface libs dropped)"
