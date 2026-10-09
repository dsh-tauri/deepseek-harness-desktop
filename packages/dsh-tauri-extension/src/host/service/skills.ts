import type { PanelExtensionHost } from '../types'
import type {
  HostSkill,
  HostSkillDefinition,
  PluginState,
  SkillInput,
  SkillRepositoryMetadata,
  SkillRow,
  SkillSourceEntry,
} from './skills.types'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { getServerContext } from 'dsh-h3/utils'
import { defineService } from 'dsh-tauri'
import { orderBy } from 'lodash-es'
import { isAbsolute, relative, resolve, sep } from 'pathe'
import { SKILL_NAME_RE, SKILLS_DATA_DIR } from '../config/constants'
import { server } from '../server'
import { storage } from '../storage'
import { skillDir, skillFilePath } from '../utils/paths.utils'
import { rmtree } from './rmtree'
import { isOwnedMaterialDir, isSkillSourceEntry, rewriteSkillContent, rewriteSkillPolicy, serializeSkill } from './skills.utils'

const STATE_FILE_NAME = 'state.json'

export const skills = defineService({
  // --- Skill 基础操作 ---
  async get(name: string): Promise<HostSkillDefinition | null> {
    return (await getServerContext<PanelExtensionHost>(server).skills.get(name)) ?? null
  },

  save(input: SkillInput, file?: string): string {
    if (file !== undefined) {
      writeFileSync(file, rewriteSkillContent(readFileSync(file, 'utf8'), input), 'utf8')
      return file
    }
    const target = skillFilePath(input.name)
    mkdirSync(skillDir(input.name), { recursive: true })
    writeFileSync(target, serializeSkill(input), 'utf8')
    return target
  },

  remove(name: string): boolean {
    if (!SKILL_NAME_RE.test(name))
      return false
    const dir = skillDir(name)
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      return false
    rmSync(dir, { recursive: true, force: true })
    return true
  },

  // --- Skill 视图/展示目录 ---
  async getCatalog(): Promise<SkillRow[]> {
    const hostSkills = await getServerContext<PanelExtensionHost>(server).skills.list()
    const sources = await readSources()
    const rows = await Promise.all(hostSkills.map(skill => toSkillRow(skill, sources)))
    return orderBy(rows, [row => row.repository === undefined], ['asc'])
  },

  // --- Skill 来源/仓库 ---
  async listSources(): Promise<SkillSourceEntry[]> {
    return readSources()
  },

  async getSource(url: string): Promise<SkillSourceEntry | null> {
    return (await readSources()).find(entry => entry.url === url) ?? null
  },

  async saveSource(entry: Omit<SkillSourceEntry, 'addedAt'>): Promise<SkillSourceEntry> {
    const sources = await readSources()
    const stored: SkillSourceEntry = { ...entry, addedAt: Date.now() }
    sources.push(stored)
    await writeSources(sources)
    return stored
  },

  async removeSource(id: string): Promise<SkillSourceEntry | null> {
    const sources = await readSources()
    const at = sources.findIndex(entry => entry.id === id)
    if (at === -1)
      return null
    const removed = sources[at]
    if (removed.materialDir !== undefined) {
      if (!isOwnedMaterialDir(removed.id, removed.materialDir))
        throw new Error(`unsafe skill material directory: ${removed.materialDir}`)
      rmtree.remove(removed.materialDir)
    }
    sources.splice(at, 1)
    await writeSources(sources)
    return removed
  },

  // --- Skill 策略配置 ---
  setPolicy(file: string, enabled: boolean): void {
    writeFileSync(file, rewriteSkillPolicy(readFileSync(file, 'utf8'), enabled), 'utf8')
  },
})

// --- internal ---

async function readSources(): Promise<SkillSourceEntry[]> {
  const parsed = await storage.getItem<Partial<PluginState>>(STATE_FILE_NAME)
  if (!Array.isArray(parsed?.skillRoots))
    return []
  return parsed.skillRoots.filter(isSkillSourceEntry)
}

async function writeSources(sources: SkillSourceEntry[]): Promise<void> {
  await storage.setItem(STATE_FILE_NAME, `${JSON.stringify({ skillRoots: sources }, null, 2)}\n`)
}

async function customSkillWritable(dir: string): Promise<boolean> {
  if (dir === SKILLS_DATA_DIR || dir.startsWith(SKILLS_DATA_DIR + sep))
    return true
  return (await readSources()).some(entry =>
    entry.roots.some(root => dir === root || dir.startsWith(root + sep)))
}

async function skillWritable(skill: HostSkill, dir: string | undefined): Promise<boolean> {
  if (dir === undefined)
    return false
  if (skill.source === 'user-dsh')
    return true
  return skill.source === 'custom' && await customSkillWritable(dir)
}

function pathWithin(path: string, parent: string): boolean {
  const child = resolve(path)
  const root = resolve(parent)
  const nested = relative(root, child)
  return nested === '' || (!nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested))
}

function repositoryForSkill(
  skill: HostSkill,
  entries: SkillSourceEntry[],
): SkillRepositoryMetadata | undefined {
  const dir = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : undefined
  if (dir === undefined)
    return undefined
  const entry = entries.find(candidate => candidate.roots.some(root => pathWithin(dir, root)))
  if (entry === undefined)
    return undefined
  return {
    id: entry.id,
    label: entry.label,
    kind: entry.kind,
    ...(entry.kind === 'git' && entry.url !== undefined ? { githubUrl: entry.url } : {}),
  }
}

async function toSkillRow(skill: HostSkill, entries: SkillSourceEntry[]): Promise<SkillRow> {
  const dir = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : undefined
  const repository = repositoryForSkill(skill, entries)
  return {
    ...skill,
    editable: await skillWritable(skill, dir),
    removable: skill.source === 'user-dsh',
    ...(dir !== undefined ? { dir } : {}),
    policyEditable: dir !== undefined,
    ...(repository !== undefined ? { repository } : {}),
  }
}
