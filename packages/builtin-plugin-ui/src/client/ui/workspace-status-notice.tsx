import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactElement } from 'react'
import type { PostApiTauriUiSessionWorkspaceStatusResponse } from '../apis/index.type'
import { useEffect, useState } from 'react'
import { postSessionWorkspaceStatus } from '../apis'
import { Button } from '../components/button'
import { Notice } from '../components/notice'
import { locale } from '../locales'

interface WorkspaceStatusNoticeProps {
  sessionId: PropsRuntime<'conversation.composer.dock'>['sessionId']
  chooseFolder: () => Promise<{ status: string }>
}

export function WorkspaceStatusNotice(props: WorkspaceStatusNoticeProps): ReactElement {
  return <SessionNotice key={props.sessionId} {...props} />
}

function SessionNotice({ sessionId, chooseFolder }: WorkspaceStatusNoticeProps): ReactElement | null {
  const [problem, setProblem] = useState<Extract<PostApiTauriUiSessionWorkspaceStatusResponse, { cwd: string }>>()
  const [choosing, setChoosing] = useState(false)
  const [chooseFailed, setChooseFailed] = useState(false)
  locale.useLocale()

  useEffect(() => {
    let request: AbortController | undefined
    const refresh = () => {
      request?.abort()
      request = new AbortController()
      const { signal } = request
      void postSessionWorkspaceStatus({ sessionId }, { signal }).then((result) => {
        if (signal.aborted)
          return
        setProblem('cwd' in result ? result : undefined)
      }).catch((error: unknown) => {
        if (!signal.aborted)
          console.warn('dsh-tauri-ui: workspace status check failed', error)
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      request?.abort()
      window.removeEventListener('focus', refresh)
    }
  }, [sessionId])

  if (problem === undefined)
    return null

  async function startNewChat(): Promise<void> {
    setChoosing(true)
    setChooseFailed(false)
    try {
      const result = await chooseFolder()
      setChooseFailed(result.status === 'unavailable')
    }
    catch {
      setChooseFailed(true)
    }
    finally {
      setChoosing(false)
    }
  }

  return (
    <Notice kind="error">
      <div className="min-w-0 wrap-anywhere">
        <p>{locale.text(problem.status === 'missing' ? 'workspaceMissing' : 'workspaceNotDirectory', { path: problem.cwd })}</p>
        <p>{locale.text('workspaceRecovery')}</p>
        <Button variant="link" disabled={choosing} onClick={() => void startNewChat()}>
          {locale.text('workspaceChooseFolder')}
        </Button>
        {chooseFailed && <p>{locale.text('workspaceChooseFailed')}</p>}
      </div>
    </Notice>
  )
}
