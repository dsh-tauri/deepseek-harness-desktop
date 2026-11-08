export interface LaunchSpec {
  file: string
  args: string[]
  cwd: string | undefined
  viaShell: boolean
}

export interface RestartOutcome {
  pid: number
  replacementPid: number | undefined
  logOut: string
}
