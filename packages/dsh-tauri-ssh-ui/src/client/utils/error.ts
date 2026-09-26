import type { SshKey } from '../locales/index'
import { isTransportError } from '../store/index'

/**
 * One operator-facing failure line: a transport code (route missing, empty
 * body) reads as the localized "service unavailable" notice instead of a raw
 * `SSH_API_*` code; host-provided prose renders verbatim.
 * @param message - the stored failure text.
 * @param t - the bound dictionary lookup.
 */
export function errorTextOf(message: string, t: (key: SshKey) => string): string {
  return isTransportError(message) ? t('error.unavailable') : message
}
