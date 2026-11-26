//! 面试橙 · Rust 原生壳（Tauri 2 框架层）。
//!
//! 与原版同栈：Tauri 2（tao 窗口 + wry WebView2 + invoke 命令层）。
//! 全部 `cmd_*` 原生能力（文档 05/15/24）经 `win.rs` 实现，经单一 `ipc` 命令分发，
//! 前端 shim（orangeNative）走 `window.__TAURI_INTERNALS__.invoke`。
//!
//! 隔离约定：工具链在 ../.tools，构建产物在 ../.tools/target（中文路径时由
//! native/run.ps1 在盘符根自动创建 ASCII junction 中转），运行数据在 ML_DATA_DIR
//! （默认包内 data/，绿色版由启动器注入绝对路径）；不写系统 PATH / 注册表 / 全局目录。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod hooks;
mod win;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use win::AppState;

#[derive(Debug, Clone)]
pub enum UserEvent {
    Focus { title: String, pid: u32 },
    Hotkey(String),
    AudioLevel(f32),
    AudioError(String),
    AudioSegment(Vec<u8>),
}

/// 本地服务地址：跟随 ML_PORT 环境变量（默认 8756），与 node 服务端、启动器口径一致；
/// native/run.ps1 启动 exe 前会按 -Port 参数注入。
pub fn base_url() -> String {
    let port = std::env::var("ML_PORT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "8756".to_string());
    format!("http://127.0.0.1:{port}")
}

static MAX_LEVEL: AtomicU32 = AtomicU32::new(0);

fn shim_js() -> &'static str {
    r#"(function(){
  if (window.__ORANGE_SHIM__) return; window.__ORANGE_SHIM__ = true;
  window.__ORANGE_EMIT__ = function(ev, payload){
    try { window.dispatchEvent(new CustomEvent('interview-orange', { detail: { event: ev, payload: payload } })); } catch(e){}
  };
  function invoke(cmd, args){
    return window.__TAURI_INTERNALS__.invoke('ipc', { cmd: cmd, args: args === undefined ? null : args })
      .catch(function(e){ throw new Error(String(e)); });
  }
  window.__ORANGE_INVOKE__ = invoke;
  window.orangeNative = {
    native: true, invoke: invoke,
    info: function(){ return invoke('native.info'); },
    showOverlay: function(o){ return invoke('overlay.show', o || {}); },
    hideOverlay: function(){ return invoke('overlay.hide'); },
    toggleOverlay: function(s){ return invoke('overlay.toggle', { show: s }); },
    closeOverlay: function(){ return invoke('overlay.close'); },
    overlaySeq: function(){ return invoke('overlay.seq'); },
    sessionReady: function(s){ return invoke('overlay.session_ready', { seq: s }); },
    releaseIfNotReady: function(s){ return invoke('overlay.release', { seq: s }); },
    stealthState: function(){ return invoke('stealth.state'); },
    setContentProtection: function(kind, enable){ return invoke('stealth.set', { kind: kind, enable: enable }); },
    setSkipTaskbar: function(enable){ return invoke('win.skip_taskbar', { enable: enable }); },
    disguiseTitle: function(title){ return invoke('win.disguise', { title: title }); },
    disguiseProcess: function(name, launch){ return invoke('win.disguise_process', { name: name, launch: !!launch }); },
    panic: function(){ return invoke('stealth.panic'); },
    captureScreen: function(o){ return invoke('capture.screen', o || {}); },
    audioStart: function(o){ return invoke('audio.start', o || {}); },
    audioStop: function(){ return invoke('audio.stop'); },
    audioLevel: function(){ return invoke('audio.level'); },
    audioDevices: function(){ return invoke('audio.devices'); },
    focusHook: function(enable){ return invoke('hook.focus', { enable: !!enable }); },
    hotkeys: function(list){ return invoke('hotkeys.set', { list: list }); },
    crashRecovery: function(){ return invoke('crash.recovery'); },
    bootOk: function(){ return invoke('crash.boot_ok'); },
    features: function(){ return invoke('features.list'); },
    setFeature: function(key, val){ return invoke('features.set', { key: key, value: val }); },
    windows: function(){ return invoke('win.list'); },
    winPosition: function(o){ return invoke('win.position', o || {}); },
    winRect: function(label){ return invoke('win.rect', { label: label }); },
    setInteractive: function(label, enable){ return invoke('win.interactive', { label: label, enable: !!enable }); }
  };
  console.info('[native-shim] orangeNative 已注入（Tauri 2 原生壳）');
})();"#
}

