import type {
  Binding,
  CheckoutOptions,
  EnsureOptions,
  OperationResult,
  WorktreeParams,
  WorktreeProcessController,
} from '../types'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import process from 'node:process'
import { defineService, DSH_HOME } from 'dsh-tauri'
import { compact, filter, find, get, isEmpty, map, reject, some } from 'lodash-es'
import { basename, dirname, join, resolve } from 'pathe'
import { TRASH_DIR, WORKTREES_DIR } from '../config/constants'
import { getCurrentHostInstance } from '../config/runtime'
import {
  copyMissingChildren,
  isDependencyInstallCommand,
  linkWorktreeDependencies,
  normalizeLinkDirectories,
  shellCommandFrom,
  shellSessionIdFrom,
  unlinkWorktreeDependencies,
} from '../utils/dependencies'
import {
  listDirectoryNames,
  removeDirectoryReliably,
  removeDirectoryTree,
  removeEmptyDirectories,
} from '../utils/filesystem'
import {
  applyStagedPatch,
  carryStagedChanges,
  git,
  gitToplevel,
  headSubject,
  projectDirname,
  shortHead,
  stagedPatch,
} from '../utils/git'
import { computeHash, parseWorktreeKey, worktreeKey, worktreePath, worktreeTrashPath } from '../utils/paths'
import { cleaner } from './cleaner'
import { ledger } from './ledger'
import { workspace } from './workspace'

const WORKTREE_BRANCH_NAME_PATTERN = /^[\w./-]+$/

// 技能目录不进 git 索引（.agents/skills 被 gitignore），`git worktree add` 永远搬不过来；
// 不链接它，继承会话就读不到初始会话的项目级技能，因此这条链接与依赖开关无关。
const AGENT_SKILLS_DIRECTORY = '.agents'

const LINK_DEPENDENCIES = true

const SWEEP_MIN_AGE_MS = 60_000

