import { fileURLToPath } from 'node:url'
import { readManifest } from '../../scripts/bundle-metadata.mjs'
import { defineDshConfig } from '../builtin-plugin-config/src/index.ts'
import { gatewayAuthHtml } from './src/host/service/gateway.auth.ts'

export default async function () {
  const dshEngine = (readManifest(fileURLToPath(new URL('../../apps/desktop', import.meta.url))).engines as { dsh: { recommend: string, minimum: string } }).dsh
  return defineDshConfig({
    server: {
      noExternal: ['qrcode'],
      define: {
        __GATEWAY_AUTH_HTML__: JSON.stringify(await gatewayAuthHtml()),
        __REMOTE_DSH_RECOMMEND__: JSON.stringify(dshEngine.recommend),
        __REMOTE_DSH_MINIMUM__: JSON.stringify(dshEngine.minimum),
      },
    },
  })
}
