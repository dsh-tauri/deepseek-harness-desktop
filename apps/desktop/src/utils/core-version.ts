import semver from 'semver'

export const MIN_SUPPORTED_CORE_VERSION = '0.2.2-rc.1'

function normalizeVersion(version: string): string {
  let value = version
  let packaged = false
  while (value.startsWith('dsh-') || value.startsWith('src-')) {
    packaged ||= value.startsWith('dsh-')
    value = value.replace(/^(?:src|dsh)-/, '')
  }
  return packaged ? value.replace(/-\d+$/, '') : value
}

export function compareVersions(a: string, b: string): number {
  const pa = semver.parse(normalizeVersion(a))
  const pb = semver.parse(normalizeVersion(b))
  if (!pa || !pb)
    return 0
  return semver.compare(pa, pb)
}

export function isCoreUnsupported(version: string): boolean {
  const parsed = semver.parse(normalizeVersion(version))
  return !parsed || parsed.major !== 0 || parsed.minor !== 2 || parsed.patch !== 2
    || semver.lt(parsed, MIN_SUPPORTED_CORE_VERSION)
}
