import type { ReactElement } from 'react'
import type { PostApiTauriExtensionMcpBody as McpSaveBody } from '../apis/index.type'
import type { McpRow } from '../types'
import type { McpEditorMode, McpEditorState, McpImportItem, McpTabProps } from './mcp-tab.types'
import { Action, ArrowRotateRight, Button, Card, Icon, Modal, PlugConnection, Select, Tag, Text, Toast, TriangleExclamation as Warning } from 'dsh-tauri-ui/client'
import { compact } from 'dsh-tauri/client'
import { useEffect, useState } from 'react'
import { deleteMcp, getImportScan, getMcp, postImportApply, postMcp, postMcpCheck, postMcpToggle } from '../apis'
import { MCP_RESTART_INITIAL_DELAY_MS, MCP_RESTART_POLL_INTERVAL_MS, MCP_RESTART_TIMEOUT_MS } from '../constants'
import { useTimers } from '../hooks/use-timers'
import { restartHost } from '../service/restart'
import { isDesktopHost } from '../service/restart.utils'
import { McpEditorForm } from './mcp-editor-form'
import { McpImportDialog } from './mcp-import-dialog'
import { mapToPairs, parseMcpJson, parsePairs } from './mcp-tab.utils'
import { failText } from './outcome.utils'

export function McpTab({ t }: McpTabProps): ReactElement {
  const [servers, setServers] = useState<McpRow[] | null>(null)
  const [editor, setEditor] = useState<McpEditorState | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importItems, setImportItems] = useState<McpImportItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [restartConfirm, setRestartConfirm] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [toast, setToast] = useState<{ text: string, ok: boolean, seq: number } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [editorMode, setEditorMode] = useState<McpEditorMode>('json')
  const [pasteJson, setPasteJson] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [scope, setScope] = useState<'all' | 'global' | 'profile'>('all')
  const [checking, setChecking] = useState<string | null>(null)
  const [globalError, setGlobalError] = useState('')
  const { later } = useTimers()

  useEffect(() => {
    let current = true
    void getMcp().then(
      (body) => {
        if (current) {
          if ('error' in body) {
            setServers([])
            setToast({ text: failText(t, new Error(body.error)), ok: false, seq: Date.now() })
            return
          }
          setServers(body.servers)
          setGlobalError(body.globalError ?? '')
        }
      },
      (error: Error) => {
        if (current) {
          setServers([])
          setToast({ text: `${t('failed')}: ${String(error.message ?? error)}`, ok: false, seq: Date.now() })
        }
      },
    )
    return () => {
      current = false
    }
  }, [reload, t])

  const openImport = async (): Promise<void> => {
    setImportOpen(true)
    setImportItems(null)
    try {
      const body = await getImportScan()
      if ('error' in body)
        throw new Error(body.error)
      const existing = new Set(body.existing)
      setImportItems(body.servers.map(server => ({
        server,
        existing: existing.has(server.name),
        checked: !existing.has(server.name),
      })))
    }
    catch (error) {
      setImportItems([])
      setToast({ text: failText(t, error), ok: false, seq: Date.now() })
    }
  }

  const doImport = async (): Promise<void> => {
    if (importItems === null)
      return
    const items = importItems.filter(item => item.checked && !item.existing).map(item => ({ agent: item.server.agent, name: item.server.name }))
    setBusy(true)
    try {
      const body = await postImportApply({ items })
      if ('error' in body)
        throw new Error(body.error)
      const failed = body.results.filter(item => !item.ok)
      if (failed.length === 0) {
        setToast({ text: t(body.restartNeeded ? 'restartNeeded' : 'mcpApplied'), ok: true, seq: Date.now() })
      }
      else {
        const detail = failed.map(item => `${item.name} (${item.error})`).join(', ')
        const restart = body.restartNeeded && body.results.some(item => item.ok) ? ` ${t('restartNeeded')}` : ''
        setToast({ text: `${t('failed')}: ${detail}${restart}`, ok: false, seq: Date.now() })
      }
      setImportOpen(false)
      setReload(value => value + 1)
    }
    catch (error) {
      setToast({ text: failText(t, error), ok: false, seq: Date.now() })
    }
    finally {
      setBusy(false)
    }
  }

  const checkConnectivity = async (row: McpRow): Promise<void> => {
    setChecking(row.id)
    try {
      const result = await postMcpCheck({ id: row.id })
      if ('error' in result)
        throw new Error(result.error)
      setToast({
        text: result.ok ? `${t('connectivityOk')}${result.detail ? ` (${result.detail})` : ''}` : `${t('connectivityFailed')}: ${result.detail ?? ''}`,
        ok: result.ok,
        seq: Date.now(),
      })
    }
    catch (error) {
      setToast({ text: `${t('connectivityFailed')}: ${String(error)}`, ok: false, seq: Date.now() })
    }
    finally { setChecking(null) }
  }

  const openCreate = (): void => {
    setFormError(null)
    setPasteError(null)
    setPasteJson('')
    setEditorMode('json')
    setEditor({ id: '', serverName: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '' })
  }

  const openEdit = (row: McpRow): void => {
    setFormError(null)
    setPasteError(null)
    setPasteJson('')
    setEditorMode('form')
    setEditor({
      id: row.id,
      serverName: row.serverName,
      transport: row.transport,
      command: row.command ?? '',
      args: (row.args ?? []).join('\n'),
      env: mapToPairs(row.env, '='),
      url: row.url ?? '',
      headers: mapToPairs(row.headers, ':'),
    })
  }

  const doPasteFill = (): void => {
    if (editor === null || pasteJson.trim() === '')
      return
    const parsed = parseMcpJson(pasteJson)
    if ('error' in parsed) {
      setPasteError(parsed.error)
      return
    }
    const lockIdentity = editor.id !== ''
    if (lockIdentity && parsed.transport !== editor.transport) {
      setPasteError(t('pasteTransportMismatch'))
      return
    }
    setPasteError(null)
    setFormError(null)
    setEditor({
      ...editor,
      ...(parsed.serverName !== undefined && !lockIdentity ? { serverName: parsed.serverName } : {}),
      ...(!lockIdentity ? { transport: parsed.transport } : {}),
      ...(parsed.transport === 'stdio'
        ? {
            command: parsed.command ?? editor.command,
            args: (parsed.args ?? []).join('\n'),
            env: mapToPairs(parsed.env, '='),
          }
        : {
            url: parsed.url ?? editor.url,
            headers: mapToPairs(parsed.headers, ':'),
          }),
    })
    setEditorMode('form')
  }

  const doSave = async (): Promise<void> => {
    if (editor === null)
      return
    let input: McpSaveBody
    if (editorMode === 'json') {
      const parsed = parseMcpJson(pasteJson)
      if ('error' in parsed) {
        setPasteError(parsed.error)
        return
      }
      input = {
        id: editor.id,
        serverName: parsed.serverName?.trim() ?? '',
        transport: parsed.transport,
        ...(parsed.transport === 'stdio'
          ? { command: parsed.command ?? '', args: parsed.args ?? [], env: parsed.env ?? {} }
          : { url: parsed.url ?? '', headers: parsed.headers ?? {} }),
      }
    }
    else {
      input = {
        id: editor.id,
        serverName: editor.serverName.trim(),
        transport: editor.transport,
        ...(editor.transport === 'stdio'
          ? {
              command: editor.command.trim(),
              args: compact(editor.args.split(/\r?\n/).map(line => line.trim())),
              env: parsePairs(editor.env, '='),
            }
          : {
              url: editor.url.trim(),
              headers: parsePairs(editor.headers, ':'),
            }),
      }
    }
    setBusy(true)
    setFormError(null)
    setPasteError(null)
    try {
      const body = await postMcp(input)
      if ('error' in body)
        throw new Error(body.error)
      setEditor(null)
      setToast({ text: t(body.restartNeeded ? 'restartNeeded' : 'mcpApplied'), ok: true, seq: Date.now() })
      setReload(value => value + 1)
    }
    catch (error) {
      setFormError(String(error instanceof Error ? error.message : error))
    }
    finally {
      setBusy(false)
    }
  }

  const doToggle = async (row: McpRow): Promise<void> => {
    setBusy(true)
    try {
      const body = await postMcpToggle({ id: row.id, disabled: !row.disabled })
      if ('error' in body)
        throw new Error(body.error)
      setToast({ text: t(body.restartNeeded ? 'restartNeeded' : 'mcpApplied'), ok: true, seq: Date.now() })
      setReload(value => value + 1)
    }
    catch (error) {
      setToast({ text: failText(t, error), ok: false, seq: Date.now() })
    }
    finally {
      setBusy(false)
    }
  }

  const doRemove = async (): Promise<void> => {
    if (confirmId === null)
      return
    setBusy(true)
    try {
      const body = await deleteMcp({ id: confirmId })
      if ('error' in body)
        throw new Error(body.error)
      setToast({ text: t(body.restartNeeded ? 'restartNeeded' : 'mcpApplied'), ok: true, seq: Date.now() })
      setReload(value => value + 1)
    }
    catch (error) {
      setToast({ text: failText(t, error), ok: false, seq: Date.now() })
    }
    finally {
      setBusy(false)
      setConfirmId(null)
    }
  }

  const doRestart = (): void => {
    setRestartConfirm(false)
    setRestarting(true)
    setToast({ text: t('restarting'), ok: true, seq: Date.now() })
    void restartHost()
    if (isDesktopHost())
      return
    const deadline = Date.now() + MCP_RESTART_TIMEOUT_MS
    const poll = (): void => {
      if (Date.now() > deadline)
        return
      later(() => {
        void getMcp().then(
          () => { window.location.reload() },
          () => { poll() },
        )
      }, MCP_RESTART_POLL_INTERVAL_MS)
    }
    later(poll, MCP_RESTART_INITIAL_DELAY_MS)
  }

  const scopeOptions = [
    { value: 'all', label: t('scopeAll') },
    { value: 'global', label: t('global') },
    { value: 'profile', label: t('profile') },
  ]

  return (
    <div className="flex flex-col gap-[14px] text-primary">
      <div className="flex items-center gap-[10px] flex-wrap [&_h3]:m-0 [&_h3]:text-[16px] [&_h3]:leading-[24px] [&_h3]:font-medium">
        <span className="inline-flex items-center justify-center flex-none w-[22px] h-[22px]"><Icon as={PlugConnection} size={16} /></span>
        <h3>{t('mcpTitle')}</h3>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" disabled={restarting} onClick={() => setRestartConfirm(true)}>{t('restart')}</Button>
        <Button variant="ghost" size="sm" onClick={() => void openImport()}>{t('importServers')}</Button>
        <Button variant="primary" size="sm" onClick={openCreate}>{t('addServer')}</Button>
      </div>
      <Text tone="tertiary">{t('mcpIntro')}</Text>

      <div className="flex items-center gap-[7px] px-[2px] mt-[2px] [&_h3]:m-0 [&_h3]:text-[13px] [&_h3]:leading-[20px] [&_h3]:font-semibold">
        <h3>{t('mcpTab')}</h3>
        {servers !== null && <span className="text-[12px] leading-[18px] text-tertiary tabular-nums">{servers.length}</span>}
        <Select
          label={t('scope')}
          options={scopeOptions}
          value={scope}
          onChange={next => setScope(next as typeof scope)}
        />
        <span className="flex-1" />
        <Action variant="toolbar" icon={<Icon as={ArrowRotateRight} />} aria-label={t('view')} title={t('view')} disabled={busy} onClick={() => setReload(value => value + 1)} />
      </div>

      {servers === null && <Text size="sm" tone="tertiary">{t('loading')}</Text>}
      {servers !== null && servers.length === 0 && <Text size="sm" tone="tertiary">{t('emptyMcp')}</Text>}
      {servers !== null && servers.length > 0 && (
        <Card.List className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-stretch gap-[10px] max-[680px]:grid-cols-[minmax(0,1fr)]">
          {servers.filter(row => scope === 'all' || (row.layer ?? 'profile') === scope).map(row => (
            <Card key={row.id} className="mx-0 flex flex-col gap-[8px] px-[14px] py-[12px]">
              <div className="flex items-center gap-[6px] flex-wrap">
                <Card.Title className="flex-1 min-w-0 font-semibold [font-family:var(--ds-font-family-code)]" title={row.id}>{row.serverName}</Card.Title>
                <Tag tone={(row.scope ?? row.layer) === 'global' ? 'info' : 'neutral'}>{(row.scope ?? row.layer) === 'global' ? t('scopeGlobal') : t('scopeProfile')}</Tag>
                <Tag tone="neutral">{row.transport}</Tag>
                <Tag tone={row.disabled ? 'warning' : 'neutral'}>{row.disabled ? t('disabled') : t('enabled')}</Tag>
              </div>
              <Card.Description className="text-secondary line-clamp-2">
                {row.transport === 'stdio' ? `${row.command ?? ''} ${(row.args ?? []).join(' ')}` : row.url ?? ''}
              </Card.Description>
              {row.shadowed === true && <Text tone="error">{t('shadowedByGlobal')}</Text>}
              {globalError !== '' && <Text tone="error">{globalError}</Text>}
              <div className="flex items-center gap-[6px] flex-wrap">
                <span className="flex-1" />
                <Button variant="ghost" size="sm" disabled={busy || checking === row.id} onClick={() => void checkConnectivity(row)}>{checking === row.id ? t('checkRunning') : t('checkLabel')}</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void doToggle(row)}>{t('toggle')}</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => openEdit(row)}>{t('edit')}</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmId(row.id)}>{t('delete')}</Button>
              </div>
            </Card>
          ))}
        </Card.List>
      )}

      <Modal
        open={editor !== null}
        onClose={() => setEditor(null)}
        closeLabel={t('close')}
        title={editor !== null && editor.id !== '' ? t('editServer') : t('addServer')}
        className="w-[min(760px,100%)]!"
        contentClassName="max-h-[calc(100vh-160px)]! overflow-y-auto"
      >
        {editor !== null && (
          <McpEditorForm
            t={t}
            editor={editor}
            mode={editorMode}
            busy={busy}
            pasteJson={pasteJson}
            pasteError={pasteError}
            formError={formError}
            onModeChange={setEditorMode}
            onEditorChange={patch => setEditor(current => current === null ? current : { ...current, ...patch })}
            onPasteJsonChange={setPasteJson}
            onPasteFill={doPasteFill}
            onCancel={() => setEditor(null)}
            onSave={() => void doSave()}
          />
        )}
      </Modal>

      <Modal
        open={confirmId !== null}
        onClose={() => setConfirmId(null)}
        closeLabel={t('close')}
        title={t('confirmRemove')}
        description={confirmId ?? undefined}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setConfirmId(null)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void doRemove()}>{t('delete')}</Button>
          </>
        )}
      >
        <p>{t('removeWarn')}</p>
      </Modal>

      <Modal
        open={restartConfirm}
        onClose={() => setRestartConfirm(false)}
        closeLabel={t('close')}
        title={t('restartConfirmTitle')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setRestartConfirm(false)}>{t('cancel')}</Button>
            <Button variant="primary" onClick={doRestart}>{t('restartNow')}</Button>
          </>
        )}
      >
        <p>{t('restartConfirmBody')}</p>
      </Modal>

      <McpImportDialog
        t={t}
        open={importOpen}
        items={importItems}
        busy={busy}
        formError={formError}
        onClose={() => setImportOpen(false)}
        onToggle={(index, checked) => {
          if (importItems === null)
            return
          const next = importItems.slice()
          next[index] = { ...next[index], checked }
          setImportItems(next)
        }}
        onToggleGroup={(indices, checked) => {
          if (importItems === null)
            return
          const next = importItems.slice()
          for (const index of indices)
            next[index] = { ...next[index], checked }
          setImportItems(next)
        }}
        onImport={() => void doImport()}
      />
      {toast !== null && <Toast key={toast.seq} text={toast.text} icon={toast.ok ? undefined : <Icon as={Warning} />} onDone={() => setToast(null)} />}
    </div>
  )
}
