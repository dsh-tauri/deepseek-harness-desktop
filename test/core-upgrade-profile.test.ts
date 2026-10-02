import { describe, expect, it } from 'vitest'
import { readLocale, readSource } from './setup/read-source'

/**
 * 「版本号变化（升级或降级）→ 请切换档案」链路的结构契约。
 *
 * 前端不在单测里挂载组件（与 clone-profile.test.ts 同款跨层守卫），因此读源码断言结构：
 * 期望值一律取自需求本身（顺序、命令名、i18n key、双向本地比对），不与被测实现同源。
 *
 * 三个入口共用同一个守卫 hook：核心面板切换、更新提示 toast（桌面外壳）、调试页更新按钮。
 */
const guardSource = readSource('src/ui/config/hooks/use-core-profile-switch.tsx')
const coreSource = readSource('src/ui/config/core.tsx')
const dialogSource = readSource('src/ui/dialog/core-upgrade-profile.tsx')
const layoutSource = readSource('src/layout/index.tsx')
const debugSource = readSource('src/ui/config/debug.tsx')
const updaterSource = readSource('src/store/modules/harness-updater/store.ts')

/** 取组件内某个顶层函数的函数体（到该函数自己的 `\n  }` 为止，嵌套块缩进更深不会误截） */
function bodyOf(source: string, marker: string): string {
  const start = source.indexOf(marker)
  expect(start, marker).toBeGreaterThan(-1)
  const rest = source.slice(start)
  const end = rest.indexOf('\n  }')
  return end === -1 ? rest : rest.slice(0, end)
}

/** 取 `handleUpdate` 的函数体（更新入口在桌面外壳与调试页各有一份） */
function updateBody(source: string): string {
  return bodyOf(source, 'async function handleUpdate')
}

describe('版本比对一律走本地数据', () => {
  it('守卫不为比对联网重拉核心列表', () => {
    expect(guardSource).not.toContain('\'get_cores\'')
  })

  it('「升级前」版本优先取现成的核心列表缓存，缺失才退回本地命令', () => {
    const body = bodyOf(guardSource, 'async function localActiveVersion')

    expect(body).toContain('queryClient.getQueryData<HarnessCore[]>(queryKeys.cores)')
    expect(body).toMatch(/cachedActive = cached\?\.find\(c => c\.active\)/)
    expect(body).toContain('invoke<RuntimeInfo>(\'get_runtime_info\')')
  })

  it('核心面板直接把列表里已加载的在用核心版本传进守卫', () => {
    const body = bodyOf(coreSource, 'async function onActivate')

    expect(body).toContain('cores.find(c => c.active)')
    expect(body).toMatch(/guardCoreUpgrade\(coreVersionKey\(core\), activeCore \? coreVersionKey\(activeCore\) : ''\)/)
    expect(body).not.toContain('\'get_cores\'')
  })

  it('核心号任一方向变化都要换档案，默认档案名取目标版本号（含 patch，Core-x.y.z）', () => {
    const body = bodyOf(guardSource, 'async function guardCoreUpgrade')
    const bypass = body.indexOf('return { handled: false }')

    expect(body).toContain('isCoreUpgrade(from, toVersion)')
    expect(body).toContain('isCoreUpgrade(toVersion, from)')
    expect(body.indexOf('isCoreUpgrade(from, toVersion)')).toBeLessThan(bypass)
    expect(body.indexOf('isCoreUpgrade(toVersion, from)')).toBeLessThan(bypass)
    expect(body).toContain('coreProfileName(toVersion)')
    expect(body).toMatch(/defaultName:/)
  })
})

