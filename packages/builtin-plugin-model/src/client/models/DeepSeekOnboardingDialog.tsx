import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type {} from './slot-contract.ts'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import { useEffect, useState } from 'react'
import { OnboardingModal } from './OnboardingModal.tsx'
import { ProviderEditor } from './ProviderEditor.tsx'
import { onboardingReadiness } from './store.ts'
import { onboardingDialogStyles as styles } from './styles.ts'

export interface DeepSeekOnboardingInjected {
  automatic: boolean
  hooks: {
    models: SnapshotStore<ModelsSettingsState>
  }

  controller: ModelsSettingsStore

  operations: ModelsOperations

  schema: SettingsSchemaOperations

  t: (key: keyof typeof en) => string
}

export type DeepSeekOnboardingDialogProps
  = PropsRuntime<'settings.onboarding'> & PropsRenderSlots<'settings.models.sign-in'> & InjectFace<DeepSeekOnboardingInjected>

function assertNever(_value: never): never {
  throw new Error('unexpected DeepSeek onboarding state')
}

export function DeepSeekOnboardingDialog(props: DeepSeekOnboardingDialogProps): ReactNode {
  const { complete, controller, useModels, operations, schema, t, renderSlot, automatic, explicit = false } = props
  const [apiKey, setApiKey] = useState(explicit)
  const state = useModels(snapshot => snapshot)
  const readiness = onboardingReadiness(state)

  useEffect(() => {
    if ((automatic || explicit) && state.status === 'idle')
      void controller.load()
  }, [controller, state.status, automatic, explicit])

  useEffect(() => {
    if (
      (!automatic && !explicit)
      || readiness.kind === 'adapter-absent'
      || (!explicit && readiness.kind === 'provider-ready')
      || readiness.kind === 'unavailable'
    ) {
      complete()
    }
  }, [complete, readiness.kind, explicit, automatic])

  if (!automatic && !explicit)
    return null

  switch (readiness.kind) {
    case 'loading':
    case 'adapter-absent':
    case 'unavailable':
      return null
    case 'provider-ready':
      if (!explicit)
        return null
      break
    case 'credential-missing':
      break

    default:
      return assertNever(readiness)
  }

  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  const namespace = state.namespaces.get('llm-deepseek')

  if (row === undefined || namespace === undefined)
    return null

  const finishCredential = (changed: boolean): void => {
    if (!changed) {
      complete()
      return
    }
    void controller.load()
  }

  const editor = (
    <OnboardingModal title={t('onboardingTitle')}>
      <p className={styles.description}>{t('onboardingDescription')}</p>
      <div className={styles.editor}>
        <ProviderEditor
          provider={row.entry.provider}
          displayName={row.entry.displayName}
          namespace={namespace}
          schema={schema}
          settingsPath={row.entry.settingsPath}
          operations={operations}
          t={t}
          readOnly={false}
          hideTitle
          credentialOnly
          credentialRequired
          autoFocusCredential
          cancelLabelKey="onboardingLater"
          submitLabelKey="onboardingSave"
          submitBusyLabelKey="onboardingSaving"
          onClose={finishCredential}
        />
      </div>
    </OnboardingModal>
  )
  const enableApiKey = (): void => {
    setApiKey(true)
  }
  return apiKey
    ? editor
    : renderSlot(
        'settings.models.sign-in',
        { complete, useApiKey: enableApiKey },
        { fallback: editor },
      )
}
