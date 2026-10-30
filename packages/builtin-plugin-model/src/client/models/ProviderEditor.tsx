import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ReactNode } from 'react'
import type {
  CredentialInfo,
  SettingsNamespaceView,
  SettingsPathOpView,
} from '../types/remotes.ts'
import type { en } from './locales.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { useEffect, useMemo, useState } from 'react'
import { apiKeyFailure } from './apiKey.ts'
import {
  DeepSeekModelsEditor,
  modelDrafts,
  validateDeepSeekModels,
} from './DeepSeekModelsEditor.tsx'
import { EditorFooter } from './EditorFooter.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import { protocolLabel } from './protocol-label.ts'
import { parseRequestHeaders, requestHeaderFailure, requestHeadersRecord, requestHeadersText } from './requestHeaders.ts'
import { deriveKeyRef, protocolChoices } from './store.ts'
import { modelStyles as styles } from './styles.ts'

type EditorLayout = 'deepseek' | 'pi-ai' | 'unknown'

export interface ProviderEditorProps {
  provider: string
  displayName: string
  hideTitle?: boolean
  declared?: boolean
  namespace: SettingsNamespaceView
  schema: SettingsSchemaOperations
  settingsPath: readonly string[]
  operations: ModelsOperations
  t: (key: keyof typeof en) => string
  readOnly: boolean
  credentialOnly?: boolean
  credentialRequired?: boolean
  autoFocusCredential?: boolean
  cancelLabelKey?: keyof typeof en
  submitLabelKey?: keyof typeof en
  submitBusyLabelKey?: keyof typeof en
  onClose: (changed: boolean) => void
  onBusyChange?: (busy: boolean) => void
}

function draftAt(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  path: readonly string[],
): Record<string, unknown> {
  const subtree = schema.getPath(namespace.user, path)
  if (typeof subtree !== 'object' || subtree === null || Array.isArray(subtree))
    return {}
  return structuredClone(subtree) as Record<string, unknown>
}

export function pathOps(
  base: readonly string[],
  before: unknown,
  after: Record<string, unknown>,
): SettingsPathOpView[] {
  const previous = typeof before === 'object' && before !== null && !Array.isArray(before)
    ? before as Record<string, unknown>
    : {}
  const ops: SettingsPathOpView[] = []
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value))
      continue
    ops.push({ op: 'set', path: [...base, key], value: value as JsonValue })
  }
  for (const key of Object.keys(previous)) {
    if (!(key in after))
      ops.push({ op: 'unset', path: [...base, key] })
  }
  return ops
}

function layoutOf(ns: string): EditorLayout {
  if (ns === 'llm-deepseek')
    return 'deepseek'
  if (ns === 'llm-pi-ai')
    return 'pi-ai'
  return 'unknown'
}

function refFor(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  path: readonly string[],
  provider: string,
): string {
  const profile = schema.getPath(namespace.value, path)
  const named = typeof profile === 'object' && profile !== null
    ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv
    : undefined
  return typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(provider)
}

