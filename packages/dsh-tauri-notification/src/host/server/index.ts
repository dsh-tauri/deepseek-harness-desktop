import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import turnEnd from './routes/turn-end/get'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.get('/api/tauri/notification/turn-end', turnEnd)
})
