#[cfg(windows)]
use tauri::Manager;

/// 如果 DSH 插件仍有兜底走浏览器 Notification，则保持“已授权”假象，
/// 并让每次 `new Notification(...)` 转成发给宿主窗口的 postMessage。
pub(crate) const NOTIFICATION_SHIM_JS: &str = r#"(function () {
  if (window.__dsh_native_notification_bridge__) return;
  window.__dsh_native_notification_bridge__ = true;

  var hostHidden = false;
  var pendingOnClicks = {};

  function setHostHidden(hidden) {
    hidden = !!hidden;
    if (hostHidden === hidden) return;
    hostHidden = hidden;
    try { document.dispatchEvent(new Event('visibilitychange')); } catch (_) {}
  }

  function send(message) {
    try {
      window.parent.postMessage(Object.assign({ source: 'dsh-notification-bridge' }, message), '*');
    } catch (_) {}
  }

  function sessionIdFromTag(tag) {
    var m = /^dsh-notification-(?:pending-)?(.+)-\d+$/.exec(tag || '');
    return m ? m[1] : '';
  }

  function DshNativeNotification(title, options) {
    options = options || {};
    this.title = String(title || '');
    this.options = options;
    this.tag = options.tag || '';
    this.onclick = null;
    this.onaction = null;
    this.onclose = null;
    this.onerror = null;
    this.onshow = null;

    if (this.tag) pendingOnClicks[this.tag] = this;

    send({
      type: 'dsh://native-notification',
      title: this.title,
      body: String(options.body || ''),
      tag: this.tag,
      requireInteraction: !!options.requireInteraction,
      silent: !!options.silent,
      sessionId: options.sessionId || sessionIdFromTag(this.tag),
      actions: Array.isArray(options.actions) ? options.actions : [],
      href: location.href,
      origin: location.origin
    });
  }

  DshNativeNotification.permission = 'granted';
  DshNativeNotification.requestPermission = function () {
    return Promise.resolve('granted');
  };
  DshNativeNotification.prototype.close = function () {
    if (!this.tag) return;
    // 关掉后不会再回灌点击：及时释放实例，避免 pendingOnClicks 无限增长。
    delete pendingOnClicks[this.tag];
    send({ type: 'dsh://close-notification', tag: this.tag });
  };

  window.Notification = DshNativeNotification;

  // 属性拦截：让 iframe 中的 visibilityState 强行跟随桌面宿主状态
  (function installHiddenOverrides() {
    var descMap = {
      hidden: { configurable: true, get: function () { return hostHidden; } },
      visibilityState: { configurable: true, get: function () { return hostHidden ? 'hidden' : 'visible'; } }
    };
    [document, Object.getPrototypeOf(document)].forEach(function (target) {
      if (!target) return;
      try {
        Object.defineProperty(target, 'hidden', descMap.hidden);
        Object.defineProperty(target, 'visibilityState', descMap.visibilityState);
      } catch (_) {}
    });
  })();

  // 宿主状态只认壳层推送（`dsh://visibility-state`）与「帧内拿到焦点」这一条正向证据。
  // 以前这里还有 `blur → 隐藏`，但帧失焦 ≠ 窗口隐藏：点壳层标题栏、设置面板都会让
  // 帧 blur，而窗口仍在前台；那条误判会让「仅在未聚焦时」在用户正盯着会话时弹通知。
  // 帧拿到焦点则窗口必然在前台（最小化的窗口给不了焦点），所以 focus 可以安全地纠正。
  window.addEventListener('focus', function () { setHostHidden(false); });

  // 查找并聚焦对应的 Session
  function tryFocusSession(sessionId, title) {
    if (!sessionId && !title) return;

    if (typeof window.__dsh_focusSession === 'function') {
      try { window.__dsh_focusSession(sessionId); return; } catch (_) {}
    }

    if (sessionId) {
      var el = document.querySelector('[data-session-id="' + sessionId + '"], [data-session="' + sessionId + '"], [data-id="' + sessionId + '"]');
      if (el) { el.click(); return; }
    }

    if (title) {
      var trimmedTitle = String(title).trim();
      var nodes = document.querySelectorAll('button, [role="button"], li, a');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].offsetParent !== null && nodes[i].textContent.trim() === trimmedTitle) {
          nodes[i].click();
          return;
        }
      }
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    switch (data.type) {
      case 'dsh://visibility-state':
        setHostHidden(data.hidden);
        break;
      case 'dsh://focus-session':
        tryFocusSession(data.sessionId, data.title);
        break;
      case 'dsh://notification-clicked':
        var instance = pendingOnClicks[data.tag];
        if (!instance) break;
        // 一次点击只回灌一次；用完即弃，避免长时间运行后字典持续增长。
        delete pendingOnClicks[data.tag];
        // 按钮点击走 onaction（动作 id 由前端约定），点通知本体走 onclick。
        // 带输入框的按钮（如「回复」）把用户填的文本一并回灌；没填时给空串。
        if (data.action && typeof instance.onaction === 'function') {
          var inputValue = typeof data.inputValue === 'string' ? data.inputValue : '';
          try { instance.onaction({ action: String(data.action), tag: data.tag, inputValue: inputValue }); } catch (_) {}
        } else if (typeof instance.onclick === 'function') {
          try { instance.onclick(new Event('click')); } catch (_) {}
        }
        break;
    }
  });
})();"#;

