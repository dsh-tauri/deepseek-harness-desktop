//! 剪贴板回退桥：让 Linux/WebKitGTK 下 iframe 的「贴图 / 贴文件」走原生剪贴板。
//!
//! WebKitGTK 不通过 Web API 暴露 `image/*` 与文件（`text/uri-list` /
//! `x-special/gnome-copied-files`）剪贴板条目，因此截图或从文件管理器复制文件后，
//! 在桌面端内嵌的 dsh iframe 中输入框按 Ctrl+V 时，`paste` 事件的 `clipboardData`
//! 里既没有图片、没有文件、往往也没有文本。本脚本在**捕获阶段**监听 `paste`，
//! 检测到「无图片且无文本」时：preventDefault → 先向宿主请求读取系统剪贴板文件
//! （宿主调用 `bridge::read_clipboard_files`）→ 有文件则把全部条目塞进同一个
//! `DataTransfer` 构造 `File` 并重发一次合成 `paste`；无文件再回退读取剪贴板图片
//! （宿主调用 `bridge::read_clipboard_image`）→ 拿到 PNG data URL → 构造 `File`
//! 重发合成 `paste`。两条路径都让 dsh 聊天框按普通附件处理，与浏览器行为一致。
//!
//! 与 [`crate::desktop::notification::NOTIFICATION_SHIM_JS`] / [`crate::desktop::compat::ABORT_SIGNAL_ANY_SHIM_JS`]
//! 走同一套注入通道（Windows 在 FrameCreated → ContentLoading 时 ExecuteScript，
//! 其余平台 `initialization_script_for_all_frames`）。脚本带 `__dsh_clipboard_image_bridge__`
//! 幂等守卫，重复注入安全；只处理「直接 iframe」发来的剪贴板请求，避免多层 iframe 误转发。
//!
//! 安全：文件路径完全来自**系统剪贴板**（宿主侧读取并回传），iframe 只能请求
//! 「读剪贴板」而不能指定路径，因此不能借本桥读取本机任意文件（issue #1160）。

