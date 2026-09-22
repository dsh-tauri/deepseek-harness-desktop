import { cssr } from 'dsh-tauri-ui/client'

const { c } = cssr

const MODELS_CSS = '.zGbnIq_section {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  max-width: 720px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.zGbnIq_title {\n  margin: 0;\n  font-size: 16px;\n  line-height: 24px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-primary);\n}\n\n.zGbnIq_intro {\n  margin: 0;\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.zGbnIq_notice {\n  margin: 0;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-state-warn-label);\n}\n\n.zGbnIq_savedNotice {\n  margin: 0;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.zGbnIq_rows {\n  list-style: none;\n  \n  margin: 12px 0 0;\n  padding: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n\n.zGbnIq_rowCard {\n  border: 0.5px solid var(--dsw-alias-border-l4);\n  border-radius: 16px;\n  padding: 12px 14px;\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n.zGbnIq_rowHead {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n}\n\n.zGbnIq_rowIdentity {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  min-width: 0;\n}\n\n.zGbnIq_rowName {\n  font-size: 14px;\n  line-height: 22px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-primary);\n}\n\n\n.zGbnIq_rowTag {\n  flex: none;\n  padding: 1px 6px;\n  border: 0.5px solid var(--dsw-alias-border-l3);\n  border-radius: 4px;\n  font-size: 11px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.zGbnIq_credentialDot {\n  box-sizing: border-box;\n  display: inline-block;\n  flex: none;\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  corner-shape: round;\n}\n\n.zGbnIq_credentialDotConfigured {\n  background: var(--dsw-alias-state-success-primary);\n}\n\n.zGbnIq_credentialDotMissing {\n  background: var(--dsw-alias-state-error-primary);\n}\n\n.zGbnIq_rowActions {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  margin-left: auto;\n}\n\n\n.zGbnIq_primaryButton,\n.zGbnIq_secondaryButton,\n.zGbnIq_addButton {\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 4px;\n  height: 36px;\n  padding: 0 14px;\n  border: none;\n  border-radius: 18px;\n  font: inherit;\n  font-size: 14px;\n  line-height: 22px;\n  cursor: pointer;\n}\n\n.zGbnIq_primaryButton {\n  background: var(--dsw-alias-button-primary-fill);\n  color: var(--dsw-alias-label-primary-foreground);\n}\n\n.zGbnIq_primaryButton:hover:not(:disabled) {\n  background: var(--dsw-alias-button-primary-hover);\n}\n\n.zGbnIq_secondaryButton,\n.zGbnIq_addButton {\n  border: 0.5px solid var(--dsw-alias-border-l3);\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n}\n\n.zGbnIq_secondaryButton:hover:not(:disabled),\n.zGbnIq_addButton:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.zGbnIq_secondaryButton:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover-solid);\n}\n\n.zGbnIq_dangerButton {\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  height: 36px;\n  padding: 0 14px;\n  border: none;\n  border-radius: 18px;\n  background: transparent;\n  color: var(--dsw-alias-state-error-primary);\n  font: inherit;\n  font-size: 14px;\n  line-height: 22px;\n  cursor: pointer;\n}\n\n.zGbnIq_dangerButton:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n}\n\n\n.zGbnIq_rowActions .zGbnIq_secondaryButton,\n.zGbnIq_rowActions .zGbnIq_dangerButton {\n  height: 28px;\n  padding: 0 10px;\n  border-radius: 14px;\n  font-size: 12px;\n  line-height: 18px;\n}\n\n.zGbnIq_primaryButton:disabled,\n.zGbnIq_secondaryButton:disabled,\n.zGbnIq_dangerButton:disabled,\n.zGbnIq_addButton:disabled,\n.zGbnIq_linkButton:disabled,\n.zGbnIq_addModelButton:disabled {\n  opacity: 0.4;\n  cursor: default;\n}\n\n.zGbnIq_primaryButton:focus-visible,\n.zGbnIq_secondaryButton:focus-visible,\n.zGbnIq_dangerButton:focus-visible,\n.zGbnIq_addButton:focus-visible,\n.zGbnIq_linkButton:focus-visible,\n.zGbnIq_addModelButton:focus-visible,\n.zGbnIq_iconButton:focus-visible,\n.zGbnIq_customizedSummary:focus-visible {\n  outline: none;\n  box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);\n}\n\n\n.zGbnIq_editor {\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-module-platform);\n  padding: 14px 16px;\n  display: flex;\n  flex-direction: column;\n  gap: 14px;\n}\n\n.zGbnIq_editorHeader {\n  display: flex;\n  align-items: baseline;\n  gap: 8px;\n}\n\n.zGbnIq_editorTitle {\n  font-size: 14px;\n  line-height: 22px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-primary);\n}\n\n.zGbnIq_editorRoute {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.zGbnIq_field {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.zGbnIq_fieldLabel {\n  display: inline-flex;\n  align-items: center;\n  gap: 10px;\n  font-size: 12px;\n  line-height: 18px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.zGbnIq_linkButton {\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  height: 28px;\n  padding: 0 10px;\n  border: none;\n  border-radius: 14px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 18px;\n  cursor: pointer;\n}\n\n.zGbnIq_linkButton:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.zGbnIq_advancedHint {\n  margin: 0;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.zGbnIq_editorActions {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n}\n\n.zGbnIq_addBlock {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n\n.zGbnIq_addActions {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 10px;\n}\n\n.zGbnIq_addButton {\n  \n  flex: 1 1 0;\n  min-width: 180px;\n  gap: 6px;\n  height: 44px;\n  border: 1px dashed var(--dsw-alias-border-l3);\n  border-radius: 16px;\n}\n\n.zGbnIq_addCard,\n.zGbnIq_setupCard {\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-module-platform);\n  padding: 14px 16px;\n  display: flex;\n  flex-direction: column;\n  gap: 14px;\n  list-style: none;\n}\n\n\n.zGbnIq_addCard .zGbnIq_editor,\n.zGbnIq_setupCard .zGbnIq_editor {\n  background: none;\n  padding: 0;\n}\n\n.zGbnIq_customized {\n  border-top: 0.5px solid var(--dsw-alias-border-l2);\n  padding-top: 10px;\n}\n\n\n.zGbnIq_customizedSummary {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  width: fit-content;\n  padding: 2px 4px;\n  margin-left: -4px;\n  border-radius: 6px;\n  cursor: pointer;\n  font-size: 12px;\n  line-height: 18px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-secondary);\n  list-style: none;\n}\n\n.zGbnIq_customizedSummary::-webkit-details-marker {\n  display: none;\n}\n\n.zGbnIq_customizedSummary::before {\n  content: \'\';\n  width: 5px;\n  height: 5px;\n  border-right: 1.5px solid currentcolor;\n  border-bottom: 1.5px solid currentcolor;\n  transform: rotate(-45deg) translate(-1px, -1px);\n  transition: transform 120ms ease;\n}\n\n.zGbnIq_customized[open] > .zGbnIq_customizedSummary::before {\n  transform: rotate(45deg) translate(-1px, -1px);\n}\n\n.zGbnIq_customizedSummary:hover {\n  color: var(--dsw-alias-label-primary);\n}\n\n.zGbnIq_customizedBody {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  padding-top: 12px;\n}\n\n\n.zGbnIq_modelCatalog {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding-top: 12px;\n  border-top: 0.5px solid var(--dsw-alias-border-l2);\n}\n\n.zGbnIq_modelCatalogHeading {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.zGbnIq_modelCatalogTitle {\n  font-size: 12px;\n  line-height: 18px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.zGbnIq_modelCatalogMeta,\n.zGbnIq_modelEmpty {\n  margin: 0;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n  line-height: 18px;\n}\n\n\n.zGbnIq_modelList {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.zGbnIq_modelListHead {\n  display: flex;\n  align-items: flex-start;\n  justify-content: space-between;\n  gap: 12px;\n}\n\n.zGbnIq_modelEntry {\n  border: 0.5px solid var(--dsw-alias-border-l4);\n  border-radius: 10px;\n  padding: 6px;\n}\n\n.zGbnIq_modelRow {\n  display: grid;\n  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto;\n  align-items: center;\n  gap: 6px;\n}\n\n\n.zGbnIq_iconButton {\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  cursor: pointer;\n}\n\n.zGbnIq_iconButton:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.zGbnIq_iconButton:disabled {\n  cursor: default;\n  opacity: 0.4;\n}\n\n\n.zGbnIq_iconButtonDanger:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.zGbnIq_modelAdvanced {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));\n  gap: 8px;\n  padding: 8px 4px 2px;\n}\n\n.zGbnIq_modelField {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.zGbnIq_modelFieldLabel {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n  line-height: 18px;\n}\n\n.zGbnIq_modelEmpty {\n  padding: 12px;\n  border: 1px dashed var(--dsw-alias-border-l3);\n  border-radius: 8px;\n  text-align: center;\n}\n\n.zGbnIq_addModelButton {\n  box-sizing: border-box;\n  align-self: flex-start;\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  height: 28px;\n  padding: 0 10px;\n  border: 0.5px solid var(--dsw-alias-border-l3);\n  border-radius: 14px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 18px;\n  cursor: pointer;\n}\n\n.zGbnIq_addModelButton:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.zGbnIq_input {\n  box-sizing: border-box;\n  width: 100%;\n  height: 32px;\n  padding: 0 10px;\n  border: 0.5px solid var(--dsw-alias-border-l4);\n  border-radius: 8px;\n  font: inherit;\n  font-size: 14px;\n  line-height: 22px;\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n}\n\n\nselect.zGbnIq_input {\n  max-width: 240px;\n  cursor: pointer;\n}\n\n.zGbnIq_input:focus {\n  outline: none;\n  border-color: var(--dsw-alias-brand-primary);\n}\n\n.zGbnIq_input::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.zGbnIq_input:disabled {\n  opacity: 0.6;\n  cursor: default;\n}\n\n\n.zGbnIq_selectInput {\n  appearance: none;\n  padding-right: 32px;\n  \n  background-image: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\' fill=\'none\'%3E%3Cpath d=\'M3 4.5L6 7.5L9 4.5\' stroke=\'%2381858C\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");\n  background-repeat: no-repeat;\n  background-position: right 12px center;\n  background-size: 12px 12px;\n}\n\n.zGbnIq_error {\n  margin: 0;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.zGbnIq_deleteDialog {\n  width: min(480px, 100%);\n}\n\n.zGbnIq_deleteConfirm:not(:disabled) {\n  border-color: var(--dsw-alias-state-error-primary);\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.zGbnIq_deleteConfirm:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n}\n\n\n.zGbnIq_hiddenLabel {\n  position: absolute;\n  width: 1px;\n  height: 1px;\n  overflow: hidden;\n  clip: rect(0 0 0 0);\n  white-space: nowrap;\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .zGbnIq_customizedSummary::before,\n  .zGbnIq_switchThumb {\n    transition: none;\n  }\n}\n\n.zGbnIq_fetchDialog {\n  max-width: 520px;\n\n  \n  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);\n  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);\n}\n\n.zGbnIq_candidateToolbar {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin-bottom: 6px;\n}\n\n.zGbnIq_candidateSearch {\n  min-width: 0;\n  flex: 1 1 240px;\n}\n\n.zGbnIq_candidateList {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  max-height: 320px;\n  margin: 0;\n  overflow-y: auto;\n  padding: 0;\n  list-style: none;\n}\n\n.zGbnIq_candidate {\n  border-radius: 6px;\n}\n\n.zGbnIq_candidateLabel {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 6px 8px;\n  cursor: pointer;\n}\n\n.zGbnIq_candidateId {\n  flex: 1 1 auto;\n  font-family: var(--ds-font-family-code);\n  font-size: 13px;\n  overflow-wrap: anywhere;\n}\n\n.zGbnIq_candidateEmpty {\n  margin: 24px 0;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 13px;\n  line-height: 20px;\n  text-align: center;\n}\n\n\n.zGbnIq_titleRow {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n}\n\n.zGbnIq_modelCatalogHeading {\n  flex: 1;\n}\n\n.zGbnIq_modelRow {\n  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto auto;\n}\n\n.zGbnIq_modelSwitchRow {\n  display: flex;\n  align-items: center;\n  height: 32px;\n}\n\n.zGbnIq_modelEfforts {\n  grid-column: 1 / -1;\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\n.zGbnIq_modelEffortChip {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  height: 24px;\n  padding: 0 8px;\n  border: 0.5px solid var(--dsw-alias-border-l3);\n  border-radius: 6px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n}\n\n.zGbnIq_modelEffortChip:has(input:disabled) {\n  opacity: 0.6;\n  cursor: default;\n}\n\n.zGbnIq_modelEffortChip input {\n  width: 12px;\n  height: 12px;\n  margin: 0;\n  accent-color: var(--dsw-alias-brand-primary);\n}\n\n.zGbnIq_headerSettingsButton {\n  margin-left: auto;\n}\n\n.zGbnIq_headersDialog {\n  width: min(560px, 100%);\n  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);\n  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);\n}\n\n.zGbnIq_headersBody {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.zGbnIq_headerRows {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  max-height: 280px;\n  overflow-y: auto;\n}\n\n.zGbnIq_headerRow {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;\n  align-items: center;\n  gap: 6px;\n}'

