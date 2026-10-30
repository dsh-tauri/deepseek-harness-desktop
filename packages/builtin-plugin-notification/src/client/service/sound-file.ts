/** 自定义提示音的文件大小上限。 */
export const MAX_CUSTOM_SOUND_BYTES = 512 * 1024

export type SoundFileError = 'too-large' | 'unreadable'

export type SoundFileResult = { ok: true, dataUrl: string } | { ok: false, error: SoundFileError }

/**
 * 把用户选中的音频文件读成 data URL。
 *
 * 只保存在本地存储里，因此必须限制体积；读得到但拿不到 `data:` URL 时按不可读处理。
 */
export async function readSoundFile(file: File): Promise<SoundFileResult> {
  if (file.size > MAX_CUSTOM_SOUND_BYTES)
    return { ok: false, error: 'too-large' }
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
      reader.onerror = () => reject(reader.error ?? new Error('read-failed'))
      reader.readAsDataURL(file)
    })
    if (!dataUrl.startsWith('data:'))
      return { ok: false, error: 'unreadable' }
    return { ok: true, dataUrl }
  }
  catch (error) {
    console.warn('[dsh-tauri-notification] failed to read sound file', error)
    return { ok: false, error: 'unreadable' }
  }
}
