import type { Binding } from '../types'

/** 工作树事实的公共措辞：常驻 section 与动态快照共用，避免两处漂移。 */
export function worktreeFactsText(binding: Binding): string {
  const lines = [
    'This session is running in an isolated worktree.',
    'is_worktree: true',
    binding.hash && binding.dirname ? `Worktree key: ${binding.hash}/${binding.dirname}` : '',
    binding.worktreePath ? `Worktree path: ${binding.worktreePath}` : '',
    binding.projectPath ? `Project path: ${binding.projectPath}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

export function worktreeSectionText(binding: Binding): string {
  return (
    `${worktreeFactsText(binding)}\n\n`
    + `Resolve every path inside the worktree path. The project path is a different checkout: `
    + `do not read from or modify it in this session, even when the inherited history refers to it. `
    + `Dependency directories (e.g. node_modules) are linked from the source repository and the agent skills directory (.agents) is copied into the worktree, so it works out of the box. The Rust build cache (src-tauri/target) is NOT carried over: the backend recompiles from scratch in this worktree. `
    + `Running a package manager install (e.g. \`pnpm install\`) inside the worktree first detaches that link and materializes an independent copy, `
    + `leaving the source repository untouched. `
    + `checkout_worktree is user-authorized only: call it only after a direct human user explicitly requests or approves checkout. `
    + `Task completion, a merged PR, or inferred convenience is not permission to call it. When checkout would be a natural next step, `
    + `such as after a PR is merged, you may ask the user whether they want to check out the worktree; wait for their approval before calling.`
  )
}

/**
 * 动态快照措辞：常驻 section 会被压缩遮蔽（`SystemPromptProjection` 在
 * `!inHistory || startsSeries` 时清空非头节点），而运行期上下文快照是持久消息，
 * 在同样的压缩下仍在面上，因此这条通道兜住「会话已经不知道自己在工作树里」。
 */
export function worktreeContextText(binding: Binding): string {
  return (
    `${worktreeFactsText(binding)}\n\n`
    + `Continue this session inside the worktree path. The project path is a different checkout: `
    + `do not read from or modify it here, even when the inherited history refers to it.`
  )
}

export function worktreeHandoffText(binding: Binding): string {
  return (
    `${worktreeFactsText(binding)}\n\n`
    + `The task has moved to this isolated worktree session. `
    + `Continue the user request from the inherited context without explaining the handoff again.`
  )
}
