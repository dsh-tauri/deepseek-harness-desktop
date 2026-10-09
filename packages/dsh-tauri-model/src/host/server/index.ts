import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import openConfig from './routes/config/open/post'
import endpointModels from './routes/endpoint/models/get'
import presets from './routes/presets/get'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.post('/api/tauri/model/config/open', openConfig)
  app.get('/api/tauri/model/endpoint/models', endpointModels)
  app.get('/api/tauri/model/presets', presets)
})
