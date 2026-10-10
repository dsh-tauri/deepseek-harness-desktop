import type { BackendDetection } from '../../shared/types'

export const KERNEL_CORE_BASELINE = '0.2.1-alpha.2'

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  pre: (string | number)[]
}

function parse(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\d.a-z-]+))?(?:\+[\d.a-z-]+)?$/i.exec(version.trim())
  if (match === null)
    return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.').map(part => /^\d+$/.test(part) ? Number(part) : part),
  }
}

function comparePrerelease(left: (string | number)[], right: (string | number)[]): number {
  if (left.length === 0 || right.length === 0)
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index]
    const b = right[index]
    if (a === undefined)
      return -1
    if (b === undefined)
      return 1
    if (a === b)
      continue
    if (typeof a === 'number' && typeof b === 'number')
      return a < b ? -1 : 1
    if (typeof a === 'number')
      return -1
    if (typeof b === 'number')
      return 1
    return a < b ? -1 : 1
  }
  return 0
}

export function kernelVersionAtLeast(version: string | null | undefined, baseline: string = KERNEL_CORE_BASELINE): boolean | undefined {
  if (typeof version !== 'string' || version.trim() === '')
    return undefined
  const left = parse(version)
  const right = parse(baseline)
  if (left === null || right === null)
    return undefined
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key])
      return left[key] > right[key]
  }
  return comparePrerelease(left.pre, right.pre) >= 0
}

export function kernelContentAvailable(backends: readonly BackendDetection[]): boolean {
  const verdict = kernelVersionAtLeast(backends.find(backend => backend.id === 'dsh')?.version)
  if (verdict !== undefined)
    return verdict
  return backends.some(backend => backend.id !== 'dsh' && backend.bridgeReady !== false)
}
