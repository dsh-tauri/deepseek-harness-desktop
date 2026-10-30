import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView } from '../types/remotes.ts'
import type { en } from './locales.ts'
import type { ModelsOperations } from './operations.ts'
import type { ProviderEditorProps } from './ProviderEditor.tsx'

import type { SettingsSchemaOperations } from './schema-operations.ts'
import type {} from './slot-contract.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { Plus, SegmentedControl } from 'dsh-tauri-ui/client'
import { useId, useState } from 'react'
import { openConfigFile } from '../service/model-config'
import { ModelConfigToolbar, modelExtrasTranslate } from '../ui/model-extras'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { ProviderEditor } from './ProviderEditor.tsx'
import { deriveKeyRef, protocolChoices, providerUsable } from './store.ts'
import { modelStyles as styles } from './styles.ts'

export interface ModelsSectionInjected {
  controller: ModelsSettingsStore
  hooks: {
    snapshot: ModelsSettingsStore['store']
  }

  operations: ModelsOperations

  schema: SettingsSchemaOperations

  t: (key: keyof typeof en) => string
}

type AddMode = 'catalog' | 'custom'

type ModelsChildSlots = 'settings.models.provider-card' | 'settings.models.footer'

type ModelsRenderSlot = PropsRenderSlots<ModelsChildSlots>['renderSlot']

export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>> & PropsRenderSlots<ModelsChildSlots>

type ModelsSectionFace = InjectFace<ModelsSectionInjected>

export interface ProviderIdentity {
  provider: string
  displayName: string
}

interface EditorTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  credentialRef?: string
  declared?: boolean
}

interface AddableRow {
  row: ProviderRow
  namespace: SettingsNamespaceView
}

interface CatalogDraft {
  target: EditorTarget
  namespace: SettingsNamespaceView
}

interface ProviderEditorRenderProps extends Pick<
  ProviderEditorProps,
  'namespace' | 'schema' | 'operations' | 't' | 'readOnly' | 'onClose'
> {
  target: EditorTarget
}

function renderProviderEditor({ target, ...props }: ProviderEditorRenderProps): ReactNode {
  return (
    <ProviderEditor
      provider={target.provider}
      displayName={target.displayName}
      settingsPath={target.settingsPath}
      {...target.declared === true ? { declared: true } : {}}
      {...props}
    />
  )
}

export async function removeProviderProfile(
  operations: ModelsOperations,
  controller: ModelsSettingsStore,
  target: { settingsNs: string, settingsPath: readonly string[], credentialRef?: string },
): Promise<string | undefined> {
  if (target.credentialRef !== undefined) {
    const credential = await operations.removeCredential(target.credentialRef)
    if (credential !== undefined)
      return credential
  }
  const written = await operations.writeSettings(
    target.settingsNs,
    [{ op: 'unset', path: [...target.settingsPath] }],
    undefined,
  )
  if (written.kind !== 'written')
    return written.message
  await controller.load()
  return undefined
}

export function needsSetup(row: ProviderRow, anyUsable: boolean): boolean {
  if (anyUsable || row.entry.provider === 'deepseek-account')
    return false
  if (row.entry.settingsPath.length > 0)
    return false
  return row.credential?.configured !== true
}

function keyConfiguredOf(row: ProviderRow): boolean {
  return row.apiKeyEnv !== undefined
    ? row.credential?.configured === true
    : row.derivedCredential?.configured === true
}

function targetOf(row: ProviderRow): EditorTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef
    && row.credential?.configured === true
    && row.credential.writable
    ? managedRef
    : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },

    ...row.entry.declared === true ? { declared: true } : {},
  }
}

export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, operations, schema, t, renderSlot } = props
  if (
    controller === undefined || useSnapshot === undefined || operations === undefined
    || schema === undefined || t === undefined
  ) {
    return null
  }
  return <Loaded injected={{ controller, useSnapshot, operations, schema, t }} renderSlot={renderSlot} />
}

