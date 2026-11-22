import type { McpCheckResult, McpRow } from './mcp.types'

export interface McpAuthAttempt {
  status: 'pending' | 'authorized' | 'error'
  error?: string
}

export interface McpAuthBackend {
  check: (row: McpRow, timeoutMs: number) => Promise<McpCheckResult>
  start: (row: McpRow) => Promise<{ authorizationUrl: string, attemptId: string }>
  lookup: (attemptId: string) => McpAuthAttempt | undefined
}

export interface McpOAuthTokens {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  issuer?: string
}

export interface McpOAuthGrant {
  clientInformation?: unknown
  discovery?: McpOAuthDiscovery
  tokens?: McpOAuthTokens
  redirectUrl?: string
}

export interface McpOAuthDiscovery {
  authorizationServerUrl?: string
  authorizationServerMetadata?: {
    registration_endpoint?: string
    token_endpoint?: string
  }
}

export interface McpAuthCredentialStore {
  readRecord: (key: string) => Promise<{ kind?: string, payload?: unknown } | undefined>
  modifyRecord: (
    key: string,
    mutate: (current: { kind?: string, payload?: unknown } | undefined) => Promise<{ kind: 'grant', payload: unknown } | undefined>,
  ) => Promise<unknown>
}

export interface McpOAuthProvider {
  readonly redirectUrl: string
  readonly clientMetadata: {
    client_name: string
    redirect_uris: string[]
    grant_types: string[]
    response_types: string[]
    token_endpoint_auth_method: string
  }
  clientInformation: () => Promise<unknown>
  saveClientInformation: (info: unknown) => Promise<void>
  tokens: () => Promise<McpOAuthTokens | undefined>
  saveTokens: (tokens: McpOAuthTokens) => Promise<void>
  state: () => string | undefined
  saveCodeVerifier: (verifier: string) => Promise<void>
  codeVerifier: () => string
  redirectToAuthorization: (url: URL) => Promise<void>
  invalidateCredentials: (scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') => Promise<void>
  discoveryState: () => Promise<McpOAuthDiscovery | undefined>
  saveDiscoveryState: (state: McpOAuthDiscovery) => Promise<void>
}

export interface McpOAuthTransport {
  finishAuth: (params: URLSearchParams) => Promise<void>
  close: () => Promise<void>
}

export interface McpOAuthClient {
  connect: (transport: McpOAuthTransport, options?: { signal?: AbortSignal, timeout?: number }) => Promise<void>
  close: () => Promise<void>
  transport?: McpOAuthTransport
}

export interface McpOAuthTransportOptions {
  authProvider?: McpOAuthProvider
  requestInit?: { headers?: Record<string, string> }
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export interface McpOAuthSdk {
  Client: new (info: { name: string, version: string }) => McpOAuthClient
  StreamableHTTPClientTransport: new (url: URL, options: McpOAuthTransportOptions) => McpOAuthTransport
  UnauthorizedError: new (message?: string) => Error
  InsufficientScopeError?: new (message?: string) => Error
  IssuerMismatchError?: new (message?: string) => Error
  InsecureTokenEndpointError?: new (message?: string) => Error
  RegistrationRejectedError?: new (message?: string) => Error
}
