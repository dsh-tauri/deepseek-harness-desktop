import base64
import copy
import importlib.util
import io
import json
from pathlib import Path
import random
import subprocess
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.parse


spec = importlib.util.spec_from_file_location('ios_beta_review', Path(__file__).with_name('ios-beta-review.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
SHA = 'a' * 40


class FakeApple:
    def __init__(self):
        self.writes = []
        self.reads = []
        self.pauses = []
        self.processing = ['VALID']
        self.state = 'READY_FOR_BETA_SUBMISSION'
        self.submissions = []
        self.auto_notify = False
        self.groups = []
        self.locales = []
        self.internal = False
        self.group_app = 'app1'
        self.expired = False
        self.contact = {'contactFirstName': 'Test', 'contactLastName': 'Reviewer', 'contactPhone': '+100000000', 'contactEmail': 'fixture@example.invalid', 'demoAccountRequired': False}
        self.app_locale = {'locale': 'zh-Hans', 'description': 'Fixture description', 'feedbackEmail': 'fixture@example.invalid'}
        self.permission_error = None
        self.conflict = False
        self.raced_submission = False
        self.builds_override = None
        self.beta_processing = []

    def pause(self, seconds):
        self.pauses.append(seconds)

    def collection(self, path):
        result = self.request(path)
        if not isinstance(result.get('data'), list):
            raise AssertionError('Expected collection route')
        return result['data']

    def request(self, path, method='GET', payload=None):
        parsed = urllib.parse.urlsplit(path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        if method != 'GET':
            self.writes.append((route, method, copy.deepcopy(payload)))
            if self.permission_error:
                raise helper.ApiError(self.permission_error)
            attributes = payload['data'].get('attributes', {}) if isinstance(payload['data'], dict) else {}
            if route.startswith('/v1/betaBuildLocalizations'):
                if method == 'POST':
                    self.locales = [{'id': 'locale1', 'attributes': attributes}]
                else:
                    self.locales[0]['attributes'].update(attributes)
            elif route == '/v1/buildBetaDetails/detail1':
                self.auto_notify = attributes['autoNotifyEnabled']
            elif route == '/v1/betaAppReviewSubmissions':
                if self.conflict:
                    if self.raced_submission:
                        self.submissions = [{'id': 'submission1', 'attributes': {'betaReviewState': 'WAITING_FOR_REVIEW'}}]
                    raise helper.ApiError(409)
                self.submissions = [{'id': 'submission1', 'attributes': {'betaReviewState': 'WAITING_FOR_REVIEW'}}]
                self.state = 'WAITING_FOR_BETA_REVIEW'
            elif route == '/v1/builds/build1/relationships/betaGroups':
                if not self.submissions and self.state not in helper.ACTIVE:
                    raise AssertionError('Group association must follow submission or approval')
                self.groups = [{'id': 'group1'}]
            else:
                raise AssertionError('Unexpected mutation route')
            return {}
        self.reads.append(route)
        if route == '/v1/apps':
            assert query['filter[bundleId]'] == ['com.dshtauri.dshbridge']
            return {'data': [{'id': 'app1', 'attributes': {'bundleId': helper.BUNDLE_ID}}]}
        if route == '/v1/betaGroups/group1':
            return {'data': {'id': 'group1', 'attributes': {'isInternalGroup': self.internal}, 'relationships': {'app': {'data': {'id': self.group_app}}}}}
        if route == '/v1/apps/app1/betaAppReviewDetail':
            return {'data': {'attributes': self.contact}}
        if route == '/v1/betaAppLocalizations':
            return {'data': [{'id': 'app-locale1', 'attributes': self.app_locale}]}
        if route == '/v1/builds':
            assert query['filter[app]'] == ['app1']
            assert query['filter[version]'] == ['2140.81.36']
            assert query['filter[preReleaseVersion.version]'] == ['0.24.0']
            if self.builds_override is not None:
                return copy.deepcopy(self.builds_override)
            state = self.processing.pop(0) if len(self.processing) > 1 else self.processing[0]
            return self.build_page(state)
        if route == '/v1/builds/build1/buildBetaDetail':
            state = self.beta_processing.pop(0) if self.beta_processing else self.state
            return {'data': {'id': 'detail1', 'attributes': {'externalBuildState': state, 'autoNotifyEnabled': self.auto_notify}}}
        if route == '/v1/betaAppReviewSubmissions':
            assert query['filter[build]'] == ['build1']
            return {'data': copy.deepcopy(self.submissions)}
        if route == '/v1/betaBuildLocalizations':
            return {'data': copy.deepcopy(self.locales)}
        if route == '/v1/builds/build1/betaGroups':
            raise helper.ApiError(403)
        if route == '/v1/betaGroups/group1/relationships/builds':
            return {'data': [{'type': 'builds', 'id': 'build1'}] if any(item['id'] == 'group1' for item in self.groups) else []}
        raise AssertionError('Unexpected read route: ' + route)

    def build_page(self, state='VALID'):
        if state is None:
            return {'data': []}
        return {'data': [{'id': 'build1', 'attributes': {'version': '2140.81.36', 'processingState': state, 'expired': self.expired}, 'relationships': {'app': {'data': {'id': 'app1'}}, 'preReleaseVersion': {'data': {'type': 'preReleaseVersions', 'id': 'version1'}}}}], 'included': [{'type': 'preReleaseVersions', 'id': 'version1', 'attributes': {'version': '0.24.0', 'platform': 'IOS'}}]}


class SubmitTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeApple()

    def submit(self, check=False):
        return helper.submit(self.api, 'group1', '0.24.0', '2140.81.36', SHA, check)

    def test_submit_orders_metadata_auto_notify_review_then_group(self):
        result = self.submit()
        self.assertEqual([(path, method) for path, method, _ in self.api.writes], [
            ('/v1/betaBuildLocalizations', 'POST'),
            ('/v1/buildBetaDetails/detail1', 'PATCH'),
            ('/v1/betaAppReviewSubmissions', 'POST'),
            ('/v1/builds/build1/relationships/betaGroups', 'POST'),
        ])
        payload = self.api.writes[0][2]['data']
        self.assertEqual(payload['attributes']['locale'], 'zh-Hans')
        self.assertEqual(payload['relationships']['build']['data']['id'], 'build1')
        self.assertEqual(payload['attributes']['whatsNew'], '请测试主机发现、扫码连接、会话交互及 iPad 横竖屏\n版本：0.24.0 (2140.81.36)\nhttps://github.com/dsh-tauri/deepseek-harness-desktop/commit/' + SHA)
        self.assertEqual(self.api.writes[1][2]['data']['attributes'], {'autoNotifyEnabled': True})
        self.assertEqual(self.api.writes[-1][2], {'data': [{'type': 'betaGroups', 'id': 'group1'}]})
        self.assertIn('No notification delivery is claimed', result)

    def test_pending_review_recovers_group_link_via_supported_reverse_relationship(self):
        self.api.state = 'WAITING_FOR_BETA_REVIEW'
        self.api.submissions = [{'id': 'submission1', 'attributes': {'betaReviewState': 'WAITING_FOR_REVIEW'}}]
        self.api.auto_notify = True
        self.submit()
        self.assertIn('/v1/betaGroups/group1/relationships/builds', self.api.reads)
        self.assertNotIn('/v1/builds/build1/betaGroups', self.api.reads)
        self.assertEqual(self.api.writes, [('/v1/builds/build1/relationships/betaGroups', 'POST', {'data': [{'type': 'betaGroups', 'id': 'group1'}]})])
        self.api.writes.clear()
        self.submit()
        self.assertEqual(self.api.writes, [])

    def test_check_verifies_group_build_read_access_without_linking(self):
        self.submit(check=True)
        self.assertIn('/v1/betaGroups/group1/relationships/builds', self.api.reads)
        self.assertFalse(self.api.writes)

    def test_group_read_failure_prevents_any_review_or_metadata_mutation(self):
        original = self.api.collection

        def denied(path):
            if '/relationships/builds' in path:
                raise helper.ApiError(403)
            return original(path)

        self.api.collection = denied
        with self.assertRaises(helper.ApiError):
            self.submit()
        self.assertFalse(self.api.writes)

    def test_repeated_run_does_not_duplicate_review_or_group(self):
        self.submit()
        self.api.writes.clear()
        self.submit()
        self.assertEqual(self.api.writes, [])

    def test_existing_localization_is_patched_instead_of_duplicated(self):
        self.api.locales = [{'id': 'locale1', 'attributes': {'locale': 'zh-Hans', 'whatsNew': 'old'}}]
        self.submit()
        self.assertEqual(self.api.writes[0][:2], ('/v1/betaBuildLocalizations/locale1', 'PATCH'))

    def test_active_external_states_do_not_resubmit_review(self):
        for state in ('WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW', 'BETA_APPROVED', 'READY_FOR_BETA_TESTING', 'IN_BETA_TESTING'):
            with self.subTest(state=state):
                self.api = FakeApple()
                self.api.state = state
                self.submit()
                self.assertNotIn('/v1/betaAppReviewSubmissions', [item[0] for item in self.api.writes])
                self.assertTrue(self.api.auto_notify)
                self.assertEqual(self.api.groups, [{'id': 'group1'}])

    def test_already_testing_build_preserves_reviewed_metadata_and_notifications(self):
        self.api.state = 'IN_BETA_TESTING'
        self.api.auto_notify = True
        self.api.groups = [{'id': 'group1'}]
        self.api.locales = [{'id': 'locale1', 'attributes': {'locale': 'zh-Hans', 'whatsNew': 'Previously approved notes'}}]
        self.submit()
        self.assertEqual(self.api.writes, [])
        self.assertEqual(self.api.locales[0]['attributes']['whatsNew'], 'Previously approved notes')

    def test_valid_build_waits_for_external_processing_without_real_sleep(self):
        self.api.beta_processing = ['PROCESSING', 'PROCESSING']
        self.submit()
        self.assertEqual(self.api.pauses, [30, 30])
        self.api = FakeApple()
        self.api.state = 'PROCESSING'
        with self.assertRaisesRegex(ValueError, 'Timed out'):
            self.submit()
        self.assertEqual(len(self.api.pauses), 60)
        self.assertFalse(self.api.writes)

    def test_submission_resource_prevents_duplicate_despite_stale_build_state(self):
        for state in ('WAITING_FOR_REVIEW', 'IN_REVIEW', 'APPROVED'):
            with self.subTest(state=state):
                self.api = FakeApple()
                self.api.submissions = [{'id': 's1', 'attributes': {'betaReviewState': state}}]
                self.submit()
                self.assertNotIn('/v1/betaAppReviewSubmissions', [item[0] for item in self.api.writes])

    def test_conflict_is_only_treated_as_idempotent_with_submission_evidence(self):
        self.api.conflict = True
        with self.assertRaisesRegex(ValueError, 'rejected review submission'):
            self.submit()
        self.assertFalse(self.api.groups)
        self.api = FakeApple()
        self.api.conflict = self.api.raced_submission = True
        self.submit()
        self.assertEqual(self.api.groups, [{'id': 'group1'}])

    def test_external_group_must_belong_to_app(self):
        self.api.group_app = 'other-app'
        with self.assertRaisesRegex(ValueError, 'another app'):
            self.submit()
        self.assertFalse(self.api.writes)

    def test_internal_group_is_rejected_without_mutation(self):
        self.api.internal = True
        with self.assertRaisesRegex(ValueError, 'external'):
            self.submit()
        self.assertFalse(self.api.writes)

    def test_read_only_check_never_changes_apple_state(self):
        self.assertIn('no Apple resources changed', self.submit(check=True))
        self.assertFalse(self.api.writes)
        self.assertFalse(self.api.pauses)

    def test_check_of_processing_build_does_not_sleep(self):
        self.api.processing = ['PROCESSING']
        with self.assertRaisesRegex(ValueError, 'not yet VALID'):
            self.submit(check=True)
        self.assertFalse(self.api.writes)
        self.assertFalse(self.api.pauses)

    def test_processing_wait_targets_exact_build_and_is_bounded(self):
        self.api.processing = [None, 'PROCESSING', 'VALID']
        self.submit()
        self.assertEqual(self.api.pauses, [30, 30])
        self.api = FakeApple()
        self.api.processing = ['PROCESSING']
        with self.assertRaisesRegex(ValueError, 'Timed out'):
            self.submit()
        self.assertLessEqual(len(self.api.pauses), 61)
        self.assertFalse(self.api.writes)

    def test_terminal_processing_and_expired_builds_fail_without_mutation(self):
        for state in ('FAILED', 'INVALID'):
            with self.subTest(state=state):
                self.api = FakeApple()
                self.api.processing = [state]
                with self.assertRaisesRegex(ValueError, 'rejected build processing'):
                    self.submit()
                self.assertFalse(self.api.writes)
        self.api = FakeApple()
        self.api.expired = True
        with self.assertRaisesRegex(ValueError, 'expired'):
            self.submit()
        self.assertFalse(self.api.writes)

    def test_missing_compliance_rejected_and_unknown_states_fail_closed(self):
        for state in ('MISSING_EXPORT_COMPLIANCE', 'IN_EXPORT_COMPLIANCE_REVIEW', 'BETA_REJECTED', 'EXPIRED', 'PROCESSING_EXCEPTION', 'SURPRISE'):
            with self.subTest(state=state):
                self.api = FakeApple()
                self.api.state = state
                with self.assertRaises(ValueError):
                    self.submit()
                self.assertFalse(self.api.writes)

    def test_missing_required_contacts_or_localization_fail_without_mutation(self):
        for field in ('contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'):
            with self.subTest(field=field):
                self.api = FakeApple()
                self.api.contact[field] = ''
                with self.assertRaisesRegex(ValueError, 'contact'):
                    self.submit()
                self.assertFalse(self.api.writes)
        self.api = FakeApple()
        self.api.app_locale.pop('feedbackEmail')
        with self.assertRaisesRegex(ValueError, 'feedback email'):
            self.submit()

    def test_no_demo_account_does_not_require_optional_notes_or_privacy_url(self):
        self.submit()
        self.assertTrue(self.api.writes)

    def test_required_demo_account_credentials_are_not_fabricated(self):
        self.api.contact['demoAccountRequired'] = True
        with self.assertRaisesRegex(ValueError, 'demo-account credentials'):
            self.submit()
        self.assertFalse(self.api.writes)

    def test_403_requests_app_manager_without_permission_mutations(self):
        self.api.permission_error = 403
        with self.assertRaisesRegex(helper.ApiError, 'App Manager'):
            self.submit()
        self.assertEqual(len(self.api.writes), 1)

    def test_exact_build_selection_rejects_wrong_marketing_platform_number_and_app(self):
        for field in ('marketing', 'platform', 'number', 'app'):
            with self.subTest(field=field):
                page = self.api.build_page()
                if field == 'marketing':
                    page['included'][0]['attributes']['version'] = '9.0.0'
                elif field == 'platform':
                    page['included'][0]['attributes']['platform'] = 'MAC_OS'
                elif field == 'number':
                    page['data'][0]['attributes']['version'] = '9999'
                else:
                    page['data'][0]['relationships']['app']['data']['id'] = 'wrong'
                self.api.builds_override = page
                self.assertIsNone(helper.exact_build(self.api, 'app1', '0.24.0', '2140.81.36'))
        self.api.builds_override = self.api.build_page()
        self.api.builds_override['data'].append(copy.deepcopy(self.api.builds_override['data'][0]))
        with self.assertRaisesRegex(ValueError, 'Multiple builds'):
            helper.exact_build(self.api, 'app1', '0.24.0', '2140.81.36')

    def test_invalid_source_commit_is_rejected_before_any_mutation(self):
        with self.assertRaisesRegex(ValueError, 'SOURCE_SHA'):
            helper.submit(self.api, 'group1', '0.24.0', '2140.81.36', 'main')
        self.assertFalse(self.api.writes)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.monotonic = patch.object(helper.time, 'monotonic', side_effect=lambda: self.now)
        self.monotonic.start()
        self.addCleanup(self.monotonic.stop)
        self.client = helper.Client(Path('/fixture/key.p8'), 'ABCDEFGHIJ', '11111111-1111-1111-1111-111111111111', timeout=60)
        self.client.token = Mock(return_value='fake-token-not-a-secret')
        self.client.opener = Mock()

    def response(self, value):
        response = Mock()
        response.read.return_value = json.dumps(value).encode()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        return response

    def advance(self, seconds):
        self.now += seconds

    def test_foreign_hosts_credentials_fragments_and_http_are_rejected_before_token(self):
        for url in ('https://evil.invalid/v1/apps', 'http://api.appstoreconnect.apple.com/v1/apps', 'https://api.appstoreconnect.apple.com.evil.invalid/v1/apps', 'https://user@api.appstoreconnect.apple.com/v1/apps', 'https://api.appstoreconnect.apple.com:443/v1/apps', '/v1/apps#fragment'):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'untrusted'):
                self.client.request(url)
        self.client.token.assert_not_called()
        self.client.opener.open.assert_not_called()

    def test_redirect_is_denied_instead_of_forwarding_bearer(self):
        with self.assertRaisesRegex(ValueError, 'redirect'):
            helper.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.invalid')

    def test_get_rate_limit_and_transient_errors_retry_with_bounded_delay(self):
        self.client.opener.open.side_effect = [urllib.error.HTTPError('https://api.appstoreconnect.apple.com/v1/apps', 429, 'PII must not appear', {}, io.BytesIO(b'secret body')), urllib.error.URLError('secret connection detail'), self.response({'data': []})]
        with patch.object(helper.time, 'sleep', side_effect=self.advance):
            self.assertEqual(self.client.request('/v1/apps'), {'data': []})
        self.assertEqual(self.now, 15)
        self.assertEqual(self.client.token.call_count, 3)

    def test_post_is_not_blindly_retried_on_ambiguous_failure(self):
        self.client.opener.open.side_effect = urllib.error.HTTPError('https://api.appstoreconnect.apple.com/v1/apps', 503, 'sensitive', {}, io.BytesIO(b'private'))
        with self.assertRaises(helper.ApiError) as context:
            self.client.request('/v1/betaAppReviewSubmissions', 'POST', {'data': {}})
        self.assertNotIn('sensitive', str(context.exception))
        self.assertNotIn('private', str(context.exception))
        self.assertEqual(self.client.opener.open.call_count, 1)

    def test_api_error_reports_method_and_path_without_query_response_or_token(self):
        self.client.opener.open.side_effect = urllib.error.HTTPError('https://api.appstoreconnect.apple.com/v1/builds/build1/betaGroups', 403, 'sensitive response', {}, io.BytesIO(b'private detail'))
        with self.assertRaises(helper.ApiError) as context:
            self.client.request('/v1/builds/build1/betaGroups?filter[email]=private@example.invalid')
        message = str(context.exception)
        self.assertIn('GET /v1/builds/build1/betaGroups HTTP 403', message)
        self.assertIn('endpoint may not support this operation', message)
        for hidden in ('private@example.invalid', 'filter[email]', 'private detail', 'sensitive response', 'fake-token-not-a-secret'):
            self.assertNotIn(hidden, message)
        self.assertEqual(helper.ApiError(403).status, 403)

    def test_get_retry_budget_and_deadline_are_finite(self):
        self.client.opener.open.side_effect = urllib.error.URLError('sensitive')
        with patch.object(helper.time, 'sleep', side_effect=self.advance), self.assertRaisesRegex(ValueError, 'transport failed'):
            self.client.request('/v1/apps')
        self.assertEqual(self.client.opener.open.call_count, 3)
        self.now = 61
        with self.assertRaisesRegex(ValueError, 'deadline'):
            self.client.request('/v1/apps')
        self.assertEqual(self.client.opener.open.call_count, 3)

    def test_pagination_rejects_cross_host_next_links(self):
        self.client.opener.open.return_value = self.response({'data': [], 'links': {'next': 'https://evil.invalid/v1/apps'}})
        with self.assertRaisesRegex(ValueError, 'untrusted'):
            self.client.collection('/v1/apps')
        self.assertEqual(self.client.opener.open.call_count, 1)

    def test_pagination_rejects_cycles(self):
        self.client.opener.open.return_value = self.response({'data': [], 'links': {'next': '/v1/apps'}})
        with self.assertRaisesRegex(ValueError, 'pagination'):
            self.client.collection('/v1/apps')
        self.assertEqual(self.client.opener.open.call_count, 1)

    def test_jwt_signs_via_openssl_and_regenerates_short_lived_claims(self):
        client = helper.Client(Path('/fixture/key.p8'), 'ABCDEFGHIJ', '11111111-1111-1111-1111-111111111111')
        signature = bytes.fromhex('3006020101020102')
        with patch.object(helper.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, signature, b'')) as command, patch.object(helper.time, 'time', side_effect=[1000, 1301]):
            tokens = [client.token(), client.token()]
        claims = [json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '==')) for token in tokens]
        self.assertEqual([value['iat'] for value in claims], [1000, 1301])
        self.assertEqual([value['exp'] for value in claims], [1300, 1601])
        self.assertEqual(claims[0]['aud'], 'appstoreconnect-v1')
        self.assertEqual(command.call_args.args[0], ['openssl', 'dgst', '-sha256', '-sign', '/fixture/key.p8'])
        self.assertEqual(len(base64.urlsafe_b64decode(tokens[0].split('.')[2] + '==')), 64)


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromModule(__import__(__name__))
    cases = [case for group in suite for case in group]
    random.Random(2026).shuffle(cases)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(cases))
    raise SystemExit(not result.wasSuccessful())
