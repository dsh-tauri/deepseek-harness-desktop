import { remotePidfile } from '../config/constants'

export function remoteInstanceStopCommand(profileName: string, remotePort: number): string[] {
  const pidfile = `$HOME/${remotePidfile(profileName, remotePort)}`
  return [
    `PROFILE="${profileName}"`,
    `PORT="${remotePort}"`,
    'ARGV="bin.js --profile $PROFILE --host 127.0.0.1 --port $PORT"',
    'PATTERN="$ARGV( |$)"',
    `if [ -f "${pidfile}" ]; then`,
    `  OLD_PID="$(cat "${pidfile}" 2>/dev/null || true)"`,
    '  case "$OLD_PID" in',
    '    "" | *[!0-9]*) ;;',
    '    *)',
    '      OLD_ARGS="$(ps -p "$OLD_PID" -o args= 2>/dev/null || true)"',
    '      if [ -z "$OLD_ARGS" ] || printf \'%s\' "$OLD_ARGS" | grep -Eq "$PATTERN"; then',
    '        kill "$OLD_PID" 2>/dev/null || true',
    '      fi',
    '      ;;',
    '  esac',
    'fi',
    'pkill -f "$PATTERN" 2>/dev/null || true',
  ]
}
