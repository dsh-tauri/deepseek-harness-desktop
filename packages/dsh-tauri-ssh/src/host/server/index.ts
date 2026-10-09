import { defineWebServer } from 'dsh-h3'
import { desktopRequestGuard } from 'dsh-tauri'
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
  app.use(desktopRequestGuard)
  app.get('/api/desktop/dsh-tauri-ssh/settings', settingsGet)
  app.post('/api/desktop/dsh-tauri-ssh/settings', settingsPost)
  app.get('/api/desktop/dsh-tauri-ssh/session/role', sessionRole)
  app.get('/api/desktop/dsh-tauri-ssh/machines', machinesGet)
  app.post('/api/desktop/dsh-tauri-ssh/machines', machinesPost)
  app.delete('/api/desktop/dsh-tauri-ssh/machines', machinesDelete)
  app.post('/api/desktop/dsh-tauri-ssh/machines/test', machinesTest)
  app.post('/api/desktop/dsh-tauri-ssh/machines/connect', machinesConnect)
  app.post('/api/desktop/dsh-tauri-ssh/machines/disconnect', machinesDisconnect)
  app.post('/api/desktop/dsh-tauri-ssh/machines/install', machinesInstall)
  app.get('/api/desktop/dsh-tauri-ssh/machines/events', machinesEvents)
  app.get('/api/desktop/dsh-tauri-ssh/sync/preview', syncPreview)
  app.post('/api/desktop/dsh-tauri-ssh/sync/apply', syncApply)
})
