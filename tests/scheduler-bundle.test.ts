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
  const ids = ['schedule', 'ui-schedule', 'dsh-tauri-scheduler']
  const active = [0, 0, 0]
  for (const [index, id] of ids.entries()) {
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

  for (const [userPatch, counts] of [[yaml.load(patch, { schema: entryListSchema }), expected], [[], [0, 0, 1]], [yaml.load(patch, { schema: entryListSchema }), expected]] as const) {
    const patches = yaml.load(source, { schema: entryListSchema })
    const entries = applyEntryPatches([
      { id: 'schedule', name: 'cordis:schedule' },
      { id: 'ui-schedule', name: 'cordis:ui-schedule' },
    ], [...patches, ...userPatch], (message) => { throw new Error(message) })
    await ctx.loader.root.update(entries.map(entry => ({ ...entry, name: `cordis:${entry.id}` })))
    await ctx.loader.await()
    expect(ids.map(id => ctx.loader.resolve(id).disabled)).toEqual(counts.map(count => count === 0))
    expect(active).toEqual(counts)
  }
  await ctx.fiber.dispose()
  expect(active).toEqual([0, 0, 0])
})
