import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('appimage_lib_closure.py')
sys.path.insert(0, str(SCRIPT.parent))

from appimage_lib_closure import HOST_LIBS, HOST_OWNED, check_tree, parse_elf  # noqa: E402

ET_DYN = 3
PT_LOAD = 1
PT_DYNAMIC = 2
DT_NULL = 0
DT_NEEDED = 1
DT_STRTAB = 5
DT_STRSZ = 10
DT_SONAME = 14
DT_VERDEF = 0x6FFFFFFC
DT_VERDEFNUM = 0x6FFFFFFD
DT_VERNEED = 0x6FFFFFFE
DT_VERNEEDNUM = 0x6FFFFFFF
BASE = 0x400000
VERNEED_ENTRY = 40
VERDEF_ENTRY = 28


def make_symlink(link, target):
    """建真实符号链接；Windows 非管理员且未开开发者模式时无法创建，跳过该用例。"""
    try:
        link.symlink_to(target)
    except OSError as error:
        if sys.platform == 'win32':
            raise unittest.SkipTest(f'cannot create symlink on this Windows host: {error}') from error
        raise


def build_elf(needed=(), soname=None, requires=(), provides=(), elf_class=2, dynamic=True):
    """按真实 ELF 布局拼出最小可解析镜像。

    DT_NEEDED / DT_SONAME / DT_VERNEED / DT_VERDEF 全部经由 PT_LOAD 映射的虚拟地址表达，
    因此解析器必须真的做 vaddr -> offset 换算，与真机 .so 走同一条路径。
    """
    is64 = elf_class == 2
    endian = '<'
    header_size = 64 if is64 else 52
    phdr_size = 56 if is64 else 32
    ph_fmt = endian + ('IIQQQQQQ' if is64 else 'IIIIIIII')
    dyn_fmt = endian + ('qQ' if is64 else 'iI')
    dyn_size = 16 if is64 else 8

    strings = bytearray(b'\x00')
    offsets = {}

    def intern(text):
        if text not in offsets:
            offsets[text] = len(strings)
            strings.extend(text.encode() + b'\x00')
        return offsets[text]

    needed_offsets = [intern(name) for name in needed]
    soname_offset = intern(soname) if soname else None
    verneed_names = [(intern(provider), intern(version)) for provider, version in requires]
    verdef_names = [intern(version) for version in provides]

    phnum = 2 if dynamic else 1
    dynamic_offset = header_size + phdr_size * phnum
    dynamic_blob = bytearray()
    for offset in needed_offsets:
        dynamic_blob += struct.pack(dyn_fmt, DT_NEEDED, offset)
    if soname_offset is not None:
        dynamic_blob += struct.pack(dyn_fmt, DT_SONAME, soname_offset)

    verneed_offset = dynamic_offset + dyn_size * (len(needed_offsets) + (1 if soname else 0) + 7)
    verneed_blob = bytearray()
    for index, (provider, version) in enumerate(verneed_names):
        last = index == len(verneed_names) - 1
        verneed_blob += struct.pack(endian + 'HHIII', 1, 1, provider, 16, 0 if last else VERNEED_ENTRY)
        verneed_blob += struct.pack(endian + 'IHHII', 0, 0, 2, version, 0)

    verdef_offset = verneed_offset + len(verneed_blob)
    verdef_blob = bytearray()
    for index, name in enumerate(verdef_names):
        last = index == len(verdef_names) - 1
        verdef_blob += struct.pack(endian + 'HHHHIII', 1, 0, index + 1, 1, 0, 20, 0 if last else VERDEF_ENTRY)
        verdef_blob += struct.pack(endian + 'II', name, 0)

    strtab_offset = verdef_offset + len(verdef_blob)
    total = strtab_offset + len(strings)

    if requires:
        dynamic_blob += struct.pack(dyn_fmt, DT_VERNEED, BASE + verneed_offset)
        dynamic_blob += struct.pack(dyn_fmt, DT_VERNEEDNUM, len(verneed_names))
    if provides:
        dynamic_blob += struct.pack(dyn_fmt, DT_VERDEF, BASE + verdef_offset)
        dynamic_blob += struct.pack(dyn_fmt, DT_VERDEFNUM, len(verdef_names))
    dynamic_blob += struct.pack(dyn_fmt, DT_STRTAB, BASE + strtab_offset)
    dynamic_blob += struct.pack(dyn_fmt, DT_STRSZ, len(strings))
    dynamic_blob += struct.pack(dyn_fmt, DT_NULL, 0)

    header = bytearray(header_size)
    header[:4] = b'\x7fELF'
    header[4] = elf_class
    header[5] = 1
    header[6] = 1
    struct.pack_into(endian + 'H', header, 16, ET_DYN)
    struct.pack_into(endian + 'H', header, 18, 62)
    struct.pack_into(endian + 'I', header, 20, 1)
    header[header_size - 4:header_size] = b'\x00' * 4

    if is64:
        struct.pack_into(endian + 'Q', header, 0x20, header_size if dynamic else 0)
        struct.pack_into(endian + 'H', header, 0x34, header_size)
        struct.pack_into(endian + 'H', header, 0x36, phdr_size)
        struct.pack_into(endian + 'H', header, 0x38, phnum)
    else:
        struct.pack_into(endian + 'I', header, 0x1C, header_size if dynamic else 0)
        struct.pack_into(endian + 'H', header, 0x28, header_size)
        struct.pack_into(endian + 'H', header, 0x2A, phdr_size)
        struct.pack_into(endian + 'H', header, 0x2C, phnum)

    payload = bytearray(total)
    payload[:header_size] = header
    if dynamic:
        if is64:
            load = struct.pack(ph_fmt, PT_LOAD, 5, 0, BASE, BASE, total, total, 0x1000)
            dyn = struct.pack(ph_fmt, PT_DYNAMIC, 6, dynamic_offset, BASE + dynamic_offset,
                              0, len(dynamic_blob), len(dynamic_blob), 8)
        else:
            load = struct.pack(ph_fmt, PT_LOAD, 0, BASE, BASE, total, total, 5, 0x1000)
            dyn = struct.pack(ph_fmt, PT_DYNAMIC, dynamic_offset, BASE + dynamic_offset,
                              0, len(dynamic_blob), len(dynamic_blob), 6, 8)
        payload[header_size:header_size + phdr_size] = load
        payload[header_size + phdr_size:header_size + phdr_size * 2] = dyn
        payload[dynamic_offset:dynamic_offset + len(dynamic_blob)] = dynamic_blob
    payload[verneed_offset:verneed_offset + len(verneed_blob)] = verneed_blob
    payload[verdef_offset:verdef_offset + len(verdef_blob)] = verdef_blob
    payload[strtab_offset:strtab_offset + len(strings)] = strings
    return bytes(payload)


class ClosureTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def write(self, relative, data):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_closed_tree_passes(self):
        self.write('usr/bin/app', build_elf(needed=('libc.so.6', 'libfoo.so.1')))
        self.write('usr/lib/libfoo.so.1', build_elf(soname='libfoo.so.1', needed=('libc.so.6', 'libbar.so.2')))
        self.write('usr/lib/libbar.so.2', build_elf(soname='libbar.so.2', needed=('libm.so.6',)))
        problems, stats = check_tree(self.root)
        self.assertEqual(problems, [])
        self.assertEqual(stats.elf_files, 3)
        self.assertEqual(stats.needed, 5)
        self.assertEqual(stats.host_needed, 3)

    def test_unresolved_needed_is_reported(self):
        self.write('usr/lib/libfoo.so.1', build_elf(soname='libfoo.so.1', needed=('libpng16.so.16',)))
        problems, _ = check_tree(self.root)
        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith('ELF_CLOSURE_UNRESOLVED_NEEDED: usr/lib/libfoo.so.1'), problems[0])
        self.assertIn('libpng16.so.16', problems[0])

    def test_every_host_allowlist_entry_is_accepted(self):
        for index, pattern in enumerate(HOST_LIBS):
            name = pattern.replace('*', '3.5.0')
            with self.subTest(pattern=pattern):
                root = self.root / f'case{index}'
                (root / 'usr/bin').mkdir(parents=True, exist_ok=True)
                (root / 'usr/bin/app').write_bytes(build_elf(needed=(name,)))
                problems, stats = check_tree(root, host_owned=())
                self.assertEqual(problems, [])
                self.assertEqual(stats.host_needed, 1)

    def test_symlink_chain_provides_soname(self):
        self.write('usr/lib/libfoo.so.1.2.3', build_elf(soname='libfoo.so.1'))
        make_symlink(self.root / 'usr/lib/libfoo.so.1', 'libfoo.so.1.2.3')
        self.write('usr/bin/app', build_elf(needed=('libfoo.so.1',)))
        problems, stats = check_tree(self.root, host_owned=())
        self.assertEqual(problems, [])
        self.assertEqual(stats.host_needed, 0)

    def test_absolute_symlink_resolves_inside_install_root(self):
        self.write('opt/app/lib/libfoo.so.1.2.3', build_elf(soname='libfoo.so.1'))
        make_symlink(self.root / 'opt/app/lib/libfoo.so.1', '/opt/app/lib/libfoo.so.1.2.3')
        self.write('opt/app/bin/app', build_elf(needed=('libfoo.so.1',)))
        problems, stats = check_tree(self.root, host_owned=())
        self.assertEqual(problems, [])
        self.assertEqual(stats.elf_files, 2)
        self.assertEqual(stats.host_needed, 0)

    def test_absolute_symlink_escaping_install_root_is_ignored(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__('shutil').rmtree(outside, ignore_errors=True))
        (outside / 'libescape.so.1').write_bytes(build_elf(soname='libescape.so.1'))
        self.write('usr/bin/app', build_elf(needed=('libescape.so.1',)))
        make_symlink(self.root / 'usr/lib/libescape.so.1', str(outside / 'libescape.so.1'))
        problems, stats = check_tree(self.root, host_owned=())
        self.assertEqual(len(problems), 1)
        self.assertIn('ELF_CLOSURE_UNRESOLVED_NEEDED: usr/bin/app needs libescape.so.1', problems[0])
        self.assertEqual(stats.elf_files, 1)

    def test_relative_symlink_escaping_install_root_is_ignored(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__('shutil').rmtree(outside, ignore_errors=True))
        (outside / 'libescape.so.1').write_bytes(build_elf(soname='libescape.so.1'))
        self.write('usr/bin/app', build_elf(needed=('libescape.so.1',)))
        make_symlink(self.root / 'usr/lib/libescape.so.1', '../../../' + outside.name + '/libescape.so.1')
        problems, stats = check_tree(self.root, host_owned=())
        self.assertEqual(len(problems), 1)
        self.assertIn('ELF_CLOSURE_UNRESOLVED_NEEDED', problems[0])
        self.assertEqual(stats.elf_files, 1)

    def test_relative_symlink_with_missing_target_is_unreadable(self):
        self.write('usr/bin/app', build_elf())
        make_symlink(self.root / 'usr/lib/libmissing.so.1', 'libabsent.so.1.2')
        problems, stats = check_tree(self.root, host_owned=())
        self.assertEqual(len(problems), 1)
        self.assertIn('ELF_CLOSURE_UNREADABLE: usr/lib/libmissing.so.1', problems[0])

    def test_absolute_symlink_without_in_tree_target_is_ignored(self):
        self.write('usr/bin/app', build_elf(needed=('libmissing.so.1',)))
        make_symlink(self.root / 'usr/lib/libmissing.so.1', '/opt/absent/libmissing.so.1')
        problems, stats = check_tree(self.root, host_owned=())
        self.assertEqual(len(problems), 1)
        self.assertIn('ELF_CLOSURE_UNRESOLVED_NEEDED: usr/bin/app needs libmissing.so.1', problems[0])
        self.assertEqual(stats.elf_files, 1)

    def test_soname_free_dependency_resolves_by_file_name(self):
        self.write('usr/lib/libfoo.so.5', build_elf())
        self.write('usr/bin/app', build_elf(needed=('libfoo.so.5',)))
        problems, stats = check_tree(self.root, host_owned=())
        self.assertEqual(problems, [])
        self.assertEqual(stats.host_needed, 0)

    def test_host_owned_library_must_not_be_bundled(self):
        self.write('usr/lib/libcups.so.2', build_elf(soname='libcups.so.2'))
        self.write('usr/lib/libgcrypt.so.20', build_elf(soname='libgcrypt.so.20'))
        problems, _ = check_tree(self.root)
        self.assertEqual(len(problems), 2)
        self.assertIn('ELF_CLOSURE_HOST_OWNED_BUNDLED: usr/lib/libcups.so.2', problems[0])
        self.assertIn('ELF_CLOSURE_HOST_OWNED_BUNDLED: usr/lib/libgcrypt.so.20', problems[1])
        problems, _ = check_tree(self.root, allow_host_owned=True)
        self.assertEqual(problems, [])

    def test_removed_kerberos_provider_leaves_libcups_dangling(self):
        pruned = tuple(name for name in HOST_OWNED if 'cups' not in name and 'gcrypt' not in name)
        self.write('usr/lib/libcups.so.2', build_elf(
            soname='libcups.so.2', needed=('libgssapi_krb5.so.2',),
            requires=(('libgssapi_krb5.so.2', 'gssapi_krb5_2_MIT'),)))
        problems, stats = check_tree(self.root, host_owned=pruned)
        self.assertEqual(problems, [])
        self.assertEqual(stats.host_needed, 1)
        problems, _ = check_tree(self.root, host_libs=tuple(name for name in HOST_LIBS if 'krb5' not in name), host_owned=pruned)
        self.assertEqual(len(problems), 1)
        self.assertIn('libgssapi_krb5.so.2', problems[0])

    def test_version_requirement_unsatisfied(self):
        self.write('usr/lib/libnssutil3.so', build_elf(soname='libnssutil3.so', provides=('NSSUTIL_3.94',)))
        self.write('usr/lib/libsoftokn3.so', build_elf(
            soname='libsoftokn3.so', needed=('libnssutil3.so',),
            requires=(('libnssutil3.so', 'NSSUTIL_3.108'),)))
        problems, stats = check_tree(self.root, host_owned=())
        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith('ELF_CLOSURE_VERSION_UNSATISFIED: usr/lib/libsoftokn3.so'), problems[0])
        self.assertIn('NSSUTIL_3.108', problems[0])
        self.assertIn('NSSUTIL_3.94', problems[0])
        self.assertEqual(stats.version_needs, 1)

    def test_version_requirement_satisfied(self):
        self.write('usr/lib/libnssutil3.so', build_elf(soname='libnssutil3.so', provides=('NSSUTIL_3.94', 'NSSUTIL_3.108')))
        self.write('usr/lib/libsoftokn3.so', build_elf(
            soname='libsoftokn3.so', needed=('libnssutil3.so',),
            requires=(('libnssutil3.so', 'NSSUTIL_3.108'),)))
        problems, stats = check_tree(self.root, host_owned=())
        self.assertEqual(problems, [])
        self.assertEqual(stats.version_needs, 1)

    def test_version_of_host_library_is_not_checked(self):
        self.write('usr/bin/app', build_elf(
            needed=('libc.so.6',), requires=(('libc.so.6', 'GLIBC_2.38'), ('libssl.so.3', 'OPENSSL_3.5.0'))))
        problems, stats = check_tree(self.root)
        self.assertEqual(problems, [])
        self.assertEqual(stats.version_needs, 0)

    def test_elf_without_program_headers_is_ignored(self):
        self.write('usr/bin/obj', build_elf(dynamic=False))
        self.write('usr/bin/app', build_elf(needed=('libc.so.6',)))
        problems, stats = check_tree(self.root)
        self.assertEqual(problems, [])
        self.assertEqual(stats.elf_files, 2)
        self.assertEqual(stats.needed, 1)

    def test_only_elf_files_are_scanned(self):
        self.write('usr/share/notes.txt', b'libnope.so.9 needs nothing\n')
        problems, stats = check_tree(self.root)
        self.assertEqual(problems, [])
        self.assertEqual(stats.elf_files, 0)

    def test_elf32_is_parsed(self):
        self.write('usr/bin/app', build_elf(needed=('libc.so.6',), elf_class=1))
        info = parse_elf(self.root / 'usr/bin/app')
        self.assertEqual(info.needed, ('libc.so.6',))

    def test_parse_elf_rejects_non_elf(self):
        path = self.write('usr/bin/text', b'#!/bin/sh\n')
        self.assertIsNone(parse_elf(path))

    def test_parse_elf_reports_truncated_file(self):
        path = self.write('usr/bin/broken', b'\x7fELF\x02\x01\x01')
        with self.assertRaises(ValueError):
            parse_elf(path)

    def test_unreadable_elf_is_reported(self):
        self.write('usr/lib/libbad.so', b'\x7fELF\x07\x01' + b'\x00' * 128)
        problems, _ = check_tree(self.root)
        self.assertEqual(len(problems), 1)
        self.assertIn('ELF_CLOSURE_UNREADABLE: usr/lib/libbad.so', problems[0])

    def test_missing_root_is_reported(self):
        with self.assertRaises(ValueError):
            check_tree(self.root / 'absent')