describe('核心面板：升级弹档案警告，不再叠加普通切换确认', () => {
  it('取消档案警告即中止本次切换（不落档案、不切核心）', () => {
    const body = bodyOf(coreSource, 'async function onActivate')
    const guardIndex = body.indexOf('guardCoreUpgrade(')
    const handledIndex = body.indexOf('if (!guard.handled)')

    expect(guardIndex).toBeGreaterThan(-1)
    expect(handledIndex).toBeGreaterThan(guardIndex)
    // 守卫返回 null = 用户取消或档案切换失败：直接结束，绝不走到激活
    const beforeHandled = body.slice(guardIndex, handledIndex)
    expect(beforeHandled).toMatch(/if \(!guard\)\n\s*return/)
    expect(beforeHandled).not.toContain('activate.mutateAsync')
  })

  it('破坏性升级时改弹档案警告，普通确认只在未命中升级时出现', () => {
    const body = bodyOf(coreSource, 'async function onActivate')
    const handledIndex = body.indexOf('if (!guard.handled)')

    expect(handledIndex).toBeGreaterThan(-1)
    expect(body.slice(0, handledIndex)).not.toContain('core.switch_confirm_title')
    expect(body.slice(handledIndex)).toContain('core.switch_confirm_title')
  })

  it('先落版本档案，再切核心，最后重启', () => {
    const body = bodyOf(coreSource, 'async function onActivate')
    const guardIndex = body.indexOf('await guardCoreUpgrade(')
    const coreIndex = body.indexOf('activate.mutateAsync(core.id)')
    const restartIndex = body.indexOf('store.harness.restart()')

    // 档案在守卫内部（弹窗确认后）落定，返回后才切核心；切核心成功才重启
    expect(guardIndex).toBeGreaterThan(-1)
    expect(coreIndex).toBeGreaterThan(guardIndex)
    expect(restartIndex).toBeGreaterThan(coreIndex)
  })

  it('核心切换失败时回滚到切换前的档案', () => {
    const body = bodyOf(coreSource, 'async function onActivate')
    const failureIndex = body.indexOf('core.switch_failed')
    expect(failureIndex).toBeGreaterThan(-1)

    const failureBranch = body.slice(failureIndex)
    expect(failureBranch).toContain('await guard.rollback?.()')
  })
})

