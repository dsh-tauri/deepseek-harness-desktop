export const TEXT_AUTOSPACE_SHIM_SCRIPT = `(() => {
  const ua = navigator.userAgent || "";
  if (ua.indexOf("Linux") < 0 || ua.indexOf("AppleWebKit") < 0 || /Chrome|Chromium/.test(ua)) return;
  const style = document.createElement("style");
  style.setAttribute("data-dsh-desktop", "text-autospace");
  style.textContent = "html,body{text-autospace:no-autospace!important}";
  (document.head || document.documentElement).appendChild(style);
})();`
