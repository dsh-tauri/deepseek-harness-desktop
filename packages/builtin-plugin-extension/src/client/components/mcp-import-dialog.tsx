import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { McpImportItem } from './mcp-tab.types'
import { Button, Card, Checkbox, Modal, Tag, Text } from 'dsh-tauri-ui/client'
import { importGroups } from './mcp-tab.utils'

export interface McpImportDialogProps {
  t: Translate
  open: boolean
  items: McpImportItem[] | null
  busy: boolean
  formError: string | null
  onClose: () => void
  onToggle: (index: number, checked: boolean) => void
  onToggleGroup: (indices: number[], checked: boolean) => void
  onImport: () => void
}

export function McpImportDialog(props: McpImportDialogProps): ReactElement {
  const { t, open, items, busy, formError, onClose, onToggle, onToggleGroup, onImport } = props
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t('close')}
      title={t('importServers')}
      className="w-[min(680px,100%)]!"
    >
      <div className="flex flex-col gap-[10px]">
        <Text tone="tertiary">{t('importIntro')}</Text>
        {items === null && <Text size="sm" tone="tertiary">{t('loading')}</Text>}
        {items !== null && items.length === 0 && <Text size="sm" tone="tertiary">{t('importEmpty')}</Text>}
        {items !== null && items.length > 0 && (
          <div className="flex flex-col gap-[14px] max-h-[min(400px,52vh)] overflow-y-auto py-[2px] pr-[4px] pl-[2px]">
            {importGroups(items).map((group) => {
              const selectable = group.items
                .filter(({ item }) => !item.existing)
                .map(({ index }) => index)
              const allChecked = selectable.length > 0
                && selectable.every(index => items[index].checked)
              return (
                <section className="flex flex-col gap-[8px]" key={group.agent}>
                  <div className="flex items-center gap-[8px] px-[2px]">
                    <Tag tone="info">{group.label}</Tag>
                    <span className="text-[12px] leading-[18px] text-tertiary">{group.items.length}</span>
                    {selectable.length > 0 && (
                      <div className="ml-auto">
                        <Checkbox checked={allChecked} onChange={next => onToggleGroup(selectable, next)}>
                          {t('importSelectAll')}
                        </Checkbox>
                      </div>
                    )}
                  </div>
                  <ul className="grid grid-cols-[minmax(0,1fr)] items-stretch gap-[10px] m-0 p-0 list-none">
                    {group.items.map(({ item, index }) => {
                      const command = item.server.transport === 'stdio'
                        ? `${item.server.command ?? ''} ${(item.server.args ?? []).join(' ')}`.trim()
                        : item.server.url ?? ''
                      return (
                        <li className={`flex flex-col gap-[8px] min-w-0 border border-border-l2 rounded-[10px] bg-layer-3 px-[14px] py-[12px] hover:bg-hover${item.existing ? ' opacity-55' : ''}`} key={`${item.server.agent}/${item.server.name}`}>
                          <div className="flex items-center gap-[6px] flex-wrap">
                            <Checkbox
                              checked={item.checked}
                              disabled={item.existing}
                              onChange={next => onToggle(index, next)}
                              title={item.server.name}
                            >
                              <Card.Title className="flex-1 min-w-0 font-semibold [font-family:var(--ds-font-family-code)]" title={item.server.name}>{item.server.name}</Card.Title>
                            </Checkbox>
                            <Tag tone="neutral">{item.server.transport}</Tag>
                            {item.existing && <Tag tone="quiet">{t('importExisting')}</Tag>}
                          </div>
                          <Card.Description className="text-secondary line-clamp-2" title={command}>{command}</Card.Description>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
        {formError !== null && <Text tone="error">{formError}</Text>}
        <div className="flex items-center gap-[6px] flex-wrap">
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || items === null || !items.some(item => item.checked && !item.existing)}
            onClick={onImport}
          >
            {t('importSelected')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
