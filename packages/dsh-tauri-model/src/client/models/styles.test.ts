import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { modelStyles, onboardingDialogStyles, onboardingStyles, welcomeStyles } from './styles'

vi.mock('dsh-tauri-ui/client', async () => await import('../../../../dsh-tauri-ui/src/client/utils/cssr'))

const MODEL_KEYS = 'addActions addBlock addButton addCard addModelButton addModes addPanel advancedHint candidate candidateActive candidateEmpty candidateId candidateLabel candidateList candidateSearch candidateToolbar credentialDot credentialDotConfigured credentialDotMissing customized customizedBody customizedSummary dangerButton deleteConfirm deleteDialog editor editorActions editorHeader editorRoute editorTitle error fetchDialog field fieldLabel headersInput hiddenLabel iconButton iconButtonDanger input intro linkButton modelAdvanced modelCatalog modelCatalogHeading modelCatalogMeta modelCatalogTitle modelEmpty modelEntry modelField modelFieldLabel modelInputChoices modelInputTypes modelList modelListHead modelRow notice primaryButton rowActions rowCard rowHead rowIdentity rowName rows rowTag savedNotice secondaryButton section selectInput setupCard switchThumb title'.split(' ')

function expected(prefix: string, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map(key => [key, `${prefix}${key}`]))
}

describe('css class maps', () => {
  it('preserves every model class including compound, camel-case and media selectors', () => {
    expect(modelStyles).toEqual(expected('zGbnIq_', MODEL_KEYS))
    expectTypeOf(modelStyles).toEqualTypeOf<Record<string, string>>()
  })

  it('preserves welcome classes without leaking other prefixes', () => {
    expect(welcomeStyles).toEqual(expected('zGbnIqw_', ['actions', 'copy', 'error', 'primary']))
    expectTypeOf(welcomeStyles).toEqualTypeOf<Record<string, string>>()
  })

  it('preserves onboarding classes with their longer prefix', () => {
    expect(onboardingStyles).toEqual(expected('zGbnIqo_', ['body', 'content', 'dialog', 'title']))
    expectTypeOf(onboardingStyles).toEqualTypeOf<Record<string, string>>()
  })

  it('preserves onboarding editor classes with duplicate media rules', () => {
    expect(onboardingDialogStyles).toEqual(expected('zGbnIqd_', ['description', 'editor']))
    expectTypeOf(onboardingDialogStyles).toEqualTypeOf<Record<string, string>>()
  })
})
