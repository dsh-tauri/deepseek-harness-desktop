import { defineWebServer } from 'dsh-h3'
import { desktopRequestGuard } from 'dsh-tauri'
import openConfig from './routes/config/open/post'
import endpointModels from './routes/endpoint/models/get'
import presets from './routes/presets/get'

export const server = defineWebServer((app) => {
  app.use(desktopRequestGuard)
  app.post('/api/desktop/dsh-tauri-model/config/open', openConfig)
  app.get('/api/desktop/dsh-tauri-model/endpoint/models', endpointModels)
  app.get('/api/desktop/dsh-tauri-model/presets', presets)
})