function Loaded({ injected, renderSlot }: { injected: ModelsSectionFace, renderSlot: ModelsRenderSlot }): ReactNode {
  const { controller, operations, schema, t } = injected
  const snapshot = injected.useSnapshot(value => value)
  const state = {
    ...snapshot,
    rows: snapshot.rows.map(row => row.entry.provider === 'deepseek-account'
      ? { ...row, entry: { ...row.entry, displayName: t('deepSeekAccount') } }
      : row),
  }
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<AddMode>('catalog')

  const [visited, setVisited] = useState<ReadonlySet<AddMode>>(() => new Set())

  const [catalogBusy, setCatalogBusy] = useState(false)
  const [customBusy, setCustomBusy] = useState(false)

  const addId = useId()
  const [deleteTarget, setDeleteTarget] = useState<EditorTarget | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(() => new Set())

  const announceSaved = (target: ProviderIdentity): void => {
    void controller.load().then(() => {
      setSavedTarget(target)
    })
  }

  const closeAdd = (): void => {
    setEditing(undefined)
    setAddOpen(false)
    setCatalogBusy(false)
    setCustomBusy(false)
  }

  const closeEditor = (changed: boolean, target: ProviderIdentity): void => {
    closeAdd()
    if (changed)
      announceSaved(target)
  }

  const closeSetup = (changed: boolean, target: ProviderIdentity): void => {
    setDismissedSetup(previous => new Set([...previous, target.provider]))
    if (changed)
      announceSaved(target)
  }

  const closeDelete = (): void => {
    if (deleting)
      return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    if (deleteTarget === undefined || deleting)
      return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeProviderProfile(operations, controller, deleteTarget)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  if (state.status === 'idle')
    void controller.load()
  if (state.status === 'error') {
    const errorText = state.error ?? ''
    return (
      <div className={styles.section}>
        <p className={styles.error}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles.secondaryButton} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  const savedRow = savedTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === savedTarget.provider)
  const savedIdentity = savedRow === undefined
    ? savedTarget
    : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName }

  const anyUsable = state.rows.some(providerUsable)
  const configured = state.rows.filter(row => row.configured)
  const configurable = state.rows.filter(row => state.namespaces.has(row.entry.settingsNs))
  const addable: AddableRow[] = state.rows.flatMap((row) => {
    const namespace = state.namespaces.get(row.entry.settingsNs)
    return namespace === undefined || row.configured ? [] : [{ row, namespace }]
  })

  const piAi = state.namespaces.get('llm-pi-ai')
  const protocols = protocolChoices(piAi, schema)

  const catalogOffered = configurable.length > 0
  const catalogEnabled = addable.length > 0
  const customOffered = piAi !== undefined
  const customEnabled = protocols.length > 0
  const bothOffered = catalogOffered && customOffered
  const mode: AddMode = bothOffered ? addMode : customOffered ? 'custom' : 'catalog'
  const mounted = (candidate: AddMode): boolean => mode === candidate || visited.has(candidate)
  const switchLocked = catalogBusy || customBusy

  const draft = ((): CatalogDraft | undefined => {
    if (!addOpen || !catalogOffered)
      return undefined
    const kept = editing === undefined ? undefined : state.namespaces.get(editing.settingsNs)
    if (editing !== undefined && kept !== undefined)
      return { target: editing, namespace: kept }
    const first = addable[0]
    return first === undefined ? undefined : { target: targetOf(first.row), namespace: first.namespace }
  })()

  const addRow = draft === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === draft.target.provider)

  return (
    <div className={styles.section}>
      <div className="dshp-models-title-row">
        <h2 className={styles.title}>{t('title')}</h2>
        <ModelConfigToolbar
          t={modelExtrasTranslate}
          onOpenConfig={() => { void openConfigFile() }}
        />
      </div>
      <p className={styles.intro}>{t('intro')}</p>
      {!state.writable && state.status === 'ready' ? <p className={styles.notice}>{t('readOnly')}</p> : null}
      {savedIdentity === undefined
        ? null
        : (
            <p className={styles.savedNotice} role="status" aria-live="polite">
              {providerCopy(t('savedProvider'), savedIdentity)}
            </p>
          )}
      <ul className={styles.rows}>
        {configured.map((row) => {
          const target = targetOf(row)
          const namespace = state.namespaces.get(target.settingsNs)

          if (namespace === undefined)
            return null
          const error = row.entry.error === undefined
            ? null
            : <p role="alert" className={styles.error}>{row.entry.error}</p>
          if (needsSetup(row, anyUsable) && !dismissedSetup.has(row.entry.provider)) {
            return (
              <li key={row.entry.provider} className={styles.setupCard}>
                {error}
                {renderProviderEditor({
                  target,
                  namespace,
                  schema,
                  operations,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => { closeSetup(changed, target) },
                })}
                {renderSlot(
                  'settings.models.provider-card',
                  { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
                  { entryKey: row.entry.settingsNs },
                )}
              </li>
            )
          }
          const open = !addOpen && editing?.provider === row.entry.provider
          const credentialConfigured = row.credential?.configured === true
          const credentialMissing = !credentialConfigured
            && row.apiKeyEnv !== undefined
            && row.credential?.configured === false
          return (
            <li key={row.entry.provider} className={styles.rowCard}>
              <div className={styles.rowHead}>
                <span className={styles.rowIdentity}>
                  <span className={styles.rowName}>{row.entry.displayName}</span>

                  {row.entry.declared === true
                    ? <span className={styles.rowTag}>{t('customTag')}</span>
                    : null}
                  {credentialConfigured
                    ? (
                        <span
                          className={`${styles.credentialDot} ${styles.credentialDotConfigured}`}
                          role="img"
                          aria-label={t('credentialConfigured')}
                          title={t('credentialConfigured')}
                        />
                      )
                    : credentialMissing
                      ? (
                          <span
                            className={`${styles.credentialDot} ${styles.credentialDotMissing}`}
                            role="img"
                            aria-label={t('credentialMissing')}
                            title={t('credentialMissing')}
                          />
                        )
                      : null}
                </span>
                <span className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    aria-label={providerCopy(t('editProvider'), target)}
                    onClick={() => {
                      setSavedTarget(undefined)

                      setAddOpen(false)
                      setEditing(open ? undefined : target)
                    }}
                  >
                    {t('edit')}
                  </button>
                  {row.removable
                    ? (
                        <button
                          type="button"
                          className={styles.dangerButton}
                          aria-label={providerCopy(t('removeProvider'), target)}
                          disabled={!state.writable}
                          onClick={() => {
                            setSavedTarget(undefined)
                            setDeleteFailure(undefined)
                            setDeleteTarget(target)
                          }}
                        >
                          {t('remove')}
                        </button>
                      )
                    : null}
                </span>
              </div>
              {error}
              {renderSlot(
                'settings.models.provider-card',
                { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
                { entryKey: row.entry.settingsNs },
              )}
              {open
                ? renderProviderEditor({
                    target,
                    namespace,
                    schema,
                    operations,
                    t,
                    readOnly: !state.writable,
                    onClose: (changed) => { closeEditor(changed, target) },
                  })
                : null}
            </li>
          )
        })}
      </ul>
      <div className={styles.addBlock}>
        {addOpen
          ? (
              <div className={styles.addCard}>
                <div className={styles.addModes}>
                  {bothOffered
                    ? (
                        <SegmentedControl
                          id={addId}
                          label={t('addMode')}
                          value={mode}
                          disabled={switchLocked}
                          options={[
                            {
                              value: 'catalog',
                              label: t('addCatalog'),
                              disabled: !catalogEnabled,
                              ...catalogEnabled ? {} : { title: t('addCatalogExhausted') },
                            },
                            {
                              value: 'custom',
                              label: t('addCustom'),
                              disabled: !customEnabled,
                              ...customEnabled ? {} : { title: t('addCustomUnavailable') },
                            },
                          ]}
                          onChange={(next) => {
                            if (next !== 'catalog' && next !== 'custom')
                              return
                            setAddMode(next)
                            setVisited(previous => new Set([...previous, next]))
                          }}
                        />
                      )
                    : (

                        <div className={styles.editorHeader}>
                          <span className={styles.editorTitle}>{t(mode === 'catalog' ? 'addCatalog' : 'addCustom')}</span>
                        </div>
                      )}
                  <p className={styles.advancedHint}>
                    {t(mode === 'catalog' ? 'addCatalogHint' : 'addCustomHint')}
                  </p>
                </div>
                {mounted('catalog') && draft !== undefined
                  ? (
                      <div
                        id={`${addId}-catalog-panel`}
                        {...bothOffered ? { 'role': 'tabpanel', 'aria-labelledby': `${addId}-catalog` } : {}}
                        hidden={mode !== 'catalog'}
                        className={styles.addPanel}
                      >
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>{t('provider')}</span>
                          <select
                            className={`${styles.input} ${styles.selectInput}`}
                            value={draft.target.provider}
                            aria-label={t('provider')}
                            disabled={catalogBusy}
                            onChange={(event) => {
                              const picked = addable.find(candidate => candidate.row.entry.provider === event.target.value)

                              if (picked === undefined)
                                return
                              setEditing(targetOf(picked.row))
                            }}
                          >
                            {addable.map(({ row }) => (
                              <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>
                            ))}
                          </select>
                        </div>
                        <ProviderEditor
                          key={draft.target.provider}
                          provider={draft.target.provider}
                          displayName={draft.target.displayName}
                          hideTitle
                          namespace={draft.namespace}
                          schema={schema}
                          settingsPath={draft.target.settingsPath}
                          operations={operations}
                          t={t}
                          readOnly={!state.writable}
                          onClose={(changed) => { closeEditor(changed, draft.target) }}
                          onBusyChange={setCatalogBusy}
                        />
                        {addRow === undefined
                          ? null
                          : renderSlot(
                              'settings.models.provider-card',
                              { provider: addRow.entry, configured: addRow.configured, keyConfigured: keyConfiguredOf(addRow) },
                              { entryKey: addRow.entry.settingsNs },
                            )}
                      </div>
                    )
                  : null}
                {mounted('custom') && piAi !== undefined
                  ? (
                      <div
                        id={`${addId}-custom-panel`}
                        {...bothOffered ? { 'role': 'tabpanel', 'aria-labelledby': `${addId}-custom` } : {}}
                        hidden={mode !== 'custom'}
                        className={styles.addPanel}
                      >
                        <CustomProviderCard
                          taken={state.rows.map(row => row.entry.provider)}
                          protocols={protocols}
                          revision={piAi.revision}
                          operations={operations}
                          t={t}
                          readOnly={!state.writable}
                          onClose={(changed) => {
                            closeAdd()
                            if (changed)
                              void controller.load()
                          }}
                          onBusyChange={setCustomBusy}
                        />
                      </div>
                    )
                  : null}
              </div>
            )
          : catalogOffered || customOffered
            ? (

                <div className={styles.addActions}>
                  <button
                    type="button"
                    className={styles.addButton}
                    disabled={!state.writable || (!catalogEnabled && !customEnabled)}
                    onClick={() => {
                      const first = addable[0]
                      const initial: AddMode = catalogEnabled ? 'catalog' : 'custom'
                      setSavedTarget(undefined)
                      setEditing(first === undefined ? undefined : targetOf(first.row))
                      setAddMode(initial)
                      setVisited(new Set([initial]))
                      setAddOpen(true)
                    }}
                  >
                    <Plus width={14} height={14} />
                    {t('add')}
                  </button>
                </div>
              )
            : null}
      </div>
      {renderSlot('settings.models.footer', {})}
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined
          ? ''
          : providerCopy(
              deleteTarget.credentialRef === undefined
                ? t('deleteDescription')
                : t('deleteDescriptionWithCredential'),
              deleteTarget,
            )}
        className={styles.deleteDialog as string}
        footer={(
          <>
            {}
            <Button variant="outline" autoFocus data-modal-autofocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles.deleteConfirm}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles.error}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
