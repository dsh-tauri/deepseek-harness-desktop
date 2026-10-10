import type { ReactElement } from 'react'
import type { BackendId } from '../../shared/types'
import { ClaudeIcon, FishLogo, GptIcon } from 'dsh-tauri-ui/client'
import { If } from 'dsh-tauri/client'

export function KernelIcon({ backend }: { backend: BackendId | undefined }): ReactElement {
  return (
    <>
      <If cond={backend === 'codex'} then={<GptIcon />} />
      <If cond={backend === 'claude'} then={<ClaudeIcon />} />
      <If cond={backend === 'dsh'} then={<FishLogo size={16} />} />
    </>
  )
}
