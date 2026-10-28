import { describe, expect, it } from 'vitest'
import { compareVersions, isCoreUnsupported, MIN_SUPPORTED_CORE_VERSION } from '@/utils/core-version'
import { readSource } from './setup/read-source'

const coreSource = readSource('src/ui/config/core.tsx')
const manifest = JSON.parse(
  readSource('src-tauri/resources/manifest.jsonc').replace(/^\s*\/\/.*$/gm, ''),
) as {
  engines: { dsh: { recommend: string, minimum: string } }
  dependencies: { dsh: { engine: { recommend: string, minimum: string } } }
}

function localPredicateSource(): string {
  const start = coreSource.indexOf('function isUnsupportedLocal')
  expect(start).toBeGreaterThan(-1)
  const end = coreSource.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  return coreSource.slice(start, end + 2)
}

describe('local core compatibility baseline', () => {
  it('前端与资源清单的最低支持版本均为 0.2.1-rc.4', () => {
    expect(MIN_SUPPORTED_CORE_VERSION).toBe('0.2.1-rc.4')
    expect(manifest.engines.dsh.minimum).toBe('0.2.1-rc.4')
    expect(manifest.dependencies.dsh.engine.minimum).toBe('0.2.1-rc.4')
  })

  it('推荐版本为 0.2.1-rc.4，与最低支持门槛同值', () => {
    expect(manifest.engines.dsh.recommend).toBe('0.2.1-rc.4')
    expect(manifest.dependencies.dsh.engine.recommend).toBe('0.2.1-rc.4')
    expect(isCoreUnsupported('0.2.1-rc.4')).toBe(false)
  })

  it.each(['0.2.1-rc.5', '0.2.1', '0.2.2-alpha.2'])('高于推荐版本的本地核心 %s 仍然受支持', (version) => {
    expect(compareVersions(version, '0.2.1-rc.4')).toBe(1)
    expect(isCoreUnsupported(version)).toBe(false)
  })

  it.each(['0.1.7-rc.1', '0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3'])('本地核心 %s 低于 rc.4 下限，判为不兼容', (version) => {
    expect(isCoreUnsupported(version)).toBe(true)
  })
})

describe('config core panel local compatibility predicate', () => {
  it('仅对存在的本地核心复用最低支持版本判据，不复用推荐版本', () => {
    const predicate = localPredicateSource()
    expect(predicate).toContain('return core.source === \'local\' && core.present && isUnsupportedCore(core)')
    expect(predicate).not.toContain('recommendedVersion')
    expect(coreSource).toContain('return isCoreUnsupported(core.version || core.tag)')
  })

  it('「不兼容」提示引用最低支持版本，而不是推荐版本', () => {
    expect(coreSource).toContain('t(\'core.local_unsupported_hint\', { version: MIN_SUPPORTED_CORE_VERSION })')
  })
})
