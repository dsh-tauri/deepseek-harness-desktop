import type { SyncPluginItem, SyncPreview, SyncSkillItem, SyncSkillRoot } from '../types/index'
import { DEFAULT_REMOTE_PROFILE } from '../config/constants'
import { shQuote } from '../utils/shell'
import { layoutBinDir, layoutNodeBinary } from './bootstrap.utils'

const FAILURE_TAIL_LINES = 5
const FAILURE_CAUSE_LINES = 2
const FAILURE_CAUSE = /ERR_PNPM_|gyp ERR!|error:|Error:|Error \d|not ok|not found|No such file|Permission denied|exit code|Command failed|ELIFECYCLE/u
const FAILURE_LOG_LINES = 60
const FAILURE_LOG_BYTES = 8000
const BUNDLED_PLUGIN_NAME = /^dsh-tauri(?:-|$)/u

export function classifySpec(spec: string): { syncable: boolean, reason?: string } {
  const value = spec.trim()
  if (value === '')
    return { syncable: false, reason: 'empty dependency spec' }
  if (/^(?:github:|git\+|git@)/u.test(value))
    return { syncable: true }
  if (/^(?:file:|link:|workspace:)/u.test(value))
    return { syncable: false, reason: 'local-path dependency; it cannot be resolved on the remote' }
  if (/^https?:\/\//u.test(value))
    return { syncable: false, reason: 'URL dependencies are not supported' }
  return { syncable: true }
}

export function buildPreview(dependencies: Record<string, string>, skillRoots: ReadonlyArray<{ root: SyncSkillRoot, names: readonly string[] }>): SyncPreview {
  const plugins: SyncPluginItem[] = Object.entries(dependencies)
    .filter(([name]) => !name.startsWith('@deepseek-ai/') && !BUNDLED_PLUGIN_NAME.test(name))
    .map(([name, spec]) => {
      const verdict = classifySpec(spec)
      return {
        name,
        spec,
        syncable: verdict.syncable,
        ...verdict.reason === undefined ? {} : { reason: verdict.reason },
      }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const skills: SyncSkillItem[] = []
  for (const entry of skillRoots) {
    for (const name of [...entry.names].sort())
      skills.push({ name, root: entry.root })
  }
  return { plugins, skills }
}

export function installSpecOf(name: string, spec: string): string {
  const value = spec.trim()
  return /^(?:github:|git\+|git@)/u.test(value) ? value : `${name}@${value}`
}

export function pluginAddCommand(dshEntry: string, target: string, profileName: string = DEFAULT_REMOTE_PROFILE): string {
  return `PATH="${layoutBinDir()}:$PATH" ${layoutNodeBinary()} ${shQuote(dshEntry)} plugin --profile ${shQuote(profileName)} add ${shQuote(target)}`
}

export function skillExtractCommand(names: readonly string[]): string {
  return [
    'set -eu',
    'dest="$HOME/.dsh/skills"',
    'lock="$HOME/.dsh/.skills-sync.lock"',
    'mkdir -p "$dest"',
    'if ! mkdir "$lock" 2>/dev/null; then',
    '  printf "Another skill sync is active, or the sync lock is unavailable: %s\\n" "$lock" >&2',
    '  exit 1',
    'fi',
    'stage=',
    'current=',
    'backup=',
    'cleanup() {',
    '  status=$?',
    '  trap - EXIT HUP INT TERM',
    '  if [ -n "$backup" ] && { [ -e "$backup" ] || [ -L "$backup" ]; }; then',
    '    if [ -e "$current" ] || [ -L "$current" ] || ! mv "$backup" "$current"; then',
    '      printf "Skill replacement failed; previous files remain at %s\\n" "$backup" >&2',
    '      rmdir "$lock"',
    '      exit 1',
    '    fi',
    '  fi',
    '  if [ -n "$stage" ] && ! rm -rf "$stage"; then status=1; fi',
    '  if ! rmdir "$lock"; then status=1; fi',
    '  exit "$status"',
    '}',
    'trap cleanup EXIT',
    'trap \'exit 129\' HUP',
    'trap \'exit 130\' INT',
    'trap \'exit 143\' TERM',
    'stage=$(mktemp -d "$dest/.dsh-sync.XXXXXX")',
    'mkdir "$stage/incoming" "$stage/previous"',
    'tar -xf - -C "$stage/incoming"',
    `set -- ${names.map(shQuote).join(' ')}`,
    'for name do',
    '  if [ ! -d "$stage/incoming/$name" ] || [ -L "$stage/incoming/$name" ] || [ ! -f "$stage/incoming/$name/SKILL.md" ]; then',
    '    printf "Missing skill directory in archive: %s\\n" "$name" >&2',
    '    exit 1',
    '  fi',
    'done',
    'for name do',
    '  current="$dest/$name"',
    '  backup="$stage/previous/$name"',
    '  if [ -e "$current" ] || [ -L "$current" ]; then mv "$current" "$backup"; fi',
    '  mv "$stage/incoming/$name" "$current"',
    '  current=',
    '  backup=',
    'done',
  ].join('\n')
}

export function describeFailure(code: number | null, stdout: string, stderr: string): string {
  const lines = outputLines(stdout, stderr)
  const causes = lines.filter(line => FAILURE_CAUSE.test(line)).slice(0, FAILURE_CAUSE_LINES)
  const picked = causes.length > 0 ? causes : lines.slice(-FAILURE_TAIL_LINES)
  const parts = picked.map(line => (line.length > 300 ? `${line.slice(0, 300)}…` : line))
  return `exit ${code ?? '?'}${parts.length === 0 ? '' : `: ${parts.join(' | ')}`}`
}

export function failureLogOf(stdout: string, stderr: string): string | undefined {
  const lines = outputLines(stdout, stderr)
  if (lines.length === 0)
    return undefined
  const kept = lines.slice(-FAILURE_LOG_LINES).join('\n')
  return kept.length > FAILURE_LOG_BYTES ? kept.slice(-FAILURE_LOG_BYTES) : kept
}

export function dedupeBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key))
      continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function outputLines(stdout: string, stderr: string): string[] {
  return `${stdout}\n${stderr}`.split('\n').map(line => line.trim()).filter(line => line !== '')
}
