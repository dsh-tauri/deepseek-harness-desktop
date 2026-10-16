import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { readSource } from './setup/read-source'

it('native checks use the shared pre-job gate instead of an independent workflow', () => {
  const source = readSource('.github/workflows/ci.yml')
  const native = source.match(/^ {2}native:\n([\s\S]*?)(?=^ {2}[\w-]+:|(?![\s\S]))/m)?.[1]
  expect(native).toContain('needs: pre_job')
  expect(native).toMatch(/^ {4}if: \$\{\{ needs\.pre_job\.outputs\.should_skip != 'true' \}\}$/m)
  expect(native).toContain('run: pnpm run typecheck:native')
  expect(native).toContain('run: pnpm run test:native')
  expect(existsSync(new URL('../.github/workflows/ci-native.yml', import.meta.url))).toBe(false)
})
