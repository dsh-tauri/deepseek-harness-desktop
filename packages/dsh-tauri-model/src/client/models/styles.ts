import { cssr } from 'dsh-tauri-ui/client'

const { c } = cssr

const MODELS_CSS = `.zGbnIq_section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}

.zGbnIq_title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.zGbnIq_intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}

.zGbnIq_notice {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-warn-label);
}

.zGbnIq_savedNotice {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-success-primary);
}

.zGbnIq_rows {
  list-style: none;

  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.zGbnIq_rowCard {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.zGbnIq_rowHead {
  display: flex;
  align-items: center;
  gap: 10px;
}

.zGbnIq_rowIdentity {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.zGbnIq_rowName {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.zGbnIq_rowTag {
  flex: none;
  padding: 1px 6px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xs);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}

.zGbnIq_credentialDot {
  box-sizing: border-box;
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  corner-shape: round;
}

.zGbnIq_credentialDotConfigured {
  background: var(--dsw-alias-state-success-primary);
}

.zGbnIq_credentialDotMissing {
  background: var(--dsw-alias-state-error-primary);
}

.zGbnIq_rowActions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.zGbnIq_primaryButton,
.zGbnIq_secondaryButton,
.zGbnIq_addButton {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-md);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}

.zGbnIq_primaryButton {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}

.zGbnIq_primaryButton:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}

.zGbnIq_secondaryButton,
.zGbnIq_addButton {
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: transparent;
  color: var(--dsw-alias-label-primary);
}

.zGbnIq_secondaryButton:hover:not(:disabled),
.zGbnIq_addButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.zGbnIq_secondaryButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}

.zGbnIq_dangerButton {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}

.zGbnIq_dangerButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

.zGbnIq_rowActions .zGbnIq_secondaryButton,
.zGbnIq_rowActions .zGbnIq_dangerButton {
  height: 28px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm);
  font-size: 12px;
  line-height: 18px;
}

.zGbnIq_primaryButton:disabled,
.zGbnIq_secondaryButton:disabled,
.zGbnIq_dangerButton:disabled,
.zGbnIq_addButton:disabled,
.zGbnIq_linkButton:disabled,
.zGbnIq_addModelButton:disabled {
  opacity: 0.4;
  cursor: default;
}

.zGbnIq_primaryButton:focus-visible,
.zGbnIq_secondaryButton:focus-visible,
.zGbnIq_dangerButton:focus-visible,
.zGbnIq_addButton:focus-visible,
.zGbnIq_linkButton:focus-visible,
.zGbnIq_addModelButton:focus-visible,
.zGbnIq_iconButton:focus-visible,
.zGbnIq_customizedSummary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}

.zGbnIq_editor {
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.zGbnIq_editorHeader {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.zGbnIq_editorTitle {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.zGbnIq_editorRoute {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.zGbnIq_field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.zGbnIq_fieldLabel {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

.zGbnIq_linkButton {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.zGbnIq_linkButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}

.zGbnIq_advancedHint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.zGbnIq_editorActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.zGbnIq_addBlock {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.zGbnIq_addActions {
  display: flex;
}

.zGbnIq_addButton {

  flex: 1 1 0;
  min-width: 180px;
  gap: 6px;
  height: 44px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
}

.zGbnIq_addModes {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.zGbnIq_addPanel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.zGbnIq_addPanel[hidden] {
  display: none;
}

.zGbnIq_addCard,
.zGbnIq_setupCard {
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  list-style: none;
}

.zGbnIq_addCard .zGbnIq_editor,
.zGbnIq_setupCard .zGbnIq_editor {
  background: none;
  padding: 0;
}

.zGbnIq_customized {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  padding-top: 10px;
}

.zGbnIq_customizedSummary {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  padding: 2px 4px;
  margin-left: -4px;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  list-style: none;
}

.zGbnIq_customizedSummary::-webkit-details-marker {
  display: none;
}

.zGbnIq_customizedSummary::before {
  content: '';
  width: 5px;
  height: 5px;
  border-right: 1.5px solid currentcolor;
  border-bottom: 1.5px solid currentcolor;
  transform: rotate(-45deg) translate(-1px, -1px);
  transition: transform 120ms ease;
}

.zGbnIq_customized[open] > .zGbnIq_customizedSummary::before {
  transform: rotate(45deg) translate(-1px, -1px);
}

.zGbnIq_customizedSummary:hover {
  color: var(--dsw-alias-label-primary);
}

.zGbnIq_customizedBody {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
}

.zGbnIq_modelCatalog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

.zGbnIq_modelCatalogHeading {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.zGbnIq_modelCatalogTitle {
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

.zGbnIq_modelCatalogMeta,
.zGbnIq_modelEmpty {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.zGbnIq_modelList {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.zGbnIq_modelListHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.zGbnIq_modelEntry {
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-lg);
  padding: 6px;
}

.zGbnIq_modelRow {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
}

.zGbnIq_iconButton {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

.zGbnIq_iconButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.zGbnIq_iconButton:disabled {
  cursor: default;
  opacity: 0.4;
}

.zGbnIq_iconButtonDanger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.zGbnIq_modelAdvanced {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 8px 4px 2px;
}

.zGbnIq_modelField {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 4px;
}

.zGbnIq_modelInputTypes {
  grid-column: 1 / -1;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
}

.zGbnIq_modelInputTypes legend {
  padding: 0;
  margin-bottom: 4px;
}

.zGbnIq_modelInputChoices {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  min-height: 32px;
  align-items: center;
}

.zGbnIq_modelFieldLabel {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.zGbnIq_modelEmpty {
  padding: 12px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
  text-align: center;
}

.zGbnIq_addModelButton {
  box-sizing: border-box;
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.zGbnIq_addModelButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.zGbnIq_input {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}

select.zGbnIq_input {
  max-width: 240px;
  cursor: pointer;
}

.zGbnIq_input:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}

.zGbnIq_input::placeholder {
  color: var(--dsw-alias-label-dimmed);
}

.zGbnIq_input:disabled {
  opacity: 0.6;
  cursor: default;
}

.zGbnIq_selectInput {
  appearance: none;
  padding-right: 32px;

  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  background-size: 12px 12px;
}

.zGbnIq_headersInput {
  box-sizing: border-box;
  width: 100%;
  min-height: 64px;
  padding: 6px 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  font: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 20px;
  resize: vertical;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}

.zGbnIq_headersInput:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}

.zGbnIq_headersInput::placeholder {
  color: var(--dsw-alias-label-dimmed);
}

.zGbnIq_headersInput:disabled {
  opacity: 0.6;
  cursor: default;
}

.zGbnIq_error {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}

.zGbnIq_deleteDialog {
  width: min(480px, 100%);
}

.zGbnIq_deleteConfirm:not(:disabled) {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

.zGbnIq_deleteConfirm:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

.zGbnIq_hiddenLabel {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .zGbnIq_customizedSummary::before,
  .zGbnIq_switchThumb {
    transition: none;
  }
}

.zGbnIq_fetchDialog {
  max-width: 520px;

  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}

.zGbnIq_candidateToolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.zGbnIq_candidateSearch {
  min-width: 0;
  flex: 1 1 240px;
}

.zGbnIq_candidateList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  margin: 0;
  overflow-y: auto;
  padding: 0;
  list-style: none;
}

.zGbnIq_candidate {
  border-radius: var(--dsw-radius-md);
}

.zGbnIq_candidateActive {
  background: var(--dsw-alias-interactive-bg-hover);
}

.zGbnIq_candidateLabel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
}

.zGbnIq_candidateId {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--ds-font-family-code);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

.zGbnIq_candidateEmpty {
  margin: 24px 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
}`

