import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import sessionStream from './routes/session/stream/get'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.get('/api/tauri/pet/session/stream', sessionStream)
})
