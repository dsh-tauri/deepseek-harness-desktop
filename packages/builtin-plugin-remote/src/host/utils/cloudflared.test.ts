import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { cloudflaredLogSink, consumeLines, createLineReader, parseMetricsAddress, tunnelArgs } from './cloudflared'

const ENTRY = 'http://127.0.0.1:3089'

describe('tunnelArgs', () => {
  it('quick 模式转发本地入口并把协议固定为 http2', () => {
    expect(tunnelArgs(ENTRY)).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', ENTRY])
  })

  it('具名模式只跑 run 子命令，同样固定 http2', () => {
    expect(tunnelArgs()).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run'])
  })

  it('两种模式都不留 cloudflared 缺省的 QUIC（UDP 7844）', () => {
    for (const args of [tunnelArgs(ENTRY), tunnelArgs()]) {
      expect(args).toContain('--protocol')
      expect(args[args.indexOf('--protocol') + 1]).toBe('http2')
    }
  })

  it('具名模式不把入口地址写进参数，凭据只走环境变量', () => {
    expect(tunnelArgs().join(' ')).not.toContain('--url')
  })
})

describe('parseMetricsAddress', () => {
  it('从 cloudflared 自报日志里取出探活入口', () => {
    expect(parseMetricsAddress('INF Starting metrics server on 127.0.0.1:41143/metrics')).toBe('127.0.0.1:41143')
  })

  it('接受 IPv6 方括号地址', () => {
    expect(parseMetricsAddress('INF Starting metrics server on [::1]:20241/metrics')).toBe('[::1]:20241')
  })

  it('端口越界或缺失时返回 undefined，避免把畸形地址交给探活请求', () => {
    expect(parseMetricsAddress('INF Starting metrics server on 127.0.0.1:0/metrics')).toBeUndefined()
    expect(parseMetricsAddress('INF Starting metrics server on 127.0.0.1:70000/metrics')).toBeUndefined()
    expect(parseMetricsAddress('INF Starting metrics server on 127.0.0.1/metrics')).toBeUndefined()
  })

  it('无关日志行不产生地址', () => {
    expect(parseMetricsAddress('INF Registered tunnel connection connIndex=0')).toBeUndefined()
  })
})

describe('createLineReader', () => {
  function collect(): { lines: string[], push: (chunk: string) => void, flush: () => void } {
    const lines: string[] = []
    const reader = createLineReader(line => lines.push(line))
    return { lines, push: reader.push, flush: reader.flush }
  }

  it('跨 chunk 拼接被切断的行', () => {
    const reader = collect()
    reader.push('INF Star')
    reader.push('ting metrics server\nINF next\n')
    expect(reader.lines).toEqual(['INF Starting metrics server', 'INF next'])
  })

  it('流结束时交付末尾没有换行的那一行', () => {
    const reader = collect()
    reader.push('INF ok\nfatal: connection lost')
    expect(reader.lines).toEqual(['INF ok'])
    reader.flush()
    expect(reader.lines).toEqual(['INF ok', 'fatal: connection lost'])
  })

  it('末尾空行不产生空记录，重复 flush 不重复交付', () => {
    const reader = collect()
    reader.push('only\n')
    reader.flush()
    reader.flush()
    expect(reader.lines).toEqual(['only'])
  })
})

describe('consumeLines', () => {
  it('流结束时把末尾没有换行的那一行也交给调用方', async () => {
    const lines: string[] = []
    const stream = new PassThrough()
    consumeLines(stream, line => lines.push(line))
    stream.write('INF ok\nfatal: connection lost')
    stream.end()
    await new Promise(resolve => stream.once('close', resolve))
    expect(lines).toEqual(['INF ok', 'fatal: connection lost'])
  })

  it('空流不产生任何记录', async () => {
    const lines: string[] = []
    const stream = new PassThrough()
    consumeLines(stream, line => lines.push(line))
    stream.end()
    await new Promise(resolve => stream.once('close', resolve))
    expect(lines).toEqual([])
  })
})

describe('cloudflaredLogSink', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true })
  })

  function tempLog(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cloudflared-log-'))
    dirs.push(dir)
    return join(dir, 'cloudflared.log')
  }

  it('把子进程输出追加落盘', () => {
    const path = tempLog()
    const write = cloudflaredLogSink(path, null)
    write('INF Starting metrics server on 127.0.0.1:41143/metrics\n')
    write('INF Registered tunnel connection\n')
    expect(readFileSync(path, 'utf8')).toBe('INF Starting metrics server on 127.0.0.1:41143/metrics\nINF Registered tunnel connection\n')
  })

  it('把 Token 一律替换为 ***，不落明文', () => {
    const path = tempLog()
    const write = cloudflaredLogSink(path, 'secret-token')
    write('connector token=secret-token ok\n')
    write('again secret-token\n')
    const text = readFileSync(path, 'utf8')
    expect(text).toBe('connector token=*** ok\nagain ***\n')
    expect(text).not.toContain('secret-token')
  })

  it('超过上限轮转为 .1 并继续写新文件', () => {
    const path = tempLog()
    const write = cloudflaredLogSink(path, null, 20)
    write('0123456789\n')
    write('abcdefghij\n')
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('0123456789\n')
    expect(readFileSync(path, 'utf8')).toBe('abcdefghij\n')
  })
})
