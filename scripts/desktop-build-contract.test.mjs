import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('builds both the packaged frontend and injected shell before native bundling', () => {
  const config = JSON.parse(readFileSync(new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const desktop = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'))
  expect(config.build.beforeBuildCommand.split(/\s*&&\s*/)).toEqual(['pnpm -w build:plugins', 'pnpm build'])
  expect(desktop.scripts.build.split(/\s*&&\s*/)).toEqual(['tsc', 'vite build', 'pnpm build:shell'])
  expect(config.build.frontendDist).toBe('../dist')
})
