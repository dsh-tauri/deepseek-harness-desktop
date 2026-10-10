// Published ui-primitives keeps these optional renderer imports in devDependencies; picker tests never render them.
function unavailable(): never {
  throw new Error('Optional primitive renderer is outside the picker test contract')
}

export function createCssVariablesTheme(options: unknown): unknown {
  return options
}

export const createJavaScriptRegexEngine = () => ({})
export function createHighlighterCoreSync() {
  return { codeToTokens: (_code: string, options: { tokenizeTimeLimit?: number }) => options.tokenizeTimeLimit === 0 ? { tokens: [] } : unavailable() }
}
export const defaultJavaScriptRegexConstructor = unavailable
export const languageForPath = unavailable
export const CODE_HIGHLIGHT_EXTENSIONS = []
export default { ansiToJson: unavailable }

const glyph = { path: '', title: 'Unavailable optional site glyph' }
export const siAliexpress = glyph
export const siApple = glyph
export const siBaidu = glyph
export const siBilibili = glyph
export const siCsdn = glyph
export const siDuckduckgo = glyph
export const siEbay = glyph
export const siFacebook = glyph
export const siGithub = glyph
export const siGitlab = glyph
export const siGoogle = glyph
export const siInstagram = glyph
export const siJuejin = glyph
export const siMdnwebdocs = glyph
export const siNetflix = glyph
export const siNpm = glyph
export const siPypi = glyph
export const siQq = glyph
export const siQuora = glyph
export const siReddit = glyph
export const siSinaweibo = glyph
export const siSpotify = glyph
export const siStackoverflow = glyph
export const siTaobao = glyph
export const siTelegram = glyph
export const siTiktok = glyph
export const siV2ex = glyph
export const siWechat = glyph
export const siWhatsapp = glyph
export const siWikipedia = glyph
export const siX = glyph
export const siYcombinator = glyph
export const siYoutube = glyph
export const siZhihu = glyph
