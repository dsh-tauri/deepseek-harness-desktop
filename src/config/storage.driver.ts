import type { StoreOptions } from '@tauri-apps/plugin-store'
import { Store } from '@tauri-apps/plugin-store'
import { defineDriver } from 'unstorage'

export interface TauriStorageDriverOptions {
  path?: string
  options?: StoreOptions
}

export const tauriStorageDriver = defineDriver<TauriStorageDriverOptions | undefined, never>((options) => {
  const promise = Store.load(options?.path ?? '.store.dat', options?.options)
  // 非 Tauri 环境（vitest/jsdom）没有 invoke，Store.load 会 reject；若此刻还
  // 没有任何驱动方法被调用，rejection 无人接管就成了 unhandled。这里挂一个
  // noop 拒绝处理器只标记「已接管」——派生的消费 promise 不受影响，真正调用
  // 驱动方法时 rejection 仍按原路径抛给调用方。
  promise.catch(() => {})
  return {
    name: 'tauri-storage',
    options,
    async hasItem(key) {
      return promise.then(store => store.has(key))
    },
    async getItem(key) {
      return promise.then(store => store.get(key))
    },
    async setItem(key, value) {
      return promise.then(store => store.set(key, value))
    },
    async removeItem(key) {
      await promise.then(store => store.delete(key))
    },
    async getKeys() {
      return promise.then(store => store.keys())
    },
    async clear() {
      return promise.then(store => store.clear())
    },
    async watch(callback) {
      return promise.then(store => store.onChange((key, value) => callback(value === null ? 'remove' : 'update', key)))
    },
  }
})
