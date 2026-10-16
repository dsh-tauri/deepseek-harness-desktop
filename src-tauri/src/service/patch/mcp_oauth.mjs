import { createHash as oauthHash, randomBytes as oauthRandom } from 'node:crypto'
import { createServer as oauthServer } from 'node:http'

const oauthInstances = new WeakMap()

export function desktopMcpOAuth(sdk, credentials) {
  if (oauthInstances.has(credentials))
    return oauthInstances.get(credentials)
  const attempts = new Map()
  const endpoint = (row) => {
    if (row.transport !== 'streamable-http')
      throw new Error('OAuth requires a streamable HTTP server')
    const url = new URL(row.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error('Invalid MCP HTTP URL')
    return url
  }
  const keyOf = row => `mcp-client/oauth-${oauthHash('sha256').update(`${row.serverName}\0${endpoint(row).href}`).digest('hex')}`
  const read = async key => (await credentials.readRecord(key))?.payload ?? {}
  const write = (key, update) => credentials.modifyRecord(key, async current => ({ kind: 'grant', payload: update(current?.payload ?? {}) }))
  const fetchWithin = signal => (url, init) => fetch(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]) })
  function provider(row, interaction, signal) {
    const key = keyOf(row)
    const make = (load, save, interactive) => ({
      get redirectUrl() { return interaction?.redirectUrl ?? 'http://127.0.0.1/callback' },
      get clientMetadata() {
        return { client_name: 'DSH Desktop', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
      },
      clientInformation: async () => interaction ? interaction.clientInformation : (await load()).clientInformation,
      saveClientInformation: async (info) => {
        if (interaction)
          interaction.clientInformation = info
        else
          await save(data => ({ ...data, clientInformation: info }))
      },
      discoveryState: async () => interaction?.discovery ?? (await load()).discovery,
      saveDiscoveryState: async (discovery) => {
        if (interaction)
          interaction.discovery = discovery
        else
          await save(data => ({ ...data, discovery }))
      },
      tokens: async () => (await load()).tokens,
      saveTokens: tokens => save(data => ({ ...data, tokens, expiresAt: typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined, ...(interaction ? { redirectUrl: interaction.redirectUrl, clientInformation: interaction.clientInformation, discovery: interaction.discovery } : {}) })),
      state: () => interaction?.state,
      saveCodeVerifier: async (value) => {
        if (!interactive)
          throw new sdk.UnauthorizedError('MCP authorization required')
        interaction.verifier = value
      },
      codeVerifier: () => {
        if (!interaction?.verifier)
          throw new Error('Missing OAuth PKCE verifier')
        return interaction.verifier
      },
      redirectToAuthorization: async (url) => {
        if (!interactive)
          throw new sdk.UnauthorizedError('MCP authorization required')
        interaction.authorizationUrl = url.href
      },
      invalidateCredentials: async scope => save((data) => {
        const next = { ...data }
        delete next.tokens
        delete next.expiresAt
        if (scope === 'client')
          delete next.clientInformation
        return next
      }),
    })
    const result = make(() => read(key), update => write(key, update), Boolean(interaction))
    result.tokens = async () => {
      let data = await read(key)
      if (data.tokens?.refresh_token && data.expiresAt !== undefined && data.expiresAt <= Date.now() + 30000) {
        await credentials.modifyRecord(key, async (current) => {
          let locked = current?.payload ?? {}
          if (!locked.tokens?.refresh_token || locked.expiresAt === undefined || locked.expiresAt > Date.now() + 30000)
            return undefined
          if (!locked.clientInformation)
            throw new sdk.UnauthorizedError('MCP authorization required')
          const transaction = make(async () => locked, async (update) => {
            locked = update(locked)
          }, false)
          Object.defineProperty(transaction, 'redirectUrl', { get: () => locked.redirectUrl ?? 'http://127.0.0.1/callback' })
          await sdk.auth(transaction, { serverUrl: endpoint(row), fetchFn: fetchWithin(signal) })
          return { kind: 'grant', payload: locked }
        })
        data = await read(key)
      }
      if (!data.tokens)
        return undefined
      const { refresh_token: omitted, ...tokens } = data.tokens
      return tokens
    }
    if (interaction)
      return result
    let sentToken
    return {
      token: async () => {
        sentToken = (await result.tokens())?.access_token
        return sentToken
      },
      onUnauthorized: async (context) => {
        await credentials.modifyRecord(key, async (current) => {
          let locked = current?.payload ?? {}
          if (locked.tokens?.access_token && locked.tokens.access_token !== sentToken)
            return undefined
          if (!locked.tokens?.refresh_token || !locked.clientInformation)
            throw new sdk.UnauthorizedError('MCP authorization required')
          const transaction = make(async () => locked, async (update) => {
            locked = update(locked)
          }, false)
          Object.defineProperty(transaction, 'redirectUrl', { get: () => locked.redirectUrl ?? 'http://127.0.0.1/callback' })
          const challenge = sdk.extractWWWAuthenticateParams(context.response)
          await sdk.auth(transaction, { serverUrl: endpoint(row), ...challenge, fetchFn: fetchWithin(signal) })
          return { kind: 'grant', payload: locked }
        })
      },
    }
  }
  async function check(row, timeoutMs = 15000) {
    let client
    let transport
    let unauthorized = false
    let httpStatus
    try {
      const url = endpoint(row)
      const signal = AbortSignal.timeout(timeoutMs)
      client = new sdk.Client({ name: 'dsh-desktop-check', version: '1' })
      transport = new sdk.StreamableHTTPClientTransport(url, {
        authProvider: provider(row, undefined, signal),
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
      const requiresAuth = unauthorized || error instanceof sdk.UnauthorizedError || Boolean(sdk.InsufficientScopeError && error instanceof sdk.InsufficientScopeError)
      return { ok: false, detail: requiresAuth ? 'MCP authorization required' : httpStatus ? `MCP initialization failed (HTTP ${httpStatus})` : 'MCP initialization failed', ...(requiresAuth ? { requiresAuth: true } : {}) }
    }
    finally {
      await Promise.resolve(client?.transport ? client.close() : transport?.close()).catch(() => {})
    }
  }
  async function start(row) {
    endpoint(row)
    if ([...attempts.values()].filter(attempt => attempt.status === 'pending').length >= 8)
      throw new Error('Too many pending MCP authorizations')
    const attemptId = oauthRandom(32).toString('hex')
    const interaction = { state: oauthRandom(32).toString('hex') }
    const attempt = { status: 'pending' }
    const controller = new AbortController()
    let consumed = false
    let timer
    let transport
    let listener
    const finish = (error) => {
      clearTimeout(timer)
      controller.abort()
      listener.close()
      listener.closeAllConnections()
      if (error) {
        attempt.status = 'error'
        attempt.error = error instanceof Error && ['MCP authorization timed out', 'OAuth authorization denied', 'Missing OAuth authorization code', 'MCP initialization failed'].some(prefix => error.message.startsWith(prefix)) ? error.message : 'MCP authorization failed'
      }
      interaction.verifier = undefined
      interaction.state = undefined
      setTimeout(() => attempts.delete(attemptId), 300000).unref()
    }
    listener = oauthServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      let url
      try {
        url = new URL(req.url ?? '/', interaction.redirectUrl)
      }
      catch {
        res.writeHead(400).end('Invalid OAuth callback')
        return
      }
      if (req.method !== 'GET' || req.headers.host !== new URL(interaction.redirectUrl).host || url.pathname !== '/callback' || consumed || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== interaction.state) {
        res.writeHead(400).end('Invalid OAuth callback')
        return
      }
      consumed = true
      try {
        if (url.searchParams.has('error'))
          throw new Error('OAuth authorization denied')
        if (url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code'))
          throw new Error('Missing OAuth authorization code')
        await transport.finishAuth(url.searchParams)
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
        finish(error)
      }
    })
    await new Promise((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', resolve)
    })
    interaction.redirectUrl = `http://127.0.0.1:${listener.address().port}/callback`
    attempts.set(attemptId, attempt)
    timer = setTimeout(() => finish(new Error('MCP authorization timed out')), 300000)
    timer.unref()
    try {
      transport = new sdk.StreamableHTTPClientTransport(endpoint(row), { authProvider: provider(row, interaction, controller.signal), requestInit: { headers: row.headers }, fetch: fetchWithin(controller.signal) })
      const client = new sdk.Client({ name: 'dsh-desktop-auth', version: '1' })
      try {
        await client.connect(transport, { signal: AbortSignal.timeout(15000), timeout: 15000 })
      }
      catch (error) {
        if (!interaction.authorizationUrl)
          throw error
      }
      finally {
        await (client.transport ? client.close() : transport.close()).catch(() => {})
      }
      if (!interaction.authorizationUrl)
        throw new Error('MCP server did not request OAuth authorization')
      return { authorizationUrl: interaction.authorizationUrl, attemptId }
    }
    catch (error) {
      finish(error)
      throw new Error('MCP OAuth authorization could not start')
    }
  }
  const api = { provider, check, start, lookup: id => attempts.get(id) ? { ...attempts.get(id) } : undefined }
  oauthInstances.set(credentials, api)
  return api
}
