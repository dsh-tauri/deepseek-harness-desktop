import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('fix-appimage-host-libs.sh')
VALIDATOR = SCRIPT.read_text(encoding='utf-8').split("<<'PY_ELECTRON'\n", 1)[1].split('\nPY_ELECTRON', 1)[0]
REQUIRED = ('main.cjs', 'preload.cjs', 'icudtl.dat', 'resources.pak', 'libffmpeg.so', 'libvulkan.so.1', 'libvk_swiftshader.so', 'vk_swiftshader_icd.json')


class AppImageTest(unittest.TestCase):
    def fixture(self, root, arch='x64'):
        dist = root / f'usr/lib/DeepSeek Harness/runtime/linux-{arch}'
        dist.mkdir(parents=True)
        (root / 'usr/bin').mkdir(parents=True)
        for name in ('AppRun', 'AppRun.wrapped', 'usr/bin/deepseek-harness'):
            path = root / name
            path.write_bytes(b'#!/bin/sh\nexit 0\n')
            path.chmod(0o755)
        (dist / 'electron-rs.json').write_text(json.dumps({
            'version': 2, 'target': 'linux', 'arch': arch, 'binary': 'DeepSeek Harness',
        }), encoding='utf-8')
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<H', header, 18, {'x64': 62, 'arm64': 183}[arch])
        binary = dist / 'DeepSeek Harness'
        binary.write_bytes(header)
        binary.chmod(0o755)
        for name in REQUIRED:
            (dist / name).write_bytes(b'preserve-electron-' + name.encode())
        (root / 'usr/lib/libwayland-client.so.0').write_bytes(b'old-host-library')
        return dist

    def validate(self, root):
        return subprocess.run([sys.executable, '-c', VALIDATOR, str(root)], capture_output=True, text=True)

    def test_electron_contract(self):
        with tempfile.TemporaryDirectory() as work:
            for arch in ('x64', 'arm64'):
                root = Path(work) / arch
                dist = self.fixture(root, arch)
                self.assertEqual(self.validate(root).returncode, 0)
                for name in (*REQUIRED, 'DeepSeek Harness', 'electron-rs.json'):
                    path = dist / name
                    backup = path.read_bytes()
                    path.unlink()
                    if name in REQUIRED:
                        (root / 'usr/lib' / name).write_bytes(backup)
                    result = self.validate(root)
                    self.assertNotEqual(result.returncode, 0, name)
                    path.write_bytes(b'')
                    self.assertNotEqual(self.validate(root).returncode, 0, name)
                    path.write_bytes(backup)
                    if name == 'DeepSeek Harness':
                        path.chmod(0o755)
                binary = dist / 'DeepSeek Harness'
                if sys.platform == 'linux':
                    binary.chmod(0o644)
                    self.assertNotEqual(self.validate(root).returncode, 0)
                    binary.chmod(0o755)
                header = bytearray(binary.read_bytes())
                struct.pack_into('<H', header, 18, {'x64': 183, 'arm64': 62}[arch])
                binary.write_bytes(header)
                self.assertNotEqual(self.validate(root).returncode, 0)
                binary.write_bytes(b'not-an-ELF-executable')
                self.assertNotEqual(self.validate(root).returncode, 0)

    @unittest.skipUnless(sys.platform == 'linux', 'real SquashFS repacking requires Linux')
    def test_real_squashfs_repack(self):
        for tool in ('mksquashfs', 'unsquashfs'):
            self.assertIsNotNone(shutil.which(tool), f'missing required tool: {tool}')
        with tempfile.TemporaryDirectory() as work:
            work = Path(work)
            for arch in ('x64', 'arm64'):
                root = work / arch
                dist = self.fixture(root, arch)
                original = {p.relative_to(dist): p.read_bytes() for p in dist.iterdir()}
                host_libraries = []
                for name in ('libmount.so.1', 'libpcre2-8.so.0', 'libselinux.so.1', 'libsystemd.so.0', 'libdbus-1.so.3'):
                    library = root / 'usr/lib' / f'{name}.0.0'
                    library.write_bytes(b'old-host-library')
                    soname = library.with_name(name)
                    soname.symlink_to(library.name)
                    host_libraries.extend((library, soname))
                image = work / f'{arch}.AppImage'
                fs = work / f'{arch}.squashfs'
                runtime = b'#!/bin/sh\nexit 1\n'

                def pack():
                    fs.unlink(missing_ok=True)
                    subprocess.run(['mksquashfs', str(root), str(fs), '-noappend', '-no-progress', '-quiet', '-processors', '1'], check=True)
                    image.write_bytes(runtime + fs.read_bytes())

                pack()
                result = subprocess.run(['bash', str(SCRIPT), '--require-removal', str(image)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                extracted = work / f'extracted-{arch}'
                subprocess.run(['unsquashfs', '-o', str(len(runtime)), '-d', str(extracted), str(image)], check=True, stdout=subprocess.DEVNULL)
                self.assertFalse((extracted / 'usr/lib/libwayland-client.so.0').exists())
                for library in host_libraries:
                    removed = extracted / library.relative_to(root)
                    self.assertFalse(removed.exists() or removed.is_symlink(), library.name)
                kept = extracted / dist.relative_to(root)
                self.assertEqual({p.relative_to(kept): p.read_bytes() for p in kept.iterdir()}, original)
                self.assertEqual(self.validate(extracted).returncode, 0)
                before = image.read_bytes()
                result = subprocess.run(['bash', str(SCRIPT), str(image)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(image.read_bytes(), before)
                for missing in ('usr/lib/DeepSeek Harness/runtime', *(f'usr/lib/DeepSeek Harness/runtime/linux-{arch}/{name}' for name in ('libffmpeg.so', 'libvulkan.so.1', 'libvk_swiftshader.so', 'vk_swiftshader_icd.json')), 'AppRun.wrapped'):
                    path = root / missing
                    backup = root / 'saved'
                    path.rename(backup)
                    pack()
                    before = image.read_bytes()
                    result = subprocess.run(['bash', str(SCRIPT), '--require-removal', str(image)], capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0, missing)
                    self.assertEqual(image.read_bytes(), before)
                    backup.rename(path)
                (root / 'usr/lib/libwayland-client.so.0').unlink()
                for library in host_libraries:
                    library.unlink()
                pack()
                before = image.read_bytes()
                result = subprocess.run(['bash', str(SCRIPT), '--require-removal', str(image)], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('--require-removal was requested', result.stderr)
                self.assertEqual(image.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
