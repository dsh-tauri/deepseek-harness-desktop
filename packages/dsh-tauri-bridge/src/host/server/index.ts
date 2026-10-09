import type { Config } from '../config/options'
import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import getBackends from './routes/backends/get'
import postSessions from './routes/sessions/post'

export const server = defineWebServer<Config>((app) => {
  app.use(guard)
  app.get('/api/tauri/bridge/backends', getBackends)
  app.post('/api/tauri/bridge/sessions', postSessions)
})
