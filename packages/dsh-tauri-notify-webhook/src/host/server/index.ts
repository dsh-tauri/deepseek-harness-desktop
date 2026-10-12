import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import delivery from './routes/delivery/post'
import settingsGet from './routes/settings/get'
import settingsPost from './routes/settings/post'
import test from './routes/test/post'
import turnEnd from './routes/turn-end/get'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.get('/api/tauri/notify-webhook/settings', settingsGet)
  app.post('/api/tauri/notify-webhook/settings', settingsPost)
  app.post('/api/tauri/notify-webhook/test', test)
  app.get('/api/tauri/notify-webhook/turn-end', turnEnd)
  app.post('/api/tauri/notify-webhook/delivery', delivery)
})
