import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { expect, it, onTestFinished } from 'vitest'

const yaml = createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-include'))('js-yaml') as {
  load: (content: string, options: { schema: typeof entryListSchema }) => PatchOptions[]
}

function fail(message: string): never {
  throw new Error(message)
}

async function activate(retired: boolean | undefined): Promise<boolean> {
  const source = readFileSync(new URL('../packages/builtin-plugin-mobile-ui/cordis.patch.yml', import.meta.url), 'utf8')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  ctx.loader.builtins['dsh-tauri-mobile-ui'] = { apply() {} }
  ctx.loader.builtins['dsh-taiwind'] = { apply() {} }

  const previous = process.env.DSH_TAURI_OFFICIAL_ADAPTERS
  if (retired === undefined)
    delete process.env.DSH_TAURI_OFFICIAL_ADAPTERS
  else process.env.DSH_TAURI_OFFICIAL_ADAPTERS = retired ? '1' : '0'
  try {
    const patches = yaml.load(source, { schema: entryListSchema })
    const entries = applyEntryPatches([], patches, fail)
    await ctx.loader.root.update(entries.map(entry => ({ ...entry, name: `cordis:${entry.id}` })))
    await ctx.loader.await()
    return ctx.loader.resolve('dsh-tauri-mobile-ui').disabled === true
  }
  finally {
    if (previous === undefined)
      delete process.env.DSH_TAURI_OFFICIAL_ADAPTERS
    else process.env.DSH_TAURI_OFFICIAL_ADAPTERS = previous
  }
}

it.each([
  { state: 'host did not retire the official adapters', retired: undefined, expected: false },
  { state: 'host still runs its own mobile layer', retired: false, expected: false },
  { state: 'host retired the official adapters', retired: true, expected: true },
])('mobile UI bundle follows the retirement flag when $state', async ({ retired, expected }) => {
  expect(await activate(retired)).toBe(expected)
})
