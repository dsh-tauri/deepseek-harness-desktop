import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
