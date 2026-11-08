#!/usr/bin/env python3
"""AppImage 镜像 ELF 依赖闭合性检查。

镜像里每个 ELF 的 DT_NEEDED 只有两条合法出路：由镜像内同名 soname 解析，或交还宿主
（HOST_LIBS 白名单）。落空的每一条，在极简发行版上就是
cannot open shared object file：#1407 的 libcups.so.2 挂在 libgssapi_krb5.so.2 上、
而后者已被 #1412 交还宿主，正是这种悬空依赖。同一个道理也适用于版本符号：镜像内
libnssutil3 只提供到 NSSUTIL_3.94 时，任何要求 NSSUTIL_3.108 的 ELF 都解析失败。
"""

import fnmatch
import os
import struct
import sys
from pathlib import Path
from typing import NamedTuple

ELF_MAGIC = b'\x7fELF'
PT_LOAD = 1
PT_DYNAMIC = 2
DT_NULL = 0
DT_NEEDED = 1
DT_STRTAB = 5
DT_SONAME = 14
DT_VERDEF = 0x6FFFFFFC
DT_VERDEFNUM = 0x6FFFFFFD
DT_VERNEED = 0x6FFFFFFE
DT_VERNEEDNUM = 0x6FFFFFFF

# 宿主保证提供的 soname（可用通配符）。加新条目等于写下一条对宿主系统的契约：
# 极简发行版上这些库由发行版自己装好，镜像不能替宿主做主。
HOST_LIBS = (
    'ld-linux*.so.*',
    'libc.so.6',
    'libm.so.6',
    'libdl.so.2',
    'libpthread.so.0',
    'librt.so.1',
    'libgcc_s.so.1',
    'libstdc++.so.6',
    'libz.so.1',
    'libexpat.so.1',
    'libX11.so.6',
    'libX11-xcb.so.1',
    'libxcb.so.1',
    'libxcb-render.so.0',
    'libxcb-shm.so.0',
    'libwayland-client.so.0',
    'libwayland-cursor.so.0',
    'libwayland-egl.so.1',
    'libxkbcommon.so.0',
    'libglib-2.0.so.0',
    'libgobject-2.0.so.0',
    'libgio-2.0.so.0',
    'libgmodule-2.0.so.0',
    'libdbus-1.so.3',
    'libfontconfig.so.1',
    'libfreetype.so.6',
    'libfribidi.so.0',
    'libharfbuzz.so.0',
    'libgmp.so.10',
    'libasound.so.2',
    'libgbm.so.1',
    'libnss3.so',
    'libnssutil3.so',
    'libsmime3.so',
    'libnspr4.so',
    'libssl.so.3',
    'libcrypto.so.3',
    'libgssapi_krb5.so.2',
    'libkrb5.so.3',
    'libk5crypto.so.3',
    'libkrb5support.so.0',
    'libkeyutils.so.1',
    'libcups.so.2',
)

# 镜像内绝不打包的宿主接口库（AppImage 专用）。这些库在宿主侧属于同一条加载链，
# 镜像内的旧副本会让宿主的 NSS softoken / libcurl / git 绑定到缺失的版本符号上。
HOST_OWNED = (
    'libnss3.so*',
    'libnssutil3.so*',
    'libsmime3.so*',
    'libnspr4.so*',
    'libplc4.so*',
    'libplds4.so*',
    'libssl.so.3*',
    'libcrypto.so.3*',
    'libkrb5.so.3*',
    'libk5crypto.so.3*',
    'libkrb5support.so.0*',
    'libgssapi_krb5.so.2*',
    'libkeyutils.so.1*',
    'libcups.so.2*',
    'libprintbackend-cups.so*',
    'libgcrypt.so*',
)


class ElfInfo(NamedTuple):
    soname: object
    needed: tuple
    requires: tuple
    provides: tuple


class Stats(NamedTuple):
    elf_files: int
    needed: int
    host_needed: int
    version_needs: int


def _cstring(data, offset):
    end = data.index(b'\x00', offset)
    return data[offset:end].decode('utf-8', 'replace')


def _to_offset(loads, vaddr):
    for offset, start, size in loads:
        if start <= vaddr < start + size:
            return offset + (vaddr - start)
    raise ValueError(f'address 0x{vaddr:x} is not mapped by any PT_LOAD segment')


