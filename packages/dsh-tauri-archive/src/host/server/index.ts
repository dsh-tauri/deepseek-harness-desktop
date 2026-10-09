import { defineWebServer } from 'dsh-h3'
import { desktopRequestGuard } from 'dsh-tauri'
import clearSessionArchive from './routes/session/archive/clear/post'
import deleteSessionArchive from './routes/session/archive/delete'
import getSessionArchive from './routes/session/archive/get'
import postSessionArchive from './routes/session/archive/post'
import postSessionUnarchive from './routes/session/archive/restore/post'
import postSessionOpenPath from './routes/session/open/path/post'
import deleteSessionWorkspaceArchive from './routes/session/workspace/archive/delete'
import postSessionWorkspaceArchive from './routes/session/workspace/archive/post'

export const server = defineWebServer((app) => {
  app.use(desktopRequestGuard)
  app.get('/api/desktop/dsh-tauri-archive/session/archive', getSessionArchive)
  app.post('/api/desktop/dsh-tauri-archive/session/archive', postSessionArchive)
  app.delete('/api/desktop/dsh-tauri-archive/session/archive', deleteSessionArchive)
  app.post('/api/desktop/dsh-tauri-archive/session/archive/clear', clearSessionArchive)
  app.delete('/api/desktop/dsh-tauri-archive/session/archive/clear', clearSessionArchive)
  app.post('/api/desktop/dsh-tauri-archive/session/workspace/archive', postSessionWorkspaceArchive)
  app.delete('/api/desktop/dsh-tauri-archive/session/workspace/archive', deleteSessionWorkspaceArchive)
  app.post('/api/desktop/dsh-tauri-archive/session/archive/restore', postSessionUnarchive)
  app.post('/api/desktop/dsh-tauri-archive/session/open/path', postSessionOpenPath)
})
