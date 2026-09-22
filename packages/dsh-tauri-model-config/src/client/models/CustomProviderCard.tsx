import type { ReactNode } from 'react'
import type { JsonValue } from '../types/remotes.ts'
import type { en } from './locales.ts'
import type { ModelDraft } from './ModelListEditor.tsx'
import type { ModelsOperations } from './operations.ts'
import type { RequestHeaders } from './requestHeaders.ts'
import { useState } from 'react'
import { loadModelCapacities } from '../service/model-config.ts'
import { mergeModelCards, modelConfigNotice, withDetail } from '../service/model-config.utils.ts'
import { ensurePresets } from '../service/presets.ts'
import { apiKeyFailure } from './apiKey.ts'
import { validateDeepSeekModels } from './DeepSeekModelsEditor.tsx'
import { EditorFooter } from './EditorFooter.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import { RequestHeadersDialog } from './RequestHeadersDialog.tsx'
import { deriveKeyRef } from './store.ts'
import { modelStyles as styles } from './styles.ts'

const NS = 'llm-pi-ai'

const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

export interface CustomProviderCardProps {

  taken: readonly string[]

  protocols: readonly string[]

  revision: number

  operations: ModelsOperations

  t: (key: keyof typeof en) => string

  readOnly: boolean

  onClose: (changed: boolean) => void
}

