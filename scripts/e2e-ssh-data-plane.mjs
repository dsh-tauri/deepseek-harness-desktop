#!/usr/bin/env node
/**
 * S5 整体验收·数据面全旅程驱动脚本（无头，直驱 /api/tauri/ssh REST 面）。
 *
 * 旅程（对应 S5 Spec 验收标准 2 的可自动化子集）：
 *   POST /machines（dev 真机，含 color/tintBorder/startCommand）
 *   → POST /machines/connect（S2 bootstrap：远端已装 dsh 则直接拉起实例 + 建隧道）
 *   → GET /machines 轮询至 connected + tunnelBaseUrl
 *   → 经隧道 GET /（远端实例可达性证据：200 或远端 dsh 的鉴权提示 401）
 *   → GET /machines/events 探日志（连接生命周期阶段）
 *   → POST /machines/disconnect → GET /machines 回 disconnected
 *   → DELETE /machines → GET /machines 行消失
 *
 * 鉴权：路由层沿用宿主 connection 的浏览器会话闸门（Host/Origin fence + 签名 Cookie），
 * 没有信封 token 通道。`--token` 只用于在根路径换取会话 Cookie（`GET /?token=…`
 * → 303 + set-cookie），随后所有请求带着该 Cookie 走；也可以直接给 `--cookie`
 * （例如从浏览器 DevTools 复制）。
 *
 * 用法（先起一个挂了 dsh-tauri-ssh 的本地 dsh 实例，见
 * docs/testing/s5-ssh-e2e-evidence.md 的复现步骤）：
 *   node scripts/e2e-ssh-data-plane.mjs \
 *     --base http://127.0.0.1:3185 --token <alpha-token> \
 *     --host dev --user root --port 22 --remote-port 3082 \
 *     --start-command '/root/.nvm/versions/node/v26.3.0/bin/dsh web --host 127.0.0.1 --port {port}' \
 *     [--out evidence.md]
 *
 * 退出码 0 = 全旅程通过；任何一步失败即非零退出（供 CI/验收判断）。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const base = argOf('base', 'http://127.0.0.1:3185').replace(/\/+$/u, '')
const token = argOf('token', '')
const host = argOf('host', 'dev')
const user = argOf('user', 'root')
const sshPort = Number(argOf('port', '22'))
const remotePort = Number(argOf('remote-port', '3082'))
const startCommand = argOf('start-command', '')
const outPath = argOf('out', '')
const machineId = randomUUID()
const api = `${base}/api/tauri/ssh`
let cookie = argOf('cookie', '')

const lines = []
function log(line) {
  process.stdout.write(`${line}\n`)
  lines.push(line)
}

async function signIn() {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? ''
  if (response.status !== 303 || setCookie === '')
    throw new Error(`launch-token exchange failed: HTTP ${response.status}（--token 是否与 dsh web 打印的一致？也可直接给 --cookie）`)
  return setCookie.split(';')[0]
}

async function request(method, path, body, query) {
  const url = new URL(`${api}${path}`)
  for (const [key, value] of Object.entries(query ?? {}))
    url.searchParams.set(key, String(value))
  const response = await fetch(url, {
    method,
    headers: {
      ...cookie === '' ? {} : { cookie },
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    redirect: 'manual',
  })
  const text = await response.text()
  const payload = jsonOf(text)
  if (!response.ok || payload?.error !== undefined)
    throw new Error(`${method} ${path} failed: HTTP ${response.status}${payload?.error === undefined ? `: ${text.slice(0, 200)}` : `: ${payload.error}`}`)
  return payload
}

function jsonOf(text) {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

function listMachines() {
  return request('GET', '/machines')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForState(machineId, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await listMachines()
    const row = (value.items ?? []).find(item => item.id === machineId)
    if (row !== undefined && predicate(row))
      return row
    if (Date.now() > deadline)
      throw new Error(`timeout waiting for ${label} (last: ${row ? `${row.state} ${row.lastError ?? ''}` : 'row missing'})`)
    await sleep(2000)
  }
}

async function main() {
  if (cookie === '')
    cookie = await signIn()

  const settings = await request('GET', '/settings')
  if (settings.enabled !== true)
    throw new Error('dsh-tauri-ssh 未启用：先 POST /api/tauri/ssh/settings {"enabled":true}')

  log(`# S5 SSH 数据面全旅程 — ${new Date().toISOString()}`)
  log(`base=${base} host=${host} user=${user} sshPort=${sshPort} remotePort=${remotePort}`)
  log(`machineId=${machineId}`)

  // 1) POST /machines：新建机器（color/tintBorder 供切换器色点与边框着色消费；
  //    startCommand 留空 = 走引擎默认 bootstrap 启动命令）
  await request('POST', '/machines', {
    machineId,
    row: {
      name: 's5-e2e-dev',
      host,
      port: sshPort,
      user,
      remotePort,
      ...(startCommand === '' ? {} : { startCommand }),
      color: '#7c5cff',
      tintBorder: true,
    },
  })
  let list = await listMachines()
  let row = (list.items ?? []).find(item => item.id === machineId)
  if (row === undefined)
    throw new Error('saved machine missing from GET /machines')
  log(`\n[1] machine.save ok → name=${row.name} state=${row.state} color=${row.color} tintBorder=${row.tintBorder} (discovered aliases: ${(list.discovered ?? []).length})`)

  // 2) POST /machines/connect：S2 bootstrap + 隧道（阻塞到 tunnelBaseUrl 就绪）
  log('\n[2] machine.connect …（bootstrap/健康探测可能需要数十秒）')
  const startedAt = Date.now()
  const link = await request('POST', '/machines/connect', { machineId })
  log(`    connect ok in ${((Date.now() - startedAt) / 1000).toFixed(1)}s tunnelBaseUrl=${link.tunnelBaseUrl}`)

  row = await waitForState(machineId, item => item.state === 'connected', 30_000, 'connected')
  if (row.tunnelBaseUrl !== link.tunnelBaseUrl)
    throw new Error(`tunnelBaseUrl mismatch: list=${row.tunnelBaseUrl} connect=${link.tunnelBaseUrl}`)
  log(`[3] machine.list → state=connected tunnelBaseUrl=${row.tunnelBaseUrl} authMethod=${row.authMethod ?? 'n/a'}`)

  // 3) 经隧道 GET /：远端实例可达（远端开启 alpha 鉴权时 401 也证明隧道通）
  const tunnelResponse = await fetch(link.tunnelBaseUrl, { redirect: 'manual' })
  const tunnelBody = await tunnelResponse.text()
  const tunnelProof = tunnelResponse.status === 200
    || (tunnelResponse.status === 401 && tunnelBody.includes('dsh web authentication required'))
  if (!tunnelProof)
    throw new Error(`tunnel GET / unexpected: ${tunnelResponse.status} ${tunnelBody.slice(0, 120)}`)
  log(`[4] tunnel GET / → HTTP ${tunnelResponse.status}（${tunnelResponse.status === 200 ? '直出页面' : '远端实例鉴权提示，隧道传输已通'}）body head: ${tunnelBody.slice(0, 60).replace(/\n/g, ' ')}`)

  // 4) GET /machines/events：连接生命周期日志证据
  const page = await request('GET', '/machines/events', undefined, { machineId, sinceSeq: 0 })
  const items = page.items ?? []
  const stages = items.map(event => `${event.seq}:${event.stage ?? '?'}`).join(' ')
  log(`[5] machine.events → ${items.length} 条 (${stages.slice(0, 400)})`)

  // 5) POST /machines/disconnect → 回 disconnected
  await request('POST', '/machines/disconnect', { machineId })
  row = await waitForState(machineId, item => item.state === 'disconnected', 30_000, 'disconnected')
  log(`[6] machine.disconnect ok → state=${row.state}`)

  // 6) DELETE /machines → 行消失
  await request('DELETE', '/machines', { machineId })
  list = await listMachines()
  if ((list.items ?? []).some(item => item.id === machineId))
    throw new Error('removed machine still present in GET /machines')
  log(`[7] machine.remove ok → items=${(list.items ?? []).length}（目标机器已从列表消失，discovered 别名不受影响：${(list.discovered ?? []).length}）`)

  log('\nALL STEPS PASSED ✅')
}

try {
  await main()
  process.exitCode = 0
}
catch (error) {
  log(`\nFAILED ❌: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
finally {
  if (outPath !== '') {
    writeFileSync(outPath, '')
    appendFileSync(outPath, `${lines.join('\n')}\n`)
    process.stdout.write(`evidence written to ${outPath}\n`)
  }
}
