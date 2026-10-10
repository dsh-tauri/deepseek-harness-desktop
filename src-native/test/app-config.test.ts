import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getConfig } from 'expo/config'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('public Expo configuration packaged by expo-constants', () => {
  it('embeds the complete third-party notice without changing Android identity', () => {
    const { exp } = getConfig(projectRoot, { isPublicConfig: true, skipSDKVersionRequirement: true })
    const notice = exp.extra?.thirdPartyNotices

    expect(notice).toBe(readFileSync(resolve(projectRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'))
    expect(String(notice)).not.toBe('')
    expect(exp.version).toBe((JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as { version: string }).version)
    expect(exp.android?.package).toBe('com.dshtauri.dshbridge')
    expect(Number.isInteger(exp.android?.versionCode)).toBe(true)
    expect(exp.android?.versionCode ?? 0).toBeGreaterThan(0)
  })
})
