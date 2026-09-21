import type { ClientContext, PanelHandle } from 'dsh-tauri/client'
import { Icon, PanelPage, Puzzle } from 'dsh-tauri-ui/client'
import { definePanel, defineRegister } from 'dsh-tauri/client'
import { ExtensionPanel } from '../components/extension-panel'
import { MARKET_SERVICE_NAME, PANEL_ACTION_ORDER, PANEL_ID } from '../constants'
import { locale } from '../locales'
import { currentScope, hostsMarketPanel, readMarket } from '../service/market'
import { store } from '../store'
import { chooseWorkspace, sessionSnapshotOf, workspaceSnapshotOf } from './extension-panel.utils'

export const extensionPanelFeature = defineRegister<ClientContext>((controller, ctx, adapter) => {
  let panel: PanelHandle | undefined
  const embedMarket = hostsMarketPanel(currentScope())

  // 市场收进本插槽后，它自带的设置页入口就是重复入口，撤下它；撤下前记住原状态，
  // 服务被撤下或本插件卸载时还原。服务由另一个客户端插件发布，apply 顺序不保证，
  // 所以用 inject 等它到位。
  ctx.inject([MARKET_SERVICE_NAME], () => {
    if (!embedMarket)
      return
    const face = readMarket(ctx)
    if (face === undefined)
      return
    const restore = face.settingsVisible()
    face.setSettingsVisible(false)
    return () => face.setSettingsVisible(restore)
  })

  const createSkill = async (): Promise<void> => {
    const id = chooseWorkspace(
      sessionSnapshotOf(adapter.sessions.list?.getSnapshot()),
      workspaceSnapshotOf(adapter.workspaces.list?.getSnapshot()),
    )
    if (id === undefined)
      throw new Error(locale.text('workspaceUnavailable'))
    const sessionId = await adapter.workspaces.connectWorkspace?.(id)
    if (typeof sessionId !== 'string' || sessionId === '')
      throw new Error(locale.text('workspaceUnavailable'))
    store.prefill.add(sessionId)
    panel?.close()
    adapter.sessions.open?.(sessionId)
  }

  panel = definePanel(ctx, {
    id: PANEL_ID,
    order: PANEL_ACTION_ORDER,
    locale: locale.NS,
    label: () => locale.text('extension'),
    icon: props => <Icon as={Puzzle} size={props.size} />,
    render: () => (
      <PanelPage>
        <ExtensionPanel createSkill={createSkill} market={embedMarket ? readMarket(ctx) : undefined} />
      </PanelPage>
    ),
  })
  controller.add(panel.dispose)
})
