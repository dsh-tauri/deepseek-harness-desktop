import { createStorage } from 'unstorage'
import { remoteDocumentDriver } from './driver'

export const storage = createStorage({ driver: remoteDocumentDriver() })
