import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agents } from './agents'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-extension-agents-'))
})

afterEach(() => {
  if (!home.startsWith(join(tmpdir(), 'dsh-extension-agents-')))
    throw new Error(`Unexpected scratch path: ${home}`)
  rmSync(home, { recursive: true, force: true })
})

function writeConfig(file: string, content: unknown): void {
  const path = join(home, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(content))
}

describe('agents.resolve', () => {
  it('returns no servers for an empty isolated home', () => {
    expect(agents.resolve(home)).toEqual([])
  })

  it('maps Cursor stdio and HTTP entries with filtered string fields', () => {
    writeConfig('.cursor/mcp.json', { mcpServers: {
      local: { command: 'node', args: ['server.js', 7], env: { TOKEN: 'value', invalid: 7 } },
      remote: { type: 'http', url: 'https://cursor.test/mcp', headers: { Authorization: 'token', invalid: false } },
      invalid: { command: '' },
      unsupported: { type: 'sse', url: 'https://cursor.test/sse' },
      missing: null,
    } })
    expect(agents.resolve(home)).toEqual([
      { agent: 'cursor', name: 'local', transport: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'value' } },
      { agent: 'cursor', name: 'remote', transport: 'streamable-http', url: 'https://cursor.test/mcp', headers: { Authorization: 'token' } },
    ])
  })

  it('uses Gemini httpUrl and gives its command precedence over the URL', () => {
    writeConfig('.gemini/settings.json', { mcpServers: {
      remote: { httpUrl: 'https://gemini.test/mcp' },
      local: { command: 'gemini-server', httpUrl: 'https://ignored.test', args: [], env: {} },
      wrongKey: { url: 'https://ignored.test' },
    } })
    expect(agents.resolve(home)).toEqual([
      { agent: 'gemini', name: 'remote', transport: 'streamable-http', url: 'https://gemini.test/mcp' },
      { agent: 'gemini', name: 'local', transport: 'stdio', command: 'gemini-server', args: undefined, env: undefined },
    ])
  })

  it('keeps Claude later invalid entries shadowing earlier valid entries', () => {
    writeConfig('.claude/settings.json', { mcpServers: { duplicate: { command: 'earlier' }, retained: { command: 'keep' } } })
    writeConfig('.claude.json', { mcpServers: { duplicate: { command: '' }, added: { command: 'later' } } })
    expect(agents.resolve(home)).toEqual([
      { agent: 'claude-code', name: 'retained', transport: 'stdio', command: 'keep', args: undefined, env: undefined },
      { agent: 'claude-code', name: 'added', transport: 'stdio', command: 'later', args: undefined, env: undefined },
    ])
  })

  it('keeps equal server names from distinct agents in source order', () => {
    writeConfig('.claude.json', { mcpServers: { shared: { command: 'claude' } } })
    writeConfig('.cursor/mcp.json', { mcpServers: { shared: { command: 'cursor' } } })
    writeConfig('.gemini/settings.json', { mcpServers: { shared: { command: 'gemini' } } })
    expect(agents.resolve(home).map(({ agent, name, command }) => ({ agent, name, command }))).toEqual([
      { agent: 'claude-code', name: 'shared', command: 'claude' },
      { agent: 'cursor', name: 'shared', command: 'cursor' },
      { agent: 'gemini', name: 'shared', command: 'gemini' },
    ])
  })

  it.each(['.cursor/mcp.json', '.gemini/settings.json'])('ignores malformed JSON in %s', (file) => {
    writeConfig(file, {})
    writeFileSync(join(home, file), '{')
    expect(agents.resolve(home)).toEqual([])
  })

  it.each(['.cursor/mcp.json', '.gemini/settings.json'])('ignores non-object mcpServers in %s', (file) => {
    writeConfig(file, { mcpServers: 'invalid' })
    expect(agents.resolve(home)).toEqual([])
  })

  it.each(['.cursor/mcp.json', '.gemini/settings.json'])('preserves the null-root rejection in %s', (file) => {
    writeConfig(file, null)
    expect(() => agents.resolve(home)).toThrow(TypeError)
  })

  it('continues past a null Claude root before reading its later file', () => {
    writeConfig('.claude/settings.json', null)
    writeConfig('.claude.json', { mcpServers: { valid: { command: 'later' } } })
    expect(agents.resolve(home)).toEqual([
      { agent: 'claude-code', name: 'valid', transport: 'stdio', command: 'later', args: undefined, env: undefined },
    ])
  })
})
