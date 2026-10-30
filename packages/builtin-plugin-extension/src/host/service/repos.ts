import type { SkillSourceEntry } from './skills.types'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs'
import process from 'node:process'
import { defineService } from 'dsh-tauri'
import { $fetch } from 'ofetch'
import { basename, join, resolve } from 'pathe'
import { materialDirFor } from '../utils/paths.utils'
import { detectSkillRoots, newEntryId, parseGitHubSource } from './repos.utils'
import { rmtree } from './rmtree'
import { skills } from './skills'
import { tar } from './tar'

const GITHUB_FETCH_TIMEOUT_MS = 60_000

const TARBALL_MAX_BYTES = 256 * 1024 * 1024

export const repos = defineService({
  async create(path: string): Promise<SkillSourceEntry> {
    const resolved = resolve(path.trim().replace(/^"|"$/g, ''))
    if (!existsSync(resolved) || !statSync(resolved).isDirectory())
      throw new Error(`not a directory: ${resolved}`)
    const detected = detectSkillRoots(resolved)
    if (!detected.single && detected.roots.length === 0)
      throw new Error('no SKILL.md found under that path (expected a skill folder or a folder of skill folders)')
    if (detected.single) {
      const id = newEntryId('local')
      const material = materialDirFor(id)
      rmtree.remove(material)
      mkdirSync(material, { recursive: true })
      try {
        symlinkSync(resolved, join(material, 'skill'), process.platform === 'win32' ? 'junction' : 'dir')
      }
      catch {
        rmtree.remove(material)
        throw new Error('single-skill local folders need a directory link; try adding their parent folder instead')
      }
      return skills.saveSource({ id, kind: 'local', label: basename(resolved), path: resolved, roots: [material], materialDir: material })
    }
    return skills.saveSource({ id: newEntryId('local'), kind: 'local', label: basename(resolved), path: resolved, roots: detected.roots })
  },

  async import(url: string): Promise<SkillSourceEntry> {
    const source = parseGitHubSource(url)
    if (source === null)
      throw new Error('expected a GitHub repository URL or owner/repo')
    const existing = await skills.getSource(source.githubUrl) ?? await skills.getSource(source.label)
    if (existing !== null)
      throw new Error(`${source.label} is already registered`)

    const archive = Buffer.from(await downloadTarball(source.tarballUrl))
    if (archive.byteLength > TARBALL_MAX_BYTES)
      throw new Error('repository tarball too large')

    const id = newEntryId('git')
    const material = materialDirFor(id)
    rmtree.remove(material)
    const checkout = join(material, 'repo')
    try {
      mkdirSync(checkout, { recursive: true })
      tar.save(archive, checkout, { stripComponents: 1 })
      const detected = detectSkillRoots(checkout)
      if (!detected.single && detected.roots.length === 0)
        throw new Error('no SKILL.md found in that repository')
      const roots = detected.single ? [material] : detected.roots
      return await skills.saveSource(
        { id, kind: 'git', label: source.label, url: source.githubUrl, ref: source.ref, roots, materialDir: material },
      )
    }
    catch (error) {
      rmtree.remove(material)
      throw error
    }
  },
})

async function downloadTarball(url: string): Promise<ArrayBuffer> {
  const response = await $fetch.raw(url, {
    responseType: 'arrayBuffer',
    timeout: GITHUB_FETCH_TIMEOUT_MS,
    retry: 0,
    onResponseError: ({ response }) => {
      throw new Error(`download failed (HTTP ${response.status}) for ${url}`)
    },
  })
  return response._data as ArrayBuffer
}
