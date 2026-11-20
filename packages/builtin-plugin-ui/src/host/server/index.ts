import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import openPath from './routes/path.open.post'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.post('/api/tauri/ui/path/open', openPath)
})
