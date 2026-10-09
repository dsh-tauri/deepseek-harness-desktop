import type { GetApiDesktopDshTauriExperimentalLiveResponse, GetApiDesktopDshTauriExperimentalSummaryResponse } from '../apis/index.type'

export type LiveSnapshot = Exclude<GetApiDesktopDshTauriExperimentalLiveResponse, { error: string }>
type SummaryPayload = Exclude<GetApiDesktopDshTauriExperimentalSummaryResponse, { error: string }>
export type TurnFileChange = SummaryPayload['turns'][number]['files'][number]
export type TurnFileStatus = TurnFileChange['status']

export interface TurnSummary extends Omit<SummaryPayload['turns'][number], 'hasBaseline'> {
  hasBaseline?: boolean
}

export interface SessionSummary extends Omit<SummaryPayload, 'turns'> {
  turns: TurnSummary[]
}

export type LocaleKey
  = | 'runningChanged'
    | 'binary'
    | 'pasteChip'
    | 'pasteChipTitled'
