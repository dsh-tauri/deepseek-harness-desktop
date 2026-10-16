const gate = Promise.withResolvers();
globalThis.__DSH_BOOT_READY__ = gate;
gate.promise.catch(() => {});
let settled = false;

function notify(type, detail) {
  window.parent.postMessage({ type, id: preload.id, detail }, preload.parentOrigin);
}

function fail(error) {
  if (settled)
    return;
  settled = true;
  gate.reject(error);
  notify('dsh://frontend-preload:failed', String(error));
}

function sameAttributes(left, right) {
  return left.attributes.length === right.attributes.length
    && [...left.attributes].every(attribute => right.getAttribute(attribute.name) === attribute.value);
}

function prefix(live, template) {
  const actual = [...live.childNodes];
  const expected = [...template.childNodes];
  if (actual.length < expected.length)
    throw new Error('FRONTEND_PRELOAD_TEMPLATE: missing static nodes');
  const offset = actual.length - expected.length;
  if (!expected.every((node, index) => node.isEqualNode(actual[offset + index])))
    throw new Error('FRONTEND_PRELOAD_TEMPLATE: static frontend changed');
  return actual.slice(0, offset).filter(node => node.nodeType !== Node.TEXT_NODE || node.textContent.trim() !== '');
}

function plan(html) {
  const parser = new DOMParser();
  const live = parser.parseFromString(html, 'text/html');
  const template = parser.parseFromString(preload.template, 'text/html');
  if (!sameAttributes(live.documentElement, template.documentElement)
    || !sameAttributes(live.head, template.head) || !sameAttributes(live.body, template.body))
    throw new Error('FRONTEND_PRELOAD_TEMPLATE: document attributes changed');
  const head = prefix(live.head, template.head);
  const body = prefix(live.body, template.body);
  const ready = body.pop();
  if (ready?.nodeName !== 'SCRIPT' || ready.attributes.length !== 0
    || ready.textContent.trim() !== '(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()')
    throw new Error('FRONTEND_PRELOAD_BOOT: missing authoritative ready marker');
  const rows = [...head.map(node => [document.head, node]), ...body.map(node => [document.body, node])];
  let loader = false;
  let graph = false;
  for (const [, node] of rows) {
    if (node.nodeType !== Node.ELEMENT_NODE)
      throw new Error('FRONTEND_PRELOAD_TEMPLATE: unsupported injection node');
    if (node.nodeName === 'BASE') {
      if (node.attributes.length !== 1 || node.getAttribute('href') !== './')
        throw new Error('FRONTEND_PRELOAD_TEMPLATE: unsupported base');
    }
    else if (node.nodeName === 'SCRIPT') {
      if ([...node.attributes].some(attribute => attribute.name !== 'src'))
        throw new Error('FRONTEND_PRELOAD_TEMPLATE: unsupported script attributes');
      if (node.hasAttribute('src')) {
        const url = new URL(node.getAttribute('src'), location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith('/plugins/'))
          throw new Error('FRONTEND_PRELOAD_BOOT: script is not an owned plugin');
      }
      else {
        loader ||= node.textContent.includes('__ModuleLoader__');
        graph ||= node.textContent.includes('globalThis["__DSH_BOOT__"] = ');
        if (node.textContent.includes('__DSH_BOOT_READY__'))
          throw new Error('FRONTEND_PRELOAD_BOOT: unexpected readiness injection');
      }
    }
    else if (node.nodeName === 'LINK') {
      const url = new URL(node.getAttribute('href'), location.href);
      if (node.getAttribute('rel') !== 'preload' || node.getAttribute('as') !== 'script'
        || [...node.attributes].some(attribute => !['rel', 'as', 'href'].includes(attribute.name))
        || url.origin !== location.origin || !url.pathname.startsWith('/plugins/'))
        throw new Error('FRONTEND_PRELOAD_TEMPLATE: unsupported preload');
    }
    else if (node.nodeName !== 'STYLE' || node.attributes.length !== 0) {
      throw new Error('FRONTEND_PRELOAD_TEMPLATE: unsupported HTML injection');
    }
  }
  if (!loader || !graph)
    throw new Error('FRONTEND_PRELOAD_BOOT: missing module loader or graph');
  return rows;
}

async function apply(html) {
  const rows = plan(html);
  const anchors = new Map([[document.head, document.head.firstChild], [document.body, document.body.firstChild]]);
  for (const [target, node] of rows) {
    const element = document.createElement(node.localName);
    for (const attribute of node.attributes)
      element.setAttribute(attribute.name, attribute.value);
    element.textContent = node.textContent;
    if (node.nodeName === 'SCRIPT' && node.hasAttribute('src')) {
      await new Promise((resolve, reject) => {
        element.onload = resolve;
        element.onerror = () => reject(new Error('FRONTEND_PRELOAD_BOOT: plugin script failed'));
        target.insertBefore(element, anchors.get(target));
      });
    }
    else {
      target.insertBefore(element, anchors.get(target));
    }
    if (settled)
      throw new Error('FRONTEND_PRELOAD_BOOT: bootstrap interrupted');
  }
  if (!globalThis.__ModuleLoader__ || !globalThis.__DSH_BOOT__)
    throw new Error('FRONTEND_PRELOAD_BOOT: bootstrap did not initialize');
  settled = true;
  window.removeEventListener('message', receive);
  gate.resolve();
  notify('dsh://frontend-preload:applied');
}

function receive(event) {
  if (settled || event.source !== window.parent || event.origin !== preload.parentOrigin)
    return;
  const data = event.data;
  if (data?.source !== 'dsh-desktop' || data.type !== 'dsh://frontend-preload:boot' || data.id !== preload.id)
    return;
  if (typeof data.html !== 'string' || data.html.length > 4194304) {
    fail(new Error('FRONTEND_PRELOAD_BOOT: invalid live document'));
    return;
  }
  window.removeEventListener('message', receive);
  void apply(data.html).catch(fail);
}

window.addEventListener('message', receive);
window.addEventListener('pagehide', () => window.removeEventListener('message', receive), { once: true });
window.addEventListener('error', event => fail(event.error ?? new Error('FRONTEND_PRELOAD_ASSET: frontend asset failed')), { once: true });
window.addEventListener('DOMContentLoaded', () => notify('dsh://frontend-preload:waiting'), { once: true });
