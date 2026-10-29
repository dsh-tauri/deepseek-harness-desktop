export const WEBRTC_FALLBACK_SCRIPT = `(() => {
  if (typeof globalThis.RTCPeerConnection === "function" || globalThis.__dshWebRtcFallback) return;
  const ua = navigator.userAgent || "";
  if (ua.indexOf("Linux") < 0 || ua.indexOf("AppleWebKit") < 0 || /Chrome|Chromium/.test(ua)) return;
  const zh = /^zh/i.test(navigator.language || "");
  const text = zh
    ? { body: "当前桌面端的 WebKitGTK 没有 WebRTC，实时语音无法使用。可在系统浏览器中打开同一界面继续通话。", open: "在浏览器中打开", close: "关闭" }
    : { body: "This desktop build's WebKitGTK has no WebRTC, so live voice calls cannot run here. Open the same UI in your system browser to keep talking.", open: "Open in browser", close: "Dismiss" };
  const browserUrl = () => {
    const url = new URL(location.href);
    url.searchParams.delete("dshDesktop");
    return url.href;
  };
  const openInBrowser = () => {
    const nonce = "webrtc-fallback-" + Date.now();
    parent.postMessage({ type: "dsh://tauri:invoke", cmd: "open_external_url", args: { url: browserUrl() }, nonce }, "*");
  };
  let panel = null;
  const button = (label, onClick) => {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.style.cssText = "margin-left:8px;padding:2px 10px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;font:inherit";
    node.addEventListener("click", onClick);
    return node;
  };
  const show = () => {
    if (panel && panel.isConnected) return;
    panel = document.createElement("div");
    panel.setAttribute("role", "alert");
    panel.setAttribute("data-dsh-webrtc-fallback", "");
    panel.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,90vw);padding:10px 14px;border-radius:10px;background:#1f2937;color:#f9fafb;box-shadow:0 8px 24px rgba(0,0,0,.35);font:13px/1.5 system-ui,sans-serif";
    const message = document.createElement("span");
    message.textContent = text.body;
    panel.append(message, button(text.open, openInBrowser), button(text.close, () => panel.remove()));
    (document.body || document.documentElement).appendChild(panel);
  };
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    get() {
      show();
      return undefined;
    },
    set(value) {
      Object.defineProperty(globalThis, "RTCPeerConnection", { value, writable: true, configurable: true });
    },
    configurable: true
  });
  Object.defineProperty(globalThis, "__dshWebRtcFallback", { value: true });
})();`
