import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile


EPOCH = 1577836800
BUNDLE_ID = 'com.dshtauri.dshbridge'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def build_number(timestamp):
    ticks = (int(timestamp) - EPOCH) // 10
    require(10000 <= ticks <= 99999999, 'Build timestamp exceeds the 4.2.2 version range')
    return f'{ticks // 10000}.{ticks // 100 % 100}.{ticks % 100}'


def validate_profile(profile, team, now, identities):
    entitlements = profile.get('Entitlements', {})
    require(profile.get('TeamIdentifier') == [team], 'Profile team mismatch')
    require(entitlements.get('com.apple.developer.team-identifier') == team, 'Entitlement team mismatch')
    prefixes = profile.get('ApplicationIdentifierPrefix', [])
    require(len(prefixes) == 1 and isinstance(prefixes[0], str), 'Invalid app identifier prefix')
    require(entitlements.get('application-identifier') == f'{prefixes[0]}.{BUNDLE_ID}', 'Profile app ID mismatch')
    require(profile.get('ExpirationDate', dt.datetime.min) > now, 'Provisioning profile expired')
    platforms = profile.get('Platform')
    require(isinstance(platforms, list) and 'iOS' in platforms, 'Profile is not for iOS')
    require(profile.get('IsXcodeManaged', False) is False, 'Profile must be manually managed; create an App Store Connect profile in the Apple Developer portal')
    require('ProvisionedDevices' not in profile and not profile.get('ProvisionsAllDevices'), 'Profile must use App Store distribution')
    require(entitlements.get('get-task-allow') is False, 'Profile must disallow debugging')
    require(entitlements.get('beta-reports-active') is True, 'Profile must support TestFlight')
    require(entitlements.get('aps-environment') == 'production', 'Profile must support production push notifications')
    require(re.fullmatch(r'[A-Fa-f0-9-]{36}', profile.get('UUID', '')), 'Invalid profile UUID')
    certificates = {hashlib.sha1(cert).hexdigest().upper() for cert in profile.get('DeveloperCertificates', [])}
    matches = certificates.intersection(identities)
    require(len(matches) == 1, 'Profile must match exactly one imported distribution signing identity')
    return matches.pop()


def decode_secret(value):
    return base64.b64decode(''.join(value.split()), validate=True)


