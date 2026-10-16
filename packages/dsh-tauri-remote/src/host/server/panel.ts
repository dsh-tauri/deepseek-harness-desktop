import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import { remoteSourceGuard } from './panel.utils'
import accessTokenDelete from './routes/access/token/delete'
import accessTokenPost from './routes/access/token/post'

export const panel = defineWebServer((app) => {
  app.use(guard)
  app.use(remoteSourceGuard)
  app.post('/api/tauri/remote/access/token', accessTokenPost)
  app.delete('/api/tauri/remote/access/token', accessTokenDelete)
})
