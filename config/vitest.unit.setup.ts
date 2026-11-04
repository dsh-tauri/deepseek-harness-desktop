function escape(value: string): string {
  const text = String(value)
  let result = ''
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    const character = text.charAt(index)
    if (code === 0) {
      result += '\uFFFD'
    }
    else if ((code >= 1 && code <= 31) || code === 127
      || (code >= 48 && code <= 57 && (index === 0 || (index === 1 && text[0] === '-')))) {
      result += `\\${code.toString(16)} `
    }
    else if ((index === 0 && character === '-' && text.length === 1)
      || !(code >= 128 || character === '-' || character === '_'
        || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122))) {
      result += `\\${character}`
    }
    else {
      result += character
    }
  }
  return result
}

if (typeof window !== 'undefined') {
  const css = window.CSS ?? (window.CSS = {} as typeof CSS)
  css.escape ??= escape
  // jsdom ships neither CSS.supports nor a cascade it could report; official hooks probe it for feature detection.
  css.supports ??= () => false
  globalThis.CSS = css
}
