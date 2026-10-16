const BOOT_MARKER = /globalThis\[(['"])__DSH_BOOT__\1\]\s*=\s*/u

export function clientUrlsFromBootHtml(port: number, html: string): string[] | undefined {
  const marker = BOOT_MARKER.exec(html)
  if (marker === null)
    return undefined
  const start = marker.index + marker[0].length
  const end = html.indexOf('</script>', start)
  if (end < 0)
    return undefined
  const json = html.slice(start, end).trim().replace(/;$/u, '').trim()
  let boot: unknown
  try {
    boot = JSON.parse(json)
  }
  catch {
    return undefined
  }
  const entries = (boot as { entries?: unknown }).entries
  if (!Array.isArray(entries))
    return undefined
  const paths: string[] = []
  for (const script of html.split('<script').slice(1)) {
    const srcStart = script.indexOf('src="')
    if (srcStart < 0)
      continue
    const rest = script.slice(srcStart + 5)
    const srcEnd = rest.indexOf('"')
    if (srcEnd < 0)
      continue
    const src = decodeHtmlAttribute(rest.slice(0, srcEnd))
    if (isClientBundlePath(src))
      paths.push(normalizeClientBundlePath(src))
  }
  for (const entry of entries) {
    const url = (entry as { url?: unknown }).url
    if (typeof url !== 'string')
      continue
    const decoded = decodeHtmlAttribute(url)
    if (isClientBundlePath(decoded))
      paths.push(normalizeClientBundlePath(decoded))
  }
  const unique = [...new Set(paths)].sort()
  if (unique.length === 0)
    return undefined
  return unique.map(path => `http://127.0.0.1:${port}${path}`)
}

export function looksLikePluginBundle(okStatus: boolean, body: string): boolean {
  if (!okStatus)
    return false
  const trimmed = body.trimStart()
  if (trimmed === '')
    return false
  const lower = trimmed.slice(0, 32).toLowerCase()
  return !lower.startsWith('<!doctype') && !lower.startsWith('<html')
}

export function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '\"')
    .replaceAll('&#39;', '\'')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function trimRelativePrefix(path: string): string {
  let rest = path
  while (rest.startsWith('./'))
    rest = rest.slice(2)
  return rest
}

function normalizeClientBundlePath(path: string): string {
  return `/${trimRelativePrefix(path).replace(/^\/+/u, '')}`
}

export function isClientBundlePath(path: string): boolean {
  const normalized = trimRelativePrefix(path)
  if (normalized.startsWith('//'))
    return false
  return (normalized.startsWith('/plugins/') || normalized.startsWith('plugins/'))
    && normalized.includes('client.js')
}
