import { describe, expect, it } from 'vitest'
import { clientUrlsFromBootHtml, decodeHtmlAttribute, isClientBundlePath, looksLikePluginBundle } from './boot-html'

/** A realistic rc-line boot page: combo preload script + entries graph. */
const BOOT_HTML = [
  '<!doctype html><html><head>',
  '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=cddf5581d5d5"></script>',
  '</head><body><div id="root"></div><script>',
  'globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/@deepseek-ai/dsh-client-ui-layout/client.js"},{"url":"/plugins/@deepseek-ai/dsh-client-modules/client.js"}]};',
  '</script></body></html>',
].join('')

describe('clientUrlsFromBootHtml', () => {
  it('parses a normal boot graph into sorted, deduped loopback bundle URLs', () => {
    const urls = clientUrlsFromBootHtml(3099, BOOT_HTML)
    expect(urls).toBeDefined()
    expect(urls).toEqual([
      'http://127.0.0.1:3099/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=cddf5581d5d5',
      'http://127.0.0.1:3099/plugins/@deepseek-ai/dsh-client-modules/client.js',
      'http://127.0.0.1:3099/plugins/@deepseek-ai/dsh-client-ui-layout/client.js',
    ])
  })

  it('decodes the combo attribute URL before use (&amp;rev= → &rev=)', () => {
    const html = '<script src="/plugins/??pkg/client.js&amp;rev=1"></script><script>globalThis["__DSH_BOOT__"] = {"entries":[]}</script>'
    expect(clientUrlsFromBootHtml(3081, html)).toEqual([
      'http://127.0.0.1:3081/plugins/??pkg/client.js&rev=1',
    ])
  })

  it('returns undefined when the marker is missing (not a dsh boot page)', () => {
    expect(clientUrlsFromBootHtml(3080, '<html><body>plain</body></html>')).toBeUndefined()
    expect(clientUrlsFromBootHtml(3080, '')).toBeUndefined()
  })

  it('returns undefined for malformed manifest JSON', () => {
    const html = '<script>globalThis["__DSH_BOOT__"] = {not json!;</script>'
    expect(clientUrlsFromBootHtml(3080, html)).toBeUndefined()
    const noEnd = '<script>globalThis["__DSH_BOOT__"] = {"entries":[]}'
    expect(clientUrlsFromBootHtml(3080, noEnd)).toBeUndefined()
  })

  it('returns undefined when entries is absent or every URL is foreign', () => {
    const noEntries = '<script>globalThis["__DSH_BOOT__"] = {}</script>'
    expect(clientUrlsFromBootHtml(3080, noEntries)).toBeUndefined()
    const foreign = '<script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"https://example.test/client.js"}]}</script>'
    expect(clientUrlsFromBootHtml(3080, foreign)).toBeUndefined()
  })

  it('accepts single-quoted marker assignments and a trailing semicolon', () => {
    const html = '<script>globalThis[\'__DSH_BOOT__\'] = {"entries":[{"url":"/plugins/x/client.js"}]} ;</script>'
    expect(clientUrlsFromBootHtml(3080, html)).toEqual(['http://127.0.0.1:3080/plugins/x/client.js'])
  })

  it('parses the relative bundle paths a 0.1.7+ boot page serves under <base href="./">', () => {
    const html = [
      '<script src="plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=1"></script>',
      '<script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"./plugins/@deepseek-ai/dsh-client-ui-layout/client.js"}]}</script>',
    ].join('')
    expect(clientUrlsFromBootHtml(3082, html)).toEqual([
      'http://127.0.0.1:3082/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=1',
      'http://127.0.0.1:3082/plugins/@deepseek-ai/dsh-client-ui-layout/client.js',
    ])
  })

  it('dedupes the absolute and relative spellings of one bundle', () => {
    const html = '<script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/x/client.js"},{"url":"./plugins/x/client.js"},{"url":"plugins/x/client.js"}]}</script>'
    expect(clientUrlsFromBootHtml(3080, html)).toEqual(['http://127.0.0.1:3080/plugins/x/client.js'])
  })
})

describe('isClientBundlePath', () => {
  it('accepts same-origin plugin bundle paths, including the combo route', () => {
    expect(isClientBundlePath('/plugins/@scope/pkg/client.js')).toBe(true)
    expect(isClientBundlePath('/plugins/??@scope/pkg/client.js&rev=1')).toBe(true)
  })

  it('accepts the relative form a 0.1.7+ boot page serves', () => {
    expect(isClientBundlePath('plugins/@scope/pkg/client.js')).toBe(true)
    expect(isClientBundlePath('./plugins/??@scope/pkg/client.js&rev=1')).toBe(true)
  })

  it('rejects foreign, protocol-relative, and non-bundle paths', () => {
    expect(isClientBundlePath('https://evil.test/client.js')).toBe(false)
    expect(isClientBundlePath('//evil.test/plugins/x/client.js')).toBe(false)
    expect(isClientBundlePath('/assets/index.js')).toBe(false)
    expect(isClientBundlePath('./assets/index.js')).toBe(false)
    expect(isClientBundlePath('plugins/@scope/pkg/index.js')).toBe(false)
  })
})

describe('looksLikePluginBundle', () => {
  it('rejects empty bodies and HTML (the SPA fallback answers 200 too)', () => {
    expect(looksLikePluginBundle(true, '')).toBe(false)
    expect(looksLikePluginBundle(true, '   \n  ')).toBe(false)
    expect(looksLikePluginBundle(true, '<!doctype html><html>')).toBe(false)
    expect(looksLikePluginBundle(true, '<HTML lang="en">')).toBe(false)
  })

  it('accepts JavaScript bodies on successful exchanges only', () => {
    expect(looksLikePluginBundle(true, 'console.log(1)')).toBe(true)
    expect(looksLikePluginBundle(false, 'console.log(1)')).toBe(false)
  })
})

describe('decodeHtmlAttribute', () => {
  it('restores the limited named entities', () => {
    expect(decodeHtmlAttribute('&amp;&quot;&#39;&lt;&gt;')).toBe('&"\'<>')
  })
})
