import valtio from 'valtio-define'
import { persist } from 'valtio-define/plugins/persist'

valtio.use(persist())

export { defineStore, useStore } from 'valtio-define'
