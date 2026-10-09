import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import openPath from './routes/open/path/post'
import openUrl from './routes/open/url/post'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.post('/api/tauri/rightclick/open/url', openUrl)
  app.post('/api/tauri/rightclick/open/path', openPath)
})
