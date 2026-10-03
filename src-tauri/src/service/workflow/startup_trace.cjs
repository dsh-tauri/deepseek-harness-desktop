const process = require('node:process')

function reportFailure(error) {
  const code = /^[A-Z_]{1,64}$/.test(error?.code) ? error.code : 'UNKNOWN'
  process.stderr.write(`STARTUP_TRACE_FAILED: ${code}\n`)
}

function startTrace() {
  const { mkdirSync, writeFileSync } = require('node:fs')
  const { Session } = require('node:inspector')
  const { builtinModules } = require('node:module')
  const { Server } = require('node:net')
  const { join } = require('node:path')
  const { performance } = require('node:perf_hooks')
  const directory = process.env.DSH_STARTUP_TRACE_DIR
  const port = Number(process.env.DSH_WEB_PORT)
  if (!directory || !Number.isInteger(port) || port < 1 || port > 65535)
    throw Object.assign(new Error('Invalid startup trace configuration'), { code: 'INVALID_CONFIGURATION' })

  const started = performance.now()
  const preloadAtMs = process.uptime() * 1000
  const cpuStarted = process.cpuUsage()
  const loopStarted = performance.eventLoopUtilization()
  const session = new Session()
  session.connect()
  let finished = false
  let lastTick = started
  let maxTimerGapMs = 0
  let timer
  let deadline
  const originalListen = Server.prototype.listen

  const builtinSources = new Set(builtinModules.map(name => name.startsWith('node:') ? name : `node:${name}`))

  function safeSource(value) {
    if (builtinSources.has(value))
      return value
    if (/^(?:node:)?internal\//.test(value))
      return 'node:internal'
    let path
    try {
      path = decodeURIComponent(value.split(/[?#]/, 1)[0]).replaceAll('\\', '/')
    }
    catch {
      return '(external)'
    }
    const marker = '/node_modules/'
    const offset = path.lastIndexOf(marker)
    if (offset < 0)
      return '(external)'
    const relative = path.slice(offset + marker.length)
    return /^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.@+-]+)*\.(?:mjs|cjs|js)$/.test(relative)
      ? `node_modules/${relative}`
      : '(external)'
  }

  function safeProfile(profile) {
    const specialNames = new Set(['(root)', '(program)', '(idle)', '(garbage collector)'])
    return {
      startTime: profile.startTime,
      endTime: profile.endTime,
      nodes: profile.nodes.map(node => ({
        id: node.id,
        hitCount: node.hitCount,
        children: node.children,
        callFrame: {
          functionName: !node.callFrame.url && specialNames.has(node.callFrame.functionName)
            ? node.callFrame.functionName
            : '(code)',
          scriptId: node.callFrame.scriptId,
          url: safeSource(node.callFrame.url),
          lineNumber: node.callFrame.lineNumber,
          columnNumber: node.callFrame.columnNumber,
        },
      })),
      samples: profile.samples,
      timeDeltas: profile.timeDeltas,
    }
  }

  function finish(reason) {
    if (finished)
      return
    finished = true
    clearInterval(timer)
    clearTimeout(deadline)
    if (Server.prototype.listen === tracedListen)
      Server.prototype.listen = originalListen
    process.removeListener('beforeExit', onExit)
    process.removeListener('exit', onExit)
    const elapsedMs = performance.now() - started
    maxTimerGapMs = Math.max(maxTimerGapMs, performance.now() - lastTick)
    const cpu = process.cpuUsage(cpuStarted)
    const cpuMs = { user: cpu.user / 1000, system: cpu.system / 1000, total: (cpu.user + cpu.system) / 1000 }
    const eventLoop = performance.eventLoopUtilization(loopStarted)
    session.post('Profiler.stop', (error, result) => {
      try {
        if (error)
          throw error
        const report = {
          version: 1,
          reason,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          elapsedMs,
          preloadAtMs,
          cpuMs,
          nonCpuWallMs: Math.max(0, elapsedMs - cpuMs.total),
          maxTimerGapMs,
          eventLoop: { activeMs: eventLoop.active, idleMs: eventLoop.idle },
          profile: safeProfile(result.profile),
        }
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        const filename = `startup-${Date.now()}-${process.pid}.json`
        writeFileSync(join(directory, filename), JSON.stringify(report), { flag: 'wx', mode: 0o600 })
        process.stderr.write(`STARTUP_TRACE: reason=${reason} wall_ms=${elapsedMs.toFixed(0)} cpu_ms=${cpuMs.total.toFixed(0)} report=${filename}\n`)
      }
      catch (failure) {
        reportFailure(failure)
      }
      finally {
        session.disconnect()
      }
    })
  }

  function onExit() {
    finish('exit')
  }

  function onListen() {
    const address = this.address()
    if (address && typeof address === 'object' && address.port === port)
      finish('listen')
  }

  function tracedListen(...args) {
    if (!finished)
      this.once('listening', onListen)
    return Reflect.apply(originalListen, this, args)
  }

  session.post('Profiler.enable')
  session.post('Profiler.setSamplingInterval', { interval: 1000 })
  session.post('Profiler.start')
  Server.prototype.listen = tracedListen
  process.once('beforeExit', onExit)
  process.once('exit', onExit)
  timer = setInterval(() => {
    const now = performance.now()
    maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTick)
    lastTick = now
  }, 100)
  timer.unref()
  deadline = setTimeout(finish, 120_000, 'timeout')
  deadline.unref()
}

if (process.env.DSH_STARTUP_TRACE === '1' && require('node:worker_threads').isMainThread) {
  process.env.DSH_STARTUP_TRACE = '0'
  try {
    startTrace()
  }
  catch (error) {
    reportFailure(error)
  }
}
