import { existsSync, readdirSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, rm, symlink } from 'node:fs/promises'
import process from 'node:process'
import { filter, find, get, isEmpty, isString, map, trimEnd, uniqBy } from 'lodash-es'
import { resolve } from 'pathe'

const DEFAULT_LINK_DIRECTORIES: readonly string[] = ['node_modules']

const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'shell',
  'sh',
  'zsh',
  'terminal',
  'run_command',
  'exec',
])

const INSTALL_PATTERNS: readonly RegExp[] = [
  /\b(?:npm|pnpm|yarn|yarnpkg|bun|corepack|pnpx|npx)\s+(?:install|i|ci|add|update|upgrade|up|remove|rm|uninstall|unlink|link|dedupe|prune|rebuild|install-test|it)\b/i,
  /(?:^|[\s;&|()])yarn\s*(?:$|[\s;&|()])/i,
  /\b(?:pip|pip3|pipenv|poetry|uv|conda|mamba)\s+(?:install|sync|add|update|upgrade|lock|remove|uninstall)\b/i,
  /\bcargo\s+(?:fetch|build|install|update)\b/i,
  /\bgo\s+(?:mod\s+(?:download|tidy|vendor)|get)\b/i,
  /\b(?:bundle|bundler)\s+install\b/i,
  /\bcomposer\s+(?:install|update|require|remove)\b/i,
  /\bdotnet\s+(?:restore|add\s+package)\b/i,
  /\b(?:mvn|maven|gradle|gradlew)\b[^\n;&|]+\bdependenc(?:y|ies)\b/i,
]

export function normalizeLinkDirectories(directories?: readonly string[]): string[] {
  const source = isEmpty(directories) ? DEFAULT_LINK_DIRECTORIES : directories ?? []
  const names = map(source, raw => trimEnd(String(raw ?? '').trim(), '/\\'))
  const valid = filter(names, name => Boolean(name) && name !== '.' && name !== '..' && !/[/\\]/.test(name))
  return uniqBy(valid, name => (process.platform === 'win32' ? name.toLowerCase() : name))
}

export function isDependencyInstallCommand(command: string): boolean {
  const text = String(command ?? '')
  return text.length > 0 && INSTALL_PATTERNS.some(pattern => pattern.test(text))
}

export function shellCommandFrom(exec: unknown): string {
  const name = get(exec, 'name')
  if (!isString(name) || !SHELL_TOOL_NAMES.has(name))
    return ''
  const args = get(exec, 'arguments')
  const value = find(['command', 'cmd', 'script'], key => isString(get(args, key)) && Boolean(get(args, key)))
  return isString(value) ? get(args, value, '') : ''
}

export function shellSessionIdFrom(exec: unknown): string {
  const sessionId = get(exec, 'agent.session.id')
  return isString(sessionId) ? sessionId : ''
}

export async function linkWorktreeDependencies(
  projectPath: string,
  worktreePath: string,
  directories: readonly string[] = DEFAULT_LINK_DIRECTORIES,
): Promise<{ linked: string[], skipped: string[] }> {
  const linked: string[] = []
  const skipped: string[] = []
  for (const name of normalizeLinkDirectories(directories)) {
    const source = resolve(projectPath, name)
    const target = resolve(worktreePath, name)
    if (!existsSync(source) || await pathExists(target)) {
      skipped.push(name)
      continue
    }
    try {
      await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(name)
    }
    catch {
      skipped.push(name)
    }
  }
  return { linked, skipped }
}

export async function unlinkWorktreeDependencies(
  worktreePath: string,
  directories: readonly string[] = DEFAULT_LINK_DIRECTORIES,
): Promise<string[]> {
  const unlinked: string[] = []
  for (const name of normalizeLinkDirectories(directories)) {
    const target = resolve(worktreePath, name)
    let stats
    try {
      stats = await lstat(target)
    }
    catch {
      continue
    }
    if (!stats.isSymbolicLink())
      continue
    try {
      await rm(target, { recursive: false, force: true })
    }
    catch {
      continue
    }
    unlinked.push(name)
  }
  return unlinked
}

/**
 * 把源目录里缺失的条目复制进目标目录，供 `.agents` 这类被 gitignore、`git worktree add`
 * 搬不过来的内容使用。两侧都有的目录会继续深合并，因此「`.agents` 一部分入库、一部分被忽略」
 * 的仓库（例如跟踪 `.agents/skills/README.md` 但有未跟踪的 `.agents/skills/handle`）
 * 也能补齐缺失的子孙，同时保留目标侧已有文件。
 *
 * 这里刻意用复制而不是符号链接：POSIX 上符号链接对 git 而言是「文件」，`.agents/skills/`
 * 这种带尾斜杠的忽略规则匹配不到它，工作树会多出一条未跟踪记录 `?? .agents`，
 * 既污染状态，又会在检出时被判为「存在未跟踪改动」而卡死。目标侧遗留的链接会被换成真实目录，
 * 让重复创建能把旧实现留下的工作树修回来。
 */
export async function copyMissingChildren(sourceDirectory: string, targetDirectory: string): Promise<string[]> {
  if (!existsSync(sourceDirectory))
    return []
  if (await isSymbolicLink(targetDirectory))
    await rm(targetDirectory, { recursive: false, force: true })
  await mkdir(targetDirectory, { recursive: true })
  const copied: string[] = []
  for (const name of readdirSync(sourceDirectory)) {
    const source = resolve(sourceDirectory, name)
    const target = resolve(targetDirectory, name)
    if (await isSymbolicLink(target))
      await rm(target, { recursive: false, force: true })
    if (existsSync(target)) {
      if (isDirectory(source) && isDirectory(target)) {
        const nested = await copyMissingChildren(source, target)
        copied.push(...nested.map(child => `${name}/${child}`))
      }
      continue
    }
    try {
      await cp(source, target, { recursive: true })
      copied.push(name)
    }
    catch {}
  }
  return copied
}

// --- internal ---

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  }
  catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  }
  catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  }
  catch {
    return false
  }
}