/// 单一 IPC 入口：前端把 {cmd, args} 打包进来，win::handle_ipc 统一分发
#[tauri::command]
fn ipc(
    cmd: String,
    args: Option<Value>,
    window: tauri::WebviewWindow,
    state: tauri::State<Arc<Mutex<AppState>>>,
) -> Result<Value, String> {
    let label = window.label().to_string();
    // P0-4：IPC 只接受自家页面（SPA 的 "/" 与 "/legacy"）——上传目录等其它同源路径
    // 即使被浏览到、或被 window.open 打开（新窗口带 shim），也不给原生能力。
    let page_path = window.url().map(|u| u.path().to_string()).unwrap_or_default();
    if page_path != "/" && page_path != "/legacy" {
        return Err(format!("IPC 来源页面不被允许: {page_path}"));
    }
    let body = json!({ "id": 0, "cmd": cmd, "args": args.unwrap_or(Value::Null) }).to_string();
    match win::handle_ipc(&state, &label, &body) {
        Some((_, true, v)) => Ok(v),
        Some((_, false, v)) => Err(v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())),
        None => Err("IPC 解析失败".into()),
    }
}

/// 自检 3 用：前端探针把结果回传打印
#[tauri::command]
fn probe_result(result: String) {
    println!("[ipc-probe] IPC 返回值 = {result}");
    if result.contains("OK ") && result.contains("rust-tauri2") {
        println!("[ipc-probe] PASS：JS ⇄ Rust IPC 打通（native.info 往返成功）");
    } else {
        println!("[ipc-probe] FAIL：IPC 未返回预期结果");
    }
}

/// 诊断：弹原生消息框（不依赖 stdout/eval 回传，纯可见）
#[tauri::command]
fn diag_box(msg: String) {
    println!("[diag] {msg}");
    unsafe {
        let wide: Vec<u16> = msg.encode_utf16().chain(std::iter::once(0)).collect();
        windows::Win32::UI::WindowsAndMessaging::MessageBoxW(
            None,
            windows::core::PCWSTR(wide.as_ptr()),
            windows::core::PCWSTR(wide.as_ptr()),
            windows::Win32::UI::WindowsAndMessaging::MB_OK,
        );
    }
}