def run(*args):
    result = subprocess.run(args, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(result.returncode == 0, f'{args[0]} {args[1]} failed (output suppressed to protect credentials)')
    return result.stdout


def emit(values):
    with open(os.environ['GITHUB_ENV'], 'a') as stream:
        for key, value in values.items():
            require('\n' not in str(value) and '\r' not in str(value), 'Invalid environment value')
            stream.write(f'{key}={value}\n')


def install():
    os.umask(0o077)
    for name in ('APPLE_TEAM_ID', 'IOS_DISTRIBUTION_CERTIFICATE', 'IOS_DISTRIBUTION_CERTIFICATE_PASSWORD', 'IOS_PROVISIONING_PROFILE', 'APP_STORE_CONNECT_API_KEY', 'APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID'):
        require(bool(os.environ.get(name)), f'Missing required secret: {name}')
    team = os.environ['APPLE_TEAM_ID']
    key_id = os.environ['APP_STORE_CONNECT_KEY_ID']
    issuer = os.environ['APP_STORE_CONNECT_ISSUER_ID']
    require(re.fullmatch(r'[A-Z0-9]{10}', team), 'Invalid Apple team ID')
    require(re.fullmatch(r'[A-Z0-9]{10}', key_id), 'Invalid App Store Connect key ID')
    require(re.fullmatch(r'[a-fA-F0-9-]{36}', issuer), 'Invalid App Store Connect issuer ID')
    root = Path(tempfile.mkdtemp(prefix='ios-testflight-', dir=Path(os.environ['RUNNER_TEMP']).resolve()))
    emit({'SIGNING_ROOT': root})
    keychain = root / 'signing.keychain-db'
    profile_file = root / 'distribution.mobileprovision'
    certificate = root / 'distribution.p12'
    certificate.write_bytes(decode_secret(os.environ['IOS_DISTRIBUTION_CERTIFICATE']))
    profile_file.write_bytes(decode_secret(os.environ['IOS_PROVISIONING_PROFILE']))
    profile = plistlib.loads(run('security', 'cms', '-D', '-i', str(profile_file)))
    search_list = run('security', 'list-keychains', '-d', 'user').decode()
    original = re.findall(r'"([^"\n]+)"', search_list)
    (root / 'keychains.json').write_text(json.dumps(original))
    password = base64.b64encode(os.urandom(32)).decode()
    run('security', 'create-keychain', '-p', password, str(keychain))
    run('security', 'set-keychain-settings', '-lut', '21600', str(keychain))
    run('security', 'unlock-keychain', '-p', password, str(keychain))
    run('security', 'import', str(certificate), '-k', str(keychain), '-P', os.environ['IOS_DISTRIBUTION_CERTIFICATE_PASSWORD'], '-T', '/usr/bin/codesign', '-T', '/usr/bin/security')
    run('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-k', password, str(keychain))
    identity_output = run('security', 'find-identity', '-v', '-p', 'codesigning', str(keychain)).decode()
    identities = set(re.findall(r'\b([A-F0-9]{40}) "(?:Apple Distribution|iPhone Distribution):[^"\n]+"', identity_output))
    identity = validate_profile(profile, team, dt.datetime.now(dt.timezone.utc).replace(tzinfo=None), identities)
    run('security', 'list-keychains', '-d', 'user', '-s', *original, str(keychain))
    profile_dir = Path.home() / 'Library/Developer/Xcode/UserData/Provisioning Profiles'
    profile_dir.mkdir(parents=True, exist_ok=True)
    destination = profile_dir / f'{root.name}.mobileprovision'
    require(not destination.exists(), 'Temporary provisioning profile already exists')
    emit({'INSTALLED_PROFILE': destination})
    with destination.open('xb') as stream:
        stream.write(profile_file.read_bytes())
    key_dir = root / 'private_keys'
    key_dir.mkdir()
    api_key = os.environ['APP_STORE_CONNECT_API_KEY']
    require(api_key.startswith('-----BEGIN PRIVATE KEY-----') and '-----END PRIVATE KEY-----' in api_key, 'API key must be raw p8 content')
    (key_dir / f'AuthKey_{key_id}.p8').write_text(api_key)
    options = {
        'method': 'app-store-connect', 'destination': 'export', 'teamID': team,
        'signingStyle': 'manual', 'signingCertificate': identity,
        'provisioningProfiles': {BUNDLE_ID: profile['UUID']},
        'manageAppVersionAndBuildNumber': False, 'stripSwiftSymbols': True,
        'uploadSymbols': False,
    }
    (root / 'ExportOptions.plist').write_bytes(plistlib.dumps(options))
    emit({'SIGNING_IDENTITY': identity, 'PROFILE_UUID': profile['UUID'], 'SIGNING_TEAM': team})


def verify():
    root = Path(os.environ['SIGNING_ROOT'])
    ipas = list((root / 'export').glob('*.ipa'))
    require(len(ipas) == 1, 'Expected one exported signed IPA')
    unpacked = root / 'verified'
    run('ditto', '-x', '-k', str(ipas[0]), str(unpacked))
    apps = list((unpacked / 'Payload').glob('*.app'))
    require(len(apps) == 1, 'Expected one IPA app')
    app = apps[0]
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    require(info['CFBundleIdentifier'] == BUNDLE_ID, 'Exported bundle ID mismatch')
    require(info['CFBundleShortVersionString'] == os.environ['IOS_VERSION'], 'Exported marketing version mismatch')
    require(info['CFBundleVersion'] == os.environ['BUILD_NUMBER'], 'Exported build number mismatch')
    require(info['CFBundleSupportedPlatforms'] == ['iPhoneOS'], 'Expected a device app')
    require((app / info['CFBundleExecutable']).stat().st_size > 0, 'Missing native executable')
    require((app / 'main.jsbundle').stat().st_size > 0, 'Missing embedded JavaScript bundle')
    config = json.loads((app / 'EXConstants.bundle/app.config').read_text())
    require(config['version'] == os.environ['IOS_VERSION'], 'Embedded Expo version mismatch')
    require(config['ios']['bundleIdentifier'] == BUNDLE_ID, 'Embedded Expo identifier mismatch')
    require(config['ios']['buildNumber'] == os.environ['BUILD_NUMBER'], 'Embedded Expo build number mismatch')
    require(config['extra']['thirdPartyNotices'] == Path('THIRD_PARTY_NOTICES.md').read_text(), 'Missing third-party notices')
    run('codesign', '--verify', '--deep', '--strict', str(app))
    run('codesign', '-d', f'--extract-certificates={root / "signed-cert-"}', str(app))
    leaf_hash = hashlib.sha1((root / 'signed-cert-0').read_bytes()).hexdigest().upper()
    require(leaf_hash == os.environ['SIGNING_IDENTITY'], 'Exported signing certificate mismatch')
    profile = plistlib.loads(run('security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')))
    validate_profile(profile, os.environ['SIGNING_TEAM'], dt.datetime.now(dt.timezone.utc).replace(tzinfo=None), {leaf_hash})
    entitlements = plistlib.loads(run('codesign', '-d', '--entitlements', ':-', str(app)))
    require(entitlements.get('get-task-allow') is False, 'Signed app allows debugging')
    require(entitlements.get('com.apple.developer.team-identifier') == os.environ['SIGNING_TEAM'], 'Signed app team mismatch')
    require(entitlements.get('application-identifier') == profile['Entitlements']['application-identifier'], 'Signed app identifier mismatch')
    require(entitlements.get('beta-reports-active') is True, 'Signed app lacks TestFlight entitlement')
    require(entitlements.get('aps-environment') == 'production', 'Signed app lacks production push entitlement')
    with zipfile.ZipFile(ipas[0]) as ipa:
        require(ipa.testzip() is None, 'Corrupt exported IPA')
    deliverables = root / 'artifact'
    deliverables.mkdir()
    name = f'Deepseek.Harness.iOS_{os.environ["VERSION"]}_{os.environ["BUILD_NUMBER"]}_signed.ipa'
    shutil.copyfile(ipas[0], deliverables / name)
    symbols = root / 'DSH.xcarchive/dSYMs'
    require(symbols.is_dir() and any(symbols.glob('*.dSYM')), 'Archive must contain release debug symbols')
    run('ditto', '-c', '-k', '--keepParent', str(symbols), str(deliverables / 'dSYMs.zip'))
    emit({'IPA_PATH': deliverables / name})


