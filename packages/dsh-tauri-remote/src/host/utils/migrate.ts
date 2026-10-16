import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'pathe'
import { messageOf } from '../../shared/error'

/** 报错只带文件名：这条原因经 `GET /settings` 下发到 web 载体，不下发 home 下的绝对路径。 */
function readDocument(file: string): unknown {
  const name = basename(file)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  }
  catch (error) {
    throw new Error(`旧状态文件不可读 ${name}：${messageOf(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new Error(`旧状态文件不是合法 JSON ${name}`)
  }
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error(`旧状态文件不是 JSON 对象 ${name}`)
  return parsed
}

/**
 * 一次性迁移一份状态文档：目标已存在（含半迁移的空文件）或源不存在即不动作；旧文件保留原位。
 *
 * @returns 是否真的写出目标文件。
 */
export function migrateDocument(source: string, target: string): boolean {
  if (existsSync(target) || !existsSync(source))
    return false
  const document = readDocument(source)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temp, target)
  }
  catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return true
}
