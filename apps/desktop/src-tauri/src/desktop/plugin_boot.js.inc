(() => {
  const ipc = window.__TAURI_INTERNALS__
  const shell = globalThis.__DSH_SHELL__
  if (!ipc || !shell || !shell.window || !shell.guest) return

  const TITLE = 'Failed to load plugins'
  let stopped = false
  let sawBoot = false
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

  function evaluate() {
    if (stopped) return
    const boot = document.querySelector('[data-dsh-boot]')
    if (boot === null) {
      if (sawBoot) stop()
      return
    }
    sawBoot = true
    const detail = failureDetail(boot)
    if (detail === null) return
    stop()
    void ipc.invoke('plugin:event|emit_to', {
      target: { kind: 'Window', label: shell.window },
      event: 'dsh://plugin-boot:failed',
      payload: { label: shell.guest, detail },
    }).catch(error => console.warn('[boot] failed to report the plugin failure page', error))
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