pub(crate) const PASTE_SHIM_JS: &str = r#"(function () {
  if (window.__dsh_clipboard_image_bridge__) return;
  window.__dsh_clipboard_image_bridge__ = true;

  // 请求方向：iframe → 宿主；响应方向：宿主 → iframe。
  // 两个方向都按 `type` 识别：宿主 → iframe 的桥统一由 useIframePost 补
  // `source: 'dsh-desktop'`，这里只比对 `type`，不再比对 `source`。
  var REQ_SRC = 'dsh-clipboard-image-bridge';
  var REQ_TYPE = 'dsh://clipboard-image:read';
  var RES_TYPE = 'dsh://clipboard-image:reply';
  var REQ_FILES_TYPE = 'dsh://clipboard-files:read';
  var RES_FILES_TYPE = 'dsh://clipboard-files:reply';

  var reqSeq = 0;
  var pending = {}; // id -> resolve（宿主回包按 type 分发，携带原始 data 调用）
  // 宿主未回包（多层 iframe / 桥未挂载）时不能把右键菜单动作永久挂住。
  var REQUEST_TIMEOUT_MS = 10000;

  function request(reqType) {
    return new Promise(function (resolve) {
      reqSeq += 1;
      var id = 'req-' + reqSeq;
      var timer = setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      pending[id] = function (data) {
        clearTimeout(timer);
        resolve(data);
      };
      try {
        window.parent.postMessage({ source: REQ_SRC, type: reqType, id: id }, '*');
      } catch (_) {
        clearTimeout(timer);
        delete pending[id];
        resolve(null);
      }
    });
  }

  // 宿主回包：只接受直接父窗口发来、`type` 匹配的回包
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== RES_TYPE && data.type !== RES_FILES_TYPE) return;
    var resolve = pending[data.id];
    if (!resolve) return;
    delete pending[data.id];
    resolve(data);
  });

  // 剪贴板事件里是否已带图片 / 文件（非 WebKitGTK 场景）：不介入，交 dsh 自身处理
  function hasImageData(dt) {
    if (!dt) return false;
    try {
      if (dt.items) {
        for (var i = 0; i < dt.items.length; i++) {
          var it = dt.items[i];
          if (it && it.type && it.type.indexOf('image/') === 0) return true;
        }
      }
      if (dt.files && dt.files.length > 0) return true;
      var types = dt.types || [];
      for (var j = 0; j < types.length; j++) {
        if (types[j] === 'Files') return true;
      }
    } catch (_) {}
    return false;
  }

  // 剪贴板事件里是否带文本/HTML（普通文本复制）：不介入，让 dsh 正常粘贴文本
  function hasTextData(dt) {
    if (!dt) return false;
    try {
      if (dt.getData('text/plain')) return true;
      if (dt.getData('text/html')) return true;
      var types = dt.types || [];
      return types.indexOf('text/plain') !== -1 || types.indexOf('text/html') !== -1;
    } catch (_) {
      return false;
    }
  }

  function isPasteTarget(target) {
    return !!(target && (target.isContentEditable || /^(textarea|INPUT)$/i.test(target.tagName)));
  }

  function dataUrlToBlob(dataUrl) {
    var comma = dataUrl.indexOf(',');
    if (comma === -1) return null;
    var header = dataUrl.slice(0, comma);
    var mime = (header.match(/:(.*?);/) || [])[1] || 'image/png';
    var b64 = dataUrl.slice(comma + 1);
    try {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    } catch (_) {
      return null;
    }
  }

  // 把若干 File 塞进同一个 DataTransfer，派发一次合成 paste 给焦点元素。
  // 返回是否真的派发成功：菜单据此决定是否还要提示读取失败。
  function dispatchPasteWithFiles(target, files) {
    try {
      var dt = new DataTransfer();
      for (var i = 0; i < files.length; i++) dt.items.add(files[i]);
      var ev;
      try {
        ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      } catch (_) {
        // 个别 WebKit 版本 ClipboardEvent 构造器不支持 clipboardData：用普通事件补属性
        ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
      }
      if (target.isConnected) {
        target.dispatchEvent(ev);
        return true;
      }
      var active = document.activeElement;
      if (active && isPasteTarget(active)) {
        active.dispatchEvent(ev);
        return true;
      }
    } catch (_) {}
    return false;
  }

  // 把图片作为 File 塞进新的 DataTransfer，再派发合成 paste 给焦点元素
  function dispatchImagePaste(target, dataUrl) {
    var blob = dataUrlToBlob(dataUrl);
    if (!blob) return false;
    var file = new File([blob], 'clipboard-image.png', { type: blob.type || 'image/png' });
    return dispatchPasteWithFiles(target, [file]);
  }

  // 把宿主回传的文件条目（data_url + 真实文件名/MIME）还原成 File 后一次性派发。
  // 返回成功构造的数量，0 表示宿主没给到可用文件（调用方据此回退图片路径）。
  function dispatchFilesPaste(target, entries) {
    var files = [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry || typeof entry.data_url !== 'string') continue;
      var blob = dataUrlToBlob(entry.data_url);
      if (!blob) continue;
      files.push(new File([blob], entry.filename || 'clipboard-file', { type: entry.mime || blob.type || 'application/octet-stream' }));
    }
    if (files.length === 0) return false;
    return dispatchPasteWithFiles(target, files);
  }

  // 先问文件：从文件管理器复制文件时剪贴板只有 uri-list（对 WebKit 表现为
  // 无图无文本），命中即贴文件（issue #1160）；复制截图时文件列表为空，
  // 落回原有图片通路（issue #610），两条路互不干扰。
  function pasteFromNative(target) {
    return request(REQ_FILES_TYPE).then(function (fileData) {
      var entries = (fileData && fileData.files) || [];
      if (entries.length > 0 && dispatchFilesPaste(target, entries)) return true;
      // 剪贴板里确实有文件、但全部被拒（超限/不可读/目录）：宿主已 toast 说明原因，
      // 这里不再落回图片通路——那只会再报一次「读不到图片」，把真实原因盖掉。
      if (fileData && fileData.rejected && fileData.rejected.length > 0) return true;
      return request(REQ_TYPE).then(function (imageData) {
        var dataUrl = imageData && imageData.data_url;
        if (!dataUrl) return false;
        return dispatchImagePaste(target, dataUrl);
      });
    });
  }

  // 捕获阶段先于 dsh 应用自身监听：空剪贴板时接管并走原生读取。
  // 仅当本窗口是子 frame（dsh iframe）时才接管；顶层壳层文档里没有聊天框，
  // 且 `window.parent` 指向自身，postMessage 不会命中宿主（见 handleClipboardImage），
  // 这里直接把拦截限定在子 frame，避免对壳层输入产生任何干扰。
  if (window !== window.parent) {
    // 右键菜单的「粘贴」只读得到纯文本；复制文件/图片时由菜单直接调用这里（issue #1190）。
    window.__dsh_paste_clipboard__ = pasteFromNative;
    document.addEventListener('paste', function (event) {
      var dt = event.clipboardData;
      if (hasImageData(dt)) return;
      if (hasTextData(dt)) return;

      var target = document.activeElement || event.target;
      if (!isPasteTarget(target)) return;

      event.preventDefault();
      pasteFromNative(target);
    }, true);
  }
})();"#;