const WELCOME_CSS = `.zGbnIqw_copy {
  font-size: 14px;
  line-height: 24px;
  color: var(--dsw-alias-label-secondary);
}

.zGbnIqw_copy p {
  margin: 0;
}

.zGbnIqw_copy p + p {
  margin-top: 12px;
}

.zGbnIqw_error {
  margin: 16px 0 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-state-error-primary);
}

.zGbnIqw_actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 24px;
}

.zGbnIqw_primary {
  min-width: 120px;
}

@media (max-width: 560px) {
  .zGbnIqw_primary {
    width: 100%;
  }
}`

const ONBOARDING_CSS = `.zGbnIqo_dialog {
  width: min(600px, 100%);
  max-height: 100%;
  padding: 0;
}

.zGbnIqo_content {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 28px;
  box-sizing: border-box;
  overflow-y: auto;
}

.zGbnIqo_title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  outline: none;
}

.zGbnIqo_body {
  margin-top: 20px;
}

@media (max-width: 560px) {
  .zGbnIqo_content {
    padding: 24px;
  }
}`

const ONBOARDING_DIALOG_CSS = `.zGbnIqd_description {
  margin: 0;
  font-size: 14px;
  line-height: 24px;
  color: var(--dsw-alias-label-secondary);
}

.zGbnIqd_editor {
  margin-top: 24px;
}

@media (max-width: 560px) {
  .zGbnIqd_editor {
    margin-top: 20px;
  }
}`

export const modelStyles: Record<string, string> = Object.fromEntries([...MODELS_CSS.matchAll(/\.(zGbnIq_(\w+))/g)].map(([, className, key]) => [key, className]))
export const welcomeStyles: Record<string, string> = Object.fromEntries([...WELCOME_CSS.matchAll(/\.(zGbnIqw_(\w+))/g)].map(([, className, key]) => [key, className]))
export const onboardingStyles: Record<string, string> = Object.fromEntries([...ONBOARDING_CSS.matchAll(/\.(zGbnIqo_(\w+))/g)].map(([, className, key]) => [key, className]))
export const onboardingDialogStyles: Record<string, string> = Object.fromEntries([...ONBOARDING_DIALOG_CSS.matchAll(/\.(zGbnIqd_(\w+))/g)].map(([, className, key]) => [key, className]))

export const modelsStylesNode = c([MODELS_CSS, WELCOME_CSS, ONBOARDING_CSS, ONBOARDING_DIALOG_CSS])
