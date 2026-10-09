import { defineWebServer } from 'dsh-h3'
import { desktopPreflight, desktopRequestGuard } from 'dsh-tauri'
import turnEnd from './routes/turn-end/get'

export const server = defineWebServer((app) => {
  app.use(desktopRequestGuard)
  app.get('/api/desktop/dsh-tauri-notification/turn-end', turnEnd)

  app.options('/api/desktop/dsh-tauri-notification/turn-end', desktopPreflight)
})