const WELCOME_CSS = '.zGbnIqw_copy {\n  font-size: 14px;\n  line-height: 24px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.zGbnIqw_copy p {\n  margin: 0;\n}\n\n.zGbnIqw_copy p + p {\n  margin-top: 12px;\n}\n\n.zGbnIqw_error {\n  margin: 16px 0 0;\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.zGbnIqw_actions {\n  display: flex;\n  justify-content: flex-end;\n  margin-top: 24px;\n}\n\n.zGbnIqw_primary {\n  min-width: 120px;\n}\n\n@media (max-width: 560px) {\n  .zGbnIqw_primary {\n    width: 100%;\n  }\n}'

const ONBOARDING_CSS = '.zGbnIqo_dialog {\n  width: min(600px, 100%);\n  padding: 0;\n}\n\n.zGbnIqo_content {\n  display: flex;\n  flex-direction: column;\n  max-height: calc(100vh - 48px);\n  padding: 28px;\n  box-sizing: border-box;\n  overflow-y: auto;\n}\n\n.zGbnIqo_title {\n  margin: 0;\n  font-size: 20px;\n  line-height: 28px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-primary);\n  outline: none;\n}\n\n.zGbnIqo_body {\n  margin-top: 20px;\n}\n\n@media (max-width: 560px) {\n  .zGbnIqo_content {\n    padding: 24px;\n  }\n}'