def parse_elf(path):
    data = Path(path).read_bytes()
    if data[:4] != ELF_MAGIC:
        return None
    if len(data) < 52:
        raise ValueError('file is truncated')
    elf_class, encoding = data[4], data[5]
    if elf_class not in (1, 2) or encoding not in (1, 2):
        raise ValueError(f'unsupported ELF class {elf_class} or byte order {encoding}')
    is64 = elf_class == 2
    endian = '<' if encoding == 1 else '>'
    if is64:
        phoff, = struct.unpack_from(endian + 'Q', data, 0x20)
        phentsize, phnum = struct.unpack_from(endian + 'HH', data, 0x36)
        phdr_fmt, offset_at, vaddr_at, filesz_at = endian + 'IIQQQQQQ', 2, 3, 5
    else:
        phoff, = struct.unpack_from(endian + 'I', data, 0x1C)
        phentsize, phnum = struct.unpack_from(endian + 'HH', data, 0x2A)
        phdr_fmt, offset_at, vaddr_at, filesz_at = endian + 'IIIIIIII', 1, 2, 4
    if phnum == 0:
        return ElfInfo(None, (), (), ())
    if phentsize == 0 or phoff + phentsize * phnum > len(data):
        raise ValueError('program header table is out of bounds')
    loads, dynamic = [], None
    for index in range(phnum):
        fields = struct.unpack_from(phdr_fmt, data, phoff + index * phentsize)
        segment = (fields[offset_at], fields[vaddr_at], fields[filesz_at])
        if fields[0] == PT_LOAD:
            loads.append(segment)
        elif fields[0] == PT_DYNAMIC:
            dynamic = segment
    if dynamic is None:
        return ElfInfo(None, (), (), ())
    step = 16 if is64 else 8
    dyn_fmt = endian + ('qQ' if is64 else 'iI')
    names, tags = [], {}
    tracked = (DT_STRTAB, DT_SONAME, DT_VERDEF, DT_VERDEFNUM, DT_VERNEED, DT_VERNEEDNUM)
    for position in range(dynamic[0], dynamic[0] + dynamic[2] - step + 1, step):
        tag, value = struct.unpack_from(dyn_fmt, data, position)
        if tag == DT_NULL:
            break
        if tag == DT_NEEDED:
            names.append(value)
        elif tag in tracked:
            tags[tag] = value
    if DT_STRTAB not in tags:
        raise ValueError('dynamic section has no DT_STRTAB')
    strings = _to_offset(loads, tags[DT_STRTAB])
    needed = tuple(_cstring(data, strings + value) for value in names)
    soname = _cstring(data, strings + tags[DT_SONAME]) if DT_SONAME in tags else None
    requires = []
    if DT_VERNEED in tags:
        cursor = _to_offset(loads, tags[DT_VERNEED])
        for _ in range(tags.get(DT_VERNEEDNUM, 0)):
            _version, count, file_name, aux_offset, next_offset = struct.unpack_from(endian + 'HHIII', data, cursor)
            provider = _cstring(data, strings + file_name)
            aux = cursor + aux_offset
            for _ in range(count):
                _hash, _flags, _other, name, next_aux = struct.unpack_from(endian + 'IHHII', data, aux)
                requires.append((provider, _cstring(data, strings + name)))
                if next_aux == 0:
                    break
                aux += next_aux
            if next_offset == 0:
                break
            cursor += next_offset
    provides = []
    if DT_VERDEF in tags:
        cursor = _to_offset(loads, tags[DT_VERDEF])
        for _ in range(tags.get(DT_VERDEFNUM, 0)):
            _version, _flags, _index, count, _hash, aux_offset, next_offset = struct.unpack_from(endian + 'HHHHIII', data, cursor)
            if count:
                name, _next = struct.unpack_from(endian + 'II', data, cursor + aux_offset)
                provides.append(_cstring(data, strings + name))
            if next_offset == 0:
                break
            cursor += next_offset
    return ElfInfo(soname, needed, tuple(requires), tuple(provides))


def _matches(name, patterns):
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns)


def _inside_tree(root, candidate):
    root_text = os.path.normpath(str(root))
    candidate_text = os.path.normpath(str(candidate))
    if candidate_text == root_text:
        return Path(candidate_text)
    try:
        if os.path.commonpath([root_text, candidate_text]) != root_text:
            return None
    except ValueError:
        return None
    return Path(candidate_text)


def _absolute_target(raw):
    return raw.startswith(('/', '\\')) or os.path.isabs(raw)


