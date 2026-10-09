export function shQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

export function loginShell(command: string): string {
  return `sh -lc ${shQuote(command)}`
}
