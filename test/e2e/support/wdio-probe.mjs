#!/usr/bin/env node
// D0 临时探针：验证 debug 二进制内嵌的 WebDriver server 能否被纯 HTTP 驱动。
// 只验这一个不确定性，通过后由 D1 的正式接线取代；见 docs/testing/desktop/basic.md。

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const APP = path.join(ROOT, 'src-tauri', 'target', 'debug', 'deepseek-harness-desktop.exe')
const LOG = path.join(ROOT, '.temp-wdio-probe-app.log')
const APP_PORT = 3081
const WD_PORT = 4445
const BASE = `http://127.0.0.1:${WD_PORT}`
const START_DEADLINE_MS = 120_000

function fail(message) {
  console.error(`[probe] FAIL: ${message}`)
  process.exit(1)
}

function isPortBusy(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (busy) => {
      socket.destroy()
      resolve(busy)
    }
    socket.setTimeout(1000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function request(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  }
  catch {
    json = text
  }
  return { status: res.status, json }
}

function logTail(lines = 15) {
  if (!existsSync(LOG))
    return '(无应用日志)'
  const all = readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean)
  return all.slice(-lines).join('\n')
}

async function waitForStatus(child) {
  const deadline = Date.now() + START_DEADLINE_MS
  let last = '(尚未连上)'
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      fail(`应用在就绪前退出（exitCode=${child.exitCode}）。应用日志尾部：\n${logTail()}`)
    try {
      const res = await request('GET', '/status')
      last = `${res.status} ${JSON.stringify(res.json)}`
      if (res.status === 200 && res.json?.value?.ready === true)
        return res
    }
    catch (error) {
      last = `请求失败：${error.message}`
    }
    await sleep(500)
  }
  fail(`等待 WebDriver server 就绪超时（${START_DEADLINE_MS}ms）。最后一次 /status：${last}`)
}

async function createSession(child) {
  const deadline = Date.now() + 30_000
  let last = ''
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      fail(`应用在建会话前退出（exitCode=${child.exitCode}）。应用日志尾部：\n${logTail()}`)
    const res = await request('POST', '/session', { capabilities: {} })
    const sessionId = res.json?.value?.sessionId
    if (res.status === 200 && sessionId)
      return sessionId
    last = `${res.status} ${JSON.stringify(res.json)}`
    await sleep(500)
  }
  fail(`POST /session 未返回 sessionId。最后一次响应：${last}`)
}

async function stopApp(child) {
  if (child.exitCode !== null)
    return
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
      killer.once('exit', resolve)
      killer.once('error', resolve)
    })
  }
  else {
    child.kill('SIGKILL')
  }
  for (let i = 0; i < 40 && child.exitCode === null; i++)
    await sleep(250)
}

async function main() {
  if (!existsSync(APP))
    fail(`二进制不存在：${APP}\n先运行：cargo build --manifest-path src-tauri/Cargo.toml`)
  if (await isPortBusy(APP_PORT))
    fail(`${APP_PORT} 已被监听（debug 固定端口）。请先停掉 dev/debug 实例；探针不自动杀进程。`)
  if (await isPortBusy(WD_PORT))
    fail(`WebDriver 端口 ${WD_PORT} 已被监听。请先释放该端口。`)

  const fd = openSync(LOG, 'w')
  const child = spawn(APP, [], {
    cwd: ROOT,
    env: { ...process.env, TAURI_WEBDRIVER_PORT: String(WD_PORT) },
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)

  try {
    const status = await waitForStatus(child)
    console.log(`[probe] status: ok (${JSON.stringify(status.json.value)})`)

    const sessionId = await createSession(child)
    console.log(`[probe] sessionId: ${sessionId}`)

    const handles = await request('GET', `/session/${sessionId}/window/handles`)
    console.log(`[probe] windows: ${JSON.stringify(handles.json?.value)}`)

    await request('DELETE', `/session/${sessionId}`)

    const list = handles.json?.value
    if (!Array.isArray(list) || list.length !== 1 || list[0] !== 'main') {
      console.error(`[probe] FAIL: 期望窗口集合恰为 ["main"]，实际 ${JSON.stringify(list)}`)
      console.error(`应用日志尾部：\n${logTail()}`)
      process.exitCode = 1
      return
    }

    console.log('[probe] PASS: 内嵌 WebDriver server 可被纯 HTTP 驱动')
  }
  finally {
    await stopApp(child)
    if (await isPortBusy(APP_PORT))
      console.warn(`[probe] WARN: 收尾后 ${APP_PORT} 仍被监听，可能有残留 harness 存活`)
  }
}

main().catch((error) => {
  console.error(`[probe] FAIL: 未捕获异常 ${error?.stack ?? error}`)
  process.exit(1)
})
