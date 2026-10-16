import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


HOST = 'https://api.appstoreconnect.apple.com'
BUNDLE_ID = 'com.dshtauri.dshbridge'
ACTIVE = {'WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW', 'BETA_APPROVED', 'READY_FOR_BETA_TESTING', 'IN_BETA_TESTING'}
SUBMITTED = {'WAITING_FOR_REVIEW', 'IN_REVIEW', 'APPROVED'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def resource_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9-]+', value), 'Invalid Apple resource identifier')
    return value


def api_url(path):
    url = HOST + path if path.startswith('/') else path
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.netloc == 'api.appstoreconnect.apple.com' and parsed.path.startswith('/v1/') and not parsed.fragment, 'Refusing untrusted Apple API URL')
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Refusing Apple API redirect')


class ApiError(ValueError):
    def __init__(self, status, method=None, path=None):
        self.status = status
        operation = f' {method} {urllib.parse.urlsplit(path).path}' if method and path else ''
        message = f'Apple API{operation} HTTP {status}; query and response omitted to protect account information'
        if status == 403:
            message += '; the endpoint may not support this operation, or the API key may lack permission; check the route before asking an administrator about App Manager access'
        super().__init__(message)


class Client:
    def __init__(self, key_path, key_id, issuer, timeout=1800):
        require(re.fullmatch(r'[A-Z0-9]{10}', key_id or ''), 'Invalid API key ID')
        require(re.fullmatch(r'[A-Fa-f0-9-]{36}', issuer or ''), 'Invalid API issuer ID')
        require(0 < timeout <= 1800, 'Processing timeout must be at most 30 minutes')
        self.key_path, self.key_id, self.issuer = key_path, key_id, issuer
        self.deadline = time.monotonic() + timeout
        self.opener = urllib.request.build_opener(NoRedirect())

    def token(self):
        def encode(value):
            return base64.urlsafe_b64encode(value).rstrip(b'=')

        now = int(time.time())
        header = encode(json.dumps({'alg': 'ES256', 'kid': self.key_id, 'typ': 'JWT'}).encode())
        claims = encode(json.dumps({'iss': self.issuer, 'iat': now, 'exp': now + 300, 'aud': 'appstoreconnect-v1'}).encode())
        message = header + b'.' + claims
        result = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', str(self.key_path)], input=message, capture_output=True, timeout=15)
        require(result.returncode == 0, 'Unable to sign Apple API token; details suppressed')
        sig = result.stdout
        require(len(sig) >= 8 and sig[0] == 0x30 and sig[1] == len(sig) - 2 and sig[2] == 2, 'Invalid ES256 signature encoding')
        end = 4 + sig[3]
        require(end + 2 < len(sig) and sig[end] == 2 and end + 2 + sig[end + 1] == len(sig), 'Invalid ES256 signature components')
        r = int.from_bytes(sig[4:end], 'big').to_bytes(32, 'big')
        s = int.from_bytes(sig[end + 2:], 'big').to_bytes(32, 'big')
        return (message + b'.' + encode(r + s)).decode()

    def pause(self, seconds):
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, 'Timed out waiting for the exact uploaded build; rerun review without uploading another build')
        time.sleep(min(seconds, remaining))

    def request(self, path, method='GET', payload=None):
        url = api_url(path)
        for attempt in range(3):
            remaining = self.deadline - time.monotonic()
            require(remaining > 0, 'Apple API operation exceeded the 30-minute deadline')
            req = urllib.request.Request(url, method=method, headers={'Authorization': 'Bearer ' + self.token(), 'Content-Type': 'application/json'}, data=json.dumps(payload).encode() if payload is not None else None)
            try:
                with self.opener.open(req, timeout=min(30, remaining)) as response:
                    body = response.read()
                return json.loads(body) if body else {}
            except urllib.error.HTTPError as error:
                status = error.code
                error.close()
                if method == 'GET' and (status == 429 or 500 <= status <= 599) and attempt < 2:
                    self.pause(5 * (attempt + 1))
                    continue
                raise ApiError(status, method, url) from None
            except (urllib.error.URLError, TimeoutError):
                if method == 'GET' and attempt < 2:
                    self.pause(5 * (attempt + 1))
                    continue
                raise ValueError('Apple API transport failed; mutation outcome may be unknown, rerun safely after checking Apple state') from None
        raise ValueError('Apple API retry budget exhausted')

    def collection(self, path):
        results, seen = [], set()
        while path:
            url = api_url(path)
            require(url not in seen and len(seen) < 20, 'Apple API pagination exceeded safe bounds')
            seen.add(url)
            page = self.request(url)
            require(isinstance(page.get('data'), list), 'Expected Apple resource collection')
            results.extend(page['data'])
            path = page.get('links', {}).get('next')
        return results


def query(path, **filters):
    return '/v1/' + path + '?' + urllib.parse.urlencode(filters)


