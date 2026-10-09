import { defineWebServer } from 'dsh-h3'
import { desktopRequestGuard } from 'dsh-tauri'
import openPath from './routes/open/path/post'
import openUrl from './routes/open/url/post'

export const server = defineWebServer((app) => {
  app.use(desktopRequestGuard)
  app.post('/api/desktop/dsh-tauri-rightclick/open/url', openUrl)
  app.post('/api/desktop/dsh-tauri-rightclick/open/path', openPath)
})
