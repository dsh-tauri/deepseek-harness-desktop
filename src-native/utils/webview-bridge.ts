import type { NativeNotificationMessage } from './notification-policy'
import { FOCUS_RETRY_INTERVAL_MS, FOCUS_TIMEOUT_MS } from '@/config/constants'
import { isRecord, isTrustedOrigin } from './bridge-protocol'

export type NativeWebViewMessage
  = | NativeNotificationMessage
    | { type: 'dsh://bridge-ready' }
    | { type: 'dsh://theme-state', theme: 'light' | 'dark' | 'system' }
    | { type: 'dsh://focus-result', requestId: string, handled: boolean }

export function parseNativeMessage(raw: string, nativeUrl: string, expectedOrigin: string, nonce: string): NativeWebViewMessage | null {
  if (raw.length > 16384 || !isTrustedOrigin(nativeUrl, expectedOrigin))
    return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.channel !== 'dsh-bridge' || value.nonce !== nonce || value.origin !== expectedOrigin)
      return null
    const payload = value.payload
    if (!isRecord(payload))
      return null
    if (payload.type === 'dsh://bridge-ready')
      return { type: 'dsh://bridge-ready' }
    if (payload.type === 'dsh://theme-state') {
      if (payload.theme !== 'light' && payload.theme !== 'dark' && payload.theme !== 'system')
        return null
      return { type: 'dsh://theme-state', theme: payload.theme }
    }
    if (payload.type === 'dsh://focus-result') {
      if (typeof payload.requestId !== 'string' || !payload.requestId || payload.requestId.length > 128 || typeof payload.handled !== 'boolean')
        return null
      return { type: 'dsh://focus-result', requestId: payload.requestId, handled: payload.handled }
    }
    if (payload.type !== 'dsh://native-notification')
      return null
    if (typeof payload.title !== 'string' || typeof payload.body !== 'string')
      return null
    if (!payload.title.trim() || payload.title.length > 256 || payload.body.length > 4096)
      return null
    if (payload.tag !== undefined && (typeof payload.tag !== 'string' || payload.tag.length > 256))
      return null
    if (payload.sessionId !== undefined && (typeof payload.sessionId !== 'string' || payload.sessionId.length > 256))
      return null
    if (payload.silent !== undefined && typeof payload.silent !== 'boolean')
      return null
    return {
      type: 'dsh://native-notification',
      title: payload.title,
      body: payload.body,
      tag: String(payload.tag ?? ''),
      sessionId: String(payload.sessionId ?? ''),
      silent: payload.silent === true,
    }
  }
  catch {
    return null
  }
}

