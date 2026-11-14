/** 代理地址是不是 SOCKS。核心侧不认 SOCKS（直连），桌面端认，提示要如实反映这个差别。 */
export function isSocksProxy(value: string): boolean {
  const scheme = value.trim().toLowerCase()
  return scheme.startsWith('socks5://') || scheme.startsWith('socks5h://')
}
