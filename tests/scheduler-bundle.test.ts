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

const IDS = ['schedule', 'ui-schedule', 'dsh-tauri-scheduler']

async function activate(patch: string, retired: boolean | undefined): Promise<{ disabled: boolean[], active: number[] | null }> {
  const source = readFileSync(new URL('../packages/builtin-plugin-scheduler/cordis.patch.yml', import.meta.url), 'utf8')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', { name: 'web' })
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  const active = [0, 0, 0]
  for (const [index, id] of IDS.entries()) {
    ctx.loader.builtins[id] = {
      apply(scope: Context) {
        scope.effect(() => {
          active[index]++
          return () => {
            active[index]--
          }
        }, 'scheduler test activation')
      },
    }
  }
  ctx.loader.builtins['dsh-taiwind'] = { apply() {} }

  const previous = process.env.DSH_TAURI_OFFICIAL_ADAPTERS
  if (retired === undefined)
    delete process.env.DSH_TAURI_OFFICIAL_ADAPTERS
  else process.env.DSH_TAURI_OFFICIAL_ADAPTERS = retired ? '1' : '0'
  try {
    const entries = applyEntryPatches([
      { id: 'schedule', name: 'cordis:schedule' },
      { id: 'ui-schedule', name: 'cordis:ui-schedule' },
    ], [...yaml.load(source, { schema: entryListSchema }), ...yaml.load(patch, { schema: entryListSchema })], (message) => { throw new Error(message) })
    await ctx.loader.root.update(entries.map(entry => ({ ...entry, name: `cordis:${entry.id}` })))
    await ctx.loader.await()
    return { disabled: IDS.map(id => ctx.loader.resolve(id).disabled === true), active }
  }
  finally {
    if (previous === undefined)
      delete process.env.DSH_TAURI_OFFICIAL_ADAPTERS
    else process.env.DSH_TAURI_OFFICIAL_ADAPTERS = previous
  }
}

it.each([
  { state: 'default', patch: '[]', expected: [0, 0, 1] },
  { state: 'enabled', patch: '- id: dsh-tauri-scheduler\n  disabled: false', expected: [0, 0, 1] },
  { state: 'disabled', patch: '- id: dsh-tauri-scheduler\n  disabled: true', expected: [1, 1, 0] },
  { state: 'conditionally enabled', patch: '- id: dsh-tauri-scheduler\n  disabled: !!js "ctx.get(\'profileContext\').name !== \'web\'"', expected: [0, 0, 1] },
  { state: 'conditionally disabled', patch: '- id: dsh-tauri-scheduler\n  disabled: !!js "ctx.get(\'profileContext\').name === \'web\'"', expected: [1, 1, 0] },
  { state: 'official scheduler explicitly enabled', patch: '- id: schedule\n  disabled: false', expected: [1, 0, 1] },
  { state: 'official UI explicitly enabled', patch: '- id: ui-schedule\n  disabled: false', expected: [0, 1, 1] },
  { state: 'all explicitly disabled', patch: '- id: dsh-tauri-scheduler\n  disabled: true\n- id: schedule\n  disabled: true\n- id: ui-schedule\n  disabled: true', expected: [0, 0, 0] },
])('scheduler bundle selects the expected stack when $state and restores the default after override removal', async ({ patch, expected }) => {
  const source = readFileSync(new URL('../packages/builtin-plugin-scheduler/cordis.patch.yml', import.meta.url), 'utf8')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', { name: 'web' })
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  const active = [0, 0, 0]
  for (const [index, id] of IDS.entries()) {
    ctx.loader.builtins[id] = {
      apply(scope: Context) {
        scope.effect(() => {
          active[index]++
          return () => {
            active[index]--
          }
        }, 'scheduler test activation')
      },
    }
  }
  ctx.loader.builtins['dsh-taiwind'] = { apply() {} }

  for (const [userPatch, counts] of [[yaml.load(patch, { schema: entryListSchema }), expected], [[] as PatchOptions[], [0, 0, 1]], [yaml.load(patch, { schema: entryListSchema }), expected]] as const) {
    const patches = yaml.load(source, { schema: entryListSchema })
    const entries = applyEntryPatches([
      { id: 'schedule', name: 'cordis:schedule' },
      { id: 'ui-schedule', name: 'cordis:ui-schedule' },
    ], [...patches, ...userPatch], (message) => { throw new Error(message) })
    await ctx.loader.root.update(entries.map(entry => ({ ...entry, name: `cordis:${entry.id}` })))
    await ctx.loader.await()
    expect(IDS.map(id => ctx.loader.resolve(id).disabled)).toEqual(counts.map(count => count === 0))
    expect(active).toEqual(counts)
  }
  await ctx.fiber.dispose()
  expect(active).toEqual([0, 0, 0])
})

it.each([
  { state: 'host did not retire the official adapters', retired: undefined, expected: [0, 0, 1] },
  { state: 'host retired the official adapters', retired: true, expected: [1, 1, 0] },
])('scheduler bundle follows the retirement flag when $state', async ({ retired, expected }) => {
  const result = await activate('[]', retired)
  expect(result.disabled).toEqual(expected.map(count => count === 0))
  expect(result.active).toEqual(expected)
})

it('still honours an explicit user disable while the official adapters are absent', async () => {
  const result = await activate('- id: dsh-tauri-scheduler\n  disabled: true', false)
  expect(result.active).toEqual([1, 1, 0])
})
