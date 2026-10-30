import type { McpInput } from './mcp.types'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { mcp } from './mcp'
import { normalizeStdioCommand, splitCommandLine } from './mcp.utils'

const HAND_EDITED = `- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config:
        serverName: github
        transport: stdio
        command: npx
        args: [-y, '@modelcontextprotocol/server-github']
        cwd: /srv/github
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
          PORT: 3000
        timeout: 30000
`

const GITHUB_ROW = {
  id: 'mcp-github',
  name: '@deepseek-ai/dsh-mcp-client',
  disabled: true,
  config: {
    serverName: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    cwd: '/srv/github',
    env: { GITHUB_TOKEN: 'process.env.GITHUB_TOKEN', PORT: 3000 },
    timeout: 30000,
  },
}

function patchDir(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-row-'))
  writeFileSync(join(dir, 'cordis.patch.yml'), content)
  return dir
}

function readPatch(dir: string): string {
  return readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
}

function savedRows(dir: string): unknown[] {
  return parseDocument(readPatch(dir)).toJS()[0].insert
}

function editorInput(dir: string): McpInput {
  const [row] = mcp.peek(dir)
  return { id: row.id, serverName: row.serverName, transport: row.transport, command: row.command, args: row.args ?? [], env: row.env ?? {} }
}

describe('splitCommandLine', () => {
  it('keeps quoted segments intact', () => {
    expect(splitCommandLine('"C:/Program Files/node.exe" --experimental')).toEqual(['C:/Program Files/node.exe', '--experimental'])
    expect(splitCommandLine('\'a b\' c')).toEqual(['a b', 'c'])
  })

  it('drops empty segments', () => {
    expect(splitCommandLine('  npx   -y   ')).toEqual(['npx', '-y'])
  })
})

describe('normalizeStdioCommand', () => {
  it('splits a whole command line into command and args', () => {
    expect(normalizeStdioCommand('npx -y @heroui/react-mcp@latest', undefined))
      .toEqual({ command: 'npx', args: ['-y', '@heroui/react-mcp@latest'] })
  })

  it('splits when args is present but empty', () => {
    expect(normalizeStdioCommand('npx -y @heroui/react-mcp@latest', []))
      .toEqual({ command: 'npx', args: ['-y', '@heroui/react-mcp@latest'] })
  })

  it('keeps explicit args untouched', () => {
    expect(normalizeStdioCommand('npx', ['-y', '@heroui/react-mcp@latest']))
      .toEqual({ command: 'npx', args: ['-y', '@heroui/react-mcp@latest'] })
  })

  it('leaves a bare executable alone', () => {
    expect(normalizeStdioCommand('node', undefined)).toEqual({ command: 'node' })
    expect(normalizeStdioCommand('', undefined)).toEqual({ command: '' })
  })

  it('leaves an existing path containing spaces alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh mcp '))
    const executable = join(dir, 'my server.exe')
    writeFileSync(executable, '')
    expect(normalizeStdioCommand(executable, undefined)).toEqual({ command: executable })
  })
})

describe('mcp.save', () => {
  it('persists a whole command line as command plus args', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-save-'))
    mcp.save(dir, {
      id: '',
      serverName: 'heroui-react',
      transport: 'stdio',
      command: 'npx -y @heroui/react-mcp@latest',
    })
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('command: npx')
    expect(patch).not.toContain('npx -y @heroui')
    expect(patch).toContain('@heroui/react-mcp@latest')
  })

  it('keeps !!js values an edit left unchanged', () => {
    const dir = patchDir(HAND_EDITED)
    mcp.save(dir, editorInput(dir))
    expect(readPatch(dir)).toContain('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN')
  })

  it('keeps the row fields the editor does not show', () => {
    const dir = patchDir(HAND_EDITED)
    mcp.save(dir, editorInput(dir))
    expect(savedRows(dir)).toEqual([GITHUB_ROW])
  })

  it('saves an edited value as plain text', () => {
    const dir = patchDir(HAND_EDITED)
    mcp.save(dir, { ...editorInput(dir), env: { GITHUB_TOKEN: 'ghp_literal', PORT: '3000' } })
    expect(readPatch(dir)).toContain('GITHUB_TOKEN: ghp_literal')
  })

  it('applies env keys added or removed in the editor', () => {
    const dir = patchDir(HAND_EDITED)
    mcp.save(dir, { ...editorInput(dir), env: { GITHUB_TOKEN: 'process.env.GITHUB_TOKEN', MODE: 'dev' } })
    expect(savedRows(dir)).toEqual([
      { ...GITHUB_ROW, config: { ...GITHUB_ROW.config, env: { GITHUB_TOKEN: 'process.env.GITHUB_TOKEN', MODE: 'dev' } } },
    ])
  })

  it('drops stdio-only fields when an edit switches to http', () => {
    const dir = patchDir(HAND_EDITED)
    mcp.save(dir, { id: 'mcp-github', serverName: 'github', transport: 'streamable-http', url: 'https://mcp.example.test/mcp', headers: {} })
    expect(savedRows(dir)).toEqual([
      { ...GITHUB_ROW, config: { serverName: 'github', transport: 'streamable-http', url: 'https://mcp.example.test/mcp', timeout: 30000 } },
    ])
  })
})

describe('mcp.peek', () => {
  it('lists non-string env values as text', () => {
    expect(mcp.peek(patchDir(HAND_EDITED))[0].env).toEqual({ GITHUB_TOKEN: 'process.env.GITHUB_TOKEN', PORT: '3000' })
  })
})

describe('mcp.copy', () => {
  it('copies a row to another scope as it is written', () => {
    const source = patchDir(HAND_EDITED)
    const target = mkdtempSync(join(tmpdir(), 'dsh-mcp-copy-'))
    expect(mcp.copy(source, target, 'mcp-github')).toBe('mcp-github')
    expect(readPatch(target)).toContain('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN')
    expect(savedRows(target)).toEqual([GITHUB_ROW])
  })

  it('gives the copy a free id when the source id is taken', () => {
    const dir = patchDir(HAND_EDITED)
    expect(mcp.copy(dir, dir, 'mcp-github')).toBe('mcp-github-2')
    expect(savedRows(dir)).toEqual([GITHUB_ROW, { ...GITHUB_ROW, id: 'mcp-github-2' }])
  })

  it('returns undefined when the source row is missing', () => {
    expect(mcp.copy(patchDir(HAND_EDITED), mkdtempSync(join(tmpdir(), 'dsh-mcp-copy-')), 'mcp-missing')).toBeUndefined()
  })
})
