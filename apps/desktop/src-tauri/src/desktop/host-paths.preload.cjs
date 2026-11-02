const { contextBridge, webUtils } = require('electron')

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
    pathFor(file) {
      try {
        return webUtils.getPathForFile(file)
      }
      catch {
        return ''
      }
    },
  })
}
