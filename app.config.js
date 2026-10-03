import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 本仓库根 package.json 是 `"type": "module"`，动态配置必须以 ESM 导出。
const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default function appConfig({ config }) {
  return {
    ...config,
    extra: {
      ...config.extra,
      thirdPartyNotices: readFileSync(`${rootDir}THIRD_PARTY_NOTICES.md`, 'utf8'),
    },
  }
}