def cleanup():
    value = os.environ.get('SIGNING_ROOT')
    if not value:
        return
    root = Path(value)
    temp = Path(os.environ['RUNNER_TEMP']).resolve()
    require(root.is_absolute() and root.parent == temp and root.name.startswith('ios-testflight-') and not root.is_symlink(), 'Refusing unsafe signing cleanup path')
    if not root.exists():
        return
    profile_value = os.environ.get('INSTALLED_PROFILE')
    if profile_value:
        expected = Path.home() / 'Library/Developer/Xcode/UserData/Provisioning Profiles' / f'{root.name}.mobileprovision'
        profile = Path(profile_value)
        require(profile == expected and profile.resolve() == expected, 'Refusing unsafe profile cleanup path')
        profile.unlink(missing_ok=True)
    failures = []
    original = root / 'keychains.json'
    if original.exists():
        try:
            run('security', 'list-keychains', '-d', 'user', '-s', *json.loads(original.read_text()))
        except ValueError as error:
            failures.append(str(error))
    keychain = root / 'signing.keychain-db'
    if keychain.exists():
        try:
            run('security', 'delete-keychain', str(keychain))
        except ValueError as error:
            failures.append(str(error))
    require(root.resolve() == root, 'Refusing redirected signing cleanup path')
    shutil.rmtree(root)
    require(not failures, '; '.join(failures))


if __name__ == '__main__':
    commands = {'install': install, 'verify': verify, 'cleanup': cleanup}
    require(len(sys.argv) == 2 and sys.argv[1] in commands, 'Expected install, verify or cleanup')
    commands[sys.argv[1]]()
