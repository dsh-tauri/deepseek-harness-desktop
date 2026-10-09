import { defineWebServer } from 'dsh-h3'
import { desktopRequestGuard } from 'dsh-tauri'
import turnEnd from './routes/turn-end/get'

export const server = defineWebServer((app) => {
  app.use(desktopRequestGuard)
  app.get('/api/desktop/dsh-tauri-notification/turn-end', turnEnd)
})
