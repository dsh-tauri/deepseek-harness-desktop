import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SessionLedger, SummaryPayload, TurnFileChange, TurnRecord } from '../../../types'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../..'
import { LEDGER_VERSION } from '../../../config/constants'
import { ledger } from '../../../service/ledger'
import { workspace } from '../../../service/workspace'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

vi.mock('../../../service/ledger', () => ({ ledger: { load: vi.fn() } }))
vi.mock('../../../service/workspace', () => ({ workspace: { peek: vi.fn(), resolve: vi.fn() } }))

const SUMMARY_PATH = '/api/tauri/experimental/summary'

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

const servers: Server[] = []

const disposers: Array<() => void> = []

function fileAt(index: number): TurnFileChange {
  return { path: `f${index}.txt`, status: 'M', insertions: 1, deletions: 0, binary: false }
}

function turnAt(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turn: 1,
    beforeRef: 'refs/running-changes/s/1/before',
    afterRef: 'refs/running-changes/s/1/after',
    files: [],
    insertions: 0,
    deletions: 0,
    createdAt: 1,
    unavailable: null,
    ...overrides,
  }
}

function ledgerWith(turns: TurnRecord[]): SessionLedger {
  return {
    version: LEDGER_VERSION,
    sessionId: 'abc',
    workspaceRoot: 'C:/repo',
    isGit: true,
    unavailableReason: null,
    turns,
  }
}

async function summaryBase(): Promise<string> {
  const registered = new Map<string, WebRoute>()
  const ctx = {
    webServer: {
      register(route: WebRoute): () => void {
        registered.set(routeKey(route.kind, route.path), route)
        return () => {
          registered.delete(routeKey(route.kind, route.path))
        }
      },
    },
    logger: { error: () => {} },
  }
  disposers.push(server(ctx as unknown as Context))
  const route = registered.get(routeKey('exact', SUMMARY_PATH))
  if (route === undefined)
    throw new Error(`summary 路由未注册：${SUMMARY_PATH}`)

  const httpServer = createServer((request, response) => {
    Promise.resolve(route.handler(request, response)).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500)
        response.end()
      }
    })
  })
  servers.push(httpServer)
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
}

async function loadSummary(): Promise<{ status: number, payload: SummaryPayload }> {
  const base = await summaryBase()
  const response = await fetch(`${base}${SUMMARY_PATH}?sessionId=abc`)
  return { status: response.status, payload: await response.json() as SummaryPayload }
}

beforeEach(() => {
  vi.mocked(workspace.peek).mockReturnValue(true)
  vi.mocked(workspace.resolve).mockResolvedValue({ ok: true, root: 'C:/repo', commonDir: 'C:/repo/.git' })
  vi.mocked(ledger.load).mockResolvedValue(ledgerWith([turnAt()]))
})

afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose())
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('summary 200 载荷', () => {
  it('files 超过 200 条时截断为前 200 条，fileCount 仍是真实总数', async () => {
    vi.mocked(ledger.load).mockResolvedValue(ledgerWith([
      turnAt({ files: Array.from({ length: 201 }, (_, index) => fileAt(index)) }),
    ]))

    const { status, payload } = await loadSummary()

    expect(status).toBe(200)
    expect(payload.turns).toHaveLength(1)
    const row = payload.turns[0]
    expect(row?.truncated).toBe(true)
    expect(row?.fileCount).toBe(201)
    expect(row?.files).toHaveLength(200)
    expect(row?.files[0]?.path).toBe('f0.txt')
    expect(row?.files.at(-1)?.path).toBe('f199.txt')
  })

  it('恰好 200 条时不截断', async () => {
    vi.mocked(ledger.load).mockResolvedValue(ledgerWith([
      turnAt({ files: Array.from({ length: 200 }, (_, index) => fileAt(index)) }),
    ]))

    const { payload } = await loadSummary()

    const row = payload.turns[0]
    expect(row?.truncated).toBe(false)
    expect(row?.fileCount).toBe(200)
    expect(row?.files).toHaveLength(200)
    expect(row?.files.at(-1)?.path).toBe('f199.txt')
  })

  it('hasBaseline 只认非空 refs', async () => {
    vi.mocked(ledger.load).mockResolvedValue(ledgerWith([
      turnAt({ turn: 1, beforeRef: '', afterRef: '' }),
      turnAt({ turn: 2, beforeRef: 'refs/running-changes/s/2/before', afterRef: '' }),
      turnAt({ turn: 3, beforeRef: '', afterRef: 'refs/running-changes/s/3/after' }),
    ]))

    const { payload } = await loadSummary()

    expect(payload.turns.map(row => row.hasBaseline)).toEqual([false, true, true])
  })
})
