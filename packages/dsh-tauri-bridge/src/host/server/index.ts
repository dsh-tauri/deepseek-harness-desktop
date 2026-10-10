import type { Config } from '../config/options'
import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import getBackends from './routes/backends/get'
import getModels from './routes/models/get'
import postModels from './routes/models/post'
import postSessions from './routes/sessions/post'

export const server = defineWebServer<Config>((app) => {
  app.use(guard)
  app.get('/api/tauri/bridge/backends', getBackends)
  app.get('/api/tauri/bridge/models', getModels)
  app.post('/api/tauri/bridge/models', postModels)
  app.post('/api/tauri/bridge/sessions', postSessions)
})