const ONBOARDING_DIALOG_CSS = '.zGbnIqd_description {\n  margin: 0;\n  font-size: 14px;\n  line-height: 24px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.zGbnIqd_editor {\n  margin-top: 24px;\n}\n\n@media (max-width: 560px) {\n  .zGbnIqd_editor {\n    margin-top: 20px;\n  }\n}'

export const modelStyles: Record<string, string> = {
  addActions: 'zGbnIq_addActions',
  addBlock: 'zGbnIq_addBlock',
  addButton: 'zGbnIq_addButton',
  addCard: 'zGbnIq_addCard',
  addModelButton: 'zGbnIq_addModelButton',
  advancedHint: 'zGbnIq_advancedHint',
  candidate: 'zGbnIq_candidate',
  candidateEmpty: 'zGbnIq_candidateEmpty',
  candidateId: 'zGbnIq_candidateId',
  candidateLabel: 'zGbnIq_candidateLabel',
  candidateList: 'zGbnIq_candidateList',
  candidateSearch: 'zGbnIq_candidateSearch',
  candidateToolbar: 'zGbnIq_candidateToolbar',
  credentialDot: 'zGbnIq_credentialDot',
  credentialDotConfigured: 'zGbnIq_credentialDotConfigured',
  credentialDotMissing: 'zGbnIq_credentialDotMissing',
  customized: 'zGbnIq_customized',
  customizedBody: 'zGbnIq_customizedBody',
  customizedSummary: 'zGbnIq_customizedSummary',
  dangerButton: 'zGbnIq_dangerButton',
  deleteConfirm: 'zGbnIq_deleteConfirm',
  deleteDialog: 'zGbnIq_deleteDialog',
  editor: 'zGbnIq_editor',
  editorActions: 'zGbnIq_editorActions',
  editorHeader: 'zGbnIq_editorHeader',
  editorRoute: 'zGbnIq_editorRoute',
  editorTitle: 'zGbnIq_editorTitle',
  error: 'zGbnIq_error',
  fetchDialog: 'zGbnIq_fetchDialog',
  field: 'zGbnIq_field',
  fieldLabel: 'zGbnIq_fieldLabel',
  headerRow: 'zGbnIq_headerRow',
  headerRows: 'zGbnIq_headerRows',
  headerSettingsButton: 'zGbnIq_headerSettingsButton',
  headersBody: 'zGbnIq_headersBody',
  headersDialog: 'zGbnIq_headersDialog',
  hiddenLabel: 'zGbnIq_hiddenLabel',
  iconButton: 'zGbnIq_iconButton',
  iconButtonDanger: 'zGbnIq_iconButtonDanger',
  input: 'zGbnIq_input',
  intro: 'zGbnIq_intro',
  linkButton: 'zGbnIq_linkButton',
  modelAdvanced: 'zGbnIq_modelAdvanced',
  modelCatalog: 'zGbnIq_modelCatalog',
  modelCatalogHeading: 'zGbnIq_modelCatalogHeading',
  modelCatalogMeta: 'zGbnIq_modelCatalogMeta',
  modelCatalogTitle: 'zGbnIq_modelCatalogTitle',
  modelEffortChip: 'zGbnIq_modelEffortChip',
  modelEfforts: 'zGbnIq_modelEfforts',
  modelEmpty: 'zGbnIq_modelEmpty',
  modelEntry: 'zGbnIq_modelEntry',
  modelField: 'zGbnIq_modelField',
  modelFieldLabel: 'zGbnIq_modelFieldLabel',
  modelList: 'zGbnIq_modelList',
  modelListHead: 'zGbnIq_modelListHead',
  modelRow: 'zGbnIq_modelRow',
  modelSwitchRow: 'zGbnIq_modelSwitchRow',
  notice: 'zGbnIq_notice',
  primaryButton: 'zGbnIq_primaryButton',
  rowActions: 'zGbnIq_rowActions',
  rowCard: 'zGbnIq_rowCard',
  rowHead: 'zGbnIq_rowHead',
  rowIdentity: 'zGbnIq_rowIdentity',
  rowName: 'zGbnIq_rowName',
  rowTag: 'zGbnIq_rowTag',
  rows: 'zGbnIq_rows',
  savedNotice: 'zGbnIq_savedNotice',
  secondaryButton: 'zGbnIq_secondaryButton',
  section: 'zGbnIq_section',
  selectInput: 'zGbnIq_selectInput',
  setupCard: 'zGbnIq_setupCard',
  switchThumb: 'zGbnIq_switchThumb',
  title: 'zGbnIq_title',
  titleRow: 'zGbnIq_titleRow',
}

export const welcomeStyles: Record<string, string> = {
  actions: 'zGbnIqw_actions',
  copy: 'zGbnIqw_copy',
  error: 'zGbnIqw_error',
  primary: 'zGbnIqw_primary',
}

export const onboardingStyles: Record<string, string> = {
  body: 'zGbnIqo_body',
  content: 'zGbnIqo_content',
  dialog: 'zGbnIqo_dialog',
  title: 'zGbnIqo_title',
}

export const onboardingDialogStyles: Record<string, string> = {
  description: 'zGbnIqd_description',
  editor: 'zGbnIqd_editor',
}

export const modelsStylesNode = c([MODELS_CSS, WELCOME_CSS, ONBOARDING_CSS, ONBOARDING_DIALOG_CSS])
