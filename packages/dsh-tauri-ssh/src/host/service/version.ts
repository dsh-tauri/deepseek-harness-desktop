/**
 * DSH version selection and download-metadata pinning, ported from the
 * retired Rust engine's semantics (`service/download/github.rs` +
 * `src-tauri/resources/manifest.jsonc`'s `engines.dsh.recommend`): never
 * "latest 直下" — resolve the
 * recommended version onto a concrete release tag, pin that tag's asset URL
 * and trusted digest, and on resolution failure fall back to a known stable
 * tag while reporting why. Also owns the install-source repository mapping
 * (`installRepo` config → the GitHub repository hosting the packaged
 * releases).
 * @module dsh-tauri-ssh/host/service/version
 */

/** One packaged release as the GitHub API lists it. */
export interface DshPkgReleaseMeta {
  tag: string
  /** GitHub's Pre-release label for the tag. */
  prerelease: boolean
}

/** How a release tag was chosen. */
export type DshTagSource = 'pin' | 'recommended' | 'latest-stable' | 'fallback'

/** The outcome of release-tag resolution. */
export interface ResolvedDshTag {
  tag: string
  /** The parsed semver (empty when the tag carries none). */
  version: string
  source: DshTagSource
  /** Human-readable notes for every departure from the primary choice. */
  notes: string[]
}

/**
 * The recommended DSH version pinned for remote installs. Kept in lockstep
 * with the desktop mainline's `src-tauri/resources/manifest.jsonc`
 * (`engines.dsh.recommend`, both name the version this desktop generation is
 * verified against); installs pin this version instead of following whatever
 * "latest" happens to be.
 */
export const RECOMMENDED_DSH_VERSION = '0.1.5-rc.3'

/**
 * The last known-good packaged release tag, used when version resolution
 * fails (offline, rate-limited, or the recommended version vanished). A
 * concrete tag — never an unknown version.
 */
export const FALLBACK_DSH_TAG = 'dsh-0.1.5-rc.3-35833820356'

/** The official DSH project repository (org verified on GitHub). */
export const OFFICIAL_INSTALL_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** The GitHub repository hosting the packaged DSH binary releases. */
export const OFFICIAL_PKG_REPO = 'dsh-tauri-desk/deepseek-harness-pkg'

/**
 * Map the `installRepo` config onto the GitHub `owner/name` repository whose
 * releases the binary install downloads from. The official anchor (and the
 * legacy wrong-org spelling it replaces) maps onto the official packaging
 * repository; any other configured repository is used as-is, so forks and
 * mirrors of the packaging repo work.
 * @param installRepo - the configured install repository (URL or `owner/name`).
 * @returns the `owner/name` release repository.
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

/** The `owner/name` of a GitHub repository URL (`.git` suffix tolerated). */
export function parseGitHubRepo(value: string): string | undefined {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(value)
  if (match === null) {
    // A bare `owner/name` is accepted for local mirrors expressed concisely.
    const bare = /^([\w.-]+)\/([\w.-]+)$/u.exec(value)
    return bare === null ? undefined : `${bare[1]}/${bare[2]}`
  }
  return `${match[1] ?? ''}/${match[2] ?? ''}`
}

/**
 * Parse the DSH semver out of a packaged release tag: `dsh-0.1.2-rc.1-<build>`
 * (the trailing build id is dropped) and `dsh-src-0.1.2-alpha.1-<build>`
 * yield the version with its prerelease segment intact. A bare dsh-prefixed
 * tag still loses its last dash segment — the build-id convention applied
 * unconditionally, matching the retired Rust parser — so bare
 * `dsh-0.1.2-rc.1` yields `0.1.2` (the `rc.1` segment is dropped); only a
 * bare `src-<version>` tag passes through as-is.
 * @param tag - the release tag.
 * @returns the version string, or undefined when the tag carries none.
 */
export function parseVersionFromTag(tag: string): string | undefined {
  const hasDshPrefix = tag.startsWith('dsh-')
  const stripped = hasDshPrefix ? tag.slice('dsh-'.length) : tag
  if (stripped.startsWith('src-')) {
    const rest = stripped.slice('src-'.length)
    // `dsh-src-<version>-<build>`: drop the build id; bare `src-<version>`: as-is.
    const version = hasDshPrefix ? rest.split('-').slice(0, -1).join('-') : rest
    return version === '' ? undefined : version
  }
  if (!hasDshPrefix)
    return undefined
  const version = stripped.split('-').slice(0, -1).join('-')
  return version === '' ? undefined : version
}

/** Pre-release markers that make a tag a preview (rc does not — rc ships). */
const PREVIEW_MARKERS = ['preview', 'beta', 'alpha', 'canary', 'next'] as const

/**
 * Whether a tag is a preview release (its version's pre-release segment
 * carries a non-rc preview marker). Preview releases never win the
 * "latest stable" fallback.
 * @param tag - the release tag.
 */
export function isPreviewTag(tag: string): boolean {
  const version = parseVersionFromTag(tag)
  if (version === undefined)
    return false
  const pre = version.split('-').slice(1).join('-')
  if (pre === '')
    return false
  return pre.split('.').some(id => PREVIEW_MARKERS.some(marker => id.startsWith(marker)))
}