def preflight(client, group_id):
    apps = client.collection(query('apps', **{'filter[bundleId]': BUNDLE_ID, 'limit': 2}))
    require(len(apps) == 1 and apps[0]['attributes'].get('bundleId') == BUNDLE_ID, 'Expected exactly one matching app')
    app_id = resource_id(apps[0]['id'])
    group = client.request(f'/v1/betaGroups/{resource_id(group_id)}?include=app')['data']
    require(group['id'] == group_id and group['attributes'].get('isInternalGroup') is False, 'Configured group must be external')
    require(group.get('relationships', {}).get('app', {}).get('data', {}).get('id') == app_id, 'Beta group belongs to another app')
    detail = client.request(f'/v1/apps/{app_id}/betaAppReviewDetail')['data']['attributes']
    required = ('contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail')
    require(all(isinstance(detail.get(key), str) and detail[key].strip() for key in required), 'Complete Beta review contact fields in App Store Connect')
    require(isinstance(detail.get('demoAccountRequired'), bool), 'Set Beta review demo-account requirement in App Store Connect')
    if detail['demoAccountRequired']:
        require(all(isinstance(detail.get(key), str) and detail[key].strip() for key in ('demoAccountName', 'demoAccountPassword')), 'Complete required Beta review demo-account credentials in App Store Connect')
    localizations = client.collection(query('betaAppLocalizations', **{'filter[app]': app_id, 'limit': 200}))
    require(any(item['attributes'].get('locale') == 'zh-Hans' and all(isinstance(item['attributes'].get(key), str) and item['attributes'][key].strip() for key in ('description', 'feedbackEmail')) for item in localizations), 'Complete zh-Hans Beta app description and feedback email in App Store Connect')
    return app_id


def exact_build(client, app_id, marketing, number):
    page = client.request(query('builds', **{'filter[app]': app_id, 'filter[version]': number, 'filter[preReleaseVersion.version]': marketing, 'filter[processingState]': 'PROCESSING,FAILED,INVALID,VALID', 'include': 'app,preReleaseVersion', 'limit': 200}))
    require(not page.get('links', {}).get('next'), 'Ambiguous exact-build response pagination')
    included = {(item['type'], item['id']): item for item in page.get('included', [])}
    matches = []
    for build in page['data']:
        attributes = build['attributes']
        relations = build.get('relationships', {})
        prerelease = relations.get('preReleaseVersion', {}).get('data')
        if attributes.get('version') != number or relations.get('app', {}).get('data', {}).get('id') != app_id:
            continue
        require(prerelease is not None, 'Exact build is missing its marketing version relationship')
        version = included.get((prerelease['type'], prerelease['id']))
        require(version is not None, 'Exact build marketing version was not included')
        if version['attributes'].get('version') == marketing and version['attributes'].get('platform') == 'IOS':
            matches.append(build)
    require(len(matches) <= 1, 'Multiple builds match the exact iOS marketing and build number')
    return matches[0] if matches else None


def wait_for_build(client, app_id, marketing, number, check=False):
    for _ in range(61):
        build = exact_build(client, app_id, marketing, number)
        if build:
            attributes = build['attributes']
            require(attributes.get('expired') is not True, 'Uploaded build is expired')
            state = attributes.get('processingState')
            require(state not in ('FAILED', 'INVALID'), 'Apple rejected build processing; inspect App Store Connect before retrying')
            if state == 'VALID':
                return build
            require(state == 'PROCESSING', 'Unknown Apple build processing state')
        require(not check, 'Exact uploaded build is not yet VALID; check mode made no changes')
        client.pause(30)
    raise ValueError('Timed out waiting for the exact uploaded build')


def review_state(client, build_id, wait=False):
    for attempt in range(61):
        detail = client.request(f'/v1/builds/{build_id}/buildBetaDetail')['data']
        state = detail['attributes'].get('externalBuildState')
        if state != 'PROCESSING' or not wait:
            break
        require(attempt < 60, 'Timed out waiting for external Beta processing')
        client.pause(30)
    require(state not in ('MISSING_EXPORT_COMPLIANCE', 'IN_EXPORT_COMPLIANCE_REVIEW'), 'Resolve export compliance in App Store Connect; this tool does not declare encryption compliance')
    require(state in ACTIVE | {'READY_FOR_BETA_SUBMISSION'}, 'Build is not eligible for Beta review; inspect external testing state in App Store Connect')
    submissions = client.collection(query('betaAppReviewSubmissions', **{'filter[build]': build_id, 'limit': 200}))
    require(all(item['attributes'].get('betaReviewState') in SUBMITTED for item in submissions), 'Existing Beta review was rejected or has an unknown state; inspect App Store Connect')
    return detail, state, bool(submissions)


