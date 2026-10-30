import type { ServiceLookup } from '../models/remote.ts'
import type { SessionRemote, WorkspacePathApplication } from '../types/remotes.ts'
import { ofetch } from 'dsh-tauri/client'
import { postConfigOpen } from '../apis'
import { resolveRemote } from '../models/remote.ts'

const CATALOG_PATH = '/open-in-app/apps'
const ICON_PREFIX = '/open-in-app/icon'

const APPLICATION_NAMES: Record<string, string | undefined> = {
  finder: 'Finder',
  explorer: 'File Explorer',
  filemanager: 'File Manager',
  cursor: 'Cursor',
  vscode: 'Visual Studio Code',
  vscodeinsiders: 'VS Code Insiders',
  windsurf: 'Windsurf',
  zed: 'Zed',
  sublimetext: 'Sublime Text',
  xcode: 'Xcode',
  androidstudio: 'Android Studio',
  intellij: 'IntelliJ IDEA',
  pycharm: 'PyCharm',
  webstorm: 'WebStorm',
  phpstorm: 'PhpStorm',
  goland: 'GoLand',
  rider: 'Rider',
  rustrover: 'RustRover',
  fork: 'Fork',
  sourcetree: 'Sourcetree',
}

let lookup: ServiceLookup | undefined

export function configureOpenInApp(next: ServiceLookup): void {
  lookup = next
}

type OpenInAppSession = SessionRemote & Required<Pick<SessionRemote, 'openWorkspacePath'>>

function openInAppSession(): OpenInAppSession | undefined {
  const session = lookup === undefined ? undefined : resolveRemote(lookup)?.session
  if (session?.openWorkspacePath === undefined)
    return undefined
  return session as OpenInAppSession
}

async function configPath(): Promise<string | undefined> {
  try {
    const response = await postConfigOpen({ dry: '1' }, { ignoreResponseError: true })
    return response.ok === true && typeof response.path === 'string' && response.path.length > 0 ? response.path : undefined
  }
  catch {
    return undefined
  }
}

export async function listConfigApplications(): Promise<readonly WorkspacePathApplication[]> {
  const session = openInAppSession()
  if (session === undefined)
    return []
  const path = await configPath()
  if (path === undefined)
    return []
  try {
    const payload = await ofetch<{ apps?: unknown }>(CATALOG_PATH)
    if (!Array.isArray(payload.apps))
      return []
    return payload.apps
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map(id => ({
        id,
        name: APPLICATION_NAMES[id] ?? id,
        default: false,
        icon: `${ICON_PREFIX}/${id}`,
      }))
  }
  catch {
    return []
  }
}

export async function openConfigInApp(application: string): Promise<boolean> {
  const session = openInAppSession()
  if (session === undefined)
    return false
  const path = await configPath()
  if (path === undefined)
    return false
  try {
    const result = await session.openWorkspacePath({ path, application })
    return result.ok
  }
  catch {
    return false
  }
}
