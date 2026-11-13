import semver from 'semver'

declare const __REMOTE_DSH_MINIMUM__: string

export interface DshPkgReleaseMeta {
  tag: string
  prerelease: boolean
}

export type DshTagSource = 'pin' | 'latest-stable' | 'fallback'

export interface ResolvedDshTag {
  tag: string
  version: string
  source: DshTagSource
  notes: string[]
  /** 可用候选 tag（按优先级排列）。第一个不一定还有 release，需要逐个验证。 */
  candidates: string[]
}

export const MINIMUM_DSH_VERSION = __REMOTE_DSH_MINIMUM__

/**
 * 回退 tag 列表（按新到旧）。必须是真实存在的 release：上游删掉 release 后
 * git tag 仍在，但 `/releases/download/<tag>/<asset>` 会 404，远端安装以 exit 10 收场。
 */
export const FALLBACK_DSH_TAGS = [
  'dsh-0.2.2-rc.1-43078653398',
  'dsh-0.2.2-rc.1-43048423223',
  'dsh-0.2.2-rc.1-42351650673',
  'dsh-0.2.2-rc.1-42271285252',
] as const

export const FALLBACK_DSH_TAG = FALLBACK_DSH_TAGS[0]

export function assertSupportedDshVersion(version: string): void {
  if (!semver.satisfies(version, `>=${MINIMUM_DSH_VERSION}`, { includePrerelease: true }))
    throw new Error(`REMOTE_DSH_VERSION_UNSUPPORTED: DSH ${version || '(unknown)'} 不受支持，最低版本 ${MINIMUM_DSH_VERSION}；请先升级远端内核`)
}

export const OFFICIAL_INSTALL_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'

export const OFFICIAL_PKG_REPO = 'dsh-tauri/deepseek-harness-pkg'

/**
 * 解析或回退 Harness 核心包的 GitHub 仓库全名。
 */
export function pkgRepoOf(installRepo?: string): string {
  const configured = installRepo === undefined || installRepo.trim() === '' ? undefined : installRepo.trim()
  if (configured === undefined)
    return OFFICIAL_PKG_REPO
  const parsed = parseGitHubRepo(configured)
  if (parsed === undefined)
    return OFFICIAL_PKG_REPO
  if (parsed === 'deepseek-ai/deepseek-harness' || parsed === 'deepseek-harness/deepseek-harness')
    return OFFICIAL_PKG_REPO
  return parsed
}

export function parseGitHubRepo(value: string): string | undefined {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(value)
  if (match === null) {
    const bare = /^([\w.-]+)\/([\w.-]+)$/u.exec(value)
    return bare === null ? undefined : `${bare[1]}/${bare[2]}`
  }
  return `${match[1] ?? ''}/${match[2] ?? ''}`
}

export function parseVersionFromTag(tag: string): string | undefined {
  const hasDshPrefix = tag.startsWith('dsh-')
  const stripped = hasDshPrefix ? tag.slice('dsh-'.length) : tag
  if (stripped.startsWith('src-')) {
    const rest = stripped.slice('src-'.length)
    const version = hasDshPrefix ? rest.split('-').slice(0, -1).join('-') : rest
    return version === '' ? undefined : version
  }
  if (!hasDshPrefix)
    return undefined
  const version = stripped.split('-').slice(0, -1).join('-')
  return version === '' ? undefined : version
}

const PREVIEW_MARKERS = ['preview', 'beta', 'alpha', 'canary', 'next'] as const

export function isPreviewTag(tag: string): boolean {
  const version = parseVersionFromTag(tag)
  if (version === undefined)
    return false
  const pre = version.split('-').slice(1).join('-')
  if (pre === '')
    return false
  return pre.split('.').some(id => PREVIEW_MARKERS.some(marker => id.startsWith(marker)))
}

