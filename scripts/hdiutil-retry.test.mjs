import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it } from 'vitest'

const wrapper = fileURLToPath(new URL('./hdiutil-retry/hdiutil', import.meta.url))

const root = mkdtempSync(path.join(tmpdir(), 'hdiutil-retry-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// 假 hdiutil：按次序吐出给定的失败，跑完这些失败之后成功。
// create 失败时像真 hdiutil 一样留下半成品，且半成品还在时再 create 报 File exists；
// 包装器里的残骸清理一旦被删掉，下面的 create 用例必须变红。
function fakeHdiutil(failures) {
  const dir = mkdtempSync(path.join(root, 'case-'))
  const state = path.join(dir, 'attempts')
  const output = path.join(dir, 'image.dmg')
  const binary = path.join(dir, 'hdiutil')
  writeFileSync(path.join(dir, 'failures'), failures.join('\n'))
  writeFileSync(binary, [
    '#!/usr/bin/env bash',
    `state=${JSON.stringify(state)}`,
    `failures=${JSON.stringify(path.join(dir, 'failures'))}`,
    `output=${JSON.stringify(output)}`,
    'attempts=$(cat "$state" 2>/dev/null || echo 0)',
    'attempts=$((attempts + 1))',
    'echo "$attempts" > "$state"',
    'echo "argv: $*" >> "$state.argv"',
    'if [ "$1" = create ] && [ -e "$output" ]; then echo "hdiutil: create failed - File exists" >&2; exit 1; fi',
    'failure=$(sed -n "$attempts"p "$failures")',
    'if [ -n "$failure" ]; then [ "$1" = create ] && : > "$output"; echo "$failure" >&2; exit 1; fi',
    'echo "created $*"',
  ].join('\n'))
  chmodSync(binary, 0o755)
  return { binary, state, output }
}

function run(binary, args) {
  return execFileSync('bash', [wrapper, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HDIUTIL_BIN: binary, HDIUTIL_RETRY_DELAY: '0' },
    stdio: 'pipe',
  })
}

it('retries the hdiutil flakes GitHub macOS runners report, then succeeds', () => {
  const { binary, state, output } = fakeHdiutil([
    'hdiutil: create failed - Resource busy',
    'hdiutil: detach: timeout for DiskArbitration expired',
  ])
  expect(run(binary, ['create', '-srcfolder', 'src', output])).toContain('created')
  expect(readFileSync(state, 'utf8')).toBe('3\n')
})

it('fails fast on an error that is not the runner flake', () => {
  const { binary, state } = fakeHdiutil(['hdiutil: create failed - File exists'])
  expect(() => run(binary, ['create', 'image.dmg'])).toThrow()
  expect(readFileSync(state, 'utf8')).toBe('1\n')
})

it('forces the detach once a retry is needed', () => {
  const { binary, state } = fakeHdiutil(['hdiutil: detach: drive not detached'])
  run(binary, ['detach', '/dev/disk4'])
  expect(readFileSync(`${state}.argv`, 'utf8').trim().split('\n')).toEqual([
    'argv: detach /dev/disk4',
    'argv: detach /dev/disk4 -force',
  ])
})
