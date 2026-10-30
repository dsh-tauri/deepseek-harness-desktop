import { defineWebServer } from 'dsh-h3'
import { ARCHIVE_STREAM_PATH } from '../../shared/constants'
import { guard } from '../service/request'
import archiveEvents from './routes/archive/events/get'

export const server = defineWebServer((app) => {
  app.use(guard)
  app.get(ARCHIVE_STREAM_PATH, archiveEvents)
})
