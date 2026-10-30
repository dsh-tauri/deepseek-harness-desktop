import type { ReactElement } from 'react'
import { SegmentedControl } from 'dsh-tauri-ui/client'
import { useId, useState } from 'react'
import { locale } from '../locales'
import { resolveActiveTab } from './extension-panel.utils'
import { McpTab } from './mcp-tab'
import { SkillsTab } from './skills-tab'

export interface ExtensionPanelProps {
  createSkill: () => Promise<void>
  plugins?: ReactElement
}

interface ExtensionTab {
  id: string
  label: string
  render: () => ReactElement
}

export function ExtensionPanel({ createSkill, plugins }: ExtensionPanelProps): ReactElement {
  const t = locale.text
  const tabsId = useId()
  const rows: ExtensionTab[] = [
    ...(plugins === undefined ? [] : [{ id: 'plugins', label: t('pluginsTab'), render: () => plugins }]),
    { id: 'skills', label: t('skillsTab'), render: () => <SkillsTab t={t} createSkill={createSkill} /> },
    { id: 'mcp', label: t('mcpTab'), render: () => <McpTab t={t} /> },
  ]
  const initialId = rows[0]?.id ?? 'skills'
  const [requestedId, setRequestedId] = useState(initialId)
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([initialId]))
  const activeId = resolveActiveTab(rows, requestedId)
  if (!visited.has(activeId))
    setVisited(new Set([...visited, activeId]))

  return (
    <div>
      <div className="flex flex-col gap-[14px] text-primary">
        <div>
          <SegmentedControl
            id={tabsId}
            label={t('extension')}
            value={activeId}
            options={rows.map(row => ({ value: row.id, label: row.label }))}
            onChange={setRequestedId}
          />
        </div>
        {rows.filter(row => row.id === activeId || (row.id !== 'plugins' && visited.has(row.id))).map((row) => {
          const selected = row.id === activeId
          return <div key={row.id} id={`${tabsId}-${row.id}-panel`} className="min-w-0 pt-[2px]" role="tabpanel" aria-labelledby={`${tabsId}-${row.id}`} hidden={!selected}>{row.render()}</div>
        })}
      </div>
    </div>
  )
}