export const worktree = defineService({
  async create(
    projectPath: string,
    sessionId: string,
    options: EnsureOptions = {},
  ): Promise<OperationResult<{ binding: Binding, log: string[], existed: boolean }>> {
    const root = await gitToplevel(projectPath)
    if (!root)
      return { ok: false, error: `项目路径不是 git 仓库顶层：${projectPath}` }

    const hash = computeHash(projectPath, sessionId)
    const dirname = projectDirname(projectPath)
    const path = worktreePath(hash, dirname)
    const linkDirectories = normalizeLinkDirectories(options.linkDependencyDirectories)
    const linkDependencies = options.linkDependencies ?? LINK_DEPENDENCIES

    const existing = ledger.load(sessionId)
    if (existing && !samePath(existing.worktreePath, path)) {
      return { ok: false, error: `会话已绑定的其他工作树与本次计算路径不一致：${existing.worktreePath}（期望 ${path}）；请先放弃或检出该会话的原工作树` }
    }
    if (existing && existsSync(existing.worktreePath)) {
      const registration = await isRegisteredWorktree(root, path, options.signal)
      if (!registration.ok)
        return { ok: false, error: `检查工作树残留状态失败：${registration.error}` }
      if (registration.registered) {
        // 旧版本创建的工作树没有这份拷贝，重复创建时补齐，让继承会话能读到项目级技能
        const repairedLog: string[] = []
        await inheritAgentSkills(root, path, repairedLog)
        if (repairedLog.length === 0)
          return { ok: true, binding: existing, existed: true, log: [] }
        const repaired: Binding = { ...existing, log: [...existing.log, ...repairedLog] }
        await ledger.save(sessionId, repaired)
        return { ok: true, binding: repaired, existed: true, log: repairedLog }
      }
    }

    const mainSource = 'refs/heads/main'
    const mainRef = await git(['rev-parse', '--verify', mainSource], root, { signal: options.signal })
    if (!mainRef.ok)
      return { ok: false, error: `创建工作树失败：本地分支 main 不存在或无法解析（refs/heads/main）：${mainRef.error}` }
    if (!mainRef.out.trim())
      return { ok: false, error: '创建工作树失败：本地分支 main 不存在或无法解析（refs/heads/main）：empty git response' }

    const registration = await isRegisteredWorktree(root, path, options.signal)
    if (!registration.ok)
      return { ok: false, error: `检查工作树残留状态失败：${registration.error}` }

    if (existsSync(path)) {
      if (registration.registered) {
        return { ok: false, error: `目标路径已是 Git 工作树但缺少当前会话绑定，拒绝覆盖：${path}` }
      }
      const removed = await removeWorktreeOnDisk(sessionId, root, path, hash, dirname, linkDirectories, options.signal)
      if (!removed.ok)
        return { ok: false, error: `清理孤儿工作树目录失败：${removed.error}` }
    }
    else {
      const pruned = await pruneWorktreeAdmin(root, options.signal)
      if (!pruned.ok)
        return { ok: false, error: `清理工作树管理记录失败：${pruned.error}` }
    }

    const requestedBranch = String(options.branchName ?? '').trim()
    if (requestedBranch && !WORKTREE_BRANCH_NAME_PATTERN.test(requestedBranch))
      return { ok: false, error: `非法分支名：${requestedBranch}` }
    const branchName = requestedBranch
      ? (requestedBranch.startsWith('dsh/') ? requestedBranch : `dsh/${requestedBranch.replace(/^\/+/, '')}`)
      : ''
    if (branchName === 'dsh/')
      return { ok: false, error: '分支名不能为空' }
    if (branchName) {
      const exists = await git(['rev-parse', '--verify', `refs/heads/${branchName}`], root, { signal: options.signal })
      if (exists.ok)
        return { ok: false, error: `分支已存在：${branchName}` }
    }

    const log = ['Starting worktree creation']
    const addArgs = branchName
      ? ['worktree', 'add', '-b', branchName, path, mainSource]
      : ['worktree', 'add', '--detach', path, mainSource]
    const add = await git(addArgs, root, { signal: options.signal })
    if (!add.ok)
      return { ok: false, error: `创建工作树失败：${add.error}` }

    if (options.carryStaged === true) {
      const carried = await carryStagedChanges(root, path, { signal: options.signal })
      if (!carried.ok) {
        const rollbackFailures = await rollbackWorktree(sessionId, root, path, hash, dirname, linkDirectories, branchName, options.signal)
        const suffix = rollbackFailures.length > 0 ? `；回滚不完整：${rollbackFailures.join('；')}` : '，工作树已回滚'
        return { ok: false, error: `携带暂存内容失败：${carried.error}${suffix}` }
      }
      if (carried.carried.length > 0)
        log.push(`Carried staged changes (${carried.carried.length} file(s)) from the source repository`)
    }

    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], path)
    const activeBranch = head.ok && head.out !== 'HEAD' ? head.out : (branchName || '(detached)')
    log.push(branchName
      ? `Preparing worktree (branch ${branchName})`
      : `Preparing worktree (detached HEAD ${await shortHead(path)})`)
    log.push(`HEAD is now at ${await shortHead(path)} ${await headSubject(path)}`)
    log.push(`Worktree created at ${path}`)

    await inheritAgentSkills(root, path, log)

    const linkedDependencies: string[] = []
    if (linkDependencies) {
      try {
        const linked = await linkWorktreeDependencies(root, path, linkDirectories)
        linkedDependencies.push(...linked.linked)
        if (linked.linked.length > 0)
          log.push(`Linked dependencies from the source repository (${linked.linked.join(', ')}); install will materialize an independent copy`)
        log.push(...map(
          filter(linked.skipped, name => existsSync(join(root, name))),
          name => `Dependency directory already present, kept as-is (${name})`,
        ))
      }
      catch (error) {
        log.push(`Dependency link skipped: ${get(error, 'message', String(error))}`)
      }
    }

    const binding: Binding = {
      sessionId,
      sourceSessionId: options.sourceSessionId || sessionId,
      hash,
      dirname,
      worktreePath: path,
      projectPath: resolve(projectPath),
      branchName: activeBranch,
      ownsBranch: Boolean(branchName),
      createdAt: new Date().toISOString(),
      log,
      ...(linkedDependencies.length > 0 ? { linkedDependencies } : {}),
    }
    try {
      await ledger.save(sessionId, binding)
    }
    catch {
      const rollbackFailures = await rollbackWorktree(sessionId, root, path, hash, dirname, linkDirectories, branchName, options.signal)
      const suffix = rollbackFailures.length > 0 ? `；回滚不完整：${rollbackFailures.join('；')}` : '，已回滚'
      return { ok: false, error: `保存工作树记录失败${suffix}` }
    }

    return { ok: true, binding, log, existed: false }
  },

  async checkout(
    params: WorktreeParams,
    options: CheckoutOptions = {},
  ): Promise<OperationResult<{ branch: string, projectPath: string, worktreePath: string }>> {
    const binding = resolveBinding(params.sessionId, params.worktreeHashDirname ?? params.worktree_hash_dirname)
    if (!binding)
      return { ok: false, error: '未找到绑定的工作树' }
    if (!existsSync(binding.worktreePath))
      return { ok: false, error: `工作树目录不存在：${binding.worktreePath}` }

    const root = binding.projectPath
    const linkDirectories = removalLinkDirectories(binding, options.linkDependencyDirectories)
    const branch = String(params.branch_name ?? binding.branchName ?? '').trim()
    if (!branch || branch.endsWith('/'))
      return { ok: false, error: `分支名不能为空或以 / 结尾：${branch}` }
    const validBranch = await git(['check-ref-format', '--branch', branch], root, { signal: options.signal })
    if (!validBranch.ok)
      return { ok: false, error: `非法分支名：${branch}` }

    const mainStatus = await git(['status', '--porcelain=v1'], root, { signal: options.signal })
    if (!mainStatus.ok)
      return { ok: false, error: `读取本地主工作区状态失败：${mainStatus.error}` }
    if (mainStatus.out)
      return { ok: false, error: '本地主工作区存在未提交改动；请先提交或清理后再检出工作树' }
    const worktreeStatus = await git(['status', '--porcelain=v1'], binding.worktreePath, { signal: options.signal })
    if (!worktreeStatus.ok)
      return { ok: false, error: `读取隔离工作树状态失败：${worktreeStatus.error}` }
    const dirtyRows = compact(worktreeStatus.out.split('\n'))
    const unsupportedRows = reject(dirtyRows, row => /^[ACDMRT] /.test(row))
    if (unsupportedRows.length > 0)
      return { ok: false, error: '隔离工作树存在未暂存或未跟踪改动；请先提交这些改动再检出，避免删除工作树时丢失内容' }
    if (dirtyRows.length > 0 && options.carryStaged !== true)
      return { ok: false, error: '隔离工作树存在已暂存改动；请启用 carry_staged 或先提交这些改动再检出' }

    const worktreeHead = await git(['rev-parse', 'HEAD'], binding.worktreePath, { signal: options.signal })
    if (!worktreeHead.ok)
      return { ok: false, error: `读取工作树 HEAD 失败：${worktreeHead.error}` }
    const prev = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root, { signal: options.signal })
    if (!prev.ok || prev.out === 'HEAD')
      return { ok: false, error: '本地主工作区当前处于 detached HEAD；请先切换到本地分支再检出工作树' }
    const prevBranch = prev.out
    const carriedPatch: OperationResult<{ patch: string }> = options.carryStaged === true
      ? await stagedPatch(binding.worktreePath, { signal: options.signal })
      : { ok: true, patch: '' }
    if (!carriedPatch.ok)
      return { ok: false, error: `读取工作树暂存内容失败：${carriedPatch.error}` }

    const branchRef = await git(['rev-parse', '--verify', `refs/heads/${branch}`], root, { signal: options.signal })
    const handsOffOwnedBranch = binding.ownsBranch && binding.branchName === branch
    let detachedOwnedBranch = false
    let createdBranch = false
    let reusedBranchHead = ''
    let advancedBranch = false
    if (handsOffOwnedBranch) {
      if (!branchRef.ok)
        return { ok: false, error: `工作树拥有的本地分支不存在，拒绝重建以避免覆盖状态：${branch}` }
      if (branchRef.out !== worktreeHead.out)
        return { ok: false, error: `工作树 HEAD 与其本地分支指针不一致，拒绝检出：${branch}` }
      const activeBranch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], binding.worktreePath, { signal: options.signal })
      if (!activeBranch.ok || activeBranch.out !== branch)
        return { ok: false, error: `工作树未签出其记录的本地分支，拒绝检出：${branch}` }
      const detached = await git(['checkout', '--detach'], binding.worktreePath, { signal: options.signal })
      if (!detached.ok)
        return { ok: false, error: `释放工作树分支失败：${detached.error}` }
      detachedOwnedBranch = true
    }
    else if (branchRef.ok) {
      // 「创建或切换到指定本地分支」：分支已存在时只要不丢提交就复用——同提交直接切换，
      // 落后于工作树 HEAD 时快进；已经分叉才拒绝，避免两边提交互相覆盖。
      const occupied = await worktreeOccupant(root, branch, binding.worktreePath, options.signal)
      if (occupied)
        return { ok: false, error: `本地分支已在其他工作树中签出，无法复用：${branch}（${occupied}）` }
      const branchOnly = await git(['rev-list', '--count', `${worktreeHead.out}..${branch}`], root, { signal: options.signal })
      if (!branchOnly.ok)
        return { ok: false, error: `检查本地分支与工作树的差异失败：${branchOnly.error}` }
      const extra = Number.parseInt(branchOnly.out, 10) || 0
      if (extra > 0)
        return { ok: false, error: `本地分支 ${branch} 与工作树 HEAD 已分叉（该分支有 ${extra} 个提交不在工作树中），复用会丢失其中一方的提交；请换一个分支名，或在本地处理该分支后再检出` }
      reusedBranchHead = branchRef.out
      if (branchRef.out !== worktreeHead.out) {
        const advanced = branch === prevBranch
          ? await git(['merge', '--ff-only', worktreeHead.out], root, { signal: options.signal })
          : await git(['branch', '-f', branch, worktreeHead.out], root, { signal: options.signal })
        if (!advanced.ok)
          return { ok: false, error: `把本地分支快进到工作树 HEAD 失败：${advanced.error}` }
        advancedBranch = true
      }
    }
    else {
      const created = await git(['branch', branch, worktreeHead.out], root, { signal: options.signal })
      if (!created.ok)
        return { ok: false, error: `创建本地分支失败：${created.error}` }
      createdBranch = true
    }

    const restoreSourceBranch = async (): Promise<string> => {
      if (!detachedOwnedBranch)
        return ''
      const restored = await git(['checkout', branch], binding.worktreePath)
      return restored.ok ? '' : `；工作树分支自动恢复失败：${restored.error}`
    }
    const removeCreatedBranch = async (): Promise<string> => {
      if (!createdBranch)
        return ''
      const removed = await git(['branch', '-D', branch], root)
      return removed.ok ? '' : `；新建分支自动清理失败：${removed.error}`
    }
    const restoreAdvancedBranch = async (): Promise<string> => {
      if (!advancedBranch)
        return ''
      const restored = branch === prevBranch
        ? await git(['reset', '--hard', reusedBranchHead], root)
        : await git(['branch', '-f', branch, reusedBranchHead], root)
      return restored.ok ? '' : `；已存在分支回退失败：${restored.error}`
    }
    const revertBranch = async (): Promise<string> => {
      if (detachedOwnedBranch)
        return restoreSourceBranch()
      if (createdBranch)
        return removeCreatedBranch()
      return restoreAdvancedBranch()
    }
    const rollbackHandoff = async (resetTarget = false): Promise<string> => {
      const failures: string[] = []
      if (resetTarget) {
        const reset = await git(['reset', '--hard', 'HEAD'], root)
        if (!reset.ok)
          failures.push(`清理目标分支暂存状态失败：${reset.error}`)
      }
      const switchedBack = await git(['checkout', prevBranch], root, { signal: options.signal })
      if (!switchedBack.ok) {
        failures.push(`恢复本地主分支失败：${switchedBack.error}`)
      }
      else {
        const sourceRecovery = await revertBranch()
        if (sourceRecovery)
          failures.push(sourceRecovery.replace(/^；/, ''))
      }
      return failures.length > 0 ? `；${failures.join('；')}` : ''
    }

    const check = await git(['checkout', branch], root, { signal: options.signal })
    if (!check.ok) {
      const recovery = await revertBranch()
      return { ok: false, error: `切换到本地分支失败：${check.error}${recovery}` }
    }

    if (carriedPatch.patch.trim()) {
      const applied = await applyStagedPatch(root, carriedPatch.patch, { signal: options.signal })
      if (!applied.ok) {
        const recovery = await rollbackHandoff(true)
        return { ok: false, error: `携带暂存内容失败，工作树已保留：${applied.error}${recovery}` }
      }
    }

    if (options.beforeRemove) {
      const prepared = await options.beforeRemove({ branch, projectPath: root, worktreePath: binding.worktreePath })
      if (!prepared.ok) {
        const recovery = await rollbackHandoff(Boolean(carriedPatch.patch.trim()))
        return { ok: false, error: `Failed to create the local handback session; the worktree was preserved: ${prepared.error}${recovery}` }
      }
    }

    await workspace.unregister(binding.worktreePath)
    const removed = await removeWorktreeOnDisk(
      binding.sessionId,
      root,
      binding.worktreePath,
      binding.hash,
      binding.dirname,
      linkDirectories,
      options.signal,
    )
    if (!removed.ok) {
      const recovery = existsSync(binding.worktreePath)
        ? await rollbackHandoff(Boolean(carriedPatch.patch.trim()))
        : ''
      return { ok: false, error: `删除工作树失败，绑定已保留以便重试：${removed.error}${recovery}` }
    }

    await ledger.remove(binding.sessionId)

    return { ok: true, branch, projectPath: root, worktreePath: binding.worktreePath }
  },

  async discard(sessionId: string, key: string): Promise<OperationResult<{ jobId?: string }>> {
    const target = await removalTarget(sessionId, key)
    if (!target)
      return { ok: false, error: '未找到绑定的工作树' }
    if (!target.bound && !existsSync(target.worktreePath))
      return { ok: true }
    const job = cleaner.start(target.sessionId, key, target.worktreePath, () => worktree.remove(sessionId, key), true)
    return { ok: true, jobId: job.jobId }
  },

  async remove(sessionId: string, key = ''): Promise<OperationResult<{ worktreePath: string }>> {
    const target = await removalTarget(sessionId, key)
    if (!target)
      return { ok: false, error: '未找到绑定的工作树' }

    await workspace.unregister(target.worktreePath)
    const removed = await removeWorktreeOnDisk(
      target.sessionId,
      target.projectPath,
      target.worktreePath,
      target.hash,
      target.dirname,
      removalLinkDirectories(target.binding),
    )
    if (!removed.ok)
      return { ok: false, error: `删除工作树失败，绑定已保留以便重试：${removed.error}` }

    if (target.binding?.ownsBranch && target.binding.branchName) {
      const dropped = await deleteOwnedBranch(target.projectPath, target.binding.branchName)
      if (!dropped.ok)
        return { ok: false, error: `删除工作树分支失败，绑定已保留以便重试：${dropped.error}` }
    }

    await ledger.remove(target.sessionId)

    return { ok: true, worktreePath: target.worktreePath }
  },

  async recover(): Promise<OperationResult<{ resumed: number, swept: number, pruned: number }>> {
    try {
      // 只补「本进程还没有删除动作」的任务（多为上次进程留下的），其余任务由 cleaner 自己退避重试；
      // 清扫兜住回收站残留、空壳目录与已消失工作树的陈旧绑定
      const pending = cleaner.unsettled()
      for (const job of pending) {
        cleaner.start(job.sessionId, job.worktreeKey, job.worktreePath, () =>
          worktree.remove(job.sessionId, job.worktreeKey))
      }
      const swept = await sweepAbandoned()
      const pruned = await pruneVanishedBindings()
      return { ok: true, resumed: pending.length, swept, pruned }
    }
    catch (error) {
      return { ok: false, error: get(error, 'message', String(error)) }
    }
  },

  async detach(exec: unknown): Promise<string[]> {
    const command = shellCommandFrom(exec)
    if (!command || !isDependencyInstallCommand(command))
      return []
    const sessionId = shellSessionIdFrom(exec)
    if (!sessionId)
      return []
    const binding = ledger.load(sessionId)
    if (!binding?.worktreePath)
      return []
    const directories = normalizeLinkDirectories([
      ...(binding.linkedDependencies ?? []),
      ...normalizeLinkDirectories(),
    ])
    const unlinked = await unlinkWorktreeDependencies(binding.worktreePath, directories)
    if (unlinked.length > 0) {
      getCurrentHostInstance().logger?.info?.(
        `dsh-tauri-worktree: unlinked ${unlinked.join(', ')} before install in ${binding.worktreePath}; `
        + 'the package manager will materialize an independent copy',
      )
    }
    return unlinked
  },
})

