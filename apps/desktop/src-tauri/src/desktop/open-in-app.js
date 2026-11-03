(() => {
  const ipc = window.__TAURI_INTERNALS__
  // 远程 Harness 没有宿主壳的 IPC，也不该让本机窗口替它让位：保持浏览器原样。
  if (!ipc) return
  const ROUTE = '/open-in-app/open'
  const platformFetch = window.fetch
  window.fetch = function (input, init) {
    const request = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (typeof request !== 'string' || !request.includes(ROUTE)) return platformFetch.apply(this, arguments)
    if ((init?.method ?? 'GET').toUpperCase() !== 'POST') return platformFetch.apply(this, arguments)
    let path
    try {
      path = JSON.parse(typeof init.body === 'string' ? init.body : '')?.path
    }
    catch {
      path = undefined
    }
    return platformFetch.apply(this, arguments).then((response) => {
      // 目标程序由核心按目录所属应用拉起；只有受理成功才让出前台，失败时把响应
      // 原样交回页面，让用户看到错误并保留本窗口。
      if (response.ok) ipc.invoke('open_in_app', { path: typeof path === 'string' ? path : null }).catch(() => {})
      return response
    })
  }
})()
