import type { RemoteMachineRow } from '@/hooks/use-remote'
import { Server } from '@gravity-ui/icons'
import { Button, Description, Dropdown, Label } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { dotClassOf } from '@/hooks/use-remote'
import { remoteMachineStateTextOf, remoteMachineSubtitleOf } from '@/layout/remote/machine.utils'

export function RemoteMachinePicker({ machines, selectedId, onChange, testId }: {
  machines: RemoteMachineRow[]
  selectedId: string
  onChange: (machineId: string) => void
  testId: string
}) {
  const { t } = useTranslation()
  const selected = machines.find(machine => machine.id === selectedId)
  const label = selected?.name ?? t('core.remote_all_machines')

  return (
    <Dropdown>
      <Button
        className="h-7 gap-1.5 px-1.5 text-[12.5px]"
        size="sm"
        variant="ghost"
        aria-label={t('core.remote_machine')}
        data-testid={testId}
      >
        <Server />
        <span className="max-w-28 truncate">{label}</span>
      </Button>
      <Dropdown.Popover className="w-72!">
        <Dropdown.Menu>
          <Dropdown.Section aria-label={t('core.remote_machine')}>
            <Dropdown.Item
              id={`${testId}-all`}
              textValue={t('core.remote_all_machines')}
              onAction={() => onChange('')}
            >
              <span className="flex w-full items-center gap-2">
                <Server className="size-3.5 text-muted" />
                <Label>{t('core.remote_all_machines')}</Label>
                <If cond={selectedId === ''}>
                  <Description className="ml-auto">{t('remote.current')}</Description>
                </If>
              </span>
            </Dropdown.Item>
            {machines.map((machine) => {
              const subtitle = remoteMachineSubtitleOf(machine)
              return (
                <Dropdown.Item
                  key={machine.id}
                  id={`${testId}-${machine.id}`}
                  textValue={machine.name}
                  onAction={() => onChange(machine.id)}
                >
                  <span className="flex w-full items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn('size-1.5 shrink-0 rounded-full', dotClassOf(machine))}
                      style={machine.color === undefined ? undefined : { backgroundColor: machine.color }}
                    />
                    <span className="flex min-w-0 flex-col">
                      <Label className="truncate">{machine.name}</Label>
                      <If cond={subtitle !== undefined}>
                        <Description className="truncate text-[11px] leading-4">{subtitle}</Description>
                      </If>
                    </span>
                    <Description className="ml-auto shrink-0">
                      {remoteMachineStateTextOf(machine, false, t)}
                    </Description>
                  </span>
                </Dropdown.Item>
              )
            })}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