fn main() {
    tauri::Builder::default()
        // P1-11：窗口销毁时移除 hwnd 登记（否则 panic/伪装会遍历到失效句柄）
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let label = window.label().to_string();
                let state = window.state::<std::sync::Arc<std::sync::Mutex<win::AppState>>>();
                win::remove_hwnd(&state, &label);
                println!("[native] 窗口已销毁并从登记移除：{label}");
            }
        })
        .on_page_load(|webview, payload| {
            println!("[page] {} → {}", webview.label(), payload.url());
        })
        .setup(|app| {
            let state = Arc::new(Mutex::new(AppState::new()));
            app.manage(state.clone());
            win::init(&state);

            // ── 窗口（main + 预建 overlay，对齐原版「窗口由 Rust 侧预建」）──
            // WebView2 用户数据目录放项目内（默认 %LOCALAPPDATA% 在受限环境下拒绝访问）
            let wv_data = win::data_dir().join("webview");
            let _ = std::fs::create_dir_all(&wv_data);

            let base = base_url();

            // ── P0-1：window.open 处理器。wry 未注册 on_new_window 时 NewWindowRequested
            // 会被 SetHandled(true) 静默丢弃，所有房间入口（#mock / #mock-exam / #overlay）都打不开。
            // 新窗口：同一 data_directory（Windows 下必须同 WebView2 environment）、
            // 同一 initialization_script（否则新窗口没有 orangeNative）、window_features 继承尺寸/位置。
            let wv_main = wv_data.clone();
            let wv_overlay = wv_data.clone();
            let h_main = app.handle().clone();
            let h_overlay = app.handle().clone();
            let base_nav = base.clone();
            let base_nav_ov = base.clone();

            let main_w = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(format!("{base}/#main").parse().unwrap()),
            )
            .title("面试橙 · 工作台")
            .inner_size(1280.0, 860.0)
            .min_inner_size(980.0, 640.0)
            .data_directory(wv_data.clone())
            .initialization_script(shim_js())
            .on_navigation(move |url: &tauri::Url| nav_allowed(&base_nav, url))
            .on_new_window(move |url, features| open_new_window(&h_main, wv_main.clone(), url, features))
            .build()?;

            let overlay_w = WebviewWindowBuilder::new(
                app,
                "overlay",
                WebviewUrl::External(format!("{base}/#overlay").parse().unwrap()),
            )
            .title("面试橙 · 浮窗")
            .inner_size(420.0, 640.0)
            .decorations(false)
            .always_on_top(true)
            .visible(false)
            .resizable(false)
            .skip_taskbar(true)
            .transparent(true) // OS 级透明：桌面透过 CSS 半透明卡片可见（对齐原版浮窗）
            .data_directory(wv_data.clone())
            .initialization_script(shim_js())
            .on_navigation(move |url: &tauri::Url| nav_allowed(&base_nav_ov, url))
            .on_new_window(move |url, features| open_new_window(&h_overlay, wv_overlay.clone(), url, features))
            .build()?;

            win::set_hwnd(&state, "main", main_w.hwnd()?.0 as isize);
            let overlay_hwnd = overlay_w.hwnd()?.0 as isize;
            win::set_hwnd(&state, "overlay", overlay_hwnd);
            // 浮窗防截屏：默认关闭。
            // 原因：WDA_EXCLUDEFROMCAPTURE 与窗口真透明（transparent(true)）在部分 DWM/显卡组合下
            // 会把浮窗渲染成纯黑块。需要隐蔽时在设置页「浮窗防截屏」开启，或启动前设 ML_OVERLAY_WDA=1。
            let overlay_wda_default =
                std::env::var("ML_OVERLAY_WDA").ok().as_deref() == Some("1");
            win::set_wda(&state, "overlay", overlay_wda_default);
            println!(
                "[native] 浮窗防截屏（WDA）默认：{}",
                if overlay_wda_default { "开" } else { "关（避免透明窗口黑块；设置页可开）" }
            );

            // ── 事件 → JS 桥（热键/焦点/WASAPI 电平 → __ORANGE_EMIT__）──
            let handle = app.handle().clone();
            let st_for_events = state.clone();
            let emitter: win::Emitter = Box::new(move |ev: UserEvent| match ev {
                UserEvent::Hotkey(name) => {
                    match name.as_str() {
                        "panic" => win::panic_toggle(&st_for_events),
                        "toggle-overlay" => {
                            let now_on = win::toggle_overlay(&st_for_events);
                            let seq = st_for_events
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .seq;
                            // P0-2：显隐热键只广播 shown/hidden，不带 mode:'preview'、不伪造
                            // sessionId —— 浮窗收到后仅当作「窗口被重新显示」，保持当前会话与模式
                            let msg = format!(
                                "(function(){{try{{var b=new BroadcastChannel('interview-orange-bus');b.postMessage({{type:'{}',seq:{}}});b.close();}}catch(e){{}}}})()",
                                if now_on { "overlay-shown" } else { "overlay-hidden" },
                                seq
                            );
                            eval_all(&handle, Some("overlay"), &msg);
                            println!(
                                "[hotkey] 浮窗显隐 → {}（seq={seq}）",
                                if now_on { "显示" } else { "隐藏" }
                            );
                        }
                        "close-overlay" => {
                            win::set_overlay_visible(&st_for_events, false);
                            eval_all(
                                &handle,
                                Some("overlay"),
                                "(function(){try{var b=new BroadcastChannel('interview-orange-bus');b.postMessage({type:'overlay-hidden'});b.close();}catch(e){}})()",
                            );
                            println!("[hotkey] 浮窗已关闭");
                        }
                        "quit" => {
                            println!("[hotkey] 退出");
                            std::process::exit(0);
                        }
                        // P1-4：未内置处理的热键动作不再静默丢弃，仅转发 native-hotkey 事件给前端
                        other => println!("[hotkey] 动作「{other}」无内置处理，转发 native-hotkey 事件"),
                    }
                    let script = format!(
                        "window.__ORANGE_EMIT__('native-hotkey', {})",
                        json!({ "hotkey": name })
                    );
                    eval_all(&handle, None, &script);
                }
                UserEvent::Focus { title, pid } => {
                    println!("[hook] 前台切换 → pid={pid} title={title}");
                    let script = format!(
                        "window.__ORANGE_EMIT__('focus-changed', {})",
                        json!({ "title": title, "pid": pid })
                    );
                    eval_all(&handle, None, &script);
                }
                UserEvent::AudioLevel(level) => {
                    if let Ok(mut st) = st_for_events.lock() {
                        st.audio_level = level;
                    }
                    let bits = level.to_bits();
                    let _ = MAX_LEVEL.try_update(Ordering::SeqCst, Ordering::SeqCst, |prev| {
                        if f32::from_bits(prev) < level { Some(bits) } else { None }
                    });
                    let script = format!("window.__ORANGE_EMIT__('audio-level', {})", json!(level));
                    eval_all(&handle, None, &script);
                }
                UserEvent::AudioError(err) => {
                    eprintln!("[audio] 错误: {err}");
                    let script = format!("window.__ORANGE_EMIT__('audio-error', {})", json!(err));
                    eval_all(&handle, None, &script);
                }
                UserEvent::AudioSegment(pcm) => {
                    let script =
                        format!("window.__ORANGE_EMIT__('audio-segment', {})", json!({ "bytes": pcm.len() }));
                    eval_all(&handle, None, &script);
                }
            });
            win::set_emitter(emitter);

            // ── 脚本直投（win::push_script 的执行端）──
            let handle2 = app.handle().clone();
            let eval_fn: win::EvalFn = Box::new(move |label, script| {
                eval_all(&handle2, label, script);
            });
            win::set_eval(eval_fn);

            // ── 后台线程：热键宿主 + 焦点钩子 ──
            hooks::spawn_hotkey_thread();
            hooks::spawn_focus_hook();
            if std::env::var("ML_FOCUS").ok().as_deref() == Some("1") {
                hooks::set_focus_hook(true);
            }

            println!("[native] Tauri 2 原生壳启动：main + overlay（浮窗透明置顶）");

            // ── 诊断（ML_DIAG=1）：结果经 location 变更回传到 [page] 日志 ──
            if std::env::var("ML_DIAG").ok().as_deref() == Some("1") {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(4000));
                    let script = r#"(function(){
  var q = [];
  if (typeof window.__TAURI_INTERNALS__ === 'undefined') q.push('noint');
  if (typeof window.orangeNative === 'undefined') q.push('noshim');
  var root = document.getElementById('root');
  var shell = document.querySelector('.overlay-shell');
  q.push('hash=' + encodeURIComponent(location.hash.slice(0, 24)));
  q.push('rootkids=' + (root ? root.childElementCount : -1));
  q.push('bodylen=' + (document.body ? document.body.innerHTML.length : -1));
  q.push('shell=' + (shell ? 'Y' : 'N'));
  if (shell) {
    var cs = getComputedStyle(shell);
    q.push('bg=' + encodeURIComponent(cs.backgroundColor));
    q.push('w=' + Math.round(shell.getBoundingClientRect().width));
    q.push('h=' + Math.round(shell.getBoundingClientRect().height));
    q.push('op=' + cs.opacity + '/' + cs.display + '/' + cs.visibility);
  }
  location.href = '{BASE_URL}/__diag?r=' + q.join('~');
})();"#.replace("{BASE_URL}", &base_url());
                    for label in ["main", "overlay"] {
                        match h.get_webview_window(label) {
                            Some(w) => match w.eval(&script) {
                                Ok(_) => println!("[diag] eval 已下发 → {label}"),
                                Err(e) => println!("[diag] eval 失败 → {label}: {e}"),
                            },
                            None => println!("[diag] 找不到窗口 → {label}"),
                        }
                    }
                });
            }

            // ── 自检 1：WDA 是否真的把浮窗排除出屏幕捕获 ──
            if std::env::var("ML_SELFTEST").ok().as_deref() == Some("1") {
                let ov = overlay_hwnd;
                std::thread::spawn(move || unsafe {
                    use windows::Win32::Foundation::HWND;
                    use windows::Win32::UI::WindowsAndMessaging::{
                        SetWindowDisplayAffinity, ShowWindow, SW_SHOWNOACTIVATE,
                        WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
                    };
                    let hw = HWND(ov as *mut core::ffi::c_void);
                    println!("[selftest] 显示浮窗 + 开启 WDA");
                    let _ = ShowWindow(hw, SW_SHOWNOACTIVATE);
                    let _ = SetWindowDisplayAffinity(hw, WDA_EXCLUDEFROMCAPTURE);
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let with_wda = win::capture_screen(0).unwrap_or_default();
                    println!("[selftest] WDA 开启时截屏：{} 字节(base64)", with_wda.len());

                    println!("[selftest] 关闭 WDA 再截屏");
                    let _ = SetWindowDisplayAffinity(hw, WDA_NONE);
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    let without_wda = win::capture_screen(0).unwrap_or_default();
                    println!("[selftest] WDA 关闭时截屏：{} 字节(base64)", without_wda.len());

                    let diff = if with_wda.len() == without_wda.len() {
                        with_wda
                            .bytes()
                            .zip(without_wda.bytes())
                            .filter(|(a, b)| a != b)
                            .count()
                    } else {
                        usize::MAX
                    };
                    if diff > 500 {
                        println!("[selftest] PASS：两次截屏差异 {diff} 字节 → WDA 生效（浮窗被排除/恢复）");
                    } else {
                        println!("[selftest] FAIL：截屏差异仅 {diff} 字节");
                    }
                    let _ = SetWindowDisplayAffinity(hw, WDA_EXCLUDEFROMCAPTURE);
                    println!("[selftest] 结束（保持 WDA 开启）");
                });
            }

            // ── 自检 2：WASAPI 环回采集 ──
            if std::env::var("ML_SELFTEST").ok().as_deref() == Some("2") {
                std::thread::spawn(|| {
                    println!("[selftest2] 启动 WASAPI 环回采集");
                    audio::start(0.0);
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    println!("[selftest2] 播放 440Hz 提示音 1.2s（应被环回采到）");
                    unsafe {
                        let _ = windows::Win32::System::Diagnostics::Debug::Beep(440, 1200);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1800));
                    let peak = f32::from_bits(MAX_LEVEL.load(Ordering::SeqCst));
                    println!("[selftest2] 采集峰值电平 = {peak:.2}");
                    if peak > 0.5 {
                        println!("[selftest2] PASS：系统音频环回采集工作正常");
                    } else {
                        println!("[selftest2] WARN：峰值为 0（可能系统静音或无输出设备），采集链路已建立");
                    }
                    audio::stop();
                });
            }

            // ── 自检 3：JS ⇄ Rust IPC 探针（结果经 probe_result 命令回传）──
            if std::env::var("ML_SELFTEST").ok().as_deref() == Some("3") {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    let full = std::env::var("ML_PROBE").ok().as_deref() == Some("all");
                    let script: &str = if full {
                        r#"(async function(){
                          var n = window.orangeNative, out = {};
                          try { out.info = await n.info(); } catch(e){ out.info = 'ERR:'+e; }
                          try { out.setWda = await n.setContentProtection('main', true); } catch(e){ out.setWda = 'ERR:'+e; }
                          try { out.devices = await n.audioDevices(); } catch(e){ out.devices = 'ERR:'+e; }
                          try { out.featureCount = Object.keys(await n.features()).length; } catch(e){ out.featureCount = 'ERR:'+e; }
                          try { out.panicHide = await n.panic(); } catch(e){ out.panicHide = 'ERR:'+e; }
                          try { out.panicRestore = await n.panic(); } catch(e){ out.panicRestore = 'ERR:'+e; }
                          try { out.overlaySeq = await n.showOverlay({}); } catch(e){ out.overlaySeq = 'ERR:'+e; }
                          try { out.crash = await n.crashRecovery(); } catch(e){ out.crash = 'ERR:'+e; }
                          out.cmds = {};
                          var cl = ['cmd_is_crash_recovery','cmd_overlay_show_seq','cmd_capture_protection_support',
                                    'cmd_panic_hotkey_status','cmd_list_system_audio_outputs','cmd_get_cursor_pos',
                                    'cmd_capture_displays','cmd_take_webview_crashes','cmd_update_state',
                                    'cmd_apply_disguise_title','cmd_set_capture_excluded','cmd_show_main',
                                    'cmd_overlay_heartbeat','cmd_set_overlay_zones','cmd_start_native_exam_osd'];
                          for (var i = 0; i < cl.length; i++) {
                            var c = cl[i], a = {};
                            if (c === 'cmd_apply_disguise_title') a = { title: '面试橙 · 工作台' };
                            if (c === 'cmd_set_capture_excluded') a = { window: 'overlay', enable: true };
                            try { out.cmds[c] = await window.__ORANGE_INVOKE__(c, a); } catch(e){ out.cmds[c] = 'ERR:'+e; }
                          }
                          window.__TAURI_INTERNALS__.invoke('probe_result', { result: 'OK ' + JSON.stringify(out) });
                        })(); 'probe-start';"#
                    } else {
                        r#"window.orangeNative.info()
                            .then(function(r){ window.__TAURI_INTERNALS__.invoke('probe_result', { result: 'OK ' + JSON.stringify(r) }); })
                            .catch(function(e){ window.__TAURI_INTERNALS__.invoke('probe_result', { result: 'ERR ' + e }); }); 'probe-start';"#
                    };
                    for label in ["main", "overlay"] {
                        if let Some(w) = h.get_webview_window(label) {
                            match w.eval(script) {
                                Ok(_) => println!("[ipc-probe] 探针已下发（full={full}）"),
                                Err(e) => println!("[ipc-probe] 下发失败: {e}"),
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc, probe_result, diag_box])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn eval_all(handle: &tauri::AppHandle, label: Option<&str>, script: &str) {
    let targets: Vec<String> = match label {
        Some(l) => vec![l.to_string()],
        None => vec!["main".into(), "overlay".into()],
    };
    for t in targets {
        if let Some(w) = handle.get_webview_window(&t) {
            let _ = w.eval(script);
        }
    }
}

/// 导航白名单（高危 6 配套）：只允许本服务 origin；about:blank 供新建窗口初始化用
fn nav_allowed(base: &str, url: &tauri::Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    let ok = base
        .parse::<tauri::Url>()
        .map(|b| b.origin() == url.origin())
        .unwrap_or(false);
    if !ok {
        eprintln!("[native] 拒绝导航：{url}");
    }
    ok
}

/// P0-1：window.open 的新窗口。WebView2 在 SetNewWindow 后会把目标 URL 导航进该窗口，
/// 所以这里先以 about:blank 建窗；尺寸/位置由 window_features 继承，下限 980x640（房间页是宽布局）。
/// 构建失败时返回 Deny（拒绝比静默丢弃可见）。新窗口 label 为 web-<n>，IPC 按 main 级别处理。
fn open_new_window(
    handle: &tauri::AppHandle,
    wv_data: std::path::PathBuf,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    static NEXT_ID: AtomicU32 = AtomicU32::new(0);
    let label = format!("web-{}", NEXT_ID.fetch_add(1, Ordering::SeqCst));
    let base = base_url();
    let h = handle.clone();
    let wv = wv_data.clone();
    let builder = WebviewWindowBuilder::new(
        handle,
        &label,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("面试橙 · 房间")
    .data_directory(wv_data.clone())
    .initialization_script(shim_js())
    .window_features(features)
    .min_inner_size(980.0, 640.0)
    .on_navigation(move |u: &tauri::Url| nav_allowed(&base, u))
    .on_new_window(move |u, f| open_new_window(&h, wv.clone(), u, f));
    match builder.build() {
        Ok(w) => {
            // P1-11：房间窗（web-*）也必须登记 hwnd，panic/伪装/任务栏/最小化/close 才能覆盖
            if let Ok(hwnd) = w.hwnd() {
                let st = handle.state::<std::sync::Arc<std::sync::Mutex<win::AppState>>>();
                win::set_hwnd(&st, &label, hwnd.0 as isize);
            }
            println!("[native] 新窗口 {label} → {url}");
            tauri::webview::NewWindowResponse::Create { window: w }
        }
        Err(e) => {
            eprintln!("[native] 新窗口创建失败（拒绝 {url}）：{e}");
            tauri::webview::NewWindowResponse::Deny
        }
    }
}