export function CustomProviderCard(props: CustomProviderCardProps): ReactNode {
  const { taken, protocols, operations, t } = props

  const [openedAt] = useState(() => props.revision)
  const [route, setRoute] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [protocol, setProtocol] = useState(protocols[0] ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState<readonly ModelDraft[]>([])
  const [headers, setHeaders] = useState<RequestHeaders>({})
  const [headersOpen, setHeadersOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [configBusy, setConfigBusy] = useState(false)
  const [configNotice, setConfigNotice] = useState<string | undefined>(undefined)
  const [configFailure, setConfigFailure] = useState<string | undefined>(undefined)

  const [committed, setCommitted] = useState(false)
  const disabled = props.readOnly || busy

  const profileDisabled = disabled || committed

  const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route)
  const routeTaken = taken.includes(route)
  const normalizedBaseURL = baseURL.trim()
  const baseUrlInvalid = baseURL.length > 0 && !isHttpUrl(normalizedBaseURL)

  const modelFailure = validateDeepSeekModels(models)
  const keyFailure = apiKeyFailure(keyDraft)

  const keyValue = keyDraft.trim()
  const ready = route.length > 0 && !routeInvalid && !routeTaken
    && normalizedBaseURL.length > 0 && !baseUrlInvalid && models.length > 0 && modelFailure === undefined
    && keyFailure === undefined

  const hint = failure !== undefined || ready

    || keyFailure !== undefined

    || route.length === 0 || routeInvalid || routeTaken || baseUrlInvalid
    ? undefined
    : normalizedBaseURL.length === 0
      ? t('customNeedsBaseUrl')
      : modelFailure !== undefined
        ? `${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`
        : t('customNeedsModels')

  const createOnce = async (): Promise<string | undefined> => {
    const keyRef = deriveKeyRef(route)
    const storesKey = keyValue.length > 0
    if (!committed) {
      const profile = {
        ...displayName.length === 0 ? {} : { displayName },

        ...storesKey ? { apiKeyEnv: keyRef } : {},
        api: protocol,
        baseURL: normalizedBaseURL,
        ...Object.keys(headers).length === 0 ? {} : { headers },
        models: models.map(model => ({ ...model })),
      }

      const written = await operations.writeSettings(
        NS,
        [{ op: 'set', path: ['providers', route], value: profile as JsonValue }],
        openedAt,
      )
      if (written.kind !== 'written') {
        return written.kind === 'conflict' ? t('conflict') : written.message
      }

      setCommitted(true)
    }
    if (storesKey) {
      const stored = await operations.storeCredential(keyRef, keyValue)

      if (stored !== undefined)
        return stored
    }
    return undefined
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await createOnce()
      if (outcome !== undefined) {
        setFailure(outcome)
        return
      }
      props.onClose(true)
    }
    finally {
      setBusy(false)
    }
  }

  const fetchConfig = (targets?: readonly string[]): void => {
    void (async () => {
      setConfigBusy(true)
      setConfigFailure(undefined)
      const [found] = await Promise.all([
        loadModelCapacities({
          settingsNs: NS,
          profilePath: ['providers', route.trim()],
          baseURL: normalizedBaseURL,
          api: protocol,
          headers,
          ...keyValue.length === 0 ? {} : { apiKey: keyValue },
        }, operations),
        ensurePresets(),
      ])
      setConfigBusy(false)
      if (!found.ok) {
        setConfigNotice(undefined)
        setConfigFailure(withDetail(t('configUnreachable'), found.error))
        return
      }
      const merged = mergeModelCards(models, found.models, { targets, overwrite: targets === undefined })
      if (merged.applied > 0)
        setModels(merged.models)
      setConfigNotice(modelConfigNotice(merged, {
        applied: t('configApplied'),
        none: t('configNoneApplied'),
        undisclosed: t('configUndisclosed'),
      }))
    })()
  }

  return (
    <div className={styles.editor}>
      <div className={styles.editorHeader}>
        <span className={styles.editorTitle}>{t('customTitle')}</span>
        <button
          type="button"
          className={`${styles.linkButton} ${styles.headerSettingsButton}`}
          title={t('requestHeadersHint')}
          data-dsh-model-header-settings=""
          disabled={profileDisabled}
          onClick={() => { setHeadersOpen(true) }}
        >
          {Object.keys(headers).length === 0
            ? t('requestHeaders')
            : `${t('requestHeaders')} (${String(Object.keys(headers).length)})`}
        </button>
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('customRoute')}</span>
        <input
          className={styles.input}
          type="text"
          value={route}
          placeholder="acme-gateway"
          aria-label={t('customRoute')}
          disabled={profileDisabled}
          onChange={(event) => { setRoute(event.target.value) }}
        />
      </div>

      {routeInvalid || routeTaken
        ? <p className={styles.error}>{t(routeInvalid ? 'customRouteInvalid' : 'customRouteTaken')}</p>
        : <p className={styles.advancedHint}>{t('customRouteHint')}</p>}
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('customDisplayName')}</span>
        <input
          className={styles.input}
          type="text"
          value={displayName}
          placeholder={route.length === 0 ? t('customDisplayName') : route}
          aria-label={t('customDisplayName')}
          disabled={profileDisabled}
          onChange={(event) => { setDisplayName(event.target.value) }}
        />
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('baseUrl')}</span>
        <input
          className={styles.input}
          type="text"
          value={baseURL}
          placeholder={t('customBaseUrlPlaceholder')}
          aria-label={t('baseUrl')}
          aria-invalid={baseUrlInvalid}
          disabled={profileDisabled}
          onChange={(event) => { setBaseURL(event.target.value) }}
        />
      </div>
      {baseUrlInvalid ? <p className={styles.error}>{t('customBaseUrlInvalid')}</p> : null}
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('customApi')}</span>
        <select
          className={`${styles.input} ${styles.selectInput}`}
          value={protocol}
          aria-label={t('customApi')}
          disabled={profileDisabled}
          onChange={(event) => { setProtocol(event.target.value) }}
        >
          {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('keyInput')}</span>
        <input
          className={styles.input}
          type="password"
          autoComplete="off"
          value={keyDraft}
          placeholder={t('keyPlaceholder')}
          aria-label={t('keyInput')}
          disabled={disabled}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />

        {keyFailure === undefined
          ? null
          : <p className={styles.error}>{t(keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure)}</p>}
      </div>
      <ModelListEditor
        models={models}
        onChange={setModels}
        probe={{
          settingsNs: NS,
          profilePath: ['providers', route.trim()],
          baseURL: normalizedBaseURL,
          api: protocol,
          headers,
          ...keyValue.length === 0 ? {} : { apiKey: keyValue },
        }}
        probeBlocked={baseUrlInvalid
          ? 'customBaseUrlInvalid'
          : keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure}
        operations={operations}
        t={t}
        disabled={profileDisabled}
        onFetchConfig={fetchConfig}
        configBusy={configBusy}
        configNotice={configNotice}
        configFailure={configFailure}
      />
      {failure !== undefined ? <p className={styles.error}>{failure}</p> : null}

      {hint === undefined ? null : <p className={styles.advancedHint}>{hint}</p>}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={disabled || !ready}
        submitLabelKey="create"
        submitBusyLabelKey="creating"
        onCancel={() => { props.onClose(committed) }}
        onSubmit={() => { void create() }}
      />
      {headersOpen
        ? (
            <RequestHeadersDialog
              headers={headers}
              disabled={profileDisabled}
              t={t}
              onClose={() => { setHeadersOpen(false) }}
              onSubmit={(next) => {
                setHeadersOpen(false)
                setHeaders(next)
              }}
            />
          )
        : null}
    </div>
  )
}
