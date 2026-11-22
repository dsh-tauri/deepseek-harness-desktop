import type { Server } from 'node:http'
import type {
  McpAuthAttempt,
  McpAuthBackend,
  McpAuthCredentialStore,
  McpOAuthClient,
  McpOAuthDiscovery,
  McpOAuthGrant,
  McpOAuthProvider,
  McpOAuthSdk,
  McpOAuthTransport,
} from './mcp-auth.types'
import type { McpCheckResult, McpRow } from './mcp.types'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const CHECK_TIMEOUT_MS = 15_000
const AUTHORIZATION_TIMEOUT_MS = 300_000
const ATTEMPT_RETENTION_MS = 300_000
const MAX_PENDING_ATTEMPTS = 8
const DEFAULT_REDIRECT_URL = 'http://127.0.0.1/callback'

interface Interaction {
  state: string
  redirectUrl?: string
  verifier?: string
  authorizationUrl?: string
  clientInformation?: unknown
  discovery?: McpOAuthDiscovery
}

export function createMcpAuthBackend(sdk: McpOAuthSdk, credentials: McpAuthCredentialStore): McpAuthBackend {
  const attempts = new Map<string, McpAuthAttempt>()

  const endpoint = (row: McpRow): URL => {
    if (row.transport !== 'streamable-http')
      throw new Error('OAuth requires a streamable HTTP server')
    const url = new URL(row.url ?? '')
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '')
      throw new Error('Invalid MCP HTTP URL')
    return url
  }

  const keyOf = (row: McpRow): string =>
    `mcp-client/oauth-${createHash('sha256').update(`${row.serverName}\0${endpoint(row).href}`).digest('hex')}`

  const readGrant = async (key: string): Promise<McpOAuthGrant> => {
    const record = await credentials.readRecord(key)
    return record?.kind === 'grant' ? asGrant(record.payload) : {}
  }

  const writeGrant = (key: string, update: (current: McpOAuthGrant) => McpOAuthGrant): Promise<unknown> =>
    credentials.modifyRecord(key, async current => ({
      kind: 'grant',
      payload: update(current?.kind === 'grant' ? asGrant(current.payload) : {}),
    }))

  const provider = (key: string, interaction?: Interaction): McpOAuthProvider => {
    const interactive = interaction !== undefined
    const redirectUrl = (): string => interaction?.redirectUrl ?? DEFAULT_REDIRECT_URL
    return {
      get redirectUrl() {
        return redirectUrl()
      },
      get clientMetadata() {
        return {
          client_name: 'DSH Desktop',
          redirect_uris: [redirectUrl()],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }
      },
      async clientInformation() {
        return interactive ? interaction.clientInformation : (await readGrant(key)).clientInformation
      },
      async saveClientInformation(info) {
        if (interactive) {
          interaction.clientInformation = info
          return
        }
        await writeGrant(key, current => ({ ...current, clientInformation: info }))
      },
      async tokens() {
        return (await readGrant(key)).tokens
      },
      async saveTokens(tokens) {
        await writeGrant(key, current => ({
          ...current,
          tokens,
          ...(interactive
            ? { redirectUrl: interaction.redirectUrl, clientInformation: interaction.clientInformation, discovery: interaction.discovery }
            : {}),
        }))
      },
      state: () => interaction?.state,
      async saveCodeVerifier(verifier) {
        if (interactive)
          interaction.verifier = verifier
        else
          throw new sdk.UnauthorizedError('MCP authorization required')
      },
      codeVerifier() {
        if (interaction?.verifier === undefined)
          throw new Error('Missing OAuth PKCE verifier')
        return interaction.verifier
      },
      async redirectToAuthorization(url) {
        if (interactive)
          interaction.authorizationUrl = url.href
        else
          throw new sdk.UnauthorizedError('MCP authorization required')
      },
      async invalidateCredentials(scope) {
        await writeGrant(key, (current) => {
          const next: McpOAuthGrant = { ...current }
          if (scope === 'all' || scope === 'tokens' || scope === 'verifier')
            delete next.tokens
          if (scope === 'all' || scope === 'client')
            delete next.clientInformation
          if (scope === 'all' || scope === 'discovery')
            delete next.discovery
          return next
        })
      },
      async discoveryState() {
        return interactive ? interaction.discovery : (await readGrant(key)).discovery
      },
      async saveDiscoveryState(state) {
        if (interactive) {
          interaction.discovery = state
          return
        }
        await writeGrant(key, current => ({ ...current, discovery: state }))
      },
    }
  }

  const fetchWithin = (signal: AbortSignal | undefined) => (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([
        AbortSignal.timeout(CHECK_TIMEOUT_MS),
        ...(signal === undefined ? [] : [signal]),
        ...(init?.signal == null ? [] : [init.signal]),
      ]),
    })

  async function check(row: McpRow, timeoutMs = CHECK_TIMEOUT_MS): Promise<McpCheckResult> {
    let url: URL
    try {
      url = endpoint(row)
    }
    catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
    let client: McpOAuthClient | undefined
    let transport: McpOAuthTransport | undefined
    let unauthorized = false
    let httpStatus: number | undefined
    try {
      const signal = AbortSignal.timeout(timeoutMs)
      client = new sdk.Client({ name: 'dsh-desktop-check', version: '1' })
      transport = new sdk.StreamableHTTPClientTransport(url, {
        authProvider: provider(keyOf(row)),
        requestInit: { headers: row.headers },
        fetch: async (input, init) => {
          const response = await fetchWithin(signal)(input, init)
          httpStatus = response.status
          unauthorized ||= response.status === 401
          return response
        },
      })
      await client.connect(transport, { signal, timeout: timeoutMs })
      return { ok: true }
    }
    catch (error) {
      const requiresAuth = unauthorized
        || error instanceof sdk.UnauthorizedError
        || (sdk.InsufficientScopeError !== undefined && error instanceof sdk.InsufficientScopeError)
      if (requiresAuth)
        return { ok: false, detail: 'MCP authorization required', requiresAuth: true }
      return { ok: false, detail: httpStatus === undefined ? 'MCP initialization failed' : `MCP initialization failed (HTTP ${httpStatus})` }
    }
    finally {
      await Promise.resolve(client?.transport === undefined ? transport?.close() : client?.close()).catch(() => {})
    }
  }

  async function start(row: McpRow): Promise<{ authorizationUrl: string, attemptId: string }> {
    const url = endpoint(row)
    if ([...attempts.values()].filter(attempt => attempt.status === 'pending').length >= MAX_PENDING_ATTEMPTS)
      throw new Error('Too many pending MCP authorizations')

    const attemptId = randomBytes(32).toString('hex')
    const interaction: Interaction = { state: randomBytes(32).toString('hex') }
    const attempt: McpAuthAttempt = { status: 'pending' }
    const controller = new AbortController()
    let consumed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let listener: Server | undefined
    let transport: McpOAuthTransport | undefined
    let stage = 'MCP initialization'
    let httpStatus: number | undefined

    const failure = (error: unknown): string => {
      if (sdk.IssuerMismatchError !== undefined && error instanceof sdk.IssuerMismatchError)
        return 'MCP OAuth authorization server validation failed'
      if (sdk.InsecureTokenEndpointError !== undefined && error instanceof sdk.InsecureTokenEndpointError)
        return 'MCP OAuth requires a secure token endpoint'
      if (error instanceof Error && /^(?:MCP authorization timed out|MCP authorization required|OAuth authorization denied|Missing OAuth authorization code|MCP server did not request OAuth authorization|MCP initialization failed(?: \(HTTP [45]\d{2}\))?)$/.test(error.message))
        return error.message
      const status = httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`
      if (sdk.RegistrationRejectedError !== undefined && error instanceof sdk.RegistrationRejectedError)
        return `MCP OAuth client registration failed${status}`
      return `${stage} failed${status}`
    }

    const finish = (message?: string): void => {
      clearTimeout(timer)
      controller.abort()
      listener?.close()
      listener?.closeAllConnections()
      if (message !== undefined) {
        attempt.status = 'error'
        attempt.error = message
      }
      interaction.verifier = undefined
      interaction.state = ''
      setTimeout(() => attempts.delete(attemptId), ATTEMPT_RETENTION_MS).unref()
    }

    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = new URL(input instanceof Request ? input.url : input)
      const metadata = interaction.discovery?.authorizationServerMetadata
      const authorizationServer = interaction.discovery?.authorizationServerUrl
      if (target.href === metadata?.registration_endpoint || (metadata?.registration_endpoint === undefined && authorizationServer !== undefined && target.href === new URL('/register', authorizationServer).href))
        stage = 'MCP OAuth client registration'
      else if (target.href === metadata?.token_endpoint || (metadata?.token_endpoint === undefined && authorizationServer !== undefined && target.href === new URL('/token', authorizationServer).href))
        stage = 'MCP OAuth token exchange'
      else
        stage = target.href === url.href ? 'MCP initialization' : 'MCP OAuth server discovery'
      httpStatus = undefined
      const response = await fetchWithin(controller.signal)(input, init)
      httpStatus = response.status
      return response
    }

    listener = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      let callback: URL
      try {
        callback = new URL(req.url ?? '/', interaction.redirectUrl)
      }
      catch {
        res.writeHead(400).end('Invalid OAuth callback')
        return
      }
      if (req.method !== 'GET' || req.headers.host !== new URL(interaction.redirectUrl ?? DEFAULT_REDIRECT_URL).host || callback.pathname !== '/callback' || consumed || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== interaction.state) {
        res.writeHead(400).end('Invalid OAuth callback')
        return
      }
      consumed = true
      try {
        if (callback.searchParams.has('error'))
          throw new Error('OAuth authorization denied')
        if (callback.searchParams.getAll('code').length !== 1 || callback.searchParams.get('code') === null)
          throw new Error('Missing OAuth authorization code')
        await transport?.finishAuth(callback.searchParams)
        const result = await check(row)
        controller.signal.throwIfAborted()
        if (!result.ok)
          throw new Error(result.detail ?? 'MCP initialization failed after authorization')
        attempt.status = 'authorized'
        res.end('MCP authorized. You can close this window.')
        finish()
      }
      catch (error) {
        res.writeHead(400).end('MCP authorization failed. Return to DSH for details.')
        finish(failure(error))
      }
    })

    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', resolve)
    })
    const address = listener.address()
    if (address === null || typeof address === 'string')
      throw new Error('MCP OAuth callback listener could not bind')
    interaction.redirectUrl = `http://127.0.0.1:${address.port}/callback`
    attempts.set(attemptId, attempt)
    timer = setTimeout(finish, AUTHORIZATION_TIMEOUT_MS, 'MCP authorization timed out')
    timer.unref()

    try {
      transport = new sdk.StreamableHTTPClientTransport(url, {
        authProvider: provider(keyOf(row), interaction),
        requestInit: { headers: row.headers },
        fetch: request,
      })
      const client = new sdk.Client({ name: 'dsh-desktop-auth', version: '1' })
      try {
        await client.connect(transport, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), timeout: CHECK_TIMEOUT_MS })
      }
      catch (error) {
        if (interaction.authorizationUrl === undefined)
          throw error
      }
      finally {
        await Promise.resolve(client.transport === undefined ? transport.close() : client.close()).catch(() => {})
      }
      if (interaction.authorizationUrl === undefined)
        throw new Error('MCP server did not request OAuth authorization')
      return { authorizationUrl: interaction.authorizationUrl, attemptId }
    }
    catch (error) {
      const message = failure(error)
      finish(message)
      throw Object.assign(new Error(message), { code: 'MCP_OAUTH_START_FAILED' })
    }
  }

  return {
    check,
    start,
    lookup: attemptId => attempts.get(attemptId),
  }
}

function asGrant(payload: unknown): McpOAuthGrant {
  return typeof payload === 'object' && payload !== null ? payload as McpOAuthGrant : {}
}
