import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import live from './routes/live/get'
import summary from './routes/summary/get'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.get('/api/tauri/experimental/summary', summary)
  app.get('/api/tauri/experimental/live', live)
})
