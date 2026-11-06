import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function main(desktopHost = false) {
  const require = createRequire(pathToFileURL(realpathSync.native(process.argv[1])))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  if (!desktopHost) {
    const { runCli } = await load('@deepseek-ai/dsh/lib/bin.js')
    await runCli({ manageDesktopProfile: true })
    return
  }
  const input = process.argv.slice(2)
  if (input.shift() !== '--profile' || input.shift() !== 'desktop') {
    throw new Error('DESKTOP_PROFILE_INVALID: expected --profile desktop')
  }
  const patchFiles = []
  while (input[0] === '--patch') {
    input.shift()
    const patch = input.shift()
    if (!patch) throw new Error('DESKTOP_PATCH_INVALID: --patch needs a path')
    patchFiles.push(patch)
  }
  const { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } = await load('@deepseek-ai/dsh-app-boot')
  const { resolveDshHome } = await load('@deepseek-ai/dsh-home-paths')
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot')
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
  const profile = loadProfileDirectory('dsh', join(resolveDshHome(), 'profiles', 'desktop'), installAnchor)
  reportSkippedBundles('dsh', profile)
  return runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles,
    args: input,
  })
}