class CommandLineTest(unittest.TestCase):
    def run_script(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)

    def test_usage_requires_a_root(self):
        self.assertEqual(self.run_script().returncode, 2)
        self.assertEqual(self.run_script('--root').returncode, 2)
        self.assertEqual(self.run_script('--unknown').returncode, 2)

    def test_closed_root_exits_zero(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            (root / 'usr/bin').mkdir(parents=True)
            (root / 'usr/bin/app').write_bytes(build_elf(needed=('libc.so.6',)))
            result = self.run_script('--root', str(root))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('is closed', result.stdout)
            self.assertIn('1 from the host', result.stdout)

    def test_violating_root_exits_nonzero_and_annotates(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            (root / 'usr/lib').mkdir(parents=True)
            (root / 'usr/lib/liborphan.so.1').write_bytes(build_elf(soname='liborphan.so.1', needed=('libnope.so.9',)))
            result = self.run_script('--root', str(root))
            self.assertEqual(result.returncode, 1)
            self.assertIn('::error::ELF_CLOSURE_UNRESOLVED_NEEDED', result.stderr)
            self.assertIn('libnope.so.9', result.stderr)

    def test_multiple_roots_are_all_checked(self):
        with tempfile.TemporaryDirectory() as work:
            good = Path(work) / 'good'
            bad = Path(work) / 'bad'
            (good / 'usr/bin').mkdir(parents=True)
            (bad / 'usr/bin').mkdir(parents=True)
            (good / 'usr/bin/app').write_bytes(build_elf(needed=('libc.so.6',)))
            (bad / 'usr/bin/app').write_bytes(build_elf(needed=('libnope.so.9',)))
            result = self.run_script('--root', str(good), '--root', str(bad))
            self.assertEqual(result.returncode, 1)
            self.assertIn('is closed', result.stdout)
            self.assertIn('1 of 2 tree(s)', result.stderr)

    def test_missing_root_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as work:
            result = self.run_script('--root', str(Path(work) / 'absent'))
            self.assertEqual(result.returncode, 1)
            self.assertIn('::error::ELF_CLOSURE_FAILED', result.stderr)

    def test_fixer_excludes_every_host_owned_library(self):
        fixer = (SCRIPT.parent / 'fix-appimage-host-libs.sh').read_text(encoding='utf-8')
        for pattern in HOST_OWNED:
            self.assertIn(f"'{pattern}'", fixer, pattern)


if __name__ == '__main__':
    unittest.main()
