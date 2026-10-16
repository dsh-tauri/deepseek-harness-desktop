export interface HostKeyRecord {
  machineId: string
  fingerprint: string
}

export type HostKeyVerdict = 'accepted' | 'unknown' | 'mismatch'
