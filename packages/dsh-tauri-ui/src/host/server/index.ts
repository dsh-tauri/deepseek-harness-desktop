import { defineWebServer } from 'dsh-h3'
import { desktopPreflight, desktopRequestGuard } from 'dsh-tauri'
import resume from './routes/session/resume/post'
import ungrouped from './routes/ungrouped/get'

export const server = defineWebServer((app) => {
  app.use(desktopRequestGuard)
  app.post('/api/desktop/dsh-tauri-ui/session/resume', resume)
  app.get('/api/desktop/dsh-tauri-ui/ungrouped', ungrouped)
  app.options('/api/desktop/dsh-tauri-ui/session/resume', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-ui/ungrouped', desktopPreflight)
})