/// 在 Windows WebView2 中接管 iframe 内的通知请求并注入原生通知桥。
#[cfg(windows)]
pub fn enable_notification_permissions(
    webview: tauri::webview::PlatformWebview,
    parent: tauri::WebviewWindow<tauri::Wry>,
) -> Result<(), Box<dyn std::error::Error>> {
    use rfd::{MessageButtons, MessageDialog, MessageDialogResult};
    use webview2_com::{
        ExecuteScriptCompletedHandler, FrameContentLoadingEventHandler, FrameCreatedEventHandler,
        FramePermissionRequestedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Frame3, ICoreWebView2Profile4, ICoreWebView2_13, ICoreWebView2_4,
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
            COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
            COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE, COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
            COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES,
            COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS,
            COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION,
            COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            COREWEBVIEW2_PERMISSION_STATE_DEFAULT, COREWEBVIEW2_PERMISSION_STATE_DENY,
        },
        PermissionRequestedEventHandler, SetPermissionStateCompletedHandler,
    };
    use windows_core::{Interface, HSTRING};

    log::info!("[notification] registering WebView2 notification handlers");

    fn ask_notification_permission(parent: &tauri::WebviewWindow<tauri::Wry>) -> bool {
        MessageDialog::new()
            .set_parent(parent)
            .set_title("允许发送通知？")
            .set_description("DSH 页面请求发送桌面通知。是否允许？")
            .set_buttons(MessageButtons::YesNo)
            .show()
            == MessageDialogResult::Yes
    }

    fn notification_origins(parent: &tauri::WebviewWindow<tauri::Wry>) -> Vec<String> {
        let mut origins = vec![
            crate::config::get_dsh_service_url(crate::config::DSH_PORT),
            crate::config::get_dsh_service_url(crate::config::DSH_DEV_PORT),
        ];
        let profile = crate::service::workflow::instances::window_profile(
            parent.app_handle(),
            parent.label(),
        );
        let port = crate::service::workflow::instances::scope_sync(profile, || {
            crate::service::workflow::instances::port(parent.app_handle())
        });
        let store_origin = crate::config::get_dsh_service_url(port);
        if !origins.contains(&store_origin) {
            origins.push(store_origin);
        }
        origins
    }

    fn permission_kinds() -> [COREWEBVIEW2_PERMISSION_KIND; 12] {
        [
            COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
            COREWEBVIEW2_PERMISSION_KIND_CAMERA,
            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
            COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE,
            COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
            COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS,
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES,
            COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
            COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS,
            COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT,
            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
        ]
    }

    fn should_allow_permission(kind: COREWEBVIEW2_PERMISSION_KIND) -> bool {
        matches!(
            kind,
            COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY
                | COREWEBVIEW2_PERMISSION_KIND_CAMERA
                | COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ
                | COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE
                | COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION
                | COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS
                | COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                | COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES
                | COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS
                | COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS
                | COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT
        )
    }

    unsafe fn reset_persisted_notification_permissions(
        webview2: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
        origins: &[String],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let webview13 = webview2.cast::<ICoreWebView2_13>()?;
        let profile = webview13.Profile()?;
        let Ok(profile4) = profile.cast::<ICoreWebView2Profile4>() else {
            log::warn!("[notification] ICoreWebView2Profile4 cast failed; skip reset.");
            return Ok(());
        };

        for origin in origins {
            // 每个 origin 要写 12 种 permission：逐个 INFO 会在一毫秒内刷出二十多行，
            // 把 desktop.log 真正有用的行挤走。正常路径只留一条 debug 汇总
            // （`RUST_LOG=debug` 可见），失败仍逐次告警。
            log::debug!("[permission] resetting persisted permissions for {origin}");
            for kind in permission_kinds() {
                let origin_str = origin.clone();
                let hstring = HSTRING::from(origin.as_str());
                // HSTRING 是引用计数类型，克隆只增加引用计数、共享底层缓冲区。
                // 回调（completed handler）是异步调用的，让克隆句柄随回调一起持有，
                // 避免 SetPermissionState 借用的句柄在回调存活期内失效。
                let hstring_for_callback = hstring.clone();
                let state = if kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                    COREWEBVIEW2_PERMISSION_STATE_DEFAULT
                } else {
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW
                };

                profile4.SetPermissionState(
                    kind,
                    &hstring,
                    state,
                    &SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                        if let Err(e) = result {
                            log::warn!(
                                "[permission] failed to set permission for {origin_str}: {e}"
                            );
                        }
                        let _ = &hstring_for_callback;
                        Ok(())
                    })),
                )?;
            }
        }
        Ok(())
    }

    unsafe fn setup_frame_handlers(
        frame3: ICoreWebView2Frame3,
        parent: tauri::WebviewWindow<tauri::Wry>,
    ) {
        let parent_for_frame = parent.clone();
        let mut permission_token = 0i64;

        let _ = frame3.add_PermissionRequested(
            &FramePermissionRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;

                    let state = if kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                        if ask_notification_permission(&parent_for_frame) {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        }
                    } else if should_allow_permission(kind) {
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW
                    } else {
                        COREWEBVIEW2_PERMISSION_STATE_DEFAULT
                    };
                    if kind != COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION {
                        args.SetState(state)?;
                        args.SetHandled(true)?;
                    }
                }
                Ok(())
            })),
            &mut permission_token,
        );

        let frame_for_injection = frame3.clone();
        let mut content_token = 0i64;

        let _ = frame3.add_ContentLoading(
            &FrameContentLoadingEventHandler::create(Box::new(move |_, _| {
                // 通知桥、剪贴板图片桥、帧内日志桥与 boot 探测桥需要 iframe 上下文执行。
                // （导航桥 / 缩放快捷键 / 全局样式已分别由 dsh-tauri、dsh-tauri-ui 插件承担。）
                for script in [
                    crate::desktop::notification::NOTIFICATION_SHIM_JS,
                    crate::desktop::paste::PASTE_SHIM_JS,
                    crate::desktop::frame_log::FRAME_LOG_BRIDGE_JS,
                    crate::desktop::plugin_boot::PLUGIN_BOOT_RELOAD_JS,
                ] {
                    let script = HSTRING::from(script);
                    let _ = frame_for_injection.ExecuteScript(
                        &script,
                        &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))),
                    );
                }
                Ok(())
            })),
            &mut content_token,
        );
    }

    let origins = notification_origins(&parent);
    let mut token = 0i64;

    unsafe {
        let controller = webview.controller();
        let webview2 = controller.CoreWebView2()?;

        if let Err(e) = reset_persisted_notification_permissions(&webview2, &origins) {
            log::warn!("[notification] failed to reset permissions: {e}");
        }

        // 1. 处理顶级页面权限请求
        let parent_for_top = parent.clone();
        webview2.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;

                    let state = if kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                        if ask_notification_permission(&parent_for_top) {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        }
                    } else if should_allow_permission(kind) {
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW
                    } else {
                        COREWEBVIEW2_PERMISSION_STATE_DEFAULT
                    };
                    if kind != COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION {
                        args.SetState(state)?;
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;

        // 2. 处理 iframe 页面权限与 JS 脚本注入
        if let Ok(webview4) = webview2.cast::<ICoreWebView2_4>() {
            let mut frame_created_token = 0i64;
            let parent_for_frame_created = parent.clone();

            webview4.add_FrameCreated(
                &FrameCreatedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        if let Ok(frame) = args.Frame() {
                            if let Ok(frame3) = frame.cast::<ICoreWebView2Frame3>() {
                                setup_frame_handlers(frame3, parent_for_frame_created.clone());
                            }
                        }
                    }
                    Ok(())
                })),
                &mut frame_created_token,
            )?;
        }
    }

    Ok(())
}
