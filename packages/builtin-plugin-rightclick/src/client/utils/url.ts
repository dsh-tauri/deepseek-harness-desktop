/** 只接受 http/https 的 URL 校验（用于外链打开 / 选中文本里的网址）。 */
export function externalUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  }
  catch {
    return null
  }
}

/** 选中文本是否为完整网址（http/https 且无空格）。 */
export function selectedUrl(value: string): string | null {
  const text = value.trim()
  if (!/^https?:\/\/\S+$/i.test(text))
    return null
  return externalUrl(text)
}
