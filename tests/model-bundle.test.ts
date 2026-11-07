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

const IDS = ['ui-settings-models', 'dsh-tauri-model']
const OFFICIAL = [{ id: 'ui-settings-models', name: 'cordis:ui-settings-models' }]

async function activate(patch: string): Promise<{ disabled: boolean[], active: number[] }> {
  const source = readFileSync(new URL('../packages/builtin-plugin-model/cordis.patch.yml', import.meta.url), 'utf8')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', { name: 'web' })
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  const active = [0, 0]
  for (const [index, id] of IDS.entries()) {
    ctx.loader.builtins[id] = {
      apply(scope: Context) {
        scope.effect(() => {
          active[index]++
          return () => {
            active[index]--
          }
        }, 'model test activation')
      },
    }
  }
  ctx.loader.builtins['dsh-taiwind'] = { apply() {} }

  const entries = applyEntryPatches(
    OFFICIAL,
    [...yaml.load(source, { schema: entryListSchema }), ...yaml.load(patch, { schema: entryListSchema })],
    (message) => { throw new Error(message) },
  )
  await ctx.loader.root.update(entries.map(entry => ({ ...entry, name: `cordis:${entry.id}` })))
  await ctx.loader.await()
  return { disabled: IDS.map(id => ctx.loader.resolve(id).disabled === true), active }
}

it.each([
  { state: 'default', patch: '[]', expected: [0, 1] },
  { state: 'the desktop editor is enabled', patch: '- id: dsh-tauri-model\n  disabled: false', expected: [0, 1] },
  { state: 'the desktop editor is disabled', patch: '- id: dsh-tauri-model\n  disabled: true', expected: [1, 0] },
  { state: 'the desktop editor is conditionally disabled', patch: '- id: dsh-tauri-model\n  disabled: !!js "ctx.get(\'profileContext\').name === \'web\'"', expected: [1, 0] },
  { state: 'the official page is explicitly enabled', patch: '- id: ui-settings-models\n  disabled: false', expected: [1, 1] },
  { state: 'both are explicitly disabled', patch: '- id: dsh-tauri-model\n  disabled: true\n- id: ui-settings-models\n  disabled: true', expected: [0, 0] },
])('model bundle restores the official settings page while the desktop editor is off when $state', async ({ patch, expected }) => {
  const result = await activate(patch)
  expect(result.disabled).toEqual(expected.map(count => count === 0))
  expect(result.active).toEqual(expected)
})

it('model bundle restores the default stack after an override is removed', async () => {
  const source = readFileSync(new URL('../packages/builtin-plugin-model/cordis.patch.yml', import.meta.url), 'utf8')
  const userPatch = yaml.load('- id: dsh-tauri-model\n  disabled: true', { schema: entryListSchema })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  const active = [0, 0]
  for (const [index, id] of IDS.entries()) {
    ctx.loader.builtins[id] = {
      apply(scope: Context) {
        scope.effect(() => {
          active[index]++
          return () => {
            active[index]--
          }
        }, 'model test activation')
      },
    }
  }
  ctx.loader.builtins['dsh-taiwind'] = { apply() {} }

  for (const [patch, expected] of [[userPatch, [1, 0]], [[] as PatchOptions[], [0, 1]], [userPatch, [1, 0]]] as const) {
    const entries = applyEntryPatches(
      OFFICIAL,
      [...yaml.load(source, { schema: entryListSchema }), ...patch],
      (message) => { throw new Error(message) },
    )
    await ctx.loader.root.update(entries.map(entry => ({ ...entry, name: `cordis:${entry.id}` })))
    await ctx.loader.await()
    expect(active).toEqual(expected)
  }

  await ctx.fiber.dispose()
  expect(active).toEqual([0, 0])
})
