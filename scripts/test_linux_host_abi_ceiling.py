import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('linux_host_abi_ceiling.py')
SHELL = Path(__file__).with_name('check-linux-glibc-abi.sh')
sys.path.insert(0, str(SCRIPT.parent))

from linux_host_abi_ceiling import CEILINGS, FORBIDDEN, exceeds, inspect, split_symbol  # noqa: E402

READELF_DUMP = """
Version needs section '.gnu.version_r' contains 2 entries:
 Addr: 0x0000000000000000  Offset: 0x0005f0  Link: 5 (.dynstr)
  000000: Version: 1  File: libc.so.6  Cnt: 2
  0x0010:   Name: GLIBC_2.2.5  Flags: none  Version: 3
  0x0020:   Name: GLIBC_2.34  Flags: none  Version: 4
  000020: Version: 1  File: libnssutil3.so  Cnt: 1
  0x0010:   Name: NSSUTIL_3.12.3  Flags: none  Version: 2

Version definition section '.gnu.version_d' contains 1 entry:
  000000: Rev: 1  Flags: BASE  Index: 1  Cnt: 1  Name: libfoo.so.2
  0x001c: Parent 1: GLIBC_9.99
"""


def run_helper(lines, *arguments):
    text = ''.join(f'{line}\n' for line in lines)
    return subprocess.run([sys.executable, '-B', str(SCRIPT), *arguments],
                          input=text, capture_output=True, text=True)


class CeilingUnitTest(unittest.TestCase):
    def test_namespace_split(self):
        self.assertEqual(split_symbol('NSS_3.30'), ('NSS_', '3.30'))
        self.assertEqual(split_symbol('NSSUTIL_3.108'), ('NSSUTIL_', '3.108'))
        self.assertEqual(split_symbol('OPENSSL_3.5.0'), ('OPENSSL_', '3.5.0'))
        self.assertEqual(split_symbol('gssapi_krb5_2_MIT'), ('gssapi_krb5_', '2_MIT'))
        self.assertEqual(split_symbol('LIBDBUS_1_3'), ('LIBDBUS_', '1_3'))
        self.assertEqual(split_symbol('V_0.5.0'), ('V_', '0.5.0'))
        self.assertEqual(split_symbol('WEAK'), ('WEAK', ''))

    def test_numeric_comparison_not_lexicographic(self):
        self.assertTrue(exceeds('3.108', '3.94'))
        self.assertFalse(exceeds('3.94', '3.108'))
        self.assertTrue(exceeds('3.5.0', '3.0.0'))
        self.assertFalse(exceeds('3.0.0', '3.5.0'))
        self.assertTrue(exceeds('3.30', '3.9'))
        self.assertFalse(exceeds('3.9', '3.30'))
        self.assertFalse(exceeds('3.30', '3.30'))

    def test_bundled_namespace_at_ceiling_passes(self):
        violations, inspected, namespaces = inspect(['libnss3.so\tNSS_3.30'])
        self.assertEqual(violations, [])
        self.assertEqual(inspected, 1)
        self.assertEqual(namespaces, ['NSS_'])

    def test_requirement_above_ceiling_is_reported(self):
        violations, _, _ = inspect(['usr/lib/libsoftokn3.so\tNSSUTIL_3.108'])
        self.assertEqual(len(violations), 1)
        self.assertIn('LINUX_HOST_ABI_CEILING', violations[0])
        self.assertIn('NSSUTIL_3.108', violations[0])
        self.assertIn('NSSUTIL_3.12.3', violations[0])

    def test_openssl_35_is_rejected(self):
        violations, _, _ = inspect(['usr/bin/app\tOPENSSL_3.5.0'])
        self.assertEqual(len(violations), 1)
        self.assertIn('OPENSSL_3.5.0', violations[0])

    def test_kerberos_requirements_are_forbidden(self):
        for symbol in ('gssapi_krb5_2_MIT', 'krb5support_0_MIT', 'krb5_3_MIT'):
            with self.subTest(symbol=symbol):
                violations, inspected, _ = inspect([f'usr/lib/libcups.so.2\t{symbol}'])
                self.assertEqual(len(violations), 1)
                self.assertIn('LINUX_HOST_ABI_FORBIDDEN', violations[0])
                self.assertEqual(inspected, 1)

    def test_glibc_and_unknown_namespaces_are_ignored(self):
        violations, inspected, _ = inspect([
            'usr/bin/app\tGLIBC_2.38',
            'usr/lib/libgnutls.so.30\tGNUTLS_3_7_3',
            'usr/lib/libp11-kit.so.0\tLIBP11_KIT_1.0',
        ])
        self.assertEqual(violations, [])
        self.assertEqual(inspected, 0)

    def test_every_contract_namespace_is_classified(self):
        for namespace in CEILINGS:
            self.assertNotIn(namespace, FORBIDDEN, namespace)
            self.assertTrue(namespace.endswith('_'), namespace)
            self.assertTrue(CEILINGS[namespace], namespace)

    def test_malformed_lines_are_skipped(self):
        violations, inspected, _ = inspect(['no tab here', '', 'label\t', 'label\t   '])
        self.assertEqual(violations, [])
        self.assertEqual(inspected, 0)


