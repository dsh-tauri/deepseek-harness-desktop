import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
import machinesConnect from './routes/machines/connect/post'
import machinesDelete from './routes/machines/delete'
import machinesDisconnect from './routes/machines/disconnect/post'
import machinesEvents from './routes/machines/events/get'
import machinesGet from './routes/machines/get'
import machinesInstall from './routes/machines/install/post'
import machinesPost from './routes/machines/post'
import machinesTest from './routes/machines/test/post'
import sessionRole from './routes/session/role/get'
import settingsGet from './routes/settings/get'
import settingsPost from './routes/settings/post'
import syncApply from './routes/sync/apply/post'
import syncPreview from './routes/sync/preview/get'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.get('/api/tauri/remote/settings', settingsGet)
  app.post('/api/tauri/remote/settings', settingsPost)
  app.get('/api/tauri/remote/session/role', sessionRole)
  app.get('/api/tauri/remote/machines', machinesGet)
  app.post('/api/tauri/remote/machines', machinesPost)
  app.delete('/api/tauri/remote/machines', machinesDelete)
  app.post('/api/tauri/remote/machines/test', machinesTest)
  app.post('/api/tauri/remote/machines/connect', machinesConnect)
  app.post('/api/tauri/remote/machines/disconnect', machinesDisconnect)
  app.post('/api/tauri/remote/machines/install', machinesInstall)
  app.get('/api/tauri/remote/machines/events', machinesEvents)
  app.get('/api/tauri/remote/sync/preview', syncPreview)
  app.post('/api/tauri/remote/sync/apply', syncApply)
})