def resolve_link_target(root, link, raw):
    target = Path(raw)
    if _absolute_target(raw):
        parts = [part for part in target.parts if part not in (target.anchor, '/', '\\')]
        return _inside_tree(root, Path(root).joinpath(*parts))
    return _inside_tree(root, link.parent / target)


def resolve_link(root, path, limit=40):
    current = Path(path)
    for _ in range(limit):
        if not current.is_symlink():
            return current
        raw = os.readlink(current)
        resolved = resolve_link_target(root, current, raw)
        if resolved is None:
            return None
        if not resolved.exists():
            if _absolute_target(raw):
                return None
            raise ValueError(f'symbolic link target is missing: {raw}')
        current = resolved
    raise ValueError(f'symbolic link chain is deeper than {limit}')


def check_tree(root, host_libs=HOST_LIBS, host_owned=HOST_OWNED, allow_host_owned=False):
    root = Path(root)
    if not root.is_dir():
        raise ValueError(f'not a directory: {root}')
    problems = []
    entries = []
    providers = {}
    parsed = {}

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            path = Path(dirpath) / name
            rel = path.relative_to(root).as_posix()
            if not allow_host_owned and _matches(name, host_owned):
                problems.append(f'ELF_CLOSURE_HOST_OWNED_BUNDLED: {rel} must be provided by the host, not bundled')
            try:
                target = resolve_link(root, path) if path.is_symlink() else path
            except (OSError, ValueError) as error:
                problems.append(f'ELF_CLOSURE_UNREADABLE: {rel}: {error}')
                continue
            if target is None:
                continue
            real = os.path.normcase(os.path.abspath(str(target)))
            if real in parsed:
                info = parsed[real]
            else:
                try:
                    info = parse_elf(target)
                except (OSError, ValueError, struct.error) as error:
                    problems.append(f'ELF_CLOSURE_UNREADABLE: {rel}: {error}')
                    info = None
                if info is not None:
                    entries.append((rel, info))
                parsed[real] = info
            if info is None:
                continue
            for alias in {info.soname, name}:
                if alias:
                    providers.setdefault(alias, []).append(info)

    needed_total = host_total = version_total = 0
    for rel, info in entries:
        for name in info.needed:
            needed_total += 1
            if name in providers:
                continue
            if _matches(name, host_libs):
                host_total += 1
                continue
            problems.append(f'ELF_CLOSURE_UNRESOLVED_NEEDED: {rel} needs {name}, which is neither bundled nor in the host allowlist')
        for provider, version in info.requires:
            candidates = providers.get(provider)
            if not candidates:
                continue
            version_total += 1
            if any(version in candidate.provides for candidate in candidates):
                continue
            offered = sorted({name for candidate in candidates for name in candidate.provides})
            problems.append(
                f'ELF_CLOSURE_VERSION_UNSATISFIED: {rel} needs {provider} version {version}, '
                f'bundled copy provides {" ".join(offered) or "none"}')
    return problems, Stats(len(entries), needed_total, host_total, version_total)


def main(argv):
    roots = []
    allow_host_owned = False
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == '--root':
            index += 1
            if index >= len(argv):
                print('usage: appimage_lib_closure.py --root <tree> [--root <tree>] [--allow-host-owned-libs]', file=sys.stderr)
                return 2
            roots.append(argv[index])
        elif argument == '--allow-host-owned-libs':
            allow_host_owned = True
        else:
            print(f'appimage_lib_closure.py: unexpected argument: {argument}', file=sys.stderr)
            return 2
        index += 1
    if not roots:
        print('usage: appimage_lib_closure.py --root <tree> [--root <tree>] [--allow-host-owned-libs]', file=sys.stderr)
        return 2

    failed = 0
    for root in roots:
        try:
            problems, stats = check_tree(root, allow_host_owned=allow_host_owned)
        except ValueError as error:
            print(f'::error::ELF_CLOSURE_FAILED: {error}', file=sys.stderr)
            failed += 1
            continue
        for problem in problems:
            print(f'::error::{problem}', file=sys.stderr)
        if problems:
            failed += 1
            continue
        print(f'appimage-lib-closure: {stats.elf_files} ELF files, {stats.needed} DT_NEEDED '
              f'({stats.host_needed} from the host), {stats.version_needs} bundled version needs: {root} is closed')
    if failed:
        print(f'appimage-lib-closure: {failed} of {len(roots)} tree(s) violate the host interface', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
