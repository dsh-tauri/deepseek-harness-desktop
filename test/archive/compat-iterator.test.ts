import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * issue #539：macOS 14 / 15.3 随附的系统 WebKit 没有全局 `Iterator`（ES2025 iterator
 * helpers），dsh 内置插件 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 内联的
 * pdf.js 在模块顶层读取 `Iterator.prototype.join`，插件 import 直接抛
 * `Can't find variable: Iterator`，桌面端启动即报 “Failed to load plugins”。
 *
 * 壳层垫片 `src-tauri/src/desktop/compat_iterator.js.inc` 在页面脚本前注入。
 * 这里在 VM 里删掉原生 `Iterator` 与原型上的原生 helper 来模拟旧 WebKit，并把垫片的
 * 行为与 Node（V8，原生 iterator helpers）做差分对照。
 */
const shim = readFileSync(
  new URL('../src-tauri/src/desktop/compat_iterator.js.inc', import.meta.url),
  'utf8',
)

/** 旧 WebKit 现场：全局没有 Iterator，%IteratorPrototype% 上也没有任何 helper。 */
const OLD_WEBKIT_SETUP = `
delete globalThis.Iterator
;['join', 'toArray', 'map', 'filter', 'take', 'drop', 'flatMap', 'reduce', 'forEach', 'some', 'every', 'find'].forEach(function (name) {
  delete Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))[name]
})
`

/** pdf.js 在模块顶层的原始写法（垫片生效前它就是 issue #539 的报错点）。 */
const PDFJS_TOP_LEVEL_GUARD = `(function () { return typeof Iterator.prototype.join !== 'function' })()`

/**
 * 对照探针：返回 JSON 字符串，跨 realm 只比较字符串，避免原型差异干扰。
 * 每个用例都用 capture 包住，断言值或错误构造器名。
 */
const PROBE = `(function () {
  if (typeof Iterator.prototype.join !== 'function') {
    Iterator.prototype.join = function (separator) { return [...this].join(separator) }
  }
  function capture(work) {
    try { return { value: work() } }
    catch (error) { return { error: error.constructor.name } }
  }
  function* letters() { yield 'a'; yield 'b' }
  function* numbers() { yield 1; yield 2; yield 3 }
  var out = {}
  out.hasIterator = typeof Iterator !== 'undefined'
  out.sharedPrototype = Iterator.prototype === Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))
  out.join = capture(function () { return letters().join('-') })
  out.joinDefault = capture(function () { return letters().join() })
  out.joinArrayIterator = capture(function () { return [1, 2].values().join('+') })
  out.joinMapIterator = capture(function () { return new Map([['a', 1]]).keys().join(',') })
  out.toArray = capture(function () { return numbers().toArray() })
  out.map = capture(function () { return numbers().map(function (v) { return v * 2 }).toArray() })
  out.mapIndex = capture(function () { return letters().map(function (v, i) { return i + v }).toArray() })
  out.filter = capture(function () { return numbers().filter(function (v, i) { return i > 0 }).toArray() })
  out.chain = capture(function () { return numbers().take(2).map(function (v) { return v + '!' }).filter(function () { return true }).toArray() })
  out.forEach = capture(function () { var seen = []; numbers().forEach(function (v, i) { seen.push(i + ':' + v) }); return seen })
  out.some = capture(function () { return [numbers().some(function (v) { return v > 2 }), numbers().some(function (v) { return v > 9 })] })
  out.every = capture(function () { return [numbers().every(function (v) { return v > 0 }), numbers().every(function (v) { return v > 1 })] })
  out.find = capture(function () { return numbers().find(function (v) { return v > 1 }) })
  out.reduce = capture(function () { return numbers().reduce(function (a, b) { return a + b }) })
  out.reduceInit = capture(function () { return numbers().reduce(function (a, b, i) { return a.concat(i + ':' + b) }, []) })
  out.reduceNoInit = capture(function () { return numbers().reduce(function (a, b, i) { return a.concat(i + ':' + b) }) })
  out.reduceEmpty = capture(function () { return (function* () {})().reduce(function (a, b) { return a }) })
  out.take = capture(function () { return [numbers().take(2).toArray(), numbers().take(0).toArray(), numbers().take(2.7).toArray(), numbers().take(Infinity).toArray()] })
  out.takeNegative = capture(function () { return numbers().take(-1).toArray() })
  out.takeNegativeFraction = capture(function () { return numbers().take(-0.5).toArray() })
  out.takeNaN = capture(function () { return numbers().take(NaN).toArray() })
  out.takeUndefined = capture(function () { return numbers().take(undefined).toArray() })
  out.drop = capture(function () { return [numbers().drop(1).toArray(), numbers().drop(1.9).toArray(), numbers().drop(Infinity).toArray(), numbers().drop(0).toArray()] })
  out.dropNegative = capture(function () { return numbers().drop(-1).toArray() })
  out.flatMap = capture(function () { return [numbers().flatMap(function (v) { return [v, v] }).toArray(), (function* () { yield 'ab' })().flatMap(function () { return Object('ab') }).toArray()] })
  out.flatMapPrimitive = capture(function () { return numbers().flatMap(function (v) { return v }).toArray() })
  out.flatMapPlainObject = capture(function () { return numbers().flatMap(function () { return {} }).toArray() })
  out.mapNonCallable = capture(function () { return numbers().map(1).toArray() })
  out.fromArray = capture(function () { return Iterator.from([1, 2]).toArray() })
  out.fromString = capture(function () { return Iterator.from('ab').toArray() })
  out.fromIterator = capture(function () { return Iterator.from(letters()).toArray() })
  out.fromNull = capture(function () { return Iterator.from(null) })
  out.fromPlainObject = capture(function () { return Iterator.from({}).toArray() })
  out.construct = capture(function () { return new Iterator() })
  return JSON.stringify(out)
})()`

