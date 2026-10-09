import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const temp = join(root, '.temp', 'icons')
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')

function generate(source: string, output: string) {
  mkdirSync(output, { recursive: true })
  const result = spawnSync(process.execPath, [cli, 'icon', source, '--output', output], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error)
    throw result.error
  if (result.status !== 0)
    throw new Error(`ICON_GENERATION_FAILED: ${relative(root, source)} (exit ${result.status})`)
}

for (const [source, output] of [
  ['deepseek-harness-desktop-tauri.svg', ''],
  ['deepseek-harness-desktop-tauri-nightly.svg', 'nightly'],
]) {
  const svg = readFileSync(join(root, 'public', source), 'utf8').match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1]
  if (!svg)
    throw new Error(`ICON_SOURCE_INVALID: public/${source}`)
  const work = join(temp, output || 'stable')
  mkdirSync(work, { recursive: true })
  const master = join(work, 'macos.svg')
  // issue #88：1024px Apple 网格保留 824px 内容和 100px 透明边距，避免 Dock 图标过大。
  writeFileSync(master, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g transform="translate(100 100) scale(12.875)">${svg}</g></svg>\n`)
  generate(master, work)
  copyFileSync(join(work, 'icon.icns'), join(root, 'src-tauri', 'icons', output, 'icon.icns'))
}

const tray = join(temp, 'tray')
generate(join(root, 'assets', 'macos-tray.svg'), tray)
copyFileSync(join(tray, '128x128@2x.png'), join(root, 'src-tauri', 'icons', 'macos-tray.png'))
console.log('Rebuilt stable/nightly macOS icons and tray template')