// --- internal ---

async function removeEmptyHashContainers(hash: string): Promise<void> {
  await removeEmptyDirectories([
    join(DSH_HOME, WORKTREES_DIR, hash),
    join(DSH_HOME, TRASH_DIR, hash),
  ])
}

async function pruneWorktreeAdmin(root: string, signal?: AbortSignal): Promise<OperationResult> {
  if (!root)
    return { ok: true }
  const pruned = await git(['worktree', 'prune', '--expire', 'now'], root, { signal })
  return pruned.ok ? { ok: true } : { ok: false, error: pruned.error }
}

/**
 * 把源仓库的 `.agents` 复制进工作树。技能目录被 gitignore，`git worktree add` 不会带过来，
 * 不补这一步，继承会话就读不到初始会话的项目级技能。
 *
 * 用复制而不是符号链接：POSIX 上符号链接对 git 是「文件」，`.agents/skills/` 这类带尾斜杠的
 * 忽略规则匹配不到它，工作树会多出未跟踪记录 `?? .agents`，既污染状态又会在检出时被判为
 * 「存在未跟踪改动」。源仓库没有 `.agents` 时静默返回。
 */
async function inheritAgentSkills(root: string, path: string, log: string[]): Promise<void> {
  const source = join(root, AGENT_SKILLS_DIRECTORY)
  if (!existsSync(source))
    return
  try {
    const copied = await copyMissingChildren(source, join(path, AGENT_SKILLS_DIRECTORY))
    if (copied.length > 0)
      log.push(`Copied the agent skills directory from the source repository (${copied.join(', ')})`)
  }
  catch (error) {
    log.push(`Agent skills directory copy skipped: ${get(error, 'message', String(error))}`)
  }
}

