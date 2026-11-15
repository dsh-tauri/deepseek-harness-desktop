import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import openPath from './routes/path.open.post'
import resume from './routes/session.resume.post'
import workspaceStatus from './routes/session.workspace-status.post'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.post('/api/tauri/ui/path/open', openPath)
  app.post('/api/tauri/ui/session/resume', resume)
  app.post('/api/tauri/ui/session/workspace-status', workspaceStatus)
})