function createSandbox(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {}
  // 浏览器语义：window 就是全局对象。
  sandbox.window = sandbox
  return sandbox
}

function runInSandbox(code: string, sandbox: Record<string, unknown>): string {
  return runInNewContext(code, sandbox)
}

describe('iterator helpers shim (issue #539)', () => {
  it('reproduces the plugin import failure when the global Iterator is missing', () => {
    const sandbox = createSandbox()
    expect(() => runInSandbox(`${OLD_WEBKIT_SETUP}\n;\n${PDFJS_TOP_LEVEL_GUARD}`, sandbox))
      .toThrow(/Iterator is not defined/)
  })

  it('defines Iterator on the shared %IteratorPrototype% so iterator .join() resolves', () => {
    const sandbox = createSandbox()
    const result = JSON.parse(runInSandbox(`${OLD_WEBKIT_SETUP}\n;\n${shim}\n;\n${PROBE}`, sandbox)) as Record<string, unknown>

    expect(result.hasIterator).toBe(true)
    expect(result.sharedPrototype).toBe(true)
    expect(result.join).toEqual({ value: 'a-b' })
    expect(result.joinDefault).toEqual({ value: 'a,b' })
    expect(result.joinArrayIterator).toEqual({ value: '1+2' })
    expect(result.joinMapIterator).toEqual({ value: 'a' })
    expect((sandbox.window as Record<string, unknown>).__dsh_iterator_helpers__).toBe(true)
  })

  it('matches the host engine native iterator helpers value for value', () => {
    const oldWebKit = createSandbox()
    const polyfilled = JSON.parse(runInSandbox(`${OLD_WEBKIT_SETUP}\n;\n${shim}\n;\n${PROBE}`, oldWebKit)) as Record<string, unknown>

    // 同一探针跑在原生实现上（垫片检测到 Iterator 已存在会整体让位）作为基准。
    const modern = createSandbox()
    const native = JSON.parse(runInSandbox(`${shim}\n;\n${PROBE}`, modern)) as Record<string, unknown>

    expect(polyfilled).toEqual(native)
  })

  it('yields to an existing Iterator and stays idempotent across injections', () => {
    const modern = createSandbox()
    runInSandbox(shim, modern)
    // 原生已有 Iterator：不定义全局、不落幂等标记。
    expect(modern.Iterator).toBeUndefined()
    expect((modern.window as Record<string, unknown>).__dsh_iterator_helpers__).toBeUndefined()

    const oldWebKit = createSandbox()
    runInSandbox(`${OLD_WEBKIT_SETUP}\n;\n${shim}`, oldWebKit)
    const firstJoin = (oldWebKit.Iterator as { prototype: { join: unknown } }).prototype.join
    // 重复注入：整体让位，不重建原型方法。
    runInSandbox(shim, oldWebKit)
    expect((oldWebKit.Iterator as { prototype: { join: unknown } }).prototype.join).toBe(firstJoin)
  })
})
