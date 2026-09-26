import { defineDshConfig } from '../dsh-tauri-tsdown/src/index.ts'

// Host stub (src/index.ts) + browser client bundle (src/client/index.ts)
// wrapped in the dsh-client-modules closure factory.
export default defineDshConfig()
