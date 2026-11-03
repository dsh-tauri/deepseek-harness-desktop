import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// This runs before dependency installation, so keep SemVer validation dependency-free.
const SEMVER_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Z-][0-9A-Z-]*)'
const SEMVER_PATTERN = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)`
  + `(?:-(${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*))?`
  + '(?:\\+([0-9A-Z-]+(?:\\.[0-9A-Z-]+)*))?$',
  'i',
)
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i

function releaseIdentityError(message, cause) {
  const error = new Error(`RELEASE_IDENTITY: ${message}`)
  if (cause !== undefined)
    error.cause = cause
  return error
}

function parseSemver(version, label = 'version') {
  if (typeof version !== 'string')
    throw releaseIdentityError(`${label} must be a string`)

  const match = SEMVER_PATTERN.exec(version)
  if (!match)
    throw releaseIdentityError(`${label} is not strict SemVer 2.0: ${JSON.stringify(version)}`)

  return {
    version,
    prerelease: match[1] ?? null,
    build: match[2] ?? null,
  }
}

function readJsonVersion(filePath, label) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  }
  catch (error) {
    throw releaseIdentityError(`cannot read ${label} at ${filePath}`, error)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw releaseIdentityError(`${label} must contain a JSON object`)

  parseSemver(parsed.version, `${label} version`)
  return parsed.version
}

function readCargoPackageVersion(content) {
  if (typeof content !== 'string')
    throw releaseIdentityError('Cargo.toml content must be a string')

  let inPackageSection = false
  let packageVersion = null

  for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.trimStart().startsWith('[')) {
      inPackageSection = /^\s*\[package\]\s*(?:#.*)?$/.test(line)
      continue
    }

    if (!inPackageSection || /^\s*#/.test(line))
      continue

    const version = /^\s*version\s*=\s*(["'])([^"']+)\1\s*(?:#.*)?$/.exec(line)
    if (!version)
      continue

    if (packageVersion !== null)
      throw releaseIdentityError('Cargo.toml [package] contains multiple version fields')
    packageVersion = version[2]
  }

  if (packageVersion === null)
    throw releaseIdentityError('Cargo.toml [package] version is missing')

  parseSemver(packageVersion, 'Cargo.toml [package] version')
  return packageVersion
}

function readReleaseIdentity(repo = process.cwd()) {
  const packageVersion = readJsonVersion(path.join(repo, 'package.json'), 'package.json')
  const cargoPath = path.join(repo, 'apps/desktop/src-tauri', 'Cargo.toml')
  let cargoVersion
  try {
    cargoVersion = readCargoPackageVersion(readFileSync(cargoPath, 'utf8'))
  }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('RELEASE_IDENTITY:'))
      throw error
    throw releaseIdentityError(`cannot read Cargo.toml at ${cargoPath}`, error)
  }
  const tauriVersion = readJsonVersion(
    path.join(repo, 'apps/desktop/src-tauri', 'tauri.conf.json'),
    'apps/desktop/src-tauri/tauri.conf.json',
  )

  const versions = {
    'package.json': packageVersion,
    'apps/desktop/src-tauri/Cargo.toml': cargoVersion,
    'apps/desktop/src-tauri/tauri.conf.json': tauriVersion,
  }
  if (new Set(Object.values(versions)).size !== 1) {
    const details = Object.entries(versions)
      .map(([file, version]) => `${file}=${version}`)
      .join(', ')
    throw releaseIdentityError(`release versions do not match: ${details}`)
  }

  return {
    version: packageVersion,
    semver: parseSemver(packageVersion),
    versions,
  }
}

function requireCommitSha(sha) {
  if (typeof sha !== 'string' || !COMMIT_SHA_PATTERN.test(sha))
    throw releaseIdentityError('source_ref must be a full 40-character commit SHA')
  return sha.toLowerCase()
}

function deriveReleaseMetadata({ eventName, pushTag = '', sourceRef, identity }) {
  if (!identity || typeof identity !== 'object')
    throw releaseIdentityError('release identity is missing')

  const semver = parseSemver(identity.version)
  const normalizedSourceRef = requireCommitSha(sourceRef)
  const expectedTag = `v${identity.version}`
  let tag = ''
  let shouldRelease = false

  if (eventName === 'push') {
    if (pushTag !== expectedTag) {
      throw releaseIdentityError(
        `pushed tag ${JSON.stringify(pushTag)} does not match checked-out version tag ${expectedTag}`,
      )
    }
    tag = expectedTag
    shouldRelease = true
  }
  else if (eventName === 'pull_request') {
    tag = expectedTag
    shouldRelease = true
  }
  else if (eventName !== 'workflow_dispatch') {
    throw releaseIdentityError(`unsupported release event: ${JSON.stringify(eventName)}`)
  }

  return {
    tag,
    prerelease: semver.prerelease !== null,
    should_release: shouldRelease,
    source_ref: normalizedSourceRef,
  }
}

function appendReleaseMetadata(outputPath, metadata) {
  if (!outputPath)
    throw releaseIdentityError('GITHUB_OUTPUT is missing')

  appendFileSync(outputPath, [
    `tag=${metadata.tag}`,
    `prerelease=${metadata.prerelease}`,
    `should_release=${metadata.should_release}`,
    `source_ref=${metadata.source_ref}`,
    '',
  ].join('\n'), 'utf8')
}

function main() {
  const repo = process.env.GITHUB_WORKSPACE || process.cwd()
  const identity = readReleaseIdentity(repo)
  let sourceRef
  try {
    sourceRef = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  }
  catch (error) {
    throw releaseIdentityError('cannot resolve the checked-out release commit', error)
  }

  const metadata = deriveReleaseMetadata({
    eventName: process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME,
    pushTag: process.env.PUSH_TAG || process.env.GITHUB_REF_NAME || '',
    sourceRef,
    identity,
  })
  appendReleaseMetadata(process.env.GITHUB_OUTPUT, metadata)
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  try {
    main()
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message.startsWith('RELEASE_IDENTITY:') ? message : `RELEASE_IDENTITY: ${message}`)
    process.exitCode = 1
  }
}

export {
  deriveReleaseMetadata,
  parseSemver,
  readCargoPackageVersion,
  readReleaseIdentity,
}
