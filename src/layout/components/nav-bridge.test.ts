import { describe, expect, it } from 'vitest'
import { navBridgeOf, REMOTE_SECTION, REMOTE_TAB_MACHINES, REMOTE_TAB_SYNC } from './nav-bridge'

describe('navBridgeOf', () => {
  it('sends no callbacks while the iframe is absent', () => {
    const post = () => {}
    expect(navBridgeOf(post, false)).toEqual({})
  })

  it('translates every navbar action into its protocol message', () => {
    const sent: Array<Record<string, unknown>> = []
    const bridge = navBridgeOf(message => sent.push(message), true)

    bridge.onToggleSidebar?.()
    bridge.onNewChat?.()
    bridge.onOpenFolder?.()
    bridge.onOpenMachineManager?.()
    bridge.onOpenSyncToRemote?.()

    expect(sent).toEqual([
      { type: 'dsh://sidebar:toggle' },
      { type: 'dsh://session:new' },
      { type: 'dsh://workspace:add' },
      // 机器管理与同步同属 SSH 分区，靠 tab 落到对应标签页
      { type: 'dsh://settings:open', section: REMOTE_SECTION, tab: REMOTE_TAB_MACHINES },
      { type: 'dsh://settings:open', section: REMOTE_SECTION, tab: REMOTE_TAB_SYNC },
    ])
  })
})
