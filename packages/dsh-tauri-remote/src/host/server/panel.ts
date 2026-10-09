import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import accessGet from './routes/access/get'
import accessPost from './routes/access/post'
import accessTokenDelete from './routes/access/token/delete'
import accessTokenPost from './routes/access/token/post'
import accessTunnelDelete from './routes/access/tunnel/delete'
import accessTunnelPost from './routes/access/tunnel/post'
import { loopbackOnly } from './panel.utils'

export const panel = defineWebServer((app) => {
  app.use(guard)
  app.get('/api/tauri/remote/access', accessGet)
  app.post('/api/tauri/remote/access', loopbackOnly(accessPost))
  app.post('/api/tauri/remote/access/token', loopbackOnly(accessTokenPost))
  app.delete('/api/tauri/remote/access/token', loopbackOnly(accessTokenDelete))
  app.post('/api/tauri/remote/access/tunnel', loopbackOnly(accessTunnelPost))
  app.delete('/api/tauri/remote/access/tunnel', loopbackOnly(accessTunnelDelete))
})
