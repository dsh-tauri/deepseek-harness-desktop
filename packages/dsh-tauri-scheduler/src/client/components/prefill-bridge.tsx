import { useStore, useWatchImmediate } from 'dsh-tauri/client'
import { store } from '../store'
import { applyPrefillToComposer } from './prefill-bridge.utils'

interface PrefillBridgeProps {
  inputActions?: { setDraft: (text: string) => void }
}

export function PrefillBridge({ inputActions }: PrefillBridgeProps): null {
  const { pending } = useStore(store.prefill)

  useWatchImmediate([pending, inputActions], () => {
    if (pending === '')
      return
    if (inputActions !== undefined) {
      inputActions.setDraft(pending)
      store.prefill.clear()
      return
    }
    if (applyPrefillToComposer(pending))
      store.prefill.clear()
  })

  return null
}
