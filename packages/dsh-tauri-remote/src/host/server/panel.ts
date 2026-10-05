import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import accessGet from './routes/access/get'
import accessPost from './routes/access/post'
import accessTokenDelete from './routes/access/token/delete'
import accessTokenPost from './routes/access/token/post'

export const panel = defineWebServer((app) => {
  app.use(guard)
  app.get('/api/tauri/remote/access', accessGet)
  app.post('/api/tauri/remote/access', accessPost)
  app.post('/api/tauri/remote/access/token', accessTokenPost)
  app.delete('/api/tauri/remote/access/token', accessTokenDelete)
})