/** 解析远端要安装的内核 tag：显式 pin 优先，否则取最新稳定 release。 */
export function pickReleaseTag(
  metas: DshPkgReleaseMeta[] | undefined,
  options: { ref?: string | undefined } = {},
): ResolvedDshTag {
  const notes: string[] = []
  const ref = options.ref === undefined || options.ref.trim() === '' ? undefined : options.ref.trim()
  if (ref !== undefined) {
    if (ref.startsWith('dsh-')) {
      const listed = metas?.some(meta => meta.tag === ref) ?? false
      if (!listed)
        notes.push(`pin tag ${ref} 不在 release 列表中（列表截断或来源异常），按 pin 直用`)
      const version = parseVersionFromTag(ref) ?? ''
      return { tag: ref, version, source: 'pin', notes, candidates: [ref] }
    }
    const pinned = metas?.find(meta => parseVersionFromTag(meta.tag) === ref)
    if (pinned !== undefined)
      return { tag: pinned.tag, version: ref, source: 'pin', notes, candidates: [pinned.tag] }
    notes.push(`版本 pin ${ref} 未找到匹配 release，回退最新稳定版`)
  }
  if (metas === undefined || metas.length === 0) {
    notes.push('release 列表不可用（网络/限流），回退已知稳定 tag')
    return {
      tag: FALLBACK_DSH_TAG,
      version: parseVersionFromTag(FALLBACK_DSH_TAG) ?? '',
      source: 'fallback',
      notes,
      candidates: [...FALLBACK_DSH_TAGS],
    }
  }
  const fallback = metas.find(meta => !meta.prerelease && !isPreviewTag(meta.tag))
  if (fallback === undefined) {
    notes.push('release 列表里没有稳定 release，回退已知稳定 tag')
    return {
      tag: FALLBACK_DSH_TAG,
      version: parseVersionFromTag(FALLBACK_DSH_TAG) ?? '',
      source: 'fallback',
      notes,
      candidates: [...FALLBACK_DSH_TAGS],
    }
  }
  return { tag: fallback.tag, version: parseVersionFromTag(fallback.tag) ?? '', source: 'latest-stable', notes, candidates: [fallback.tag] }
}

export interface GithubAsset {
  name: string
  url: string
  digest?: string
}

export class GithubHttpError extends Error {
  readonly status: number

  constructor(url: string, status: number) {
    super(`GET ${url} → HTTP ${status}`)
    this.name = 'GithubHttpError'
    this.status = status
  }
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok)
    throw new GithubHttpError(url, response.status)
  return await response.json() as unknown
}

export async function listGithubReleases(repo: string, timeoutMs = 15_000): Promise<DshPkgReleaseMeta[]> {
  const json = await fetchJson(
    `https://api.github.com/repos/${repo}/releases?per_page=100`,
    { 'accept': 'application/vnd.github+json', 'user-agent': 'dsh-tauri-remote' },
    timeoutMs,
  )
  if (!Array.isArray(json))
    throw new Error(`unexpected releases payload from ${repo}`)
  return json
    .filter((entry): entry is { tag_name: string, draft: boolean, prerelease: boolean } =>
      typeof entry === 'object' && entry !== null && typeof (entry as { tag_name?: unknown }).tag_name === 'string')
    .filter(entry => !entry.draft)
    .map(entry => ({ tag: entry.tag_name, prerelease: entry.prerelease }))
}

export async function listGithubAssets(repo: string, tag: string, timeoutMs = 15_000): Promise<GithubAsset[]> {
  const json = await fetchJson(
    `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    { 'accept': 'application/vnd.github+json', 'user-agent': 'dsh-tauri-remote' },
    timeoutMs,
  )
  const assets = (json as { assets?: unknown }).assets
  if (!Array.isArray(assets))
    throw new Error(`unexpected release payload for ${tag}`)
  return assets
    .filter((asset): asset is { name: string, browser_download_url: string, digest?: unknown } =>
      typeof asset === 'object' && asset !== null && typeof (asset as { name?: unknown }).name === 'string')
    .map(asset => ({
      name: asset.name,
      url: asset.browser_download_url,
      ...typeof asset.digest === 'string' ? { digest: asset.digest } : {},
    }))
}

export async function npmDistMetadata(
  packageName: string,
  version: string,
  timeoutMs = 15_000,
): Promise<{ url: string, mirrorUrl: string, integrity?: string }> {
  const headers = { accept: 'application/json' }
  const packument = await fetchJson(`https://registry.npmjs.org/${packageName}`, headers, timeoutMs)
    .catch(() => fetchJson(`https://registry.npmmirror.com/${packageName}`, headers, timeoutMs))
  const dist = (packument as { versions?: Record<string, { dist?: { tarball?: unknown, integrity?: unknown } }> })
    ?.versions?.[version]
    ?.dist
  if (dist === undefined || typeof dist.tarball !== 'string')
    throw new Error(`npm registry carries no ${packageName}@${version}`)
  return {
    url: dist.tarball,
    mirrorUrl: dist.tarball.replace('https://registry.npmjs.org/', 'https://registry.npmmirror.com/'),
    ...typeof dist.integrity === 'string' ? { integrity: dist.integrity } : {},
  }
}
