import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import bindings from './routes/bindings/get'
import attach from './routes/bindings/post'
import checkout from './routes/checkouts/post'
import deleteWorktree from './routes/delete'
import postWorktree from './routes/post'
import status from './routes/status/get'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.post('/api/tauri/worktree', postWorktree)
  app.delete('/api/tauri/worktree', deleteWorktree)
  app.get('/api/tauri/worktree/bindings', bindings)
  app.get('/api/tauri/worktree/status', status)
  app.post('/api/tauri/worktree/bindings', attach)
  app.post('/api/tauri/worktree/checkouts', checkout)
})
