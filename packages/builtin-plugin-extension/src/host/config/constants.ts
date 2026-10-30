import { DSH_HOME } from 'dsh-tauri'
import { join } from 'pathe'

export const SKILL_FILE_NAME = 'SKILL.md'
export const SKILLS_DATA_DIR = join(DSH_HOME, 'skills')

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'
export const PATCH_FILE_NAME = 'cordis.patch.yml'
