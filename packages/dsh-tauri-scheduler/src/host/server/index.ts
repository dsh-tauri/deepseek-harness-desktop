import { defineWebServer } from 'dsh-h3'
import { guard } from 'dsh-tauri'
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
  app.use(guard)
  app.get('/api/tauri/scheduler/tasks', tasks)
  app.post('/api/tauri/scheduler/tasks', tasksCreate)
  app.put('/api/tauri/scheduler/tasks', tasksUpdate)
  app.delete('/api/tauri/scheduler/tasks', tasksDelete)
  app.post('/api/tauri/scheduler/tasks/toggle', tasksToggle)
  app.post('/api/tauri/scheduler/tasks/run', tasksRun)
  app.get('/api/tauri/scheduler/history', history)
  app.delete('/api/tauri/scheduler/history', historyDelete)
  app.get('/api/tauri/scheduler/options', options)
  app.post('/api/tauri/scheduler/runs/recover', recover)
})
