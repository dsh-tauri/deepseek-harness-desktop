import type { ReactElement } from 'react'
import type { SessionsRuntime, WorkspacesRuntime } from '../service/session-switch.types'
import type { WorktreeDialogProps } from './dialog.types'
import { Button, Input, Modal } from 'dsh-tauri-ui/client'
import { find } from 'dsh-tauri/client'
import { useCurrentSession } from '../hooks/use-current-session'
import { useDiscard } from '../hooks/use-discard'
import { useWaiter } from '../hooks/use-waiter'
import { useWorktreeSession } from '../hooks/use-worktree-session'
import { locale } from '../locales'
import { openSession, waitForSessionListed } from '../service/session-switch'
import { checkout } from '../service/worktree'
import { store } from '../store'

export function WorktreeDialog({ workspacesRuntime, sessionsRuntime }: WorktreeDialogProps): ReactElement | null {
  locale.useLocale()
  const sessionId = useCurrentSession(sessionsRuntime)
  const state = useWorktreeSession(sessionId)
  const discardWorktree = useDiscard(sessionId)
  const checkoutOpen = state.checkoutOpen
  const abandonOpen = state.abandonOpen
  const closeAll = (): void => store.worktree.patch(sessionId, { checkoutOpen: false, abandonOpen: false })

  if (!sessionId || (!checkoutOpen && !abandonOpen))
    return null

  return (
    <>
      {checkoutOpen && (
        <CheckoutDialog
          sessionId={sessionId}
          worktreeKey={state.worktreeKey}
          projectPath={state.projectPath}
          branchName={state.branchName}
          error={state.error}
          workspacesRuntime={workspacesRuntime}
          sessionsRuntime={sessionsRuntime}
          onCancel={closeAll}
        />
      )}
      {abandonOpen && (
        <AbandonDialog
          sessionId={sessionId}
          worktreeKey={state.worktreeKey}
          error={state.error}
          workspacesRuntime={workspacesRuntime}
          discardWorktree={discardWorktree}
          onCancel={closeAll}
        />
      )}
    </>
  )
}

function CheckoutDialog(props: {
  sessionId: string
  worktreeKey: string
  projectPath: string
  branchName: string
  error: string
  workspacesRuntime: WorkspacesRuntime
  sessionsRuntime: SessionsRuntime
  onCancel: () => void
}): ReactElement {
  const { sessionId, worktreeKey, projectPath, workspacesRuntime, sessionsRuntime, onCancel } = props
  const { wait } = useWaiter()
  const branchName = props.branchName || 'dsh/'
  const disabled = branchName.trim() === '' || branchName.trim().endsWith('/')

  const updateBranch = (value: string): void => store.worktree.patch(sessionId, { branchName: value, error: '' })

  const promoteToWorkspaceTop = async (targetSessionId: string): Promise<void> => {
    const workspace = find(workspacesRuntime.list.getSnapshot().items, item => item.path === projectPath)
    if (!workspace)
      return
    await workspacesRuntime.insertSessionBefore(
      workspace.workspaceId,
      targetSessionId,
      find(workspace.sessionIds, id => id !== targetSessionId),
    )
  }

  const confirm = async (): Promise<void> => {
    const result = await checkout({ sessionId, worktreeKey, branchName: branchName.trim() })
    if (!result.ok || !result.targetSessionId)
      return
    const targetSessionId = result.targetSessionId
    try {
      await waitForSessionListed({ sessions: sessionsRuntime, sessionId: targetSessionId, wait, attempts: 30, delayMs: 250 })
    }
    catch {
      store.worktree.patch(sessionId, { error: `Local session ${targetSessionId} was created but did not appear in the session list.` })
      return
    }
    await promoteToWorkspaceTop(targetSessionId).catch(() => {})
    await workspacesRuntime.archiveSession(sessionId).catch(() => {})
    const opened = await openSession({ sessions: sessionsRuntime, sessionId: targetSessionId, wait, attempts: 10, delayMs: 100 })
    if (!opened)
      store.worktree.patch(sessionId, { error: `Local session ${targetSessionId} could not be selected.` })
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={locale.text('checkoutTitle')}
      closeLabel={locale.text('close')}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{locale.text('checkoutCancel')}</Button>
          <Button variant="primary" disabled={disabled} onClick={() => void confirm()}>
            {locale.text('checkoutConfirm')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-[14px]">
        <div className="flex flex-col gap-[6px]">
          <label className="text-[12px] leading-[18px] text-[var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))]" htmlFor="wt-checkout-branch">{locale.text('checkoutBranchLabel')}</label>
          <Input
            id="wt-checkout-branch"
            value={branchName}
            placeholder={locale.text('branchPlaceholder')}
            onChange={event => updateBranch(event.target.value)}
          />
        </div>
        <div className="flex justify-between gap-[12px] text-[12px] leading-[18px]">
          <span className="flex-none text-[var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))]">{locale.text('checkoutCurrentPath')}</span>
          <span className="truncate [font-family:monospace]">{worktreeKey || '—'}</span>
        </div>
        <div className="flex justify-between gap-[12px] text-[12px] leading-[18px]">
          <span className="flex-none text-[var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))]">{locale.text('checkoutTargetPath')}</span>
          <span className="truncate [font-family:monospace]">{projectPath.replaceAll('\\', '/') || '—'}</span>
        </div>
        {props.error && <div className="text-[12px] leading-[18px] text-error">{props.error}</div>}
      </div>
    </Modal>
  )
}

function AbandonDialog(props: {
  sessionId: string
  worktreeKey: string
  error: string
  workspacesRuntime: Pick<WorkspacesRuntime, 'archiveSession'>
  discardWorktree: (input: { worktreeKey: string }) => Promise<{ ok: boolean, error?: string }>
  onCancel: () => void
}): ReactElement {
  const { sessionId, worktreeKey, workspacesRuntime, discardWorktree, onCancel } = props
  const abandon = async (): Promise<void> => {
    const result = await discardWorktree({ worktreeKey })
    if (!result.ok)
      return
    await workspacesRuntime.archiveSession(sessionId)
  }
  return (
    <Modal
      open
      onClose={onCancel}
      title={locale.text('abandonTitle')}
      description={locale.text('abandonBody')}
      closeLabel={locale.text('close')}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{locale.text('abandonCancel')}</Button>
          <Button variant="primary" onClick={() => void abandon()}>
            {locale.text('abandonConfirm')}
          </Button>
        </>
      )}
    >
      {props.error === '' ? undefined : <div className="text-[12px] leading-[18px] text-error">{props.error}</div>}
    </Modal>
  )
}
