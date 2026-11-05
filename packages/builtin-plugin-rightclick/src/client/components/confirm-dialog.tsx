import { Button, Modal } from 'dsh-tauri-ui/client'
import { createRoot } from 'react-dom/client'
import { locale } from '../locales'

export interface ConfirmDialogOptions {
  title: string
  description: string
  confirmLabel: string
}

/**
 * 客户端样式确认框：确认 resolve(true)，取消 / 关闭 resolve(false)。
 * 原生 confirm 不随主题，这里用 primitives Modal 渲染。
 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (typeof document === 'undefined')
    return Promise.resolve(false)
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const close = (result: boolean): void => {
      root.unmount()
      host.remove()
      resolve(result)
    }
    root.render(
      <Modal
        open
        onClose={() => close(false)}
        closeLabel={locale.text('close')}
        title={options.title}
        description={options.description}
        footer={(
          <div>
            <Button variant="ghost" style={{ marginRight: 6 }} onClick={() => close(false)}>
              {locale.text('cancel')}
            </Button>
            <Button variant="outline" onClick={() => close(true)}>
              {options.confirmLabel}
            </Button>
          </div>
        )}
      />,
    )
  })
}