function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p)
  }
  catch {
    const resolved = resolve(p)
    const segments: string[] = []
    let current = resolved
    while (true) {
      const parent = dirname(current)
      if (parent === current)
        break
      segments.unshift(basename(current))
      try {
        const canonicalParent = realpathSync.native(parent)
        return join(canonicalParent, ...segments)
      }
      catch {
        current = parent
      }
    }
    return resolved
  }
}

function samePath(a: string, b: string): boolean {
  const left = canonicalPath(a)
  const right = canonicalPath(b)
  return process.platform === 'win32'
    ? left.replaceAll('/', '\\').toLowerCase() === right.replaceAll('/', '\\').toLowerCase()
    : left === right
}

async function isRegisteredWorktree(root: string, path: string, signal?: AbortSignal): Promise<OperationResult<{ registered: boolean }>> {
  const listed = await git(['worktree', 'list', '--porcelain'], root, { signal })
  if (!listed.ok)
    return { ok: false, error: listed.error }
  const registered = some(compact(listed.out.split('\n')), line =>
    line.startsWith('worktree ') && samePath(line.slice('worktree '.length), path))
  return { ok: true, registered }
}

async function stopWorktreeProcesses(sessionId: string, path: string): Promise<void> {
  let ctx: unknown
  try {
    ctx = getCurrentHostInstance()
  }
  catch {
    ctx = undefined
  }
  const getController = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  const controller = typeof getController === 'function'
    ? getController.call(ctx, 'worktreeProcessController')
    : (ctx as { worktreeProcessController?: WorktreeProcessController } | undefined)?.worktreeProcessController
  const stop = (controller as WorktreeProcessController | undefined)?.stopSessionProcesses
  if (typeof stop !== 'function')
    return
  await stop(sessionId, path).catch(() => {})
}

