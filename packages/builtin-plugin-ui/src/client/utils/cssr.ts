import { plugin as bem } from '@css-render/plugin-bem'
import { CssRender } from 'css-render'

const root = CssRender()
const plugin = bem({ blockPrefix: '.dshp-' })
root.use(plugin)

export const cssr = Object.assign(root, {
  bem: {
    b: plugin.cB,
    e: plugin.cE,
    m: plugin.cM,
  },
})
