import { statSync } from 'node:fs'

export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  }
  catch {
    return false
  }
}