class CommandLineTest(unittest.TestCase):
    def test_clean_input_exits_zero(self):
        result = run_helper(['usr/bin/app\tNSS_3.30', 'usr/bin/app\tOPENSSL_3.0.0'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('2 host-interface version symbol(s)', result.stdout)
        self.assertIn('NSS_ OPENSSL_', result.stdout)

    def test_violation_exits_nonzero_and_annotates(self):
        result = run_helper(['usr/lib/libsoftokn3.so\tNSSUTIL_3.108'])
        self.assertEqual(result.returncode, 1)
        self.assertIn('::error::LINUX_HOST_ABI_CEILING', result.stderr)

    def test_unexpected_argument_exits_two(self):
        result = run_helper([], '--max')
        self.assertEqual(result.returncode, 2)
        self.assertIn('::error::LINUX_HOST_ABI_FAILED', result.stderr)

    def test_empty_input_is_not_a_violation(self):
        result = run_helper([])
        self.assertEqual(result.returncode, 0)
        self.assertIn('none', result.stdout)


@unittest.skipUnless(shutil.which('bash'), 'synthetic readelf parsing needs bash and awk')
class ShellExtractionTest(unittest.TestCase):
    def extract_functions(self):
        text = SHELL.read_text(encoding='utf-8')
        bodies = []
        for name in ('glibc_versions_from', 'host_symbols_from'):
            match = re.search(rf'^{name}\(\) \{{\n.*?^\}}\n', text, re.MULTILINE | re.DOTALL)
            self.assertIsNotNone(match, name)
            bodies.append(match.group(0))
        return '\n'.join(bodies)

    def run_shell(self, function, dump):
        with tempfile.TemporaryDirectory() as work:
            report = Path(work) / 'report.txt'
            report.write_text(dump, encoding='utf-8')
            script = Path(work) / 'run.sh'
            script.write_text(self.extract_functions() + f'\n{function} "{report}"\n', encoding='utf-8')
            return subprocess.run(['bash', str(script)], capture_output=True, text=True)

    def test_glibc_extraction_ignores_other_namespaces_and_definitions(self):
        result = self.run_shell('glibc_versions_from', READELF_DUMP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ['2.2.5', '2.34'])

    def test_symbol_extraction_keeps_library_namespaces(self):
        result = self.run_shell('host_symbols_from', READELF_DUMP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ['GLIBC_2.2.5', 'GLIBC_2.34', 'NSSUTIL_3.12.3'])

    def test_readelf_dump_feeds_the_helper(self):
        symbols = self.run_shell('host_symbols_from', READELF_DUMP).stdout.split()
        result = run_helper([f'usr/lib/app\t{symbol}' for symbol in symbols])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('NSSUTIL_', result.stdout)

@unittest.skipUnless(shutil.which('bash'), 'shell contract checks need bash')
class ShellContractTest(unittest.TestCase):
    def test_abi_script_rejects_bad_arguments(self):
        result = subprocess.run(['bash', str(SHELL)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        result = subprocess.run(['bash', str(SHELL), '--max', '2.35', 'missing.deb'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('no such artifact', result.stderr)
        result = subprocess.run(['bash', str(SHELL), '--max', '2.35', str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('unsupported artifact type', result.stderr)

    def test_closure_check_is_wired_for_both_artifact_kinds(self):
        text = SHELL.read_text(encoding='utf-8')
        self.assertIn('check_closure "$extract/squashfs-root" "AppImage $(basename "$artifact")" ""', text)
        self.assertIn('check_closure "$target" "deb $(basename "$artifact")" "--allow-host-owned-libs"', text)
        self.assertIn('closure_failures', text)
        self.assertIn('appimage_lib_closure.py', text)
        self.assertIn('linux_host_abi_ceiling.py', text)


if __name__ == '__main__':
    unittest.main()