describe('守卫：档案缺失才新建，已存在只切换，失败即中止', () => {
  it('按后端归一化后的 id 匹配在用档案列表', () => {
    const body = bodyOf(guardSource, 'async function guardCoreUpgrade')

    expect(body).toContain('invoke<Profile[]>(\'get_profiles\')')
    expect(body).toContain('normalizeProfileId(choice.name)')
    expect(body).toMatch(/profiles\.find\(p => p\.id === id\)/)
  })

  it('已存在且在用时不重复切换，缺失时新建并切为使用中', () => {
    const body = bodyOf(guardSource, 'async function guardCoreUpgrade')

    expect(body).toMatch(/if \(!existing\.active\)\n\s*await invoke<Profile>\('set_active_profile', \{ id \}\)/)
    expect(body).toContain('invoke<Profile>(\'create_profile\', { name: choice.name })')
    expect(body).toContain('invoke<Profile>(\'set_active_profile\', { id: created.id })')
  })

  it('档案切换失败时提示并中止（不切核心）', () => {
    const body = bodyOf(guardSource, 'async function guardCoreUpgrade')
    const failureIndex = body.indexOf('core.breaking_profile_failed')

    expect(failureIndex).toBeGreaterThan(-1)
    expect(body.slice(failureIndex)).toMatch(/return null/)
  })

  it('回滚切回原档案，失败只记日志，并始终失效档案查询', () => {
    const body = bodyOf(guardSource, 'async function guardCoreUpgrade')

    expect(body).toContain('previousId === switchedId')
    expect(body).toContain('invoke<Profile>(\'set_active_profile\', { id: previousId })')
    expect(body).toMatch(/console\.error/)
    expect(body).toMatch(/finally \{/)
    expect(body).toContain('queryKeys.profiles')
  })

  it('「无视风险切换」保持档案不变，只切核心', () => {
    const body = bodyOf(guardSource, 'async function guardCoreUpgrade')

    expect(body).toMatch(/if \(choice\.mode === 'ignore'\)\n\s*return \{ handled: true \}/)
    // ignore 分支必须在读档案列表之前返回，避免无谓的档案请求
    expect(body.indexOf('choice.mode === \'ignore\'')).toBeLessThan(body.indexOf('invoke<Profile[]>(\'get_profiles\')'))
  })
})

describe('更新提示入口（桌面外壳 / 调试页）走同一守卫', () => {
  for (const [name, source] of [['layout', layoutSource], ['debug', debugSource]] as const) {
    it(`${name}：「立即更新」先确认、再落档案、更新失败回滚`, () => {
      const body = updateBody(source)

      expect(body).toContain('confirmCoreBreaking(info.tag)')
      expect(body).toContain('guardCoreUpgrade(info.tag)')
      expect(body).toMatch(/if \(!guard\)\n\s*return/)
      expect(body).toContain('if (!(await store.harnessUpdater.handleUpdate()))')
      expect(body).toContain('await guard.rollback?.()')
      // 守卫的弹窗必须挂进渲染树，否则 useOverlay 的 holder 无处可渲染
      expect(source).toContain('{coreProfileSwitchHolder}')
    })
  }

  it('handleUpdate 返回是否真的切到了新版本，供调用方决定是否回滚', () => {
    const source = updaterSource

    expect(source).toMatch(/async handleUpdate\(\): Promise<boolean>/)
    expect(source).toMatch(/return false/)
    expect(source).toMatch(/return true/)
  })

  it('已落盘的新版本即使随后启动失败也不报「没切换」（否则会回滚出旧档案配新核心）', () => {
    const source = updaterSource

    // 安装结果记在 try 之外，catch 里回传它而不是一律 false
    expect(source).toMatch(/let installed = false/)
    expect(source).toMatch(/installed = changed/)
    expect(source).toMatch(/catch \(err\) \{[\s\S]*?return installed/)
  })
})

describe('警告对话框控件', () => {
  it('档案名默认填目标版本号（含 patch）、可编辑，并用 InputGroup 组合而非自绘 Label + Input', () => {
    const source = dialogSource

    expect(source).toMatch(/useState\(props\.defaultName\)/)
    expect(source).toMatch(/value=\{name\}/)
    expect(source).toMatch(/onChange=\{e => setName\(e\.target\.value\)\}/)
    expect(source).toMatch(/import \{[^}]+InputGroup[^}]+Label[^}]+TextField[^}]*\} from '@heroui\/react'/)
    expect(source).toMatch(/<TextField[\s>]/)
    expect(source).toMatch(/<Label>/)
    expect(source).toMatch(/<InputGroup[\s>]/)
    expect(source).toMatch(/<InputGroup\.Input/)
    expect(source).not.toMatch(/<Input[\s>]/)
  })

  it('「无视风险切换」是 warning Chip，与取消/确认按钮同处一行的 footer', () => {
    const source = dialogSource
    const footerStart = source.indexOf('<AlertDialog.Footer')
    const footerEnd = source.indexOf('</AlertDialog.Footer>')

    expect(footerStart).toBeGreaterThan(-1)
    expect(footerEnd).toBeGreaterThan(footerStart)

    const footer = source.slice(footerStart, footerEnd)
    expect(source).toMatch(/import \{[^}]+Chip[^}]*\} from '@heroui\/react'/)
    expect(footer).toMatch(/<Chip[\s>]/)
    expect(footer).toMatch(/color="warning"/)
    expect(footer).toContain('core.breaking_ignore')
    expect(footer).toMatch(/disclosure\.confirm\(\{ mode: 'ignore' \}\)/)
    expect(footer).toContain('buttons.cancel')
    expect(footer).toContain('buttons.confirm')
    expect(footer).toContain('disclosure.cancel')
    expect(source).toMatch(/disclosure\.confirm\(\{ mode: 'profile', name \}\)/)
  })

  it('归一化后为空的档案名禁止确认', () => {
    const source = dialogSource

    expect(source).toMatch(/const profileId = normalizeProfileId\(name\)/)
    expect(source).toMatch(/isDisabled=\{!profileId\}/)
  })

  it('danger 状态的 AlertDialog，警告文案同时给出源版本与目标版本', () => {
    const source = dialogSource

    expect(source).toMatch(/status="danger"/)
    expect(source).toMatch(/core\.breaking_desc', \{ from: props\.fromVersion, to: props\.toVersion \}/)
  })
})

describe('i18n parity', () => {
  const keys = [
    'core.breaking_title',
    'core.breaking_desc',
    'core.breaking_profile_label',
    'core.breaking_ignore',
    'core.breaking_profile_failed',
  ]

  for (const locale of ['zh-CN', 'en-US']) {
    it(`includes all core.breaking* keys in ${locale}`, () => {
      const messages = readLocale(locale)
      for (const key of keys) {
        expect(typeof messages[key], key).toBe('string')
        expect(messages[key].length, key).toBeGreaterThan(0)
      }
    })
  }
})
