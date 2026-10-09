import { defineWebServer } from 'dsh-h3'
import { desktopPreflight, desktopRequestGuard } from 'dsh-tauri'
import historyDelete from './routes/history/delete'
import history from './routes/history/get'
import options from './routes/options/get'
import recover from './routes/runs/recover/post'
import tasksDelete from './routes/tasks/delete'
import tasks from './routes/tasks/get'
import tasksCreate from './routes/tasks/post'
import tasksUpdate from './routes/tasks/put'
import tasksRun from './routes/tasks/run/post'
import tasksToggle from './routes/tasks/toggle/post'

export const server = defineWebServer((app) => {
  app.use(desktopRequestGuard)
  app.get('/api/desktop/dsh-tauri-scheduler/tasks', tasks)
  app.post('/api/desktop/dsh-tauri-scheduler/tasks', tasksCreate)
  app.put('/api/desktop/dsh-tauri-scheduler/tasks', tasksUpdate)
  app.delete('/api/desktop/dsh-tauri-scheduler/tasks', tasksDelete)
  app.post('/api/desktop/dsh-tauri-scheduler/tasks/toggle', tasksToggle)
  app.post('/api/desktop/dsh-tauri-scheduler/tasks/run', tasksRun)
  app.get('/api/desktop/dsh-tauri-scheduler/history', history)
  app.delete('/api/desktop/dsh-tauri-scheduler/history', historyDelete)
  app.get('/api/desktop/dsh-tauri-scheduler/options', options)
  app.post('/api/desktop/dsh-tauri-scheduler/runs/recover', recover)

  app.options('/api/desktop/dsh-tauri-scheduler/tasks', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-scheduler/tasks/toggle', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-scheduler/tasks/run', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-scheduler/history', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-scheduler/options', desktopPreflight)
  app.options('/api/desktop/dsh-tauri-scheduler/runs/recover', desktopPreflight)
})
