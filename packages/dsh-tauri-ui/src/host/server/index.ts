import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import resume from './routes/session/resume/post'
import ungrouped from './routes/ungrouped/get'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.post('/api/tauri/ui/session/resume', resume)
  app.get('/api/tauri/ui/ungrouped', ungrouped)
})
