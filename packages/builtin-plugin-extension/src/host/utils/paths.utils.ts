import { DSH_HOME } from 'dsh-tauri'
import { join } from 'pathe'
import { SKILL_FILE_NAME, SKILLS_DATA_DIR } from '../config/constants'

const PROFILES_DIRECTORY = 'profiles'

const REPOS_DIRECTORY = 'repos'

export function skillDir(name: string): string {
  return join(SKILLS_DATA_DIR, name)
}

export function skillFilePath(name: string): string {
  return join(skillDir(name), SKILL_FILE_NAME)
}

export function materialDirFor(entryId: string): string {
  return join(SKILLS_DATA_DIR, REPOS_DIRECTORY, entryId)
}

export function profileDir(profile: string): string {
  return join(DSH_HOME, PROFILES_DIRECTORY, profile)
}
