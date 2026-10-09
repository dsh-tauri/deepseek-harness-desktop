import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { parseSemver, readReleaseIdentity } from './release-identity.mjs'

function stampError(message) {
  return new Error(`STAMP_VERSION: ${message}`)
}

function replaceOnce(content, pattern, replacement, label) {
  const matches = [...content.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))]
  if (matches.length !== 1)
    throw stampError(`${label}: expected exactly one version field, found ${matches.length}`)
  return content.replace(pattern, replacement)
}

function stampCargoToml(content, version, label) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const targets = []
  let section = ''

  for (const [index, line] of lines.entries()) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (header) {
      section = header[1].trim()
      continue
    }
    if (section === 'package' && /^\s*version\s*=/.test(line))
      targets.push(index)
  }

  if (targets.length !== 1)
    throw stampError(`${label}: expected exactly one [package] version field, found ${targets.length}`)

  const [target] = targets
  const stamped = lines[target].replace(/^(\s*version\s*=\s*")[^"]*(")/, `$1${version}$2`)
  if (stamped === lines[target])
    throw stampError(`${label}: [package] version is not a double-quoted string`)

  lines[target] = stamped
  return lines.join(eol)
}

const STAMPED_FILES = [
  {
    label: 'package.json',
    segments: ['package.json'],
    stamp: (content, version, label) =>
      replaceOnce(content, /^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`, label),
  },
  {
    label: 'src-tauri/Cargo.toml',
    segments: ['src-tauri', 'Cargo.toml'],
    stamp: stampCargoToml,
  },
  {
    label: 'src-tauri/tauri.conf.json',
    segments: ['src-tauri', 'tauri.conf.json'],
    stamp: (content, version, label) =>
      replaceOnce(content, /^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`, label),
  },
]

function parseStampedVersion(version) {
  try {
    parseSemver(version, 'stamped version')
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw stampError(message.replace(/^RELEASE_IDENTITY:\s*/, ''))
  }
}

function stampVersion(repo, version) {
  parseStampedVersion(version)

  const base = readReleaseIdentity(repo)
  if (base.version === version)
    throw stampError(`stamped version ${version} equals the checked-out release version`)

  const written = []
  for (const file of STAMPED_FILES) {
    const filePath = path.join(repo, ...file.segments)
    let content
    try {
      content = readFileSync(filePath, 'utf8')
    }
    catch (error) {
      throw stampError(`${file.label}: cannot be read (${error instanceof Error ? error.message : String(error)})`)
    }

    const stamped = file.stamp(content, version, file.label)
    if (stamped === content)
      continue
    writeFileSync(filePath, stamped, 'utf8')
    written.push(file.label)
  }

  const result = readReleaseIdentity(repo)
  if (result.version !== version)
    throw stampError(`stamped files report ${result.version} instead of ${version}`)

  return { version, files: written }
}

function main() {
  const [version] = process.argv.slice(2)
  if (!version)
    throw stampError('usage: node scripts/stamp-version.mjs <version>')

  const repo = process.env.GITHUB_WORKSPACE || process.cwd()
  const { files } = stampVersion(repo, version)
  console.log(`STAMP_VERSION: ${files.join(', ')} -> ${version}`)
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  try {
    main()
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message.startsWith('STAMP_VERSION:') ? message : `STAMP_VERSION: ${message}`)
    process.exitCode = 1
  }
}

export { stampCargoToml, stampVersion }
