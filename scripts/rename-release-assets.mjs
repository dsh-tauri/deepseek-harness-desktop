import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { readReleaseIdentity } from './release-identity.mjs'

const repo = process.env.GITHUB_WORKSPACE || process.cwd()
const { version, semver } = readReleaseIdentity(repo)
const configFile = semver.prerelease?.split('.')[0] === 'nightly' ? 'tauri.nightly.conf.json' : 'tauri.conf.json'
const { productName } = JSON.parse(readFileSync(path.join(repo, 'src-tauri', configFile), 'utf8'))
const sourcePrefix = `${productName}_${version}_`
const assetPrefix = `Deepseek.Harness.Desktop_${version}_`
const directories = process.argv.slice(2).map(directory => path.resolve(repo, directory))

if (directories.length === 0)
  throw new Error('RELEASE_ASSETS_DIR: provide bundle directories')

for (const directory of directories) {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter(file => file.isFile() && /\.(?:exe|msi|dmg|AppImage|deb)(?:\.sig)?$/.test(file.name))
  if (files.length === 0)
    throw new Error(`RELEASE_ASSETS_EMPTY: ${directory}`)

  for (const file of files) {
    if (file.name.startsWith(assetPrefix))
      continue
    if (!file.name.startsWith(sourcePrefix))
      throw new Error(`RELEASE_ASSET_NAME: ${file.name}`)

    const target = path.join(directory, assetPrefix + file.name.slice(sourcePrefix.length))
    if (existsSync(target))
      throw new Error(`RELEASE_ASSET_EXISTS: ${target}`)
    console.log(`${path.join(directory, file.name)} -> ${target}`)
    renameSync(path.join(directory, file.name), target)
  }
}
