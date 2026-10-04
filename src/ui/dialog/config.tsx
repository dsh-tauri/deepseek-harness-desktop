import type { PropsWithOverlays } from '@overlastic/react'
import type { DshPlugin } from '@/types'
import { Brush, Cpu, Globe, LogoWindows, PersonPencil, Puzzle } from '@gravity-ui/icons'
import { cn, Modal } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useListener } from '@reause/core'
import { useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Case, If, Switch } from 'react-if-lite'
import { hooks } from '@/config/hooks'
import { queryKeys } from '@/config/query-keys'
import { ConfigAppearance } from '@/ui/config/appearance'
import { ConfigCore } from '@/ui/config/core'
import { ConfigDebug } from '@/ui/config/debug'
import { ConfigNetwork } from '@/ui/config/network'
import { ConfigPlugin } from '@/ui/config/plugin'
import { ConfigProfile } from '@/ui/config/profile'

/** 配置面板标识（左侧导航与顶部「配置」菜单共用同一组值） */
export type ConfigTab = 'appearance' | 'application' | 'network' | 'profiles' | 'plugins' | 'harness'

export interface ConfigDialogProps extends PropsWithOverlays {
  /** 打开时定位到的面板；缺省为「应用」 */
  tab?: ConfigTab
}

export function ConfigDialog(props: ConfigDialogProps) {
  const disclosure = useDisclosure({ props })
  const { t } = useTranslation()
  // 异常插件数：在「插件」Tab 上给出红点/角标，方便用户直接感知出问题的插件。
  // 与「插件」面板共用同一份查询缓存（根布局订阅后端事件写入）。
  const { data: plugins = [] } = useQuery({
    queryKey: queryKeys.plugins,
    queryFn: () => invoke<DshPlugin[]>('get_dsh_plugins'),
  })
  const abnormalCount = plugins.filter(p => p.error != null).length

  const navs: { label: string, value: ConfigTab, icon: typeof Cpu }[] = [
    { label: t('config.application'), value: 'application', icon: LogoWindows },
    { label: t('config.appearance'), value: 'appearance', icon: Brush },
    { label: t('config.network'), value: 'network', icon: Globe },
    { label: t('config.profiles'), value: 'profiles', icon: PersonPencil },
    { label: t('config.plugins'), value: 'plugins', icon: Puzzle },
    { label: t('config.harness'), value: 'harness', icon: Cpu },
  ]

  const [activeTab, setActiveTab] = useState<ConfigTab>(props.tab ?? 'application')

  // 服务重启/退出前由 store 触发，命令式收起本对话框（卸载时自动注销）
  useListener(hooks['config.dialog.hidden'].on, disclosure.cancel)

  return (
    <Modal isOpen={disclosure.visible} onOpenChange={disclosure.cancel}>
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog data-testid="dsh-config-dialog" className="w-[800px] max-w-[calc(100vw-48px)] h-[min(720px,calc(100vh-96px))] pr-2.5">
            <Modal.CloseTrigger data-testid="dsh-config-dialog-close" />
            <Modal.Header className="mb-3">
              <Modal.Heading>
                {t('app.config')}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex gap-6 pr-0">
              <aside className="w-[164px]">
                <nav className="flex flex-col gap-2 w-full">
                  {navs.map((item) => {
                    const isActive = item.value === activeTab
                    return (
                      <button
                        key={item.value}
                        data-testid={`dsh-config-nav-${item.value}`}
                        aria-current={isActive ? 'true' : undefined}
                        onClick={() => setActiveTab(item.value)}
                        className={cn(
                          'text-foreground h-[40px] rounded-md flex items-center gap-2 py-[9px] px-[16px] hover:bg-background-secondary cursor-pointer',
                          isActive ? 'bg-background-secondary' : '',
                        )}
                      >
                        <item.icon className="w-5 h-5 mr-2" />
                        <span>{item.label}</span>
                        <If cond={item.value === 'plugins' && abnormalCount > 0}>
                          <span data-testid="dsh-config-nav-plugins-badge" className="ml-auto flex size-5 items-center justify-center rounded-full bg-danger text-[10px] font-semibold leading-none text-white">
                            {abnormalCount}
                          </span>
                        </If>
                      </button>
                    )
                  })}
                </nav>
              </aside>
              <div data-testid="dsh-config-panel-body" className="flex flex-col flex-1 overflow-auto min-h-0 pr-2.5">
                <Switch value={activeTab} as="div">
                  <Case cond="application">
                    <ConfigDebug />
                  </Case>
                  <Case cond="appearance">
                    <ConfigAppearance />
                  </Case>
                  <Case cond="network">
                    <ConfigNetwork />
                  </Case>
                  <Case cond="profiles">
                    <ConfigProfile />
                  </Case>
                  <Case cond="plugins">
                    <ConfigPlugin />
                  </Case>
                  <Case cond="harness">
                    <ConfigCore />
                  </Case>
                </Switch>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
