import { worktree } from '../service/worktree'

export async function handleToolsExecute(exec: any, next: () => Promise<any>): Promise<any> {
  await worktree.detach(exec).catch(() => {})
  return next()
}
