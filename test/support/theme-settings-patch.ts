import { readFileSync } from 'node:fs'

export function patchThemeSettings(source: string): string | undefined {
  if (source.includes('dshPendingThemeWrites'))
    return source
  const rust = readFileSync(new URL('../../src-tauri/src/service/patch/theme_settings.rs', import.meta.url), 'utf8')
  const constants = new Map(Array.from(rust.matchAll(/const (\w+): &str =\s*r#"([\s\S]*?)"#;/g), match => [match[1], match[2]]))
  const replacements = ['THEME_WRITE', 'FONT_WRITE', 'ADOPT'].map((name) => {
    const before = constants.get(name)
    const after = constants.get(`${name}_PATCHED`)
    if (!before || !after)
      throw new Error(`Missing theme patch constant: ${name}`)
    return [before, after] as const
  })
  if (replacements.some(([before]) => source.split(before).length !== 2))
    return undefined
  return replacements.reduce((result, [before, after]) => result.replace(before, after), source)
}
