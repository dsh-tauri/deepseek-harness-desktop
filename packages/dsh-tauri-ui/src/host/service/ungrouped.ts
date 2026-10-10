import { defineService, resolveUngroupedSessionPath } from 'dsh-tauri'

export const ungrouped = defineService({
  resolve(): string {
    return resolveUngroupedSessionPath()
  },
})
