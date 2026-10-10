import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSource } from './setup/read-source'

/**
 * issue #763：插件包内的 `cordis.patch.yml` 用顶层 `- id: <官方 id>` 关掉官方入口，
 * 但该 id 一旦随核心移除就成了死目标——loader 只在启动日志里告警跳过，静默留痕。
 *
 * 下面这份字面量是「当前确实仍需禁用的官方入口」的独立来源：`ui-settings-models`
 * 由核心 `@deepseek-ai/dsh-client-ui-settings-models` 提供（0.2.0-rc.1 仍在），
 * `dsh-tauri-model` 是它的完整 fork、注册同一个 `settings.section/models`，故必须禁用。
 * 已被核心移除的 `ui-settings-unarchive-sessions` 不得再回到任何 patch 层。
 */
const OFFICIAL_ROW_DISABLES = [
  'dsh-tauri-model → ui-settings-models',
  'dsh-tauri-scheduler → schedule',
  'dsh-tauri-scheduler → ui-schedule',
]

const PACKAGES_ROOT = new URL('../packages/', import.meta.url)

function readPatchLayer(pkg: string): string {
  return readSource(`packages/${pkg}/cordis.patch.yml`)
}

function packageNames(): string[] {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(new URL(`${entry.name}/cordis.patch.yml`, PACKAGES_ROOT)))
    .map(entry => entry.name)
    .sort()
}

/** 顶层 `- id:` 才是 patch 目标；`insert:` 内缩进的 `id` 是插入的插件自身条目。 */
function disabledRowIds(source: string): string[] {
  return source.split('\n').flatMap((line) => {
    const match = /^- id: (\S+)\s*$/.exec(line)
    return match === null ? [] : [match[1]]
  })
}

describe('插件 patch 层的官方目标', () => {
  it('定时任务插件明确禁用完整官方调度栈且插入唯一实现', () => {
    const source = readPatchLayer('dsh-tauri-scheduler')
    expect(source).toMatch(/^- id: schedule\r?\n {2}disabled: true$/m)
    expect(source).toMatch(/^- id: ui-schedule\r?\n {2}disabled: true$/m)
    expect(source.match(/name: dsh-tauri-scheduler/g)).toHaveLength(1)
  })

  it('只把核心仍在提供的官方入口列为 patch 目标', () => {
    const actual = packageNames().flatMap(pkg => disabledRowIds(readPatchLayer(pkg)).map(id => `${pkg} → ${id}`))

    expect(actual).toEqual(OFFICIAL_ROW_DISABLES)
  })

  it('dsh-tauri-archive 的 patch 层只插入插件自身', () => {
    const source = readPatchLayer('dsh-tauri-archive')

    expect(disabledRowIds(source)).toEqual([])
    expect(source).toContain('- insert:')
    expect(source).toContain('- id: dsh-tauri-archive')
    expect(source).toContain('name: dsh-tauri-archive')
  })

  it('dsh-tauri-archive 的第三方声明不再声称禁用了官方入口', () => {
    const notices = readSource('packages/dsh-tauri-archive/THIRD_PARTY_NOTICES.md')

    expect(notices).not.toContain('ui-settings-unarchive-sessions')
    expect(notices).not.toContain('Official row disabled')
  })
})