async function removeWorktreeOnDisk(
  sessionId: string,
  root: string,
  path: string,
  hash: string,
  dirname: string,
  linkDirectories: readonly string[] = [],
  signal?: AbortSignal,
): Promise<OperationResult> {
  await stopWorktreeProcesses(sessionId, path)

  if (linkDirectories.length > 0)
    await unlinkWorktreeDependencies(path, linkDirectories)

  let failure = ''
  try {
    await removeDirectoryReliably(path, worktreeTrashPath(hash, dirname))
  }
  catch (error) {
    failure = get(error, 'message', String(error))
  }

  // 失败时同样清一次：内容可能已被清空但目录句柄未释放，空壳不该继续堆积
  await removeEmptyHashContainers(hash)
  if (failure)
    return { ok: false, error: failure }

  return pruneWorktreeAdmin(root, signal)
}

function removalLinkDirectories(binding: Binding | null, configured?: readonly string[]): string[] {
  const configuredDirectories = normalizeLinkDirectories(configured)
  if (!binding || isEmpty(binding.linkedDependencies))
    return configuredDirectories
  return normalizeLinkDirectories([...binding.linkedDependencies ?? [], ...configuredDirectories])
}

async function deleteOwnedBranch(root: string, branch: string, signal?: AbortSignal): Promise<OperationResult> {
  const existing = await git(['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`], root, { signal })
  if (!existing.ok)
    return { ok: false, error: existing.error }
  if (!existing.out.trim())
    return { ok: true }
  const dropped = await git(['branch', '-D', branch], root, { signal })
  return dropped.ok ? { ok: true } : { ok: false, error: dropped.error }
}

async function rollbackWorktree(
  sessionId: string,
  root: string,
  path: string,
  hash: string,
  dirname: string,
  linkDirectories: readonly string[],
  branchName: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const failures: string[] = []
  const removed = await removeWorktreeOnDisk(sessionId, root, path, hash, dirname, linkDirectories, signal)
  if (!removed.ok)
    failures.push(`移除工作树失败：${removed.error}`)
  if (branchName) {
    const dropped = await deleteOwnedBranch(root, branchName, signal)
    if (!dropped.ok)
      failures.push(`删除分支失败：${dropped.error}`)
  }
  return failures
}

function resolveBinding(sessionId?: string, key?: string): Binding | null {
  const bySession = sessionId ? ledger.load(sessionId) : null
  if (bySession)
    return bySession
  if (!key)
    return null
  return find(ledger.list(), binding =>
    Boolean(binding.hash) && Boolean(binding.dirname) && worktreeKey(binding.hash, binding.dirname) === key) ?? null
}

interface RemovalTarget {
  sessionId: string
  hash: string
  dirname: string
  worktreePath: string
  projectPath: string
  binding: Binding | null
  bound: boolean
}

/**
 * 删除目标优先取会话绑定；绑定已丢失（旧版本残留、清理中断）时按 `hash/dirname`
 * 还原确定性路径，并尽力从 `.git` 文件反推项目路径，让孤儿目录也能进回收站。
 */
async function removalTarget(sessionId: string, key: string): Promise<RemovalTarget | null> {
  const binding = resolveBinding(sessionId, key)
  if (binding)
    return { ...binding, binding, bound: true }
  const parsed = parseWorktreeKey(key)
  // 未绑定的 key 直接来自请求体：任一段越出 `worktrees/<hash>/<dirname>` 都拒绝，
  // 否则 `../..` 这类 key 会被 join() 归一化到工作树根之外再被递归删除
  if (!parsed || !isSafeKeySegment(parsed.hash) || !isSafeKeySegment(parsed.dirname))
    return null
  const path = worktreePath(parsed.hash, parsed.dirname)
  return {
    sessionId,
    hash: parsed.hash,
    dirname: parsed.dirname,
    worktreePath: path,
    projectPath: projectFromWorktree(path),
    binding: null,
    bound: false,
  }
}

/** key 的每一段都必须是单一目录名：不接受空串、`.`、`..` 与任何路径分隔符。 */
function isSafeKeySegment(segment: string): boolean {
  return Boolean(segment) && segment !== '.' && segment !== '..' && !segment.includes('/') && !segment.includes('\\')
}

function projectFromWorktree(path: string): string {
  try {
    const pointer = readFileSync(join(path, '.git'), 'utf8')
      .split('\n')
      .find(line => line.startsWith('gitdir:'))
    if (!pointer)
      return ''
    return resolve(pointer.slice('gitdir:'.length).trim(), '..', '..', '..')
  }
  catch {
    return ''
  }
}

/** 该分支是否已被别的 git 工作树签出（含当前工作树本身则不算占用）。 */
async function worktreeOccupant(root: string, branch: string, worktreePath: string, signal?: AbortSignal): Promise<string> {
  const listed = await git(['worktree', 'list', '--porcelain'], root, { signal })
  if (!listed.ok)
    return ''
  let current = ''
  for (const line of listed.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length).trim()
      continue
    }
    if (line === `branch refs/heads/${branch}` && !samePath(current, root) && !samePath(current, worktreePath))
      return current
  }
  return ''
}

