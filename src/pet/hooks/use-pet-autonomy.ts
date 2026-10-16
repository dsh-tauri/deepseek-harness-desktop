import type { PetRef } from 'dsh-pet-component'
import { useIntervalFn, useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useRef } from 'react'
import { reportPetIssue } from '../utils/log'

export function usePetAutonomy(pet: PetRef, enabled: boolean, isBusy: () => boolean): void {
  const pendingRef = useRef(false)
  const retryAtRef = useRef(0)
  const currentRef = useRef({ enabled, isBusy })
  currentRef.current = { enabled, isBusy }

  const timer = useIntervalFn(() => {
    void step()
  }, 50, { immediate: false })
  useWatch(enabled, (active) => {
    if (active)
      timer.resume()
    else
      timer.pause()
    void step()
  }, { immediate: true })

  async function step(): Promise<void> {
    if (pendingRef.current || Date.now() < retryAtRef.current)
      return
    pendingRef.current = true
    try {
      const geometry = pet.geometry
      await invoke('step_pet_autonomy', {
        body: geometry?.body ?? null,
        paused: !currentRef.current.enabled || currentRef.current.isBusy(),
      })
    }
    catch (error) {
      retryAtRef.current = Date.now() + 20_000
      reportPetIssue('autonomy', error)
    }
    finally {
      pendingRef.current = false
    }
  }
}
