import type { Binding } from '../types'

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
    + `leaving the source repository untouched.`
  )
}

export function worktreeContextText(binding: Binding): string {
  return (
    `${worktreeFactsText(binding)}\n\n`
    + `Continue this session inside the worktree path. The project path is a different checkout: `
    + `do not read from or modify it here, even when the inherited history refers to it.`
  )
}
