import copy
import datetime as dt
import hashlib
import importlib.util
import json
import plistlib
import os
from pathlib import Path
import random
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('ios_testflight', Path(__file__).with_name('ios-testflight.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class SecretTests(unittest.TestCase):
    def test_wrapped_base64_decodes_identically(self):
        self.assertEqual(helper.decode_secret(' Zm\n l4dH\r\nVy ZQ==\t'), b'fixture')

    def test_invalid_base64_is_rejected(self):
        with self.assertRaises(ValueError):
            helper.decode_secret('Zm!4dHVyZQ==')


class VersionTests(unittest.TestCase):
    def test_timestamp_uses_ten_second_ticks_and_numeric_components(self):
        self.assertEqual(helper.build_number(1767225600), '1893.88.80')
        self.assertEqual(helper.build_number(1767225610), '1893.88.81')

    def test_component_rollover_preserves_numeric_order(self):
        self.assertEqual(helper.build_number(helper.EPOCH + 199990), '1.99.99')
        self.assertEqual(helper.build_number(helper.EPOCH + 200000), '2.0.0')

    def test_apple_component_upper_bound_is_enforced(self):
        self.assertEqual(helper.build_number(helper.EPOCH + 999999990), '9999.99.99')
        for timestamp in (helper.EPOCH, helper.EPOCH - 1, helper.EPOCH + 1000000000):
            with self.subTest(timestamp=timestamp), self.assertRaisesRegex(ValueError, 'range'):
                helper.build_number(timestamp)


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026, 1, 1)
        self.identity = hashlib.sha1(b'fixture-certificate').hexdigest().upper()
        self.profile = {
            'TeamIdentifier': ['ABCDEFGHIJ'],
            'ApplicationIdentifierPrefix': ['OLDPREFIX1'],
            'UUID': '12345678-1234-1234-1234-123456789abc',
            'Platform': ['iOS'],
            'ExpirationDate': dt.datetime(2027, 1, 1),
            'DeveloperCertificates': [b'fixture-certificate'],
            'Entitlements': {
                'com.apple.developer.team-identifier': 'ABCDEFGHIJ',
                'application-identifier': 'OLDPREFIX1.com.dshtauri.dshbridge',
                'get-task-allow': False,
                'beta-reports-active': True,
                'aps-environment': 'production',
            },
        }

    def validate(self, profile=None, identities=None):
        return helper.validate_profile(self.profile if profile is None else profile, 'ABCDEFGHIJ', self.now, {self.identity} if identities is None else identities)

    def test_valid_profile_allows_legacy_app_identifier_prefix(self):
        self.assertEqual(self.validate(), self.identity)

    def test_accepts_apple_multiplatform_profile_containing_ios(self):
        self.profile['Platform'] = ['iOS', 'xrOS', 'visionOS']
        self.assertEqual(self.validate(), self.identity)

    def test_rejects_platform_metadata_without_ios_or_not_a_list(self):
        for platforms in (None, [], ['xrOS', 'visionOS'], 'iOS', {'iOS': True}):
            with self.subTest(platforms=platforms), self.assertRaisesRegex(ValueError, 'iOS'):
                self.profile['Platform'] = platforms
                self.validate()

    def test_rejects_xcode_managed_profile_before_manual_signing(self):
        self.profile['IsXcodeManaged'] = True
        with self.assertRaisesRegex(ValueError, 'manually managed'):
            self.validate()

    def test_accepts_explicitly_manual_profile(self):
        self.profile['IsXcodeManaged'] = False
        self.assertEqual(self.validate(), self.identity)

    def test_rejects_wrong_team_app_platform_expiry_and_distribution(self):
        cases = [
            ('TeamIdentifier', ['OTHERTEAM1']),
            ('ApplicationIdentifierPrefix', []),
            ('UUID', '../profile'),
            ('Platform', ['OSX']),
            ('ExpirationDate', self.now),
            ('ProvisionedDevices', []),
            ('ProvisionsAllDevices', True),
            ('DeveloperCertificates', []),
        ]
        for key, value in cases:
            with self.subTest(key=key), self.assertRaises(ValueError):
                profile = copy.deepcopy(self.profile)
                profile[key] = value
                self.validate(profile)

    def test_rejects_development_wildcard_or_missing_entitlements(self):
        cases = [
            ('get-task-allow', True), ('get-task-allow', None),
            ('beta-reports-active', False),
            ('aps-environment', 'development'), ('aps-environment', None),
            ('application-identifier', 'OLDPREFIX1.*'),
            ('application-identifier', 'OLDPREFIX1.com.other.app'),
            ('com.apple.developer.team-identifier', 'OTHERTEAM1'),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                profile = copy.deepcopy(self.profile)
                profile['Entitlements'][key] = value
                self.validate(profile)

    def test_requires_matching_imported_certificate(self):
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.validate(identities={'0' * 40})

    def test_rejects_ambiguous_imported_certificates(self):
        self.profile['DeveloperCertificates'].append(b'another-certificate')
        other = hashlib.sha1(b'another-certificate').hexdigest().upper()
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.validate(identities={self.identity, other})


class VerifyCommandTests(unittest.TestCase):
    def test_certificate_extraction_prefix_is_attached_to_optional_argument(self):
        class ExtractionReached(Exception):
            pass

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'export').mkdir()
            (root / 'export/fixture.ipa').write_bytes(b'fixture')
            app = root / 'verified/Payload/Fixture.app'
            app.mkdir(parents=True)
            (app / 'Info.plist').write_bytes(plistlib.dumps({
                'CFBundleIdentifier': helper.BUNDLE_ID,
                'CFBundleShortVersionString': '0.24.0',
                'CFBundleVersion': '2140.80.1',
                'CFBundleSupportedPlatforms': ['iPhoneOS'],
                'CFBundleExecutable': 'Fixture',
            }))
            (app / 'Fixture').write_bytes(b'executable')
            (app / 'main.jsbundle').write_bytes(b'bundle')
            (app / 'EXConstants.bundle').mkdir()
            (app / 'EXConstants.bundle/app.config').write_text(json.dumps({
                'version': '0.24.0',
                'ios': {'bundleIdentifier': helper.BUNDLE_ID, 'buildNumber': '2140.80.1'},
                'extra': {'thirdPartyNotices': Path('THIRD_PARTY_NOTICES.md').read_text()},
            }))

            def external_command(*args):
                if args[:2] == ('codesign', '-d'):
                    self.assertEqual(args, ('codesign', '-d', f'--extract-certificates={root / "signed-cert-"}', str(app)))
                    raise ExtractionReached()
                self.assertIn(args[0], ('ditto', 'codesign'))
                return b''

            with patch.dict(os.environ, {'SIGNING_ROOT': str(root), 'IOS_VERSION': '0.24.0', 'BUILD_NUMBER': '2140.80.1'}), patch.object(helper, 'run', side_effect=external_command), self.assertRaises(ExtractionReached):
                helper.verify()


class CleanupTests(unittest.TestCase):
    def test_absent_signing_root_is_noop(self):
        with patch.dict(os.environ, {}, clear=True):
            helper.cleanup()

    def test_cleanup_only_removes_its_owned_temp_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            temp = Path(temporary).resolve()
            owned = temp / 'ios-testflight-fixture'
            owned.mkdir()
            (owned / 'secret.p8').write_text('fixture')
            unrelated = temp / 'unrelated'
            unrelated.write_text('preserve')
            with patch.dict(os.environ, {'RUNNER_TEMP': str(temp), 'SIGNING_ROOT': str(owned)}, clear=True):
                helper.cleanup()
            self.assertFalse(owned.exists())
            self.assertEqual(unrelated.read_text(), 'preserve')

    def test_cleanup_refuses_parent_unowned_relative_and_redirected_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            temp = Path(temporary).resolve()
            unrelated = temp / 'unrelated'
            unrelated.mkdir()
            link = temp / 'ios-testflight-link'
            link.symlink_to(unrelated, target_is_directory=True)
            for root in (str(temp), str(unrelated), 'ios-testflight-relative', str(link)):
                with self.subTest(root=root), patch.dict(os.environ, {'RUNNER_TEMP': str(temp), 'SIGNING_ROOT': root}, clear=True), self.assertRaisesRegex(ValueError, 'unsafe'):
                    helper.cleanup()
            self.assertTrue(unrelated.exists())

    def test_cleanup_refuses_unrelated_profile_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            temp = Path(temporary).resolve()
            owned = temp / 'ios-testflight-fixture'
            owned.mkdir()
            unrelated = temp / 'profile.mobileprovision'
            unrelated.write_text('preserve')
            with patch.dict(os.environ, {'RUNNER_TEMP': str(temp), 'SIGNING_ROOT': str(owned), 'INSTALLED_PROFILE': str(unrelated)}, clear=True), self.assertRaisesRegex(ValueError, 'profile cleanup'):
                helper.cleanup()
            self.assertEqual(unrelated.read_text(), 'preserve')


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromModule(__import__(__name__))
    tests = [case for group in suite for case in group]
    random.Random(2026).shuffle(tests)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(tests))
    raise SystemExit(not result.wasSuccessful())
