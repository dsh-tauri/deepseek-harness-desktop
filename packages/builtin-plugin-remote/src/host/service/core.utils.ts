import { REMOTE_ROOT } from '../config/constants'

const COPY_MARKER = '__DSH_COPY__'
const DIR_MARKER = '__DSH_DIR__'
const ENTRY_MARKER = '__DSH_ENTRY__'
const PKG_BEGIN = '__DSH_PKG_BEGIN__'
const PKG_END = '__DSH_PKG_END__'

const DSH_ZIP_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const DSH_NPM_ENTRY = 'lib/bin.js'

/** 远端机器上的核心副本：当前使用的那份叫 `dsh`，其余按版本标识分目录存放。 */
export interface RemoteCoreCopy {
  name: string
  dir: string
  entry?: string
  version?: string
  unreadable?: string
}

export function remoteCopiesProbeCommand(): string {
  return [
    `ROOT="$HOME/${REMOTE_ROOT}"`,
    'DEPS="$ROOT/dependencies"',
    '[ -d "$DEPS" ] || exit 0',
    'for dir in "$DEPS"/*; do',
    '  [ -d "$dir" ] || continue',
    '  name="$(basename "$dir")"',
    '  case "$name" in',
    '    *.new|*.new.*|*.ready|*.ready.*) continue ;;',
    '    dsh|dsh-*|src-*) ;;',
    '    *) continue ;;',
    '  esac',
    '  pkg=""',
    '  entry=""',
    `  if [ -f "$dir/${DSH_ZIP_ENTRY}" ]; then`,
    `    entry="$dir/${DSH_ZIP_ENTRY}"`,
    `    pkg="$dir/node_modules/@deepseek-ai/dsh/package.json"`,
    `  elif [ -f "$dir/${DSH_NPM_ENTRY}" ]; then`,
    `    entry="$dir/${DSH_NPM_ENTRY}"`,
    '    pkg="$dir/package.json"',
    '  fi',
    '  [ -n "$entry" ] || continue',
    `  printf '${COPY_MARKER}%s\\n' "$name"`,
    `  printf '${DIR_MARKER}%s\\n' "$dir"`,
    `  printf '${ENTRY_MARKER}%s\\n' "$entry"`,
    `  printf '${PKG_BEGIN}\\n'`,
    '  if [ -n "$pkg" ]; then cat "$pkg"; fi',
    `  printf '\\n${PKG_END}\\n'`,
    'done',
    'true',
  ].join('\n')
}

export function parseRemoteCopies(stdout: string): RemoteCoreCopy[] {
  const copies: RemoteCoreCopy[] = []
  let current: { name: string, dir: string, entry: string, pkg: string[] } | undefined
  let inPackage = false
  for (const line of stdout.split('\n')) {
    if (line.startsWith(COPY_MARKER)) {
      if (current !== undefined)
        copies.push(finishCopy(current))
      current = { name: line.slice(COPY_MARKER.length).trim(), dir: '', entry: '', pkg: [] }
      inPackage = false
      continue
    }
    if (current === undefined)
      continue
    if (line.startsWith(DIR_MARKER)) {
      current.dir = line.slice(DIR_MARKER.length).trim()
      continue
    }
    if (line.startsWith(ENTRY_MARKER)) {
      current.entry = line.slice(ENTRY_MARKER.length).trim()
      continue
    }
    if (line === PKG_BEGIN) {
      inPackage = true
      continue
    }
    if (line === PKG_END) {
      inPackage = false
      continue
    }
    if (inPackage)
      current.pkg.push(line)
  }
  if (current !== undefined)
    copies.push(finishCopy(current))
  return copies
}

function finishCopy(raw: { name: string, dir: string, entry: string, pkg: string[] }): RemoteCoreCopy {
  const copy: RemoteCoreCopy = {
    name: raw.name,
    dir: raw.dir,
    ...raw.entry === '' ? {} : { entry: raw.entry },
  }
  const text = raw.pkg.join('\n').trim()
  if (text === '')
    return { ...copy, unreadable: 'REMOTE_DSH_PACKAGE_UNREADABLE: 副本缺少包元数据' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return { ...copy, unreadable: 'REMOTE_DSH_PACKAGE_INVALID: 包元数据无法解析' }
  }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string' || parsed.version === '')
    return { ...copy, unreadable: 'REMOTE_DSH_PACKAGE_INVALID: 包元数据缺少版本号' }
  return { ...copy, version: parsed.version }
}