def submit(client, group_id, marketing, number, source_sha, check=False):
    require(re.fullmatch(r'\d+\.\d+\.\d+', marketing or ''), 'Invalid marketing version')
    require(re.fullmatch(r'\d+(?:\.\d+){0,2}', number or ''), 'Invalid build number')
    require(re.fullmatch(r'[0-9a-f]{40}', source_sha or ''), 'SOURCE_SHA must be an immutable official commit')
    app_id = preflight(client, group_id)
    build = wait_for_build(client, app_id, marketing, number, check)
    build_id = resource_id(build['id'])
    detail, state, submitted = review_state(client, build_id, wait=not check)
    group_builds = client.collection(f'/v1/betaGroups/{resource_id(group_id)}/relationships/builds?limit=200')
    require(all(item.get('type') == 'builds' for item in group_builds), 'Expected build identifiers in the Beta group relationship')
    if check:
        return f'Preflight passed for {marketing} ({number}); no Apple resources changed'
    if state == 'READY_FOR_BETA_SUBMISSION' and not submitted:
        whats_new = f'请测试主机发现、扫码连接、会话交互及 iPad 横竖屏\n版本：{marketing} ({number})\nhttps://github.com/dsh-tauri/deepseek-harness-desktop/commit/{source_sha}'
        locales = client.collection(query('betaBuildLocalizations', **{'filter[build]': build_id, 'limit': 200}))
        matches = [item for item in locales if item['attributes'].get('locale') == 'zh-Hans']
        require(len(matches) <= 1, 'Duplicate zh-Hans build localizations')
        if matches:
            if matches[0]['attributes'].get('whatsNew') != whats_new:
                identifier = resource_id(matches[0]['id'])
                client.request(f'/v1/betaBuildLocalizations/{identifier}', 'PATCH', {'data': {'type': 'betaBuildLocalizations', 'id': identifier, 'attributes': {'whatsNew': whats_new}}})
        else:
            client.request('/v1/betaBuildLocalizations', 'POST', {'data': {'type': 'betaBuildLocalizations', 'attributes': {'locale': 'zh-Hans', 'whatsNew': whats_new}, 'relationships': {'build': {'data': {'type': 'builds', 'id': build_id}}}}})
    if detail['attributes'].get('autoNotifyEnabled') is not True:
        identifier = resource_id(detail['id'])
        client.request(f'/v1/buildBetaDetails/{identifier}', 'PATCH', {'data': {'type': 'buildBetaDetails', 'id': identifier, 'attributes': {'autoNotifyEnabled': True}}})
    if state == 'READY_FOR_BETA_SUBMISSION' and not submitted:
        try:
            client.request('/v1/betaAppReviewSubmissions', 'POST', {'data': {'type': 'betaAppReviewSubmissions', 'relationships': {'build': {'data': {'type': 'builds', 'id': build_id}}}}})
        except ApiError as error:
            if error.status != 409:
                raise
            _, current, exists = review_state(client, build_id)
            require(current in ACTIVE or exists, 'Apple rejected review submission; no duplicate submission attempted')
    if not any(item['id'] == build_id for item in group_builds):
        client.request(f'/v1/builds/{build_id}/relationships/betaGroups', 'POST', {'data': [{'type': 'betaGroups', 'id': group_id}]})
    final, final_state, final_submitted = review_state(client, build_id)
    require(final['attributes'].get('autoNotifyEnabled') is True, 'Apple did not retain automatic tester notification setting')
    require(final_state in ACTIVE or final_submitted, 'Apple has not confirmed Beta review submission; rerun this step safely')
    return f'Beta review configured for {marketing} ({number}); Apple automatic notification enabled for the existing external group after approval. No notification delivery is claimed.'


def main():
    require(sys.argv[1:] in ([], ['--check']), 'Only --check is supported')
    key_id = os.environ.get('APP_STORE_CONNECT_KEY_ID', '')
    root = Path(os.environ['SIGNING_ROOT']).resolve()
    require(root.is_dir(), 'Signing root is unavailable')
    require(re.fullmatch(r'[A-Z0-9]{10}', key_id), 'Invalid API key ID')
    key = root / 'private_keys' / f'AuthKey_{key_id}.p8'
    require(key.is_file() and not key.is_symlink() and key.resolve().is_relative_to(root), 'API private key must reside inside the signing root')
    client = Client(key, key_id, os.environ.get('APP_STORE_CONNECT_ISSUER_ID', ''))
    result = submit(client, os.environ.get('TESTFLIGHT_BETA_GROUP_ID', ''), os.environ.get('IOS_VERSION', ''), os.environ.get('BUILD_NUMBER', ''), os.environ.get('SOURCE_SHA', ''), check=bool(sys.argv[1:]))
    print(result)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write(result + '\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.TimeoutExpired):
        error = sys.exc_info()[1]
        message = str(error) if isinstance(error, ValueError) else 'Beta review configuration or local signing operation failed; sensitive details omitted'
        print(f'::error::{message}', file=sys.stderr)
        raise SystemExit(1)
