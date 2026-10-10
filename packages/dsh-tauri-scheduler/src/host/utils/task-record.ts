import type { SchedulerTask } from '../types'
import { isEqual, omit } from 'lodash-es'

export function sameTaskRecord(current: SchedulerTask | null, expected: SchedulerTask): boolean {
  try {
    return current !== null && isEqual(JSON.parse(JSON.stringify(omit(current, 'waiting'))), JSON.parse(JSON.stringify(omit(expected, 'waiting'))))
  }
  catch {
    return false
  }
}