export function ProviderEditor(props: ProviderEditorProps): ReactNode {
  const { namespace, schema, settingsPath, operations, t } = props
  const [draft, setDraft] = useState<Record<string, unknown>>(() => draftAt(schema, namespace, settingsPath))
  const [headersDraft, setHeadersDraft] = useState(
    () => requestHeadersText(schema.getPath(draft, ['headers'])),
  )
  const [keyDraft, setKeyDraft] = useState('')
  const [credential, setCredential] = useState<{
    keyRef: string
    operations: ModelsOperations
    info: CredentialInfo | undefined
  } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [listBusy, setListBusy] = useState(false)
  const { onBusyChange } = props
  useEffect(() => {
    onBusyChange?.(busy || listBusy)
  }, [busy, listBusy, onBusyChange])
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const [committedOriginal, setCommittedOriginal] = useState<unknown>(
    () => schema.getPath(namespace.user, settingsPath),
  )
  const [expectedRevision, setExpectedRevision] = useState(() => namespace.revision)
  const root = useMemo(() => schema.rehydrate(namespace.schema), [namespace.schema, schema])
  const node = useMemo(() => schema.nodeAtPath(root, settingsPath), [root, schema, settingsPath])
  const fallback = schema.getPath(namespace.value, settingsPath)
  const disabled = props.readOnly || busy
  const accountProvider = props.provider === 'deepseek-account'
  const layout = accountProvider ? 'deepseek' : layoutOf(namespace.ns)
  const keyRef = refFor(schema, namespace, settingsPath, props.provider)
  const keyState = !accountProvider && credential?.keyRef === keyRef && credential.operations === operations
    ? credential.info
    : undefined

  const protocols = useMemo(
    () => layout === 'pi-ai' ? protocolChoices(namespace, schema) : [],
    [layout, namespace, schema],
  )

  useEffect(() => {
    if (accountProvider)
      return
    let stale = false
    void operations.describeCredential(keyRef).then((described) => {
      if (stale)
        return
      setCredential({ keyRef, operations, info: described })
    })
    return () => {
      stale = true
    }
  }, [operations, keyRef, accountProvider])

  const stringAt = (source: unknown, key: string): string | undefined => {
    const value = schema.getPath(source, [key])
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined
  }
  const setField = (key: string, next: string | undefined): void => {
    const value = next === undefined || next.trim().length === 0 ? undefined : next
    setDraft(current => value === undefined
      ? schema.deletePath(current, [key])
      : schema.setPath(current, [key], value))
  }
  const setHeaders = (text: string): void => {
    setHeadersDraft(text)
    const record = requestHeadersRecord(parseRequestHeaders(text))
    setDraft(current => Object.keys(record).length === 0
      ? schema.deletePath(current, ['headers'])
      : schema.setPath(current, ['headers'], record))
  }

  const modelFailure = validateDeepSeekModels(schema.getPath(draft, ['models']))
  const keyFailure = apiKeyFailure(keyDraft)

  const headers = parseRequestHeaders(headersDraft)
  const headerFailure = requestHeaderFailure(headers)

  const keyValue = keyDraft.trim()
  const credentialRequiredFailure = props.credentialRequired === true
    && keyDraft.length > 0 && keyValue.length === 0
    ? 'keyRequired' as const
    : undefined
  const shownKeyFailure = credentialRequiredFailure ?? keyFailure

  const probeApi = stringAt(draft, 'api') ?? stringAt(fallback, 'api')
  const probeBaseURL = stringAt(draft, 'baseURL') ?? stringAt(fallback, 'baseURL')
  const probe = {
    settingsNs: namespace.ns,

    provider: props.provider,
    ...probeBaseURL === undefined ? {} : { baseURL: probeBaseURL },
    ...probeApi === undefined ? {} : { api: probeApi },
    ...keyValue.length === 0 ? {} : { apiKey: keyValue },
    ...headers.length === 0 ? {} : { headers: requestHeadersRecord(headers) },
  }

  const applyOnce = async (): Promise<string | undefined> => {
    const ns = namespace.ns

    const next = layout === 'pi-ai' && stringAt(draft, 'apiKeyEnv') === undefined
      && stringAt(fallback, 'apiKeyEnv') === undefined && keyValue.length > 0
      ? schema.setPath(draft, ['apiKeyEnv'], keyRef)
      : draft
    if (props.credentialOnly !== true) {
      const failure = validateDeepSeekModels(schema.getPath(next, ['models']))

      if (failure !== undefined) {
        return `${t('model')} ${String(failure.index + 1)}: ${t(failure.key)}`
      }
    }

    if (props.credentialOnly !== true && headerFailure !== undefined)
      return t(headerFailure)

    if (props.credentialOnly !== true && node !== undefined && settingsPath.length === 0) {
      const sectionError = schema.validate(node, next)
      if (sectionError !== undefined)
        return sectionError
    }
    const materializesNativeProfile = layout === 'pi-ai'
      && fallback === undefined
      && committedOriginal === undefined
      && Object.keys(next).length === 0
    const ops: SettingsPathOpView[] = props.credentialOnly === true
      ? []
      : materializesNativeProfile
        ? [{ op: 'set', path: [...settingsPath], value: {} }]
        : pathOps(settingsPath, committedOriginal, next)
    if (ops.length > 0) {
      const written = await operations.writeSettings(ns, ops, expectedRevision)
      if (written.kind !== 'written')
        return written.kind === 'conflict' ? t('conflict') : written.message
      setCommittedOriginal(schema.getPath(written.view.user, settingsPath))
      setExpectedRevision(written.view.revision)
      setDraft(next)
    }
    if (keyValue.length > 0) {
      const stored = await operations.storeCredential(keyRef, keyValue)
      if (stored !== undefined)
        return stored
    }
    setKeyDraft('')
    return undefined
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const failure = await applyOnce()
      if (failure !== undefined) {
        setFailure(failure)
        return
      }
      props.onClose(true)
    }
    finally {
      setBusy(false)
    }
  }

  if (node === undefined) {
    return (
      <p className={styles.error}>
        {props.provider}
        :
        {' '}
        {props.t('settingsPathUnresolvable')}
      </p>
    )
  }

  const keyLocked = keyState?.writable === false

  const inheritedModels = (): unknown => {
    const pinned = schema.getPath(namespace.base, [...settingsPath, 'models'])
    return pinned ?? schema.nodeAtPath(root, [...settingsPath, 'models'])?.meta.default
  }

  const curatedFields = (family: 'deepseek' | 'pi-ai'): ReactNode => {
    const ownsIdentity = family === 'pi-ai' && props.declared === true
    const customModels = schema.getPath(draft, ['models'])
    const modelsOverridden = schema.hasPath(draft, ['models'])
    const models = modelDrafts(modelsOverridden ? customModels : inheritedModels())
    const defaultContextWindow = schema.getPath(fallback, ['defaultContextWindow'])
    const defaultMaxTokens = schema.getPath(fallback, ['maxTokens'])
    const defaultInput = schema.getPath(fallback, ['defaultInput'])
    const keyPlaceholder = keyLocked
      ? t('keyEnvLocked')
      : keyState?.configured === true && props.credentialRequired !== true
        ? t('keyStored')
        : family === 'pi-ai' ? t('keyPlaceholderNative') : t('keyPlaceholder')

    const catalogProps = {
      models,
      overridden: modelsOverridden,
      t,
      disabled,
      onChange: (next: Record<string, unknown>[]) => {
        setDraft(current => schema.setPath(current, ['models'], next))
      },
      onReset: () => { setDraft(current => schema.deletePath(current, ['models'])) },
    }
    if (accountProvider) {
      return (
        <DeepSeekModelsEditor
          {...catalogProps}
          defaultContextWindow={typeof defaultContextWindow === 'number' ? defaultContextWindow : undefined}
          defaultMaxTokens={typeof defaultMaxTokens === 'number' ? defaultMaxTokens : undefined}
        />
      )
    }
    return (
      <>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('keyInput')}</span>
          <input
            className={styles.input}
            type="password"
            autoComplete="new-password"
            value={keyDraft}
            placeholder={keyPlaceholder}
            aria-label={t('keyInput')}
            aria-invalid={shownKeyFailure !== undefined}
            required={props.credentialRequired === true}
            autoFocus={props.autoFocusCredential === true}
            disabled={disabled || keyLocked}
            onChange={(event) => { setKeyDraft(event.target.value) }}
          />
          {shownKeyFailure === undefined ? null : <p className={styles.error}>{t(shownKeyFailure)}</p>}
        </div>
        {props.credentialOnly === true
          ? null
          : (
              <details className={styles.customized}>
                <summary className={styles.customizedSummary}>{t('customized')}</summary>
                <div className={styles.customizedBody}>

                  {ownsIdentity
                    ? (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>{t('customDisplayName')}</span>
                          <input
                            className={styles.input}
                            type="text"
                            value={stringAt(draft, 'displayName') ?? ''}

                            placeholder={stringAt(schema.getPath(namespace.base, settingsPath), 'displayName')
                              ?? props.provider}
                            aria-label={t('customDisplayName')}
                            disabled={disabled}
                            onChange={(event) => { setField('displayName', event.target.value) }}
                          />
                        </div>
                      )
                    : null}
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('baseUrl')}</span>
                    <input
                      className={styles.input}
                      type="text"
                      value={stringAt(draft, 'baseURL') ?? ''}
                      placeholder={family === 'deepseek'
                        ? t('deepSeekBaseUrl')
                        : stringAt(fallback, 'baseURL') ?? t('baseUrlDefault')}
                      aria-describedby={family === 'deepseek' ? `${props.provider}-endpoint-hint` : undefined}
                      aria-label={t('baseUrl')}
                      disabled={disabled}
                      onChange={(event) => {
                        setField('baseURL', event.target.value === '' ? undefined : event.target.value)
                      }}
                    />
                    {family === 'deepseek' ? <span id={`${props.provider}-endpoint-hint`} className={styles.advancedHint}>{t('deepSeekEndpointHint')}</span> : null}
                  </div>

                  {ownsIdentity
                    ? (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>{t('customApi')}</span>
                          <select
                            className={`${styles.input} ${styles.selectInput}`}
                            value={probeApi ?? ''}
                            aria-label={t('customApi')}
                            disabled={disabled}
                            onChange={(event) => { setField('api', event.target.value) }}
                          >

                            {probeApi === undefined ? <option value="">{t('customApiUnset')}</option> : null}
                            {protocols.map(choice => <option key={choice} value={choice}>{protocolLabel(t, choice)}</option>)}
                          </select>
                        </div>
                      )
                    : null}

                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('requestHeaders')}</span>
                    <textarea
                      className={styles.headersInput}
                      value={headersDraft}
                      placeholder={t('requestHeadersPlaceholder')}
                      aria-label={t('requestHeaders')}
                      aria-invalid={headerFailure !== undefined}
                      disabled={disabled}
                      onChange={(event) => { setHeaders(event.target.value) }}
                    />
                    <span className={styles.advancedHint}>{t('requestHeadersHint')}</span>
                    <span className={styles.advancedHint}>{t('requestHeadersProbeHint')}</span>
                    {headerFailure === undefined ? null : <p className={styles.error}>{t(headerFailure)}</p>}
                  </div>

                  {family === 'deepseek'
                    ? (
                        <DeepSeekModelsEditor
                          {...catalogProps}
                          defaultContextWindow={typeof defaultContextWindow === 'number'
                            ? defaultContextWindow
                            : undefined}
                          defaultMaxTokens={typeof defaultMaxTokens === 'number' ? defaultMaxTokens : undefined}
                        />
                      )
                    : (
                        <ModelListEditor
                          {...catalogProps}
                          catalogProvider={props.declared === true ? undefined : props.provider}
                          defaultInput={Array.isArray(defaultInput) ? defaultInput : undefined}
                          probe={probe}
                          probeBlocked={keyFailure}
                          operations={operations}
                          onBusyChange={setListBusy}
                        />
                      )}
                </div>
              </details>
            )}
      </>
    )
  }

  return (
    <div className={props.credentialOnly === true ? styles.addBlock : styles.editor}>
      {props.hideTitle === true
        ? null
        : (
            <div className={styles.editorHeader}>
              <span className={styles.editorTitle}>{props.displayName}</span>
              {props.provider !== props.displayName
                ? <span className={styles.editorRoute}>{props.provider}</span>
                : null}
            </div>
          )}
      {layout === 'unknown'
        ? <p className={styles.advancedHint}>{`${t('advancedHint')} (${namespace.ns})`}</p>
        : curatedFields(layout)}
      {failure !== undefined ? <p className={styles.error}>{failure}</p> : null}
      {props.credentialOnly === true || modelFailure === undefined
        ? null
        : (
            <p className={styles.advancedHint}>
              {`${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`}
            </p>
          )}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={disabled || layout === 'unknown'
          || (props.credentialOnly !== true && modelFailure !== undefined)
          || (props.credentialOnly !== true && headerFailure !== undefined)
          || shownKeyFailure !== undefined
          || (props.credentialRequired === true && keyValue.length === 0)}
        submitLabelKey={props.submitLabelKey ?? 'apply'}
        submitBusyLabelKey={props.submitBusyLabelKey ?? 'applying'}
        {...props.cancelLabelKey === undefined ? {} : { cancelLabelKey: props.cancelLabelKey }}
        onCancel={() => { props.onClose(false) }}
        onSubmit={() => { void apply() }}
      />
    </div>
  )
}
