import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import type { ModelDraft } from './ModelListEditor.tsx'
import type { ModelsOperations } from './operations.ts'
import { useEffect, useState } from 'react'
import { apiKeyFailure } from './apiKey.ts'
import { validateDeepSeekModels } from './DeepSeekModelsEditor.tsx'
import { EditorFooter } from './EditorFooter.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import { protocolLabel } from './protocol-label.ts'
import { parseRequestHeaders, requestHeaderFailure, requestHeadersRecord } from './requestHeaders.ts'
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
  onBusyChange?: (busy: boolean) => void
}

export function CustomProviderCard(props: CustomProviderCardProps): ReactNode {
  const { taken, protocols, operations, t, onBusyChange } = props

  const [openedAt] = useState(() => props.revision)
  const [route, setRoute] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [protocol, setProtocol] = useState(protocols[0] ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  const [headersDraft, setHeadersDraft] = useState('')
  const [models, setModels] = useState<readonly ModelDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [listBusy, setListBusy] = useState(false)
  useEffect(() => {
    onBusyChange?.(busy || listBusy)
  }, [busy, listBusy, onBusyChange])
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const [committed, setCommitted] = useState(false)
  const disabled = props.readOnly || busy

  const profileDisabled = disabled || committed

  const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route)
  const routeTaken = taken.includes(route)
  const normalizedBaseURL = baseURL.trim()
  const baseUrlInvalid = baseURL.length > 0 && !isHttpUrl(normalizedBaseURL)

  const modelFailure = validateDeepSeekModels(models)
  const keyFailure = apiKeyFailure(keyDraft)

  const headers = parseRequestHeaders(headersDraft)
  const headerFailure = requestHeaderFailure(headers)

  const keyValue = keyDraft.trim()
  const ready = route.length > 0 && !routeInvalid && !routeTaken
    && normalizedBaseURL.length > 0 && !baseUrlInvalid && models.length > 0 && modelFailure === undefined
    && keyFailure === undefined && headerFailure === undefined

  const hint = failure !== undefined || ready

    || keyFailure !== undefined || headerFailure !== undefined

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
        ...headers.length === 0 ? {} : { headers: requestHeadersRecord(headers) },
        api: protocol,
        baseURL: normalizedBaseURL,
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

  return (
    <div className={styles.editor}>
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
          placeholder={t(protocol === 'anthropic-messages'
            ? 'customAnthropicBaseUrlPlaceholder'
            : 'customBaseUrlPlaceholder')}
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
          {protocols.map(choice => <option key={choice} value={choice}>{protocolLabel(t, choice)}</option>)}
        </select>
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('keyInput')}</span>
        <input
          className={styles.input}
          type="password"
          autoComplete="new-password"
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
      <details className={styles.customized}>
        <summary className={styles.customizedSummary}>{t('requestHeaders')}</summary>
        <div className={styles.customizedBody}>
          <textarea
            className={styles.headersInput}
            value={headersDraft}
            placeholder={t('requestHeadersPlaceholder')}
            aria-label={t('requestHeaders')}
            aria-invalid={headerFailure !== undefined}
            disabled={profileDisabled}
            onChange={(event) => { setHeadersDraft(event.target.value) }}
          />
          <p className={styles.advancedHint}>{t('requestHeadersHint')}</p>
          {headerFailure === undefined ? null : <p className={styles.error}>{t(headerFailure)}</p>}
        </div>
      </details>
      <ModelListEditor
        models={models}
        onChange={setModels}
        probe={{
          settingsNs: NS,
          baseURL: normalizedBaseURL,
          api: protocol,
          ...keyValue.length === 0 ? {} : { apiKey: keyValue },
          ...headers.length === 0 ? {} : { headers: requestHeadersRecord(headers) },
        }}
        probeBlocked={baseUrlInvalid
          ? 'customBaseUrlInvalid'
          : keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure}
        operations={operations}
        t={t}
        disabled={profileDisabled}
        onBusyChange={setListBusy}
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
    </div>
  )
}
