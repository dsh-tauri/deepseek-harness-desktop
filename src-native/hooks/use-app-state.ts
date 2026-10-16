import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

function subscribe(onChange: () => void): () => void {
  const subscription = AppState.addEventListener('change', onChange)
  return () => subscription.remove()
}

function snapshot() {
  return AppState.currentState
}

export function useAppState() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
