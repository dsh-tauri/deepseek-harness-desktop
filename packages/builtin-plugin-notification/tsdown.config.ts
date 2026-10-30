import { defineDshConfig } from '../builtin-plugin-config/src/index.ts'

export default defineDshConfig({
  client: {
    loader: { '.wav': 'dataurl' },
  },
})
