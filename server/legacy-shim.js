/**
 * 原版前端挂载桩（/legacy）：在浏览器里替代 Tauri 2 运行时，
 * 让 reverse-engineered/www 的原版 UI 跑在本地后端上。
 *
 * 覆盖面（对照 tauri-cmds 实测 54 个 cmd_*）：
 *  - 网络定向：localStorage.custom_api_url → 本服务（bootstrap ul()/cl() 的回退路径）
 *  - 鉴权：模块启动前同步预取 token 写入 localStorage['token']
 *  - 事件：plugin:event|listen/emit + BroadcastChannel 跨标签（模拟 Tauri emit/listen）
 *  - store：plugin:store|* → localStorage 后端
 *  - 窗口：plugin:webview|create_webview → window.open（overlay/mock 用弹出窗）
 *  - cmd_*：54 个命令全部给出浏览器语义（原生不可行者返回安全默认值）
 */
(function () {
  'use strict';
  var BASE = location.origin;

  /* ── 1) API base 覆盖：必须在 bootstrap 模块执行前写好 ── */
  try { localStorage.setItem('custom_api_url', BASE); } catch (e) { /* ignore */ }

  /* ── 1.5) 网络重定向层：mountDesktopApp 会用硬编码生产地址覆盖运行时 apiBase，
        其自定 fetch 每次按运行时配置重写 URL。这里在 fetch/XHR/WebSocket 三个入口
        把生产域名改写回本地，保证原版 UI 永远打在本地后端上。 ── */
  var WS_BASE = BASE.replace(/^http/, 'ws');
  function toLocal(u) {
    if (typeof u !== 'string' || u.indexOf('api.') < 0) return u;
    return u
      .replace(/wss:\/\/api\.mianlingai\.com/g, WS_BASE)
      .replace(/wss:\/\/api\.aceround\.app/g, WS_BASE)
      .replace(/https:\/\/api\.mianlingai\.com/g, BASE)
      .replace(/https:\/\/api\.aceround\.app/g, BASE);
  }
  var _fetch = window.fetch && window.fetch.bind(window);
  if (_fetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') input = toLocal(input);
        else if (input && typeof input.url === 'string') input = new Request(toLocal(input.url), input);
      } catch (e) { /* ignore */ }
      return _fetch(input, init);
    };
  }
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { arguments[1] = toLocal(String(url)); } catch (e) { /* ignore */ }
    return _xhrOpen.apply(this, arguments);
  };
  var _WS = window.WebSocket;
  if (_WS) {
    var LocalWS = function (url, protocols) {
      return new _WS(toLocal(String(url)), protocols);
    };
    LocalWS.prototype = _WS.prototype;
    LocalWS.OPEN = _WS.OPEN; LocalWS.CONNECTING = _WS.CONNECTING;
    LocalWS.CLOSING = _WS.CLOSING; LocalWS.CLOSED = _WS.CLOSED;
    window.WebSocket = LocalWS;
  }

  /* ── 1.8) token 删除竞态防护 ──
     jZ 壳在渲染期执行 kZ(storeToken)，首帧 store 尚未 hydrate、token 为空 →
     removeItem 会把预置 token 抹掉，随后 hydrate 才读存储（必读到空）。
     把启动 8s 内、最多 3 次针对非空 token 的删除视为竞态吞掉；
     hydrate 完成后 kZ(真 token) 会正常写回，正常登出不受影响。 */
  var BOOT_TS = Date.now();
  var delGuard = 3;
  (function () {
    var _getItem = Storage.prototype.getItem;
    var _removeItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (k) {
      if (k === 'token' && Date.now() - BOOT_TS < 8000 && delGuard > 0) {
        var v = _getItem.call(this, k);
        var parsed;
        try { parsed = v === null ? null : JSON.parse(v); } catch (e) { parsed = v; }
        if (parsed) {
          delGuard--;
          console.info('[legacy-shim] 吞掉启动期 token 删除（jZ/hydrate 竞态），剩余额度', delGuard);
          return;
        }
      }
      return _removeItem.call(this, k);
    };
  })();

  /* ── 2) 同步预取 token：保证 app 启动时已登录 ── */
  try {
    if (!localStorage.getItem('token')) {
      var post = function (url, body) {
        var x = new XMLHttpRequest();
        x.open('POST', url, false);
        x.setRequestHeader('content-type', 'application/json');
        x.send(body);
        var j = JSON.parse(x.responseText);
        return (j.result && j.result.data && j.result.data.json) || null;
      };
      var t1 = post(BASE + '/trpc/user.getTempToken', '{"json":{}}');
      var t2 = t1 && t1.token
        ? post(BASE + '/trpc/user.loginByTempToken', JSON.stringify({
            json: { token: t1.token, client: 'desktop', version: 'desktop/0.3.25', platform: 'win32' },
          }))
        : null;
      if (t2 && t2.token) {
        /* 按原版持久化钩子的格式写入（JSON 字符串），保证读写对称 */
        localStorage.setItem('token', JSON.stringify(t2.token));
        console.info('[legacy-shim] token 预取成功');
      } else {
        console.warn('[legacy-shim] 登录返回无 token', t1, t2);
      }
    }
  } catch (e) {
    console.warn('[legacy-shim] token 预取失败（后端未启动？）', e);
  }


  /* ── 3) 事件总线 ── */
  var cbSeq = 0;
  var evtSeq = 0;
  var listeners = [];
  var bc = null;
  try { bc = new BroadcastChannel('interview-orange-legacy-bus'); } catch (e) { /* ignore */ }

  function fire(name, payload, source) {
    listeners.slice().forEach(function (l) {
      if (l.event !== name) return;
      var fn = window['_' + l.handlerId];
      if (typeof fn === 'function') {
        try { fn({ event: name, id: l.id, payload: payload }); } catch (e) { console.warn(e); }
      }
    });
    if (bc && source !== 'bc') {
      try { bc.postMessage({ event: name, payload: payload }); } catch (e) { /* ignore */ }
    }
  }
  if (bc) {
    bc.onmessage = function (ev) {
      var m = ev.data || {};
      fire(m.event, m.payload, 'bc');
    };
  }

  function currentLabel() {
    var h = (location.hash || '').replace(/^#/, '').split('?')[0];
    return h === 'overlay' ? 'overlay' : h === 'mock' ? 'mock' : 'main';
  }

  var overlaySeq = Number(localStorage.getItem('legacy.overlaySeq') || 0);
  var opened = {}; // label → window

  function bumpSeq() {
    overlaySeq += 1;
    try { localStorage.setItem('legacy.overlaySeq', String(overlaySeq)); } catch (e) { /* ignore */ }
    return overlaySeq;
  }

  /* ── 4) cmd_* 处理（54 个全量） ── */
  var CMDS = {
    /* 版本与伪装 */
    cmd_get_demo_visible_mode: function () { return null; },
    cmd_set_demo_visible_mode: function () { return null; },
    cmd_apply_disguise_title: function (a) {
      var t = (a && (a.title || a.windowTitle)) || '';
      if (window.orangeNative && window.orangeNative.disguiseTitle && t) window.orangeNative.disguiseTitle(t);
      else if (t) document.title = t;
      return t || document.title || '面试橙';
    },
    cmd_apply_overlay_styles: function (a) { fire('overlay-styles-applied', a || {}); return null; },
    cmd_set_disguise_icon: function () { return null; },
    cmd_clear_disguise_icon: function () { return null; },
    cmd_get_disguise_icon: function () { return null; },
    cmd_panic_hotkey_status: function () {
      return window.orangeNative
        ? { registered: true, hotkey: 'Ctrl+Alt+Esc' }
        : { registered: false, reason: 'browser-legacy' };
    },
    cmd_set_panic_hotkey: function () { return false; },
    cmd_set_action_hotkeys: function () { return false; },

    /* 启动 / 恢复 / 崩溃 */
    cmd_is_crash_recovery: function () { return false; },
    cmd_is_recovered_boot: function () { return false; },
    cmd_read_native_crash: function () { return null; },
    cmd_clear_native_crash: function () { return null; },
    cmd_take_webview_crashes: function () { return []; },
    cmd_read_recent_logs: function () { return []; },
    cmd_relaunch: function () { location.reload(); return null; },
    cmd_pending_newer_version: function () { return null; },

    /* 更新 */
    cmd_update_state: function () { return { status: 'none' }; },
    cmd_update_download: function () { return { status: 'unsupported' }; },
    cmd_update_install: function () { return { status: 'unsupported' }; },
    cmd_update_reveal: function () { return null; },

    /* 主窗 / 浮窗显隐与门禁（seq 协议） */
    cmd_show_main: function () { fire('main-shown', {}); return null; },
    cmd_hide_main: function () { fire('main-hidden', {}); return null; },
    cmd_minimize_main: function () { return null; },
    cmd_show_overlay: function () {
      var seq = bumpSeq();
      fire('overlay-shown', { seq: seq });
      return seq;
    },
    cmd_hide_overlay: function () { fire('overlay-hidden', {}); return null; },
    cmd_overlay_show_seq: function () { return overlaySeq; },
    cmd_overlay_session_ready: function (a) { fire('overlay-session-ready', { seq: a && a.seq }); return true; },
    cmd_release_session_if_not_ready: function () { return false; },
    cmd_overlay_heartbeat: function () { return Date.now(); },
    cmd_set_session_active: function () { return true; },
    cmd_set_overlay_interactive: function () { return null; },
    cmd_set_overlay_size: function (a) { fire('overlay-size-changed', a || {}); return null; },
    cmd_position_overlay: function (a) { fire('overlay-position-changed', a || {}); return null; },
    cmd_set_overlay_zones: function () { return null; },
    cmd_set_drag_active: function (a) { fire('drag-mode-changed', { active: !!(a && a.active) }); return null; },
    cmd_set_capture_excluded: function (a) {
      if (window.orangeNative && window.orangeNative.setContentProtection) {
        window.orangeNative.setContentProtection(a && a.window === 'overlay' ? 'overlay' : 'main', !!(a && a.enable !== false));
        return true;
      }
      return false;
    },
    cmd_get_cursor_pos: function () { return null; },
    cmd_set_cursor_point_feed: function () { return null; },

    /* 采集：原生壳内委托 GDI 截屏；纯浏览器保持不可用 */
    cmd_capture_screen: function (a) {
      if (window.orangeNative && window.orangeNative.captureScreen) {
        return window.orangeNative.captureScreen({ maxWidth: (a && a.maxWidth) || 0 });
      }
      return null;
    },
    cmd_capture_displays: function () { return []; },
    cmd_check_screen_capture_permission: function () { return { granted: true, canAsk: true }; },
    cmd_request_screen_capture_permission: function () { return { granted: true }; },
    cmd_open_screen_recording_settings: function () { return null; },
    cmd_capture_protection_support: function () {
      return window.orangeNative
        ? { wda: true, platform: 'win32' }
        : { wda: false, reason: 'browser-legacy' };
    },
    cmd_start_system_audio_capture: function () { return { started: false, reason: 'browser-legacy' }; },
    cmd_stop_system_audio_capture: function () { return null; },
    cmd_list_system_audio_outputs: function () { return []; },
    cmd_set_system_audio_excluded_outputs: function () { return null; },
    cmd_start_native_exam_osd: function () { return { started: false }; },
    cmd_stop_native_exam_osd: function () { return null; },
    cmd_exam_window_snapshot: function () { return null; },

    /* 登录监听（浏览器里不需要） */
    cmd_start_auth_listener: function () { return { port: 0, started: false }; },
  };

  function invokeHandler(cmd, args) {
    args = args || {};

    /* 事件插件 */
    if (cmd === 'plugin:event|listen') {
      var id = ++evtSeq;
      listeners.push({ id: id, event: args.event, target: args.target || null, handlerId: args.handler });
      return id;
    }
    if (cmd === 'plugin:event|unlisten') {
      listeners = listeners.filter(function (l) {
        return l.id !== args.eventId && l.handlerId !== args.eventId;
      });
      return null;
    }
    if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') {
      fire(args.event, args.payload);
      return null;
    }

    /* store 插件：localStorage 后端（v2 契约：get 返回 [value, exists] 元组） */
    if (cmd.indexOf('plugin:store|') === 0) {
      var op = cmd.slice('plugin:store|'.length);
      if (op === 'load' || op === 'create_store' || op === 'get_store') return { rid: 1 };
      if (op === 'get') {
        var raw;
        if (args.key === 'token' || /^token($|_)/.test(args.key)) {
          /* 原版 Tc(ll()) 持久化钩子按 JSON.stringify 写、JSON.parse 读；
             store 读侧也要解包，避免引号层层叠加撑爆请求头（431）。 */
          raw = localStorage.getItem(args.key);
          if (raw === null) return [null, false];
          var tok;
          try { tok = JSON.parse(raw); } catch (e) { tok = raw; }
          return [typeof tok === 'string' ? tok : raw, true];
        }
        raw = localStorage.getItem('store:' + args.key);
        if (raw === null) return [null, false];
        var parsed;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
        return [parsed, true];
      }
      if (op === 'set') {
        try { localStorage.setItem('store:' + args.key, JSON.stringify(args.value === undefined ? null : args.value)); } catch (e) { /* ignore */ }
        return null;
      }
      if (op === 'has') return localStorage.getItem('store:' + args.key) !== null;
      if (op === 'delete') { localStorage.removeItem('store:' + args.key); return null; }
      if (op === 'clear') { return null; }
      if (op === 'entries') { return []; }
      if (op === 'keys') { return []; }
      if (op === 'values') { return []; }
      if (op === 'length') { return 0; }
      if (op === 'reset') { return null; }
      return null;
    }

    /* 热更协议（非 cmd_ 前缀的裸命令名）。
       注意：enter_hot_ui 必须抛错——Be() 的迁移流程把它当作「切换到热更前端」的信号，
       成功会让主窗返回 navigating 并等待一个永远不会到来的跳转；抛错则走
       catch → 'ready'，留在内置前端（等价原 serve.js 的无 Tauri 模式）。 */
    if (cmd === 'export_webstate') return null;
    if (cmd === 'import_webstate') return null;
    if (cmd === 'enter_hot_ui') throw new Error('[legacy-shim] hot UI 不可用：留在内置前端');
    if (cmd === 'take_broken_hotpatch') return null;
    if (cmd === 'clear_hotpatch') return null;
    /* 热更会话门（De/PO.busy 等）：无热更会话 → false，门放行 */
    if (cmd === 'hotpatch_session_active') return false;
    if (cmd === 'apply_hotpatch') return null;
    if (cmd === 'hotpatch_activate') return null;
    if (cmd === 'hotpatch_status') return { activeVersion: null, nativeVersion: '0.3.25' };

    /* 窗口 / webview 插件：create → window.open，其余宽容 */
    if (cmd === 'plugin:webview|create_webview' || cmd === 'plugin:window|create' || cmd === 'plugin:webview|create_webview_window') {
      var opts = args.options || {};
      var url = opts.url ? new URL(opts.url, BASE + '/legacy/').href : BASE + '/legacy/';
      var label = args.id || args.label || 'ml-win';
      var w = Math.round(opts.width || 420);
      var h = Math.round(opts.height || 640);
      var feat = 'popup=1,width=' + w + ',height=' + h + ',left=' + (screen.availWidth - w - 24) + ',top=60';
      try {
        opened[label] = window.open(url, 'legacy-' + label, feat);
      } catch (e) { console.warn('[legacy-shim] window.open 被拦截', label); }
      return null;
    }
    if (cmd === 'plugin:window|set_focus' || cmd === 'plugin:webview|set_focus') {
      try { window.focus(); } catch (e) { /* ignore */ }
      return null;
    }
    if (cmd === 'plugin:window|close') {
      var self = currentLabel();
      if (self === 'overlay' || self === 'mock') window.close();
      return null;
    }
    if (cmd.indexOf('plugin:window|') === 0 || cmd.indexOf('plugin:webview|') === 0 || cmd.indexOf('plugin:webview-window|') === 0) {
      return null; // set_size/set_position/set_always_on_top/…：浏览器语义由弹出窗自身决定
    }

    /* os 插件 */
    if (cmd === 'plugin:os|platform') return 'win32';
    if (cmd === 'plugin:os|family') return 'windows';
    if (cmd === 'plugin:os|arch') return 'x86_64';
    if (cmd === 'plugin:os|version') return '10.0.26100';
    if (cmd === 'plugin:os|locale') return 'zh-CN';
    if (cmd === 'plugin:os|hostname') return 'legacy-host';

    /* 其余插件：宽容默认 */
    if (cmd.indexOf('plugin:') === 0) return null;

    /* 原生 cmd_* */
    if (Object.prototype.hasOwnProperty.call(CMDS, cmd)) return CMDS[cmd](args);
    if (cmd === 'getVersion' || cmd === 'version' || cmd === 'cmd_get_version') return '0.3.25';

    /* 未知命令按 Tauri 语义拒绝（原版对不可用命令普遍 .catch 兜底） */
    throw new Error('[legacy-shim] 未实现 invoke: ' + cmd);
  }

  function invoke(cmd, args, _opts) {
    return new Promise(function (resolve, reject) {
      Promise.resolve()
        .then(function () { return invokeHandler(cmd, args); })
        .then(resolve, function (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  function transformCallback(cb, once) {
    var id = ++cbSeq;
    var key = '_' + id;
    window[key] = function (data) {
      if (once) { try { delete window[key]; } catch (e) { /* ignore */ } }
      if (typeof cb === 'function') cb(data);
    };
    return id;
  }

  var label = currentLabel();
  window.__TAURI_INTERNALS__ = {
    invoke: invoke,
    transformCallback: transformCallback,
    metadata: {
      currentWindow: { label: label },
      currentWebview: { label: label, windowLabel: label },
      currentWebviewWindow: { label: label },
      windows: [],
    },
    plugins: {},
  };
  try {
    window.__TAURI__ = window.__TAURI_INTERNALS__;
  } catch (e) { /* ignore */ }

  /* @tauri-apps/api v2 事件清理会调这个全局（unregisterListener） */
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function () { /* 浏览器桩：无需反注册 */ },
  };

  /* OS 插件内部全局（Ph/Fh/Ih 直读 version/os_type/arch） */
  window.__TAURI_OS_PLUGIN_INTERNALS__ = {
    version: '10.0.26100',
    osVersion: '10.0.26100',
    os_type: 'Windows_NT',
    arch: 'x86_64',
    platform: 'win32',
    family: 'windows',
    locale: 'zh-CN',
    hostname: 'legacy-host',
  };

  console.info('[legacy-shim] Tauri 桩已注入：apiBase=' + BASE + ' window=' + label + ' cmds=54');
})();
