import { defineWebServer } from 'dsh-h3'
import { desktopPreflight, desktopRequestGuard } from 'dsh-tauri'
import sessionStream from './routes/session/stream/get'

export const server = defineWebServer((app) => {
  app.use(desktopRequestGuard)
  app.get('/api/desktop/dsh-tauri-pet/session/stream', sessionStream)
  app.options('/api/desktop/dsh-tauri-pet/session/stream', desktopPreflight)
})