/**
 * 清扫上一轮没能删干净的残骸：回收站内容一律可删（搬进去即已判定删除），
 * `worktrees/` 下只删空壳——仍有内容的工作树可能承载未提交改动，绝不自动删除。
 */
async function sweepAbandoned(): Promise<number> {
  let swept = 0
  const trashRoot = join(DSH_HOME, TRASH_DIR)
  for (const hash of listDirectoryNames(trashRoot)) {
    const container = join(trashRoot, hash)
    await removeDirectoryTree(container)
    if (!existsSync(container))
      swept += 1
  }

  const worktreesRoot = join(DSH_HOME, WORKTREES_DIR)
  for (const hash of listDirectoryNames(worktreesRoot)) {
    const container = join(worktreesRoot, hash)
    const staleContainer = isSweepable(container)
    for (const name of listDirectoryNames(container)) {
      const path = join(container, name)
      if (isSweepable(path))
        await removeEmptyDirectories([path])
      if (!existsSync(path))
        swept += 1
    }
    // 容器是否陈旧要在删子目录之前判定：删子目录会刷新它的 mtime
    if (staleContainer)
      await removeEmptyDirectories([container])
    if (!existsSync(container))
      swept += 1
  }
  return swept
}

/** 只清扫静置超过一分钟的目录，避开 create/删除正在使用的中间态。 */
function isSweepable(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > SWEEP_MIN_AGE_MS
  }
  catch {
    return false
  }
}

/** 回收目录已消失的绑定记录，避免 `/bindings` 与启动遍历长期背着历史包袱。 */
async function pruneVanishedBindings(): Promise<number> {
  let pruned = 0
  for (const binding of ledger.list()) {
    if (!binding.sessionId || !binding.hash || !binding.dirname)
      continue
    if (existsSync(binding.worktreePath))
      continue
    // 删除流程的中间态：内容已搬进回收站，绑定要等回收站清空后再回收
    if (existsSync(worktreeTrashPath(binding.hash, binding.dirname)))
      continue
    if (some(cleaner.unsettled(), job => job.sessionId === binding.sessionId))
      continue
    await ledger.remove(binding.sessionId)
    pruned += 1
  }
  return pruned
}