/**
 * Resolve the install tag from the release list (pure — the network fetch is
 * injected). Resolution order: the configured pin (`ref`, a tag or version),
 * the {@link RECOMMENDED_DSH_VERSION} match, the newest stable release, and
 * finally the {@link FALLBACK_DSH_TAG} constant when no list was available.
 * Every departure from the primary choice carries a human-readable note.
 * @param metas - the packaged release list (newest first), or undefined when
 * the listing itself failed.
 * @param options - the pin (`ref`) and the recommended version override.
 * @param options.ref - the configured pin: a full release tag or a semver.
 * @param options.recommended - the recommended version (defaults to the constant).
 * @returns the resolved tag, its version, the resolution source, and notes.
 */
export function pickReleaseTag(
  metas: DshPkgReleaseMeta[] | undefined,
  options: { ref?: string | undefined, recommended?: string | undefined } = {},
): ResolvedDshTag {
  const recommended = options.recommended ?? RECOMMENDED_DSH_VERSION
  const notes: string[] = []
  const ref = options.ref === undefined || options.ref.trim() === '' ? undefined : options.ref.trim()
  if (ref !== undefined) {
    if (ref.startsWith('dsh-')) {
      const listed = metas?.some(meta => meta.tag === ref) ?? false
      if (!listed)
        notes.push(`pin tag ${ref} 不在 release 列表中（列表截断或来源异常），按 pin 直用`)
      const version = parseVersionFromTag(ref) ?? ''
      return { tag: ref, version, source: 'pin', notes }
    }
    const pinned = metas?.find(meta => parseVersionFromTag(meta.tag) === ref)
    if (pinned !== undefined)
      return { tag: pinned.tag, version: ref, source: 'pin', notes }
    notes.push(`版本 pin ${ref} 未找到匹配 release，回退推荐/最新稳定版`)
  }
  if (metas === undefined || metas.length === 0) {
    notes.push('release 列表不可用（网络/限流），回退已知稳定 tag')
    return { tag: FALLBACK_DSH_TAG, version: parseVersionFromTag(FALLBACK_DSH_TAG) ?? '', source: 'fallback', notes }
  }
  // Dedupe by version keeping the first-listed tag: GitHub lists releases
  // newest-first (created_at descending, verified against the pkg repo), so
  // the first tag of a version is its newest republish — e.g. `dsh-…` wins
  // over an older `dsh-src-…` that parses to the same version.
  const byVersion = new Map<string, DshPkgReleaseMeta>()
  for (const meta of metas) {
    const version = parseVersionFromTag(meta.tag)
    if (version === undefined)
      continue
    if (!byVersion.has(version))
      byVersion.set(version, meta)
  }
  const recommendedMeta = byVersion.get(recommended)
  if (recommendedMeta !== undefined)
    return { tag: recommendedMeta.tag, version: recommended, source: 'recommended', notes }
  const fallback = metas.find(meta => !meta.prerelease && !isPreviewTag(meta.tag))
  if (fallback === undefined) {
    notes.push('推荐版本不在 release 列表且无稳定 release，回退已知稳定 tag')
    return { tag: FALLBACK_DSH_TAG, version: parseVersionFromTag(FALLBACK_DSH_TAG) ?? '', source: 'fallback', notes }
  }
  notes.push(`推荐版本 ${recommended} 不在 release 列表，回退最新稳定 ${fallback.tag}`)
  return { tag: fallback.tag, version: parseVersionFromTag(fallback.tag) ?? '', source: 'latest-stable', notes }
}

/** One packaged release asset as GitHub reports it. */
export interface GithubAsset {
  name: string
  url: string
  /** Trusted digest (`sha256:<hex>`), when GitHub computed one. */
  digest?: string
}

/** Fetch JSON with a deadline; a non-2xx fails with the status. */
async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok)
    throw new Error(`GET ${url} → HTTP ${response.status}`)
  return await response.json() as unknown
}

/** List the packaged releases (newest first) from the GitHub API. */
export async function listGithubReleases(repo: string, timeoutMs = 15_000): Promise<DshPkgReleaseMeta[]> {
  const json = await fetchJson(
    `https://api.github.com/repos/${repo}/releases?per_page=100`,
    { 'accept': 'application/vnd.github+json', 'user-agent': 'dsh-tauri-ssh' },
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

/** Fetch one tag's release assets from the GitHub API. */
export async function listGithubAssets(repo: string, tag: string, timeoutMs = 15_000): Promise<GithubAsset[]> {
  const json = await fetchJson(
    `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    { 'accept': 'application/vnd.github+json', 'user-agent': 'dsh-tauri-ssh' },
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

/**
 * Resolve the `npm-tgz` DSH asset metadata for one version from the npm
 * registry (official → npmmirror fallback): the deterministic tarball URL
 * pair and the packument's trusted integrity digest.
 * @param packageName - the scoped package name (`@deepseek-ai/dsh`).
 * @param version - the resolved version.
 * @param timeoutMs - per-request deadline.
 * @returns the tarball URL (official), its mirror, and the `sha512` integrity.
 */
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