export function createNotificationShim(origin: string, nonce: string): string {
  return `
(function () {
  var expectedOrigin = ${JSON.stringify(origin)};
  var nonce = ${JSON.stringify(nonce)};
  if (window.top !== window || location.origin !== expectedOrigin) return;
  function suppressTapHighlight() {
    if (document.getElementById('dsh-bridge-tap-highlight')) return;
    var style = document.createElement('style');
    style.id = 'dsh-bridge-tap-highlight';
    style.textContent = '* { -webkit-tap-highlight-color: transparent; }';
    (document.head || document.documentElement).appendChild(style);
  }
  if (document.documentElement) suppressTapHighlight();
  else document.addEventListener('DOMContentLoaded', suppressTapHighlight, { once: true });
  if (window.__dshBridgeNonce === nonce) {
    if (typeof window.__dshBridgeReady === 'function') window.__dshBridgeReady();
    return;
  }
  if (typeof window.__dshBridgeDispose === 'function') window.__dshBridgeDispose();
  window.__dshBridgeNonce = nonce;
  var active = true;
  var instances = new Map();
  var sessionRunning = new Map();
  var completionSent = new Set();
  var completionTimers = new Map();
  var listSource = null;
  var statusSource = null;
  var disposeList = null;
  var disposeStatus = null;
  var sessionWatchTimer = null;
  var sessionWatchAttempts = 0;
  var hidden = document.hidden;
  var sequence = 0;
  var pendingFocus = null;
  var focusStartedAt = 0;
  var focusTimer = null;
  var results = new Map();
  function send(payload) {
    if (!active || window.__dshBridgeNonce !== nonce || !window.ReactNativeWebView) return false;
    var raw = JSON.stringify({ channel: 'dsh-bridge', origin: expectedOrigin, nonce: nonce, payload: payload });
    if (raw.length > 16384) return false;
    window.ReactNativeWebView.postMessage(raw);
    return true;
  }
  function cancelCompletion(sessionId) {
    clearTimeout(completionTimers.get(sessionId));
    completionTimers.delete(sessionId);
  }
  function forwardNotification(payload) {
    // Why: rejected native payloads must not consume an otherwise valid completion fallback.
    if (payload.type !== 'dsh://native-notification' || typeof payload.title !== 'string' || !payload.title.trim()
      || payload.title.length > 256 || typeof payload.body !== 'string' || payload.body.length > 4096
      || (payload.tag !== undefined && (typeof payload.tag !== 'string' || payload.tag.length > 256))
      || (payload.sessionId !== undefined && (typeof payload.sessionId !== 'string' || payload.sessionId.length > 256))
      || (payload.silent !== undefined && typeof payload.silent !== 'boolean')) return;
    var tag = payload.tag || '';
    var sessionId = payload.sessionId || sessionIdFromTag(tag);
    var completed = /^dsh-notification-(?!pending-).+-\\d+$/.test(tag) && sessionRunning.has(sessionId);
    if (completed && completionSent.has(sessionId)) return;
    if (send(payload) && completed) {
      cancelCompletion(sessionId);
      completionSent.add(sessionId);
    }
  }
  function sessionIdFromTag(tag) {
    var match = /^dsh-notification-(?:pending-)?(.+)-\\d+$/.exec(tag || '');
    return match ? match[1] : '';
  }
  function DshNotification(title, options) {
    options = options || {};
    this.title = String(title || '');
    this.body = String(options.body || '');
    this.tag = String(options.tag || ('mobile-' + Date.now() + '-' + (++sequence)));
    this.onclick = null;
    this.onclose = null;
    this.onaction = null;
    instances.set(this.tag, this);
    if (instances.size > 128) instances.delete(instances.keys().next().value);
    forwardNotification({
      type: 'dsh://native-notification', title: this.title, body: this.body,
      tag: this.tag, sessionId: options.sessionId || sessionIdFromTag(this.tag),
      silent: options.silent === true
    });
  }
  DshNotification.permission = 'granted';
  DshNotification.requestPermission = function () { return Promise.resolve('granted'); };
  DshNotification.prototype.close = function () { instances.delete(this.tag); };
  window.Notification = DshNotification;
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return hidden; } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return hidden ? 'hidden' : 'visible'; } });
  } catch (_) {}
  function receiveNotification(event) {
    if (event.origin !== expectedOrigin || event.source !== window) return;
    var data = event.data;
    if (data && data.type === 'dsh://native-notification') forwardNotification(data);
  }
  window.addEventListener('message', receiveNotification);
  function focusResult(data, handled) {
    results.set(data.requestId, handled);
    if (results.size > 32) results.delete(results.keys().next().value);
    send({ type: 'dsh://focus-result', requestId: data.requestId, handled: handled });
  }
  function openSession(sessionId) {
    if (!sessionId) return true;
    var ctx = window.__dshClientCtx;
    try {
      var workspace = ctx && (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : ctx.uiWorkspace);
      if (workspace && typeof workspace.openSession === 'function') {
        workspace.openSession(sessionId);
        return true;
      }
    } catch (_) {}
    // Why: DSH 0.1.6 moved session selection from sessions.open to uiWorkspace.openSession.
    try {
      var sessions = ctx && ctx.sessions;
      if (sessions && typeof sessions.open === 'function') {
        sessions.open(sessionId);
        return true;
      }
    } catch (_) {}
    var nodes = document.querySelectorAll('[data-row-key]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-row-key') === 'session:' + sessionId) {
        nodes[i].click();
        return true;
      }
    }
    return false;
  }
  function tryFocus() {
    focusTimer = null;
    var data = pendingFocus;
    if (!data) return;
    if (!hidden && document.readyState === 'complete' && openSession(data.sessionId)) {
      pendingFocus = null;
      var instance = instances.get(data.tag);
      if (instance) {
        instances.delete(data.tag);
        try { if (typeof instance.onclick === 'function') instance.onclick(new Event('click')); } catch (_) {}
      }
      window.dispatchEvent(new MessageEvent('message', { data: data, origin: expectedOrigin, source: window }));
      focusResult(data, true);
      return;
    }
    if (Date.now() - focusStartedAt >= ${FOCUS_TIMEOUT_MS}) {
      pendingFocus = null;
      focusResult(data, false);
      return;
    }
    focusTimer = setTimeout(tryFocus, ${FOCUS_RETRY_INTERVAL_MS});
  }
  window.__dshBridgeReceive = function (data) {
    if (!active || window.__dshBridgeNonce !== nonce || !data || data.nonce !== nonce) return;
    if (data.type === 'dsh://visibility-state') {
      if (hidden !== !!data.hidden) {
        hidden = !!data.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      }
    }
    if (data.type === 'dsh://notification-clicked') {
      var instance = instances.get(data.tag);
      if (instance) {
        instances.delete(data.tag);
        if (typeof instance.onclick === 'function') instance.onclick(new Event('click'));
      }
      window.dispatchEvent(new MessageEvent('message', { data: data, origin: expectedOrigin }));
    }
    if (data.type === 'dsh://cancel-focus' && pendingFocus && pendingFocus.requestId === data.requestId) {
      pendingFocus = null;
      clearTimeout(focusTimer);
      focusTimer = null;
    }
    if (data.type === 'dsh://focus-session' && typeof data.requestId === 'string' && data.requestId && typeof data.sessionId === 'string' && typeof data.tag === 'string') {
      if (results.has(data.requestId)) {
        send({ type: 'dsh://focus-result', requestId: data.requestId, handled: results.get(data.requestId) });
        return;
      }
      clearTimeout(focusTimer);
      pendingFocus = { type: data.type, requestId: data.requestId, sessionId: data.sessionId, tag: data.tag, title: data.title };
      focusStartedAt = Date.now();
      tryFocus();
    }
  };
  function readService(name) {
    var ctx = window.__dshClientCtx;
    try { return ctx && (typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]); } catch (_) {}
  }
  function sessionObservation(sessionId, list, statuses) {
    var summary = list && list.byId[sessionId];
    if (!summary || summary.origin === 'subagent') return;
    var status = statuses && statuses.get(sessionId);
    return { summary: summary, running: statusSource ? status && status.running : summary.running, pending: status && status.pendingInteraction };
  }
  function observeSessions() {
    if (!active || window.__dshBridgeNonce !== nonce || !listSource) return;
    var list = listSource.getSnapshot();
    var statuses = statusSource && statusSource.getSnapshot();
    var present = new Set();
    list.ids.forEach(function (sessionId) {
      var observed = sessionObservation(sessionId, list, statuses);
      if (!observed) return;
      present.add(sessionId);
      var previous = sessionRunning.get(sessionId);
      sessionRunning.set(sessionId, observed.running);
      if (observed.running === true && previous !== true) {
        completionSent.delete(sessionId);
        cancelCompletion(sessionId);
      }
      if (previous === true && observed.running === false && !observed.pending && hidden) {
        cancelCompletion(sessionId);
        completionTimers.set(sessionId, setTimeout(function () {
          completionTimers.delete(sessionId);
          var latestList = listSource && listSource.getSnapshot();
          var current = sessionObservation(sessionId, latestList, statusSource && statusSource.getSnapshot());
          if (!active || !hidden || !current || latestList.ids.indexOf(sessionId) === -1
            || current.running !== false || current.pending || completionSent.has(sessionId)) return;
          var title = String(current.summary.displayTitle || current.summary.title || '').trim().slice(0, 256) || 'DSH 会话';
          new DshNotification(title, { body: '轮次已完成', sessionId: sessionId, tag: 'dsh-notification-' + sessionId + '-' + (++sequence) });
        }, 250));
      }
    });
    sessionRunning.forEach(function (_, sessionId) {
      if (present.has(sessionId)) return;
      sessionRunning.delete(sessionId);
      completionSent.delete(sessionId);
      cancelCompletion(sessionId);
    });
  }
  function watchSessions() {
    sessionWatchTimer = null;
    if (!active || !readySent || window.__dshBridgeNonce !== nonce) return;
    var sessions = readService('sessions');
    var uiSession = readService('uiSession');
    if (!listSource && sessions && sessions.list && typeof sessions.list.subscribe === 'function' && typeof sessions.list.getSnapshot === 'function') {
      listSource = sessions.list;
      disposeList = listSource.subscribe(observeSessions);
    }
    if (!statusSource && uiSession && uiSession.sessionStatus && typeof uiSession.sessionStatus.subscribe === 'function' && typeof uiSession.sessionStatus.getSnapshot === 'function') {
      statusSource = uiSession.sessionStatus;
      disposeStatus = statusSource.subscribe(observeSessions);
    }
    observeSessions();
    if ((!listSource || !statusSource) && (window.__DSH_BOOT__ || window.__dshClientCtx)) {
      // ponytail: one slow attach timer supports late/legacy providers; stop it when both public sources exist.
      sessionWatchTimer = setTimeout(watchSessions, sessionWatchAttempts++ < 20 ? 250 : 5000);
    }
  }
  var readySent = false;
  var lastTheme = null;
  var themeObserver = null;
  function syncTheme() {
    if (!readySent || window.__dshBridgeNonce !== nonce || !window.ReactNativeWebView) return;
    var root = document.documentElement;
    var theme = root && root.getAttribute('data-ds-theme-source');
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') {
      if (!document.body || (!window.__DSH_BOOT__ && !window.__dshClientCtx)) return;
      theme = document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
    }
    if (theme === lastTheme) return;
    lastTheme = theme;
    send({ type: 'dsh://theme-state', theme: theme });
  }
  function ready() {
    if (!active || window.__dshBridgeNonce !== nonce) return;
    if (!readySent && window.ReactNativeWebView && document.readyState === 'complete'
      && (window.__DSH_BOOT__ || window.__dshClientCtx || document.getElementById('loginForm'))) {
      readySent = true;
      send({ type: 'dsh://bridge-ready' });
    }
    if (readySent && !themeObserver && document.documentElement) {
      themeObserver = new MutationObserver(syncTheme);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-theme-source'] });
      if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
      window.__dshBridgeThemeObserver = themeObserver;
    }
    syncTheme();
    clearTimeout(sessionWatchTimer);
    watchSessions();
  }
  window.__dshBridgeReady = ready;
  if (document.readyState === 'complete') ready();
  else window.addEventListener('load', ready, { once: true });
  function dispose() {
    if (!active) return;
    active = false;
    window.removeEventListener('message', receiveNotification);
    window.removeEventListener('load', ready);
    window.removeEventListener('pagehide', dispose);
    document.removeEventListener('DOMContentLoaded', suppressTapHighlight);
    if (window.__dshBridgeNonce === nonce) window.__dshBridgeNonce = null;
    pendingFocus = null;
    clearTimeout(focusTimer);
    clearTimeout(sessionWatchTimer);
    completionTimers.forEach(clearTimeout);
    completionTimers.clear();
    if (disposeList) disposeList();
    if (disposeStatus) disposeStatus();
    disposeList = null;
    disposeStatus = null;
    if (themeObserver) themeObserver.disconnect();
    themeObserver = null;
  }
  window.__dshBridgeDispose = dispose;
  window.addEventListener('pagehide', dispose);
})(); true;
`
}

export function nativeMessageScript(origin: string, nonce: string, payload: Record<string, unknown>): string {
  return `if (window.top === window && location.origin === ${JSON.stringify(origin)} && window.__dshBridgeNonce === ${JSON.stringify(nonce)}) { window.__dshBridgeReceive && window.__dshBridgeReceive(${JSON.stringify({ ...payload, nonce })}); } true;`
}
