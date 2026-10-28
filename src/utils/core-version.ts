import semver from 'semver'

export const MIN_SUPPORTED_CORE_VERSION = '0.2.1-rc.4'

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
  return compareVersions(version, MIN_SUPPORTED_CORE_VERSION) < 0
}
