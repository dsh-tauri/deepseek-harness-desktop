/**
 * Boot-HTML readiness parsing, ported from the retired Rust engine's
 * `client_urls_from_boot_html` (`service/workflow/utils.rs`): the remote
 * instance's readiness verdict comes from the `__DSH_BOOT__` client manifest
 * embedded in its served HTML — a real manifest proves the actual dsh web
 * server is up with its plugin bundles mounted, where a bare "some HTTP
 * server answered" probe (the legacy fallback) cannot.
 * @module dsh-tauri-ssh/host/service/boot-html
 */

/** The boot-manifest assignment marker inside the served HTML. */
const BOOT_MARKER = /globalThis\[(['"])__DSH_BOOT__\1\]\s*=\s*/u

/**
 * Extract the client-bundle URLs from one served boot HTML document. Both
 * collection axes of the blueprint are honored: the `entries[].url` graph of
 * the `__DSH_BOOT__` manifest and the `<script src>` attributes (the preload
 * script does not always repeat in entries), deduped and sorted.
 * @param port - the remote instance's loopback port.
 * @param html - the HTML the root probe received.
 * @returns the absolute loopback URLs, or undefined when the document is not
 * a dsh boot page (marker missing, malformed manifest JSON, no entries
 * array, or no same-origin client-bundle paths at all).
 */
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

/**
 * Whether a probe response body is a plugin bundle (not the SPA fallback):
 * unknown `/plugins/...` paths get rewritten to `index.html` with HTTP 200,
 * so an HTML-looking body must not count as a served bundle.
 * @param okStatus - whether the HTTP exchange itself succeeded (2xx).
 * @param body - the response body.
 */
export function looksLikePluginBundle(okStatus: boolean, body: string): boolean {
  if (!okStatus)
    return false
  const trimmed = body.trimStart()
  if (trimmed === '')
    return false
  const lower = trimmed.slice(0, 32).toLowerCase()
  return !lower.startsWith('<!doctype') && !lower.startsWith('<html')
}

/**
 * Restore the limited named entities boot HTML attributes/JSON carry (the
 * combo route's `&rev=` arrives as `&amp;rev=`).
 * @param value - the raw attribute value.
 */
export function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '\"')
    .replaceAll('&#39;', '\'')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

/**
 * Drop the leading `./` segments a relative bundle path carries.
 * @param path - the raw path.
 */
function trimRelativePrefix(path: string): string {
  let rest = path
  while (rest.startsWith('./'))
    rest = rest.slice(2)
  return rest
}

/**
 * The canonical same-origin `/plugins/...` form. From 0.1.7 the kernel boot
 * page injects `<base href="./">`, so the same bundle addresses appear in the
 * HTML as **relative** paths (`plugins/...`, `./plugins/...`); accepting only
 * the absolute form makes the parse fall through to the hardcoded probe. Both
 * forms converge here, so dedupe and sort run on one set of addresses.
 * @param path - an accepted client-bundle path.
 */
function normalizeClientBundlePath(path: string): string {
  return `/${trimRelativePrefix(path).replace(/^\/+/u, '')}`
}

/**
 * Whether a path is a same-origin client-bundle path: under `/plugins/`,
 * naming `client.js` (the combo route's `/plugins/??<pkg>/client.js&rev=…`
 * included), never protocol-relative or foreign. Both the absolute form and
 * the relative form a 0.1.7+ boot page serves are accepted.
 * @param path - the candidate path.
 */
export function isClientBundlePath(path: string): boolean {
  const normalized = trimRelativePrefix(path)
  if (normalized.startsWith('//'))
    return false
  return (normalized.startsWith('/plugins/') || normalized.startsWith('plugins/'))
    && normalized.includes('client.js')
}
