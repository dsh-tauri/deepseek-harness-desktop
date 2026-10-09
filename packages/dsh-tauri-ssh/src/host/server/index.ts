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
  app.get('/api/tauri/ssh/settings', settingsGet)
  app.post('/api/tauri/ssh/settings', settingsPost)
  app.get('/api/tauri/ssh/session/role', sessionRole)
  app.get('/api/tauri/ssh/machines', machinesGet)
  app.post('/api/tauri/ssh/machines', machinesPost)
  app.delete('/api/tauri/ssh/machines', machinesDelete)
  app.post('/api/tauri/ssh/machines/test', machinesTest)
  app.post('/api/tauri/ssh/machines/connect', machinesConnect)
  app.post('/api/tauri/ssh/machines/disconnect', machinesDisconnect)
  app.post('/api/tauri/ssh/machines/install', machinesInstall)
  app.get('/api/tauri/ssh/machines/events', machinesEvents)
  app.get('/api/tauri/ssh/sync/preview', syncPreview)
  app.post('/api/tauri/ssh/sync/apply', syncApply)
})
