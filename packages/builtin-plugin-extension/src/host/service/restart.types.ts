export type RestartOutcome
  = | { owned: true }
    | { owned: false, pid: number, replacementPid: number | undefined, logOut: string }
