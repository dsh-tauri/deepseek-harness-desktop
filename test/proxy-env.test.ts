import { describe, expect, it } from 'vitest'
import { readLocale, readSource } from './setup/read-source'

/** issue #110：配置页保存的代理地址要下发给 Harness 与插件子进程。 */
const PROXY = 'src-tauri/src/config/proxy.rs'
const ENV = 'src-tauri/src/service/plugin/install/env.rs'
const LAUNCH = 'src-tauri/src/service/workflow/launch.rs'
const PANEL = 'src/ui/config/debug.tsx'

const POLICY_KEYS = ['http_proxy', 'https_proxy', 'no_proxy']
const NETWORK_KEYS = [
  'config.network',
  'network.proxy_url',
  'network.description',
  'network.formats',
  'network.saved',
  'network.invalid',
  'network.save_failed',
]

describe('child proxy environment contract', () => {
  it('translates the saved proxy URL inside the config module', () => {
    const source = readSource(PROXY)
    expect(source).toContain('pub fn proxy_child_env(value: &str) -> HashMap<String, String>')
    expect(source).toContain('const CHILD_NO_PROXY')
  })

  it('writes only the lowercase policy names the harness reads', () => {
    const source = readSource(PROXY)
    for (const key of POLICY_KEYS)
      expect(source).toContain(`("${key}".to_string()`)
    expect(source).not.toContain('("all_proxy".to_string()')
    expect(source).not.toContain('("NODE_USE_ENV_PROXY".to_string()')
  })

  it('bypasses loopback with the bare hosts Node understands', () => {
    const source = readSource(PROXY)
    expect(source).toContain(
      'localhost,.localhost,127.0.0.1,127.0.0.0/8,::1,[::1],127.0.0.1-127.255.255.255',
    )
  })

  it('appends the inherited bypass list instead of replacing it', () => {
    const source = readSource(PROXY)
    expect(source).toContain('fn child_no_proxy() -> String')
    expect(source).toContain('fn merge_no_proxy(inherited: &str) -> String')
    for (const key of ['NO_PROXY', 'no_proxy'])
      expect(source).toContain(`"${key}"`)
  })

  it('feeds both desktop spawn sites through the helper', () => {
    expect(readSource(ENV)).toContain('config::proxy::proxy_child_env(')
    expect(readSource(ENV)).toContain('config::get_store_dat_setting(app_handle).proxy_url')
    expect(readSource(LAUNCH)).toContain('envs.extend(config::proxy::proxy_child_env(&setting.proxy_url))')
  })

  it('keeps the proxy panel wired to the saved setting', () => {
    const source = readSource(PANEL)
    expect(source).toContain('dsh-proxy-url')
    expect(source).toContain('dsh-proxy-save')
    expect(source).toContain('proxyUrl')
  })

  it('documents the child process scope in both locales', () => {
    const zh = readLocale('zh-CN')
    const en = readLocale('en-US')
    for (const key of NETWORK_KEYS) {
      expect(zh[key]).toBeTypeOf('string')
      expect(en[key]).toBeTypeOf('string')
    }
    expect(zh['network.description']).toContain('Harness')
    expect(en['network.description']).toContain('Harness')
  })
})
