import type { ConversationTurnDataMap, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '../locales/index.types'
import type { ScheduleTurnData, ScheduleTurnOwner } from '../service/schedule-turn'
import type { TaskView } from '../types'

export const ambientTranslate: Translate = (key, params) => {
  const value = params?.name ?? params?.count
  return value === undefined ? key : `${key}:${value}`
}

export function ambientTask(id: string, changes: Partial<TaskView> = {}): TaskView {
  return {
    id,
    name: `Task ${id}`,
    prompt: 'Reminder',
    delivery: 'this-session',
    status: 'active',
    sessionId: 'owner',
    enabled: true,
    schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...changes,
  }
}

export function ambientTurn(tasks: readonly TaskView[], cursor = Number.POSITIVE_INFINITY): ScheduleTurnOwner {
  const data: ScheduleTurnData = { created: tasks.map((task, index) => ({ seq: 4 + index * 4, time: 1700000000000 + index, callId: `call-${task.id}`, task })) }
  const values: Partial<ConversationTurnDataMap> = { 'schedule-created': data }
  const turn: TurnLocation = {
    turn: 3,
    status: 'open',
    steps: [],
    start: undefined,
    end: undefined,
    data: { get: key => values[key], source: key => ({ getSnapshot: () => values[key], subscribe: () => () => {} }) },
  }
  return { turn, seq: cursor, openFile: () => {} }
}

export async function ambientClientFacade() {
  return {
    ...await import('../../../../dsh-tauri/src/client/modules/valtio-define'),
    ...await import('../../../../dsh-tauri/src/client/modules/reause'),
    ...await import('../../../../dsh-tauri/src/client/modules/date-fns'),
    ...await import('../../../../dsh-tauri/src/client/modules/tailwind-variants'),
  }
}

export async function ambientUiFacade() {
  return {
    ...await import('../../../../dsh-tauri-ui/src/client/components/action'),
    ...await import('../../../../dsh-tauri-ui/src/client/components/button'),
    ...await import('../../../../dsh-tauri-ui/src/client/components/card'),
    ...await import('../../../../dsh-tauri-ui/src/client/components/icon'),
    ...await import('../../../../dsh-tauri-ui/src/client/components/icons'),
    ...await import('./ambient-test.ui').then(ui => ({ Menu: ui.AmbientMenu, Modal: ui.AmbientModal, Toast: ui.AmbientToast })),
  }
}
