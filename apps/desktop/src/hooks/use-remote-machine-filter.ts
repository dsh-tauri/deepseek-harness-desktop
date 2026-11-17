import type { Dispatch, SetStateAction } from 'react'
import type { RemoteMachineRow } from './use-remote'
import { useWatch } from '@reause/core'
import { useState } from 'react'

export function useRemoteMachineFilter(machines: RemoteMachineRow[]): [string, Dispatch<SetStateAction<string>>] {
  const [selectedId, setSelectedId] = useState('')

  useWatch([machines, selectedId], () => {
    if (selectedId !== '' && !machines.some(machine => machine.id === selectedId))
      setSelectedId('')
  })

  return [selectedId, setSelectedId]
}
