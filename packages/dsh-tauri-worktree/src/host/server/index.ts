import { defineWebServer } from 'dsh-h3'
import { desktopRequestGuard } from 'dsh-tauri'
import bindings from './routes/bindings/get'
import attach from './routes/bindings/post'
import checkout from './routes/checkouts/post'
import deleteWorktree from './routes/delete'
import postWorktree from './routes/post'
import status from './routes/status/get'

export const server = defineWebServer((app) => {
  app.use(desktopRequestGuard)
  app.post('/api/desktop/dsh-tauri-worktree', postWorktree)
  app.delete('/api/desktop/dsh-tauri-worktree', deleteWorktree)
  app.get('/api/desktop/dsh-tauri-worktree/bindings', bindings)
  app.get('/api/desktop/dsh-tauri-worktree/status', status)
  app.post('/api/desktop/dsh-tauri-worktree/bindings', attach)
  app.post('/api/desktop/dsh-tauri-worktree/checkouts', checkout)
})
