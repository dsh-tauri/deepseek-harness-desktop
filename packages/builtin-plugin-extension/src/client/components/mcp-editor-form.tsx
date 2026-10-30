import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { McpEditorMode, McpEditorState } from './mcp-tab.types'
import { Button, Field, Input, SegmentedControl, Select, Text, Textarea } from 'dsh-tauri-ui/client'
import { useId } from 'react'

export interface McpEditorFormProps {
  t: Translate
  editor: McpEditorState
  mode: McpEditorMode
  busy: boolean
  pasteJson: string
  pasteError: string | null
  formError: string | null
  onModeChange: (mode: McpEditorMode) => void
  onEditorChange: (patch: Partial<McpEditorState>) => void
  onPasteJsonChange: (value: string) => void
  onPasteFill: () => void
  onCancel: () => void
  onSave: () => void
}

export function McpEditorForm(props: McpEditorFormProps): ReactElement {
  const { t, editor, mode, busy, pasteJson, pasteError, formError, onModeChange, onEditorChange, onPasteJsonChange, onPasteFill, onCancel, onSave } = props
  const tabsId = useId()
  const transportOptions = [
    { value: 'stdio', label: t('transportStdio') },
    { value: 'streamable-http', label: t('transportHttp') },
  ]
  return (
    <div className="flex flex-col gap-[10px]">
      <div>
        <SegmentedControl
          id={tabsId}
          label={t('addServer')}
          value={mode}
          options={[
            { value: 'json', label: t('editorJsonTab') },
            { value: 'form', label: t('editorFormTab') },
          ]}
          onChange={next => onModeChange(next as McpEditorMode)}
        />
      </div>
      {mode === 'json'
        ? (
            <div id={`${tabsId}-json-panel`} className="flex flex-col gap-[10px]" role="tabpanel" aria-labelledby={`${tabsId}-json`}>
              <Field label={t('formatPaste')}>
                <Textarea
                  size="compact"
                  placeholder={'{\n  "mcpServers": {\n    "name": { "command": "npx", "args": ["-y", "@example/mcp-server"] }\n  }\n}\n'}
                  value={pasteJson}
                  onChange={event => onPasteJsonChange(event.target.value)}
                />
              </Field>
              {pasteError !== null && <Text tone="error">{pasteError}</Text>}
              <div className="flex items-center gap-[6px] flex-wrap">
                <Button variant="outline" size="sm" disabled={pasteJson.trim() === ''} onClick={onPasteFill}>{t('formatFill')}</Button>
              </div>
            </div>
          )
        : (
            <div id={`${tabsId}-form-panel`} className="flex flex-col gap-[10px]" role="tabpanel" aria-labelledby={`${tabsId}-form`}>
              <Field label={t('serverName')}>
                <Input
                  value={editor.serverName}
                  disabled={editor.id !== ''}
                  onChange={event => onEditorChange({ serverName: event.target.value })}
                />
              </Field>
              <Field as="div" label={t('transport')}>
                <div>
                  <Select
                    disabled={editor.id !== ''}
                    label={t('transport')}
                    options={transportOptions}
                    value={editor.transport}
                    onChange={next => onEditorChange({ transport: next as McpEditorState['transport'] })}
                  />
                </div>
              </Field>
              {editor.transport === 'stdio'
                ? (
                    <>
                      <Field label={t('command')}>
                        <Input value={editor.command} onChange={event => onEditorChange({ command: event.target.value })} />
                      </Field>
                      <Field label={t('args')}>
                        <Textarea size="short" value={editor.args} onChange={event => onEditorChange({ args: event.target.value })} />
                      </Field>
                      <Field label={t('envPairs')}>
                        <Textarea size="short" value={editor.env} onChange={event => onEditorChange({ env: event.target.value })} />
                      </Field>
                    </>
                  )
                : (
                    <>
                      <Field label={t('url')}>
                        <Input value={editor.url} onChange={event => onEditorChange({ url: event.target.value })} />
                      </Field>
                      <Field label={t('headersPairs')}>
                        <Textarea size="short" value={editor.headers} onChange={event => onEditorChange({ headers: event.target.value })} />
                      </Field>
                    </>
                  )}
            </div>
          )}
      {formError !== null && <Text tone="error">{formError}</Text>}
      <div className="flex items-center gap-[6px] flex-wrap">
        <span className="flex-1" />
        <Button variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={onSave}>{t('save')}</Button>
      </div>
    </div>
  )
}
