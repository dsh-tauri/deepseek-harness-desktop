(() => {
  const ipc = window.__TAURI_INTERNALS__
  const shell = globalThis.__DSH_SHELL__
  if (!ipc || !shell || !shell.window || !shell.guest) return

  const TITLE = 'Failed to load plugins'
  // 上报失败时有界重试：失败卡片还在页面上，壳层却收不到事件就永远不会切错误页。
  const REPORT_ATTEMPTS = 3
  let stopped = false
  let sawBoot = false
  let reporting = false
  let attempts = 0
  let observer
  let timer

  function stop() {
    if (stopped) return
    stopped = true
    observer?.disconnect()
    clearInterval(timer)
    window.removeEventListener('pagehide', stop)
  }

  // 逐叶子取文本并按行拼接：官方失败卡片是「标题 + 逐项状态行」的多行结构，
  // 壳层与 Rust 侧的插件定位都依赖这些行边界（压成单行会丢掉包名上下文）。
  function lines(node, out) {
    if (node.children.length === 0) {
      const text = (node.textContent ?? '').trim()
      if (text !== '') out.push(text)
      return
    }
    for (const child of node.children) lines(child, out)
    return out
  }

  function failureDetail(boot) {
    const rows = lines(boot, [])
    const at = rows.indexOf(TITLE)
    return at < 0 ? null : rows.slice(at).join('\n')
  }

  function report(detail) {
    // 上报在飞时不再发第二个请求：观察器与轮询会重复命中同一张失败卡片。
    if (reporting) return
    reporting = true
    attempts += 1
    ipc.invoke('plugin:event|emit_to', {
      target: { kind: 'Window', label: shell.window },
      event: 'dsh://plugin-boot:failed',
      payload: { label: shell.guest, detail },
    }).then(
      () => stop(),
      (error) => {
        console.warn('[boot] failed to report the plugin failure page', error)
        reporting = false
        if (attempts >= REPORT_ATTEMPTS) stop()
      },
    )
  }

  function evaluate() {
    if (stopped) return
    const boot = document.querySelector('[data-dsh-boot]')
    if (boot === null) {
      if (sawBoot) stop()
      return
    }
    sawBoot = true
    const detail = failureDetail(boot)
    if (detail !== null) report(detail)
  }

  observer = new MutationObserver(evaluate)
  try {
    observer.observe(document, { childList: true, subtree: true, characterData: true })
  }
  catch (error) {
    console.warn('[boot] cannot observe the document', error)
  }
  timer = setInterval(evaluate, 1000)
  window.addEventListener('pagehide', stop)
  evaluate()
})()
