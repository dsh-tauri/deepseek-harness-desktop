import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateDocument } from './migrate'

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-migrate-'))
  roots.push(root)
  return root
}

function write(file: string, document: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`)
}

beforeEach(() => {})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('migrateDocument', () => {
  it('旧文件存在且新文件不存在时写出新文件并保留旧文件', () => {
    const root = scratch()
    const source = join(root, 'ssh', 'machines.json')
    const target = join(root, 'remote', 'machines.json')
    write(source, { version: 1, machines: { a: { id: 'a' } } })
    expect(migrateDocument(source, target)).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ version: 1, machines: { a: { id: 'a' } } })
    expect(existsSync(source)).toBe(true)
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(target)).mode & 0o777).toBe(0o700)
  })

  it('新文件已存在时不迁移也不覆盖（含半迁移的空文件）', () => {
    const root = scratch()
    const source = join(root, 'ssh', 'machines.json')
    const target = join(root, 'remote', 'machines.json')
    write(source, { version: 1, machines: { legacy: { id: 'legacy' } } })
    write(target, { version: 1, machines: { current: { id: 'current' } } })
    expect(migrateDocument(source, target)).toBe(false)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ version: 1, machines: { current: { id: 'current' } } })

    const empty = join(root, 'remote', 'known-hosts.json')
    writeFileSync(empty, '')
    write(join(root, 'ssh', 'known-hosts.json'), [{ machineId: 'a', fingerprint: 'SHA256:x' }])
    expect(migrateDocument(join(root, 'ssh', 'known-hosts.json'), empty)).toBe(false)
    expect(readFileSync(empty, 'utf8')).toBe('')
  })

  it('旧文件不存在时不做任何动作', () => {
    const root = scratch()
    expect(migrateDocument(join(root, 'ssh', 'machines.json'), join(root, 'remote', 'machines.json'))).toBe(false)
    expect(existsSync(join(root, 'remote'))).toBe(false)
  })

  it('旧文件损坏时抛出可读原因且不产生目标文件', () => {
    const root = scratch()
    const source = join(root, 'ssh', 'machines.json')
    const target = join(root, 'remote', 'machines.json')
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, '{ not json')
    expect(() => migrateDocument(source, target)).toThrow(/不是合法 JSON/u)
    expect(existsSync(target)).toBe(false)
    expect(existsSync(source)).toBe(true)
  })

  it('损坏与不可读的原因只带文件名，不带 home 下的绝对路径', () => {
    const root = scratch()
    const corrupt = join(root, 'ssh', 'machines.json')
    const unreadable = join(root, 'ssh', 'known-hosts.json')
    mkdirSync(corrupt, { recursive: true })
    mkdirSync(dirname(unreadable), { recursive: true })
    writeFileSync(unreadable, '{ not json')

    const reasonOf = (source: string, index: number): string => {
      try {
        migrateDocument(source, join(root, 'remote', `target-${index}.json`))
        return ''
      }
      catch (error) {
        return (error as Error).message
      }
    }

    const reasons = [reasonOf(corrupt, 0), reasonOf(unreadable, 1)]

    for (const reason of reasons) {
      expect(reason).toContain('旧状态文件')
      expect(reason).not.toContain(root)
    }
    expect(reasons[0]).toContain('machines.json')
    expect(reasons[1]).toContain('known-hosts.json')
  })

  it('重复执行结果相同（第二次为空操作）', () => {
    const root = scratch()
    const source = join(root, 'ssh', 'machines.json')
    const target = join(root, 'remote', 'machines.json')
    write(source, { version: 1, machines: {} })
    expect(migrateDocument(source, target)).toBe(true)
    const migrated = readFileSync(target, 'utf8')
    expect(migrateDocument(source, target)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe(migrated)
  })
})
