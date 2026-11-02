import { defineDshConfig, dshExternal } from '../builtin-plugin-config/src/index.ts'

export default defineDshConfig({
  server: { external: [...dshExternal, /^@earendil-works\//] },
  client: {
    dts: true,
  },
})
