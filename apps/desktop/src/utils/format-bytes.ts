/** 把字节转成人类可读体积（保留 1 位小数）；数据目录与依赖根两个面板共用。 */
export function formatBytes(bytes: number): string {
  const kb = 1024
  if (bytes < kb)
    return `${bytes} B`
  if (bytes < kb * kb)
    return `${(bytes / kb).toFixed(1)} KB`
  if (bytes < kb * kb * kb)
    return `${(bytes / kb / kb).toFixed(1)} MB`
  return `${(bytes / kb / kb / kb).toFixed(1)} GB`
}
