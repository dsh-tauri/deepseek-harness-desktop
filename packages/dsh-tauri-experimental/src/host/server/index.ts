import { defineWebServer } from 'dsh-h3'
import { desktopRequestGuard } from 'dsh-tauri'
import live from './routes/live/get'
import summary from './routes/summary/get'

export const server = defineWebServer((app) => {
  app.use(desktopRequestGuard)
  app.get('/api/desktop/dsh-tauri-experimental/summary', summary)
  app.get('/api/desktop/dsh-tauri-experimental/live', live)
})
