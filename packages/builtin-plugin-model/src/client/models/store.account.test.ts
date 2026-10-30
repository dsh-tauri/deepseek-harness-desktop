import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientRemote, CredentialInfo, RemoteResult, SettingsNamespaceView } from '../types/remotes.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T>(initial: T) => {
    const snapshot = initial
    return {
      getSnapshot: () => snapshot,
      update: (mutate: (draft: T) => void) => {
        mutate(snapshot)
        return snapshot
      },
      subscribe: () => () => {},
    }
  },
}))

const { joinProviderDirectory, ModelsSettingsStore, onboardingReadiness, providerUsable } = await import('./store.ts')

const ACCOUNT: SettingsNamespaceView = {
  ns: 'llm-deepseek-account',
  schema: {},
  value: {},
  applies: 'live',
  secrets: [],
  revision: 1,
}

const OFFICIAL: SettingsNamespaceView = {
  ns: 'llm-deepseek',
  schema: {},
  value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  applies: 'live',
  secrets: [],
  revision: 2,
}

function schema(): SettingsSchemaOperations {
  const readPath = (value: unknown, path: readonly string[]): unknown =>
    path.reduce<unknown>((current, key) => (typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined), value)
  return {
    rehydrate: (value: unknown) => value,
    validate: () => undefined,
    nodeAtPath: (value: unknown) => value,
    getPath: readPath,
    hasPath: (value: unknown, path: readonly string[]) => readPath(value, path) !== undefined,
    setPath: (value: unknown) => value,
    deletePath: (value: unknown) => value,
  } as unknown as SettingsSchemaOperations
}

function describeFace(namespaces: SettingsNamespaceView[]): SettingsDescribeFace {
  return {
    getSnapshot: () => ({
      status: 'ready',
      view: { namespaces, writable: true, hasDocument: true },
      error: null,
    }),
    subscribe: () => () => {},
    ensure: async () => {},
    acceptView: () => {},
  } as unknown as SettingsDescribeFace
}

interface RemoteOptions {
  credentials?: Record<string, CredentialInfo>
  accountModels?: number
  withoutCatalog?: boolean
  describeCalls?: string[][]
}

function remote(options: RemoteOptions = {}): ClientRemote {
  const credentials = options.credentials ?? {}
  return {
    settings: {
      mutate: async () => ok(OFFICIAL),
    },
    llm: {
      listProviders: async () => ok([{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'deepseek-account', name: 'DeepSeek Account' }]),
      listConfigurableProviders: async () => ok([
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
        { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
      ]),
      discoverModels: async () => ok([]),
    },
    credentials: {
      describe: async (refs) => {
        options.describeCalls?.push([...refs])
        return ok(Object.fromEntries(refs.map(ref => [ref, credentials[ref] ?? { configured: false, writable: true }])))
      },
      set: async () => ok(undefined),
      unset: async () => ok(undefined),
    },
    session: options.withoutCatalog === true
      ? {} as ClientRemote['session']
      : {
          modelCatalog: async () => ok({
            default: { provider: 'deepseek-official', model: 'deepseek-flash' },
            routableProviders: [],
            groups: options.accountModels === undefined || options.accountModels === 0
              ? []
              : [{ id: 'deepseek-account', name: 'DeepSeek Account', models: Array.from({ length: options.accountModels }, (_, index) => ({ id: `m${index}`, name: `M${index}` })) }],
          }),
        },
    $on: () => () => {},
  } as ClientRemote
}

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

async function load(options: RemoteOptions, namespaces: SettingsNamespaceView[] = [OFFICIAL, ACCOUNT]) {
  const store = new ModelsSettingsStore(remote(options), schema(), describeFace(namespaces))
  await store.load()
  return store.store.getSnapshot()
}

describe('joinProviderDirectory', () => {
  it('账号与官方置顶，其余保持声明顺序', () => {
    const rows = joinProviderDirectory(
      [{ id: 'zeta', name: 'Zeta' }],
      [
        { provider: 'alpha', displayName: 'Alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
        { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
      ],
    )

    expect(rows.map(row => row.provider)).toEqual(['deepseek-account', 'deepseek-official', 'alpha', 'zeta'])
  })
})

describe('账号路由的行投影', () => {
  it('不读账号的 apiKeyEnv，也不为它取派生凭据', async () => {
    const describeCalls: string[][] = []
    const state = await load({ credentials: { DEEPSEEK_API_KEY: { configured: true, writable: true } }, accountModels: 2, describeCalls })

    const account = state.rows.find(row => row.entry.provider === 'deepseek-account')
    expect(account?.apiKeyEnv).toBeUndefined()
    expect(account?.credential).toBeUndefined()
    expect(describeCalls.flat()).not.toContain('DEEPSEEK_ACCOUNT_API_KEY')
    expect(describeCalls.flat()).toContain('DEEPSEEK_API_KEY')
  })

  it('已登录（账号分组有模型）时账号行可用且置顶', async () => {
    const state = await load({ accountModels: 2 })

    expect(state.rows[0]?.entry.provider).toBe('deepseek-account')
    expect(providerUsable(state.rows[0]!)).toBe(true)
    expect(onboardingReadiness(state).kind).toBe('provider-ready')
  })

  it('未登录（账号分组为空）时账号行隐去，官方路由转入 setup', async () => {
    const state = await load({ accountModels: 0 })

    expect(state.rows.map(row => row.entry.provider)).toEqual(['deepseek-official'])
    expect(onboardingReadiness(state).kind).toBe('credential-missing')
  })

  it('老核心没有 session.modelCatalog 时按未登录处理，不中断页面', async () => {
    const state = await load({ withoutCatalog: true })

    expect(state.status).toBe('ready')
    expect(state.rows.map(row => row.entry.provider)).toEqual(['deepseek-official'])
  })
})

describe('失败降级', () => {
  it('模型目录读取抛错时仍发布快照', async () => {
    const broken = remote({ accountModels: 1 })
    broken.session.modelCatalog = vi.fn(async () => {
      throw new Error('disconnected')
    })
    const store = new ModelsSettingsStore(broken, schema(), describeFace([OFFICIAL, ACCOUNT]))

    await store.load()

    expect(store.store.getSnapshot().status).toBe('ready')
  })
})
