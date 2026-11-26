//! 原生能力实现：窗口 / WDA 防截屏 / 伪装 / panic / 覆盖层门禁 / 崩溃恢复 / 特性开关 / 截屏。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, IsWindow, IsWindowVisible, SetWindowDisplayAffinity,
    SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow, SM_CXSCREEN, SM_CYSCREEN,
    SWP_NOACTIVATE, SW_HIDE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    HWND_TOPMOST, GWL_EXSTYLE,
};

use crate::UserEvent;

/// 运行数据目录：绿色版/便携版由启动器注入 ML_DATA_DIR；未注入时按 exe 位置回退：
/// app/interview-orange.exe → 上一级/data；其他位置 → 同目录/data。
/// 不再把编译期 CARGO_MANIFEST_DIR 烙进 exe，整目录搬迁后数据仍落在包内。
pub fn data_dir() -> std::path::PathBuf {
    if let Ok(v) = std::env::var("ML_DATA_DIR") {
        if !v.trim().is_empty() {
            let p = std::path::PathBuf::from(v);
            if p.is_absolute() {
                return p;
            }
            if let Ok(cwd) = std::env::current_dir() {
                return cwd.join(p);
            }
            return p;
        }
    }
    let base = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let root = if base.file_name().and_then(|n| n.to_str()) == Some("app") {
        base.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| base.clone())
    } else {
        base
    };
    root.join("data")
}

/// 46 项特性开关的本地替身（文档 24：服务端下发 → 客户端 if 判断）
const FEATURE_KEYS: &[&str] = &[
    "overlay.auto_palette", "overlay.turn_cards", "overlay.copy_code", "overlay.show_reasoning",
    "overlay.follow_streaming", "overlay.newest_first", "overlay.answer_first",
    "interview.auto_answer", "interview.follow_new_round", "interview.dual_camera",
    "interview.web_search", "interview.translate", "interview.dual_lang", "interview.replay",
    "exam.dual_camera", "exam.solver_enabled", "exam.show_reasoning", "exam.pending_card_hint",
    "stt.speaker_correct", "stt.silence_gate", "stt.voiceprint", "stt.low_latency",
    "stealth.wda", "stealth.panic", "stealth.disguise", "stealth.hide_taskbar",
    "stealth.focus_hook", "stealth.anti_debug", "stealth.title_disguise",
    "update.hotpatch", "update.auto_check", "update.boot_failure_report",
    "telemetry.crash", "telemetry.perf", "telemetry.error", "telemetry.usage",
    "ui.usage_notice", "ui.announcement", "ui.changelog", "ui.onboarding",
    "billing.screenshot_unit", "billing.trial_card", "billing.referral",
    "net.region_oversea", "net.custom_api", "net.ws_fallback",
];

const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
const WS_EX_APPWINDOW: isize = 0x0004_0000;
const WS_EX_TRANSPARENT: isize = 0x0000_0020;
// 注：WS_EX_TRANSPARENT 的点击穿透只在分层窗口上可靠；浮窗由 transparent(true) 创建，
// 本身已是分层窗口，SetWindowLongPtrW 改样式后配合 SetWindowPos(FRAMECHANGED) 即可生效，
// 不需要再额外设置 WS_EX_LAYERED（此前那个 0 值占位是无效代码，已删除）。

pub struct AppState {
    pub hwnds: HashMap<String, isize>,
    pub seq: i64,
    pub last_ready_seq: i64,
    pub hidden_by_panic: Vec<isize>,
    pub wda: HashMap<String, bool>,
    pub features: HashMap<String, Value>,
    pub crash_recovery: bool,
    pub boot_ok: bool,
    pub audio_level: f32,
    pub focus_enabled: bool,
    pub overlay_visible: bool,
    pub last_error: String,
    /// 浮窗分区（cmd_set_overlay_zones）：仅存储，供后续做点击穿透
    pub zones: Vec<Value>,
}

impl AppState {
    pub fn new() -> Self {
        let mut features = HashMap::new();
        for k in FEATURE_KEYS {
            features.insert((*k).to_string(), Value::Bool(true));
        }
        Self {
            hwnds: HashMap::new(),
            seq: 0,
            last_ready_seq: -1,
            hidden_by_panic: Vec::new(),
            wda: HashMap::new(),
            features,
            crash_recovery: false,
            boot_ok: false,
            audio_level: 0.0,
            focus_enabled: false,
            overlay_visible: false,
            last_error: String::new(),
            zones: Vec::new(),
        }
    }
}

fn scripts() -> &'static Mutex<Vec<(Option<String>, String)>> {
    static Q: OnceLock<Mutex<Vec<(Option<String>, String)>>> = OnceLock::new();
    Q.get_or_init(|| Mutex::new(Vec::new()))
}

/* ───────────── 事件/脚本执行端（由 main.rs 在 setup 时注入 Tauri 实现）───────────── */

pub type Emitter = Box<dyn Fn(UserEvent) + Send + Sync>;
pub type EvalFn = Box<dyn Fn(Option<&str>, &str) + Send + Sync>;

fn emitters() -> &'static (OnceLock<Emitter>, OnceLock<EvalFn>) {
    static E: (OnceLock<Emitter>, OnceLock<EvalFn>) = (OnceLock::new(), OnceLock::new());
    &E
}

pub fn set_emitter(e: Emitter) {
    let _ = emitters().0.set(e);
}

pub fn set_eval(f: EvalFn) {
    let _ = emitters().1.set(f);
}

/// 后台线程（热键/焦点/WASAPI）→ JS 事件的统一入口
pub fn emit_event(ev: UserEvent) {
    if let Some(f) = emitters().0.get() {
        f(ev);
    }
}

/// 把排队的脚本立即投给 webview 执行
fn flush_scripts() {
    let batch = drain_scripts();
    if batch.is_empty() {
        return;
    }
    if let Some(f) = emitters().1.get() {
        for (target, s) in batch {
            f(target.as_deref(), &s);
        }
    }
}

/// 广播脚本（所有 webview 执行）
pub fn push_script(_state: &Mutex<AppState>, script: &str) {
    if let Ok(mut q) = scripts().lock() {
        q.push((None, script.to_string()));
    }
    flush_scripts();
}

/// 定向脚本（只在该 label 的 webview 执行，避免多窗口 id 冲突）
pub fn push_script_to(_state: &Mutex<AppState>, label: &str, script: &str) {
    if let Ok(mut q) = scripts().lock() {
        q.push((Some(label.to_string()), script.to_string()));
    }
    flush_scripts();
}

pub fn drain_scripts() -> Vec<(Option<String>, String)> {
    scripts()
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

pub fn emit_flag(state: &Mutex<AppState>, event: &str, payload: Value) {
    let script = format!(
        "window.__ORANGE_EMIT__({}, {})",
        serde_json::to_string(event).unwrap(),
        payload
    );
    push_script(state, &script);
}

pub fn init(state: &Mutex<AppState>) {
    let data = data_dir();
    let marker = data.join(".recovery");
    let _ = std::fs::create_dir_all(&data);
    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
    st.crash_recovery = marker.exists();
    let _ = std::fs::write(&marker, b"1");
}

pub fn set_hwnd(state: &Mutex<AppState>, label: &str, hwnd: isize) {
    state.lock().unwrap_or_else(|e| e.into_inner()).hwnds.insert(label.to_string(), hwnd);
}

/// P1-11：窗口销毁时移除登记，并把它从 panic 隐藏列表里去掉
pub fn remove_hwnd(state: &Mutex<AppState>, label: &str) {
    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(h) = st.hwnds.remove(label) {
        st.hidden_by_panic.retain(|x| *x != h);
    }
}

/// P1-11：句柄有效性惰性清理——窗口销毁事件在部分平台/关闭路径下不保证送达，
/// 遍历前先用 IsWindow 剔除失效句柄，保证 win.list/panic/伪装不残留、不报错。
fn prune_dead_hwnds(state: &Mutex<AppState>) {
    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
    let dead: Vec<isize> = st
        .hwnds
        .values()
        .copied()
        .filter(|h| unsafe { !IsWindow(HWND(*h as *mut core::ffi::c_void)).as_bool() })
        .collect();
    if !dead.is_empty() {
        st.hwnds.retain(|_, h| !dead.contains(h));
        st.hidden_by_panic.retain(|h| !dead.contains(h));
    }
}

fn hwnd_of(state: &Mutex<AppState>, label: &str) -> Option<HWND> {
    prune_dead_hwnds(state);
    state
        .lock().unwrap_or_else(|e| e.into_inner())
        .hwnds
        .get(label)
        .copied()
        .map(|p| HWND(p as *mut core::ffi::c_void))
}

/* ───────────── WDA 防截屏 ───────────── */

pub fn set_wda(state: &Mutex<AppState>, label: &str, enable: bool) -> bool {
    if !wda_allowed() {
        // ML_NO_WDA=1：调试态强制不防截屏，便于外部截图验收
        if let Some(hwnd) = hwnd_of(state, label) {
            unsafe { let _ = SetWindowDisplayAffinity(hwnd, WDA_NONE); }
        }
        state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .wda
            .insert(label.to_string(), false);
        return false;
    }
    let Some(hwnd) = hwnd_of(state, label) else {
        return false;
    };
    let aff = if enable { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    let ok = unsafe { SetWindowDisplayAffinity(hwnd, aff).is_ok() };
    state.lock().unwrap_or_else(|e| e.into_inner()).wda.insert(label.to_string(), ok && enable);
    ok
}

/* ───────────── 窗口显隐 / panic ───────────── */

fn show_window(hwnd: HWND, show: bool) {
    unsafe {
        let _ = ShowWindow(hwnd, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });
    }
}

/// 调试开关：ML_NO_WDA=1 时不启用防截屏（便于外部截图/录屏验收透明与排版）
fn wda_allowed() -> bool {
    std::env::var("ML_NO_WDA").ok().as_deref() != Some("1")
}

/// 显示/隐藏浮窗（热键与 IPC 共用）；显示时置顶；WDA 仅在用户已开启时才重新应用
pub fn set_overlay_visible(state: &Mutex<AppState>, show: bool) -> bool {
    let Some(h) = hwnd_of(state, "overlay") else {
        return false;
    };
    let wda_on = state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .wda
        .get("overlay")
        .copied()
        .unwrap_or(false);
    show_window(h, show);
    if show {
        unsafe {
            let _ = SetWindowPos(
                h,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                    | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE
                    | SWP_NOACTIVATE,
            );
        }
        // 注意：WDA 与窗口真透明在部分 DWM/显卡组合下会把窗口渲染成黑块。
        // 因此这里不强制开启，只把用户已选择的状态重新应用一次。
        if wda_on {
            set_wda(state, "overlay", true);
        }
        let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
        st.overlay_visible = true;
        st.seq += 1;
    } else {
        state.lock().unwrap_or_else(|e| e.into_inner()).overlay_visible = false;
    }
    true
}

/// 热键 Ctrl+Alt+H：真正的显隐切换（返回切换后是否可见）
pub fn toggle_overlay(state: &Mutex<AppState>) -> bool {
    let visible = state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .overlay_visible;
    let next = !visible;
    set_overlay_visible(state, next);
    next
}

pub fn panic_toggle(state: &Mutex<AppState>) {
    prune_dead_hwnds(state);
    // 小项3：features.set 的 stealth.panic=false 时 panic 热键不响应（仅存储以外的真实联动）
    let enabled = state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .features
        .get("stealth.panic")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !enabled {
        println!("[panic] 已被特性开关 stealth.panic 禁用");
        return;
    }
    let (hwnds, already) = {
        let st = state.lock().unwrap_or_else(|e| e.into_inner());
        (st.hwnds.clone(), !st.hidden_by_panic.is_empty())
    };
    if already {
        let prev = {
            let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut st.hidden_by_panic)
        };
        for h in prev {
            show_window(HWND(h as *mut core::ffi::c_void), true);
        }
        let wda = { state.lock().unwrap_or_else(|e| e.into_inner()).wda.clone() };
        for (label, on) in wda {
            if on {
                set_wda(state, &label, true);
            }
        }
        println!("[panic] 已恢复全部窗口");
    } else {
        let mut hidden = Vec::new();
        for (_label, h) in &hwnds {
            let hw = HWND(*h as *mut core::ffi::c_void);
            let visible = unsafe { IsWindowVisible(hw).as_bool() };
            if visible {
                unsafe {
                    let _ = SetWindowDisplayAffinity(hw, WDA_EXCLUDEFROMCAPTURE);
                }
                show_window(hw, false);
                hidden.push(*h);
            }
        }
        println!("[panic] 已隐藏 {} 个窗口", hidden.len());
        state.lock().unwrap_or_else(|e| e.into_inner()).hidden_by_panic = hidden;
    }
}

pub fn set_skip_taskbar(state: &Mutex<AppState>, label: &str, enable: bool) -> bool {
    let Some(hwnd) = hwnd_of(state, label) else {
        return false;
    };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = if enable {
            (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW
        } else {
            ex & !WS_EX_TOOLWINDOW
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        // P2-C：改扩展样式后必须发 FRAMECHANGED，任务栏/边框样式才会立即生效
        let _ = SetWindowPos(
            hwnd,
            HWND(core::ptr::null_mut()),
            0,
            0,
            0,
            0,
            windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE
                | windows::Win32::UI::WindowsAndMessaging::SWP_NOZORDER
                | windows::Win32::UI::WindowsAndMessaging::SWP_FRAMECHANGED,
        );
    }
    true
}

pub fn set_interactive(state: &Mutex<AppState>, label: &str, interactive: bool) -> bool {
    let Some(hwnd) = hwnd_of(state, label) else {
        return false;
    };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = if interactive {
            ex & !WS_EX_TRANSPARENT
        } else {
            ex | WS_EX_TRANSPARENT
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        let _ = SetWindowPos(
            hwnd,
            HWND(core::ptr::null_mut()),
            0,
            0,
            0,
            0,
            windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE
                | windows::Win32::UI::WindowsAndMessaging::SWP_NOZORDER
                | windows::Win32::UI::WindowsAndMessaging::SWP_FRAMECHANGED,
        );
    }
    true
}

pub fn disguise_title(state: &Mutex<AppState>, title: &str) -> bool {
    prune_dead_hwnds(state);
    let targets: Vec<isize> = state.lock().unwrap_or_else(|e| e.into_inner()).hwnds.values().copied().collect();
    let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let mut ok = false;
    for h in targets {
        unsafe {
            if SetWindowTextW(HWND(h as *mut core::ffi::c_void), PCWSTR(wide.as_ptr())).is_ok() {
                ok = true;
            }
        }
    }
    ok
}

/* ───────────── PE 资源：重写版本信息（伪装）───────────── */

fn align4(v: &mut Vec<u8>) {
    while v.len() % 4 != 0 {
        v.push(0);
    }
}

fn wstr(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn push_block(out: &mut Vec<u8>, value_len: u16, ty: u16, key: &str, value: &[u8], children: &[u8]) {
    let start = out.len();
    out.extend_from_slice(&[0u8, 0]); // wLength 占位
    out.extend_from_slice(&value_len.to_le_bytes());
    out.extend_from_slice(&ty.to_le_bytes());
    for c in wstr(key) {
        out.extend_from_slice(&c.to_le_bytes());
    }
    align4(out);
    if !value.is_empty() {
        out.extend_from_slice(value);
        align4(out);
    }
    out.extend_from_slice(children);
    let total = (out.len() - start) as u16;
    out[start..start + 2].copy_from_slice(&total.to_le_bytes());
}

fn version_string(name: &str, value: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let v = wstr(value);
    let bytes: Vec<u8> = v.iter().flat_map(|c| c.to_le_bytes()).collect();
    // wValueLength 对字符串是「字符数（含 \0）」
    push_block(&mut out, v.len() as u16, 1, name, &bytes, &[]);
    out
}

/// 生成完整的 VS_VERSIONINFO 资源
pub fn build_version_info(product: &str, desc: &str, original: &str) -> Vec<u8> {
    const VERSION: u32 = 0x0003_0019; // 0.3.25
    let mut fixed = Vec::new();
    let dwords: [u32; 13] = [
        0xFEEF_04BD,
        0x0001_0000,
        VERSION,
        0,
        VERSION,
        0,
        0x0000_003F,
        0,
        0x0004_0004, // VOS_NT_WINDOWS32
        1,           // VFT_APP
        0,
        0,
        0,
    ];
    for d in dwords {
        fixed.extend_from_slice(&d.to_le_bytes());
    }

    // StringTable(040904B0) 子块
    let mut table = Vec::new();
    for (k, v) in [
        ("CompanyName", "Microsoft Corporation"),
        ("FileDescription", desc),
        ("FileVersion", "0.3.25.0"),
        ("InternalName", original),
        ("OriginalFilename", original),
        ("ProductName", product),
        ("ProductVersion", "0.3.25.0"),
    ] {
        table.extend_from_slice(&version_string(k, v));
    }
    let mut string_table = Vec::new();
    push_block(&mut string_table, 0, 1, "040904B0", &[], &table);

    let mut string_file_info = Vec::new();
    push_block(&mut string_file_info, 0, 1, "StringFileInfo", &[], &string_table);

    // VarFileInfo 子块
    let mut var = Vec::new();
    push_block(&mut var, 4, 0, "Translation", &[0x09u8, 0x04, 0xB0, 0x04], &[]);
    let mut var_file_info = Vec::new();
    push_block(&mut var_file_info, 0, 1, "VarFileInfo", &[], &var);

    let mut children = Vec::new();
    children.extend_from_slice(&string_file_info);
    children.extend_from_slice(&var_file_info);

    let mut root = Vec::new();
    push_block(&mut root, fixed.len() as u16, 0, "VS_VERSION_INFO", &fixed, &children);
    root
}

/// 用 UpdateResource 把版本信息写进 PE 副本（进程名/属性页显示伪装名）
pub fn rewrite_version_info(path: &str, product: &str, desc: &str, original: &str) -> Result<(), String> {
    use windows::Win32::System::LibraryLoader::*;
    let _ = (LOAD_LIBRARY_FLAGS(0),);
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let data = build_version_info(product, desc, original);
    unsafe {
        let handle = BeginUpdateResourceW(PCWSTR(wide.as_ptr()), false)
            .map_err(|e| format!("BeginUpdateResource: {}", e.message()))?;
        let ok = UpdateResourceW(
            handle,
            PCWSTR(16 as *const u16), // RT_VERSION
            PCWSTR(1 as *const u16),  // MAKEINTRESOURCE(1)
            0,
            Some(data.as_ptr() as *const core::ffi::c_void),
            data.len() as u32,
        )
        .is_ok();
        let end = EndUpdateResourceW(handle, false);
        if !ok || end.is_err() {
            return Err(format!("UpdateResource 失败（ok={ok}）"));
        }
    }
    Ok(())
}

/* ───────────── PE 资源：替换图标（RT_ICON + RT_GROUP_ICON）───────────── */

/// 生成 32bpp 图标的 RT_ICON 负载（BITMAPINFOHEADER + BGRA + AND mask）
fn icon_image(size: u32, hue: (u8, u8, u8)) -> Vec<u8> {
    let mut out = Vec::new();
    let himage = size * size * 4;
    let and_stride = ((size + 31) / 32) * 4;
    let and_size = and_stride * size;
    out.extend_from_slice(&40u32.to_le_bytes()); // biSize
    out.extend_from_slice(&(size as i32).to_le_bytes()); // biWidth
    out.extend_from_slice(&((size * 2) as i32).to_le_bytes()); // biHeight = 2*h
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression=BI_RGB
    out.extend_from_slice(&(himage + and_size).to_le_bytes()); // biSizeImage
    for _ in 0..4 {
        out.extend_from_slice(&0u32.to_le_bytes());
    }
    // XOR：右下角渐变（自下而上存储）
    let (r, g, b) = hue;
    for y in (0..size).rev() {
        for x in 0..size {
            let a = 255u8;
            let t = ((x + y) as f32 / (size as f32 * 2.0)).min(1.0);
            let px = [
                (b as f32 * (1.0 - t * 0.4)) as u8,
                (g as f32 * (1.0 - t * 0.3)) as u8,
                (r as f32) as u8,
                a,
            ];
            out.extend_from_slice(&px);
        }
    }
    // AND mask：全 0（完全不透明）
    out.extend(std::iter::repeat(0u8).take(and_size as usize));
    out
}

fn group_icon(entries: &[(u32, u32, u16)]) -> Vec<u8> {
    // (size, bytes, icon_id)
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&1u16.to_le_bytes()); // type = icon
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for (size, bytes, id) in entries {
        out.push(if *size >= 256 { 0 } else { *size as u8 });
        out.push(if *size >= 256 { 0 } else { *size as u8 });
        out.push(0); // colorCount
        out.push(0); // reserved
        out.extend_from_slice(&1u16.to_le_bytes()); // planes
        out.extend_from_slice(&32u16.to_le_bytes()); // bitCount
        out.extend_from_slice(&bytes.to_le_bytes());
        out.extend_from_slice(&id.to_le_bytes());
    }
    out
}

fn update_res(h: windows::Win32::Foundation::HANDLE, ty: u16, id: u16, data: &[u8]) -> bool {
    use windows::Win32::System::LibraryLoader::UpdateResourceW;
    unsafe {
        UpdateResourceW(
            h,
            PCWSTR(ty as usize as *const u16),
            PCWSTR(id as usize as *const u16),
            0,
            Some(data.as_ptr() as *const core::ffi::c_void),
            data.len() as u32,
        )
        .is_ok()
    }
}

/// 替换 exe 图标；返回替换的图标组数量
pub fn replace_icon(path: &str) -> Result<u32, String> {
    use windows::Win32::System::LibraryLoader::{BeginUpdateResourceW, EndUpdateResourceW};
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    const RT_ICON: u16 = 3;
    const RT_GROUP_ICON: u16 = 14;

    let imgs = [(16u32, (79u8, 70u8, 229u8)), (32u32, (99u8, 102u8, 241u8))];
    let mut payloads = Vec::new();
    for (size, hue) in imgs {
        payloads.push((size, icon_image(size, hue), hue));
    }

    unsafe {
        let h = BeginUpdateResourceW(PCWSTR(wide.as_ptr()), false)
            .map_err(|e| format!("BeginUpdateResource: {}", e.message()))?;
        let mut ok = true;
        let mut entries = Vec::new();
        for (i, (size, data, _)) in payloads.iter().enumerate() {
            let icon_id = 400 + i as u16;
            ok &= update_res(h, RT_ICON, icon_id, data);
            entries.push((*size, data.len() as u32, icon_id));
        }
        let group = group_icon(&entries);
        // 覆盖常见的图标组 id（1/2/100…）；存在几个改几个
        let mut replaced = 0u32;
        for gid in [1u16, 2, 3, 100, 101, 32512] {
            if update_res(h, RT_GROUP_ICON, gid, &group) {
                replaced += 1;
            }
        }
        let end = EndUpdateResourceW(h, false);
        if !ok || end.is_err() {
            return Err("UpdateResource(icon) 失败".into());
        }
        Ok(replaced)
    }
}

/* ───────────── 进程级伪装（复制自身为指定文件名）───────────── */

pub fn disguise_process(name: &str, launch: bool) -> Result<Value, String> {
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let safe = if safe.trim().is_empty() { "App".to_string() } else { safe };
    let dir = format!("{}/disguise", data_dir().to_string_lossy());
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let exe = std::env::current_exe().map_err(|e| format!("取当前 exe 失败: {e}"))?;
    let target = format!("{}/{}.exe", dir, safe);
    std::fs::copy(&exe, &target).map_err(|e| format!("复制 exe 失败: {e}"))?;

    // WebView2Loader.dll 若与 exe 同目录则一并复制，保证副本可独立启动
    let src_dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let loader = src_dir.join("WebView2Loader.dll");
    if loader.exists() {
        let _ = std::fs::copy(&loader, format!("{}/WebView2Loader.dll", dir));
    }

    // PE 资源：重写版本信息（属性页/任务管理器显示伪装名）
    if let Err(e) = rewrite_version_info(&target, &safe, &safe, &format!("{}.exe", safe)) {
        eprintln!("[disguise] 版本信息重写失败（不影响运行）: {e}");
    } else {
        println!("[disguise] 版本信息已重写：ProductName/FileDescription = {safe}");
    }

    // PE 图标资源替换
    match replace_icon(&target) {
        Ok(n) => println!("[disguise] 图标已替换（{n} 个图标组）"),
        Err(e) => eprintln!("[disguise] 图标替换失败（不影响运行）: {e}"),
    }

    let mut launched = false;
    let mut pid = 0u32;
    if launch {
        match std::process::Command::new(&target).spawn() {
            Ok(mut child) => {
                // 高危6：绝不能在 IPC 线程里 wait（伪装进程长驻，会永久阻塞前端 await）。
                // 立即返回 pid；退出码由后台线程收割，避免僵尸进程。
                pid = child.id();
                launched = true;
                let name = safe.clone();
                std::thread::spawn(move || match child.wait() {
                    Ok(code) => println!("[disguise] 伪装进程 {name} 已退出：{code}"),
                    Err(e) => eprintln!("[disguise] 等待伪装进程退出失败: {e}"),
                });
                println!("[disguise] 已以伪装名启动进程（pid={pid}）");
            }
            Err(e) => eprintln!("[disguise] 启动失败: {e}"),
        }
    }
    println!("[disguise] 进程副本 → {target}");
    Ok(json!({ "path": target, "name": safe, "launched": launched, "pid": pid }))
}

pub fn position_overlay(state: &Mutex<AppState>, x: i32, y: i32, w: i32, h: i32) -> bool {    let Some(hwnd) = hwnd_of(state, "overlay") else {
        return false;
    };
    unsafe { SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE).is_ok() }
}

pub fn window_rect(state: &Mutex<AppState>, label: &str) -> Option<(i32, i32, i32, i32)> {
    let hwnd = hwnd_of(state, label)?;
    let mut r = RECT::default();
    unsafe {
        if GetWindowRect(hwnd, &mut r).is_err() {
            return None;
        }
    }
    Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
}

/* ───────────── 截屏（GDI BitBlt → BMP data URL）───────────── */

/// GDI BitBlt 截屏 → BMP data URL。
/// max_width > 0 且屏幕更宽时做整点步长均值降采样（配色采样够用，IPC 体积降约两个数量级）；
/// max_width = 0 保持全分辨率（笔试 OCR 的 cmd_capture_screen 走这条）。
pub fn capture_screen(max_width: i32) -> Result<String, String> {
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("GetDC 失败".into());
        }
        let width = GetSystemMetrics(SM_CXSCREEN);
        let height = GetSystemMetrics(SM_CYSCREEN);
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, width, height);
        let old = SelectObject(mem, bmp);
        let _ = BitBlt(mem, 0, 0, width, height, screen, 0, 0, SRCCOPY);

        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 24;
        info.bmiHeader.biCompression = BI_RGB.0;

        let stride = ((width * 3 + 3) / 4) * 4;
        let mut pixels = vec![0u8; (stride * height) as usize];
        let scanned = GetDIBits(
            mem,
            bmp,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(mem, old);
        let _ = DeleteObject(bmp);
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        if scanned == 0 {
            return Err("GetDIBits 失败".into());
        }

        // 可选降采样：step×step 块均值（BGR 序保持不变）
        let mut out_width = width;
        let mut out_height = height;
        let mut out_pixels = std::mem::take(&mut pixels);
        // 源缓冲行跨距：未降采样时仍是 GDI 的 4 字节对齐 stride，降采样后是紧密排列的 tw*3
        let mut src_stride = stride;
        if max_width > 0 && width > max_width {
            let step = (width + max_width - 1) / max_width;
            let tw = width / step;
            let th = height / step;
            let mut dst = vec![0u8; (tw * th * 3) as usize];
            for dy in 0..th {
                for dx in 0..tw {
                    let (mut rb, mut gb, mut bb, mut n) = (0u64, 0u64, 0u64, 0u64);
                    for sy in (dy * step)..((dy + 1) * step).min(height) {
                        let row = (sy * stride) as usize;
                        for sx in (dx * step)..((dx + 1) * step).min(width) {
                            let p = row + (sx * 3) as usize;
                            bb += out_pixels[p] as u64;
                            gb += out_pixels[p + 1] as u64;
                            rb += out_pixels[p + 2] as u64;
                            n += 1;
                        }
                    }
                    if n == 0 {
                        n = 1;
                    }
                    let o = ((dy * tw + dx) * 3) as usize;
                    dst[o] = (bb / n) as u8;
                    dst[o + 1] = (gb / n) as u8;
                    dst[o + 2] = (rb / n) as u8;
                }
            }
            out_width = tw;
            out_height = th;
            out_pixels = dst;
            src_stride = tw * 3;
        }

        // BMP 行须 4 字节对齐：按源行跨距逐行重排（不能假设源行紧密排列）
        let out_stride = ((out_width * 3 + 3) / 4) * 4;
        let row_bytes = (out_width * 3) as usize;
        let mut bmp_px = vec![0u8; (out_stride * out_height) as usize];
        for y in 0..out_height as usize {
            let src = y * src_stride as usize;
            bmp_px[y * out_stride as usize..y * out_stride as usize + row_bytes]
                .copy_from_slice(&out_pixels[src..src + row_bytes]);
        }

        let file_size = 54 + bmp_px.len();
        let mut out = Vec::with_capacity(file_size);
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&(file_size as u32).to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&54u32.to_le_bytes());
        out.extend_from_slice(&40u32.to_le_bytes());
        out.extend_from_slice(&out_width.to_le_bytes());
        out.extend_from_slice(&(-out_height).to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&24u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(bmp_px.len() as u32).to_le_bytes());
        out.extend_from_slice(&[0u8; 16]);
        out.extend_from_slice(&bmp_px);

        Ok(format!("data:image/bmp;base64,{}", base64(&out)))
    }
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn base64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/* ───────────── IPC 分发 ───────────── */

/* ───────────── 原版 cmd_* 名称映射（文档 24 的 54 个命令）───────────── */

fn map_cmd(cmd: &str, args: &Value) -> (String, Value) {
    let as_str = |v: &Value| v.as_str().unwrap_or("").to_string();
    let args_c = args.clone();
    let mapped: Option<(&str, Value)> = match cmd {
        "cmd_show_overlay" => Some(("overlay.show", args_c.clone())),
        "cmd_hide_overlay" => Some(("overlay.hide", args_c.clone())),
        "cmd_overlay_show_seq" => Some(("overlay.seq", args_c.clone())),
        "cmd_overlay_session_ready" => Some(("overlay.session_ready", args_c.clone())),
        "cmd_release_session_if_not_ready" => Some(("overlay.release", args_c.clone())),
        "cmd_overlay_heartbeat" => Some(("native.ping", args_c.clone())),
        "cmd_set_session_active" => Some(("native.unsupported", args_c.clone())),
        "cmd_set_overlay_interactive" => Some(("win.interactive", args_c.clone())),
        "cmd_set_overlay_size" => Some(("win.position", args_c.clone())),
        "cmd_position_overlay" => Some(("win.position", args_c.clone())),
        "cmd_set_drag_active" => Some(("native.unsupported", args_c.clone())),
        "cmd_set_overlay_zones" => Some(("overlay.zones", args_c.clone())),
        "cmd_apply_overlay_styles" => Some(("native.unsupported", args_c.clone())),
        "cmd_capture_screen" => Some(("capture.screen", args_c.clone())),
        "cmd_capture_displays" => Some(("native.empty_array", args_c.clone())),
        "cmd_check_screen_capture_permission" => Some(("native.capture_permission", args_c.clone())),
        "cmd_request_screen_capture_permission" => Some(("native.capture_permission", args_c.clone())),
        "cmd_open_screen_recording_settings" => Some(("native.unsupported", args_c.clone())),
        "cmd_capture_protection_support" => Some(("stealth.support", args_c.clone())),
        "cmd_set_capture_excluded" => Some(("stealth.set", args_c.clone())),
        "cmd_set_panic_hotkey" => Some(("hotkeys.set", args_c.clone())),
        "cmd_panic_hotkey_status" => Some(("hotkeys.status", args_c.clone())),
        "cmd_set_action_hotkeys" => Some(("hotkeys.set", args_c.clone())),
        "cmd_apply_disguise_title" => {
            let title = args_c
                .get("title")
                .or_else(|| args.get("windowTitle"))
                .cloned()
                .unwrap_or(Value::String(String::new()));
            Some(("win.disguise", json!({ "title": title })))
        }
        "cmd_set_disguise_icon" | "cmd_clear_disguise_icon" | "cmd_get_disguise_icon" => {
            Some(("native.null", args_c.clone()))
        }
        "cmd_show_main" => Some(("win.show_label", json!({ "label": "main", "show": true }))),
        "cmd_hide_main" => Some(("win.show_label", json!({ "label": "main", "show": false }))),
        "cmd_minimize_main" => Some(("win.minimize", json!({ "label": "main" }))),
        "cmd_start_system_audio_capture" => Some(("audio.start", args_c.clone())),
        "cmd_stop_system_audio_capture" => Some(("audio.stop", args_c.clone())),
        "cmd_list_system_audio_outputs" => Some(("audio.devices", args_c.clone())),
        "cmd_set_system_audio_excluded_outputs" => Some(("native.unsupported", args_c.clone())),
        "cmd_get_cursor_pos" => Some(("win.cursor", args_c.clone())),
        "cmd_set_cursor_point_feed" => Some(("native.unsupported", args_c.clone())),
        "cmd_is_crash_recovery" => Some(("crash.is", args_c.clone())),
        "cmd_is_recovered_boot" => Some(("crash.booted", args_c.clone())),
        "cmd_read_native_crash" | "cmd_clear_native_crash" | "cmd_pending_newer_version"
        | "cmd_get_demo_visible_mode" | "cmd_set_demo_visible_mode" | "cmd_exam_window_snapshot"
        | "cmd_update_state" => Some(("native.null", args_c.clone())),
        "cmd_take_webview_crashes" | "cmd_read_recent_logs" => Some(("native.empty_array", args_c.clone())),
        // 高危7：cmd_relaunch 真正重启（spawn 自身 + exit），不再 native.ok 假装成功
        "cmd_relaunch" => Some(("native.relaunch", args_c.clone())),
        "cmd_update_download" | "cmd_update_install" | "cmd_update_reveal" => {
            Some(("native.unsupported", args_c.clone()))
        }
        "cmd_start_native_exam_osd" | "cmd_stop_native_exam_osd" | "cmd_start_auth_listener" => {
            Some(("native.unsupported", args_c.clone()))
        }
        _ => None,
    };
    match mapped {
        Some((name, a)) => (name.to_string(), a),
        None => {
            let _ = as_str(&Value::Null);
            (cmd.to_string(), args_c)
        }
    }
}

pub fn handle_ipc(
    state: &Mutex<AppState>,
    label: &str,
    body: &str,
) -> Option<(u64, bool, Value)> {
    let v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            state.lock().unwrap_or_else(|e| e.into_inner()).last_error = format!("IPC JSON 解析失败: {e}");
            return None;
        }
    };
    let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
    let raw_cmd = v.get("cmd").and_then(|x| x.as_str()).unwrap_or("");
    let raw_args = v.get("args").cloned().unwrap_or(Value::Null);
    let (cmd_owned, args) = map_cmd(raw_cmd, &raw_args);
    let cmd = cmd_owned.as_str();
    if std::env::var("ML_IPCLOG").ok().as_deref() == Some("1") {
        println!("[ipc] {cmd} ← {label}");
    }
    // 高危7：按 label 分级。map_cmd 已把 cmd_* 别名映射到内部名，这里按内部名校验即可。
    // overlay 是更暴露的窗口（可被拖到任意位置），只放行浮窗所需最小集；
    // main 与 on_new_window 新开的房间窗（web-*，房间页与主窗同级）放行全部。
    if !cmd_allowed_for_label(label, cmd, &args) {
        return Some((id, false, json!(format!("命令不被允许: {cmd}（label={label}）"))));
    }

    match cmd {
        /* 通用占位（供原版 cmd_* 复用） */
        "native.ok" => Some((id, true, json!(true))),
        "native.null" => Some((id, true, json!(null))),
        "native.empty_array" => Some((id, true, json!([]))),
        "native.unsupported" => Some((id, true, json!({ "status": "unsupported" }))),
        "native.ping" => Some((id, true, json!(now_millis()))),
        "native.capture_permission" => Some((id, true, json!({ "granted": true, "canAsk": true }))),
        "stealth.support" => Some((id, true, json!({ "wda": true, "platform": "win32" }))),
        // P1-4：返回真实注册结果，不再写死 Ctrl+Alt+Esc
        "hotkeys.status" => Some((id, true, crate::hooks::hotkey_status())),
        "crash.is" => Some((id, true, json!(state.lock().unwrap_or_else(|e| e.into_inner()).crash_recovery))),
        "crash.booted" => Some((id, true, json!(state.lock().unwrap_or_else(|e| e.into_inner()).boot_ok))),
        "win.show_label" => {
            let target = args.get("label").and_then(|x| x.as_str()).unwrap_or("main");
            let show = args.get("show").and_then(|x| x.as_bool()).unwrap_or(true);
            if let Some(h) = hwnd_of(state, target) {
                show_window(h, show);
            }
            Some((id, true, json!({ "label": target, "show": show })))
        }
        "win.minimize" => {
            let target = args.get("label").and_then(|x| x.as_str()).unwrap_or("main");
            if let Some(h) = hwnd_of(state, target) {
                unsafe {
                    let _ = ShowWindow(h, windows::Win32::UI::WindowsAndMessaging::SW_MINIMIZE);
                }
            }
            Some((id, true, json!({ "minimized": target })))
        }
        "win.cursor" => {
            let mut p = windows::Win32::Foundation::POINT::default();
            let ok = unsafe {
                windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p).is_ok()
            };
            Some((id, true, json!({ "ok": ok, "x": p.x, "y": p.y })))
        }
        "native.info" => {
            let st = state.lock().unwrap_or_else(|e| e.into_inner());
            Some((id, true, json!({
                "shell": "rust-tauri2",
                "native": true,
                "platform": "win32",
                "base": crate::base_url(),
                "wda": st.wda,
                "crashRecovery": st.crash_recovery,
            })))
        }
        "overlay.show" => {
            // P0-3：先记下采纳前的 seq；set_overlay_visible 内部已 +1（同一次显示只算一次）
            let prev = state.lock().unwrap_or_else(|e| e.into_inner()).seq;
            set_overlay_visible(state, true);
            let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
            // 前端传来的 seq 仅在「比采纳前大且增量 ≤ 100」时采纳（正常每次 +1）；
            // Date.now() 级的 13 位时间戳直接忽略，避免原生 seq 永久错位
            let incoming = args.get("seq").and_then(|x| x.as_i64()).filter(|&s| s > 0);
            match incoming {
                Some(s) if s > prev && s - prev <= 100 => st.seq = s,
                Some(s) => println!("[overlay] 忽略异常 seq={s}（采纳前 {prev}，当前 {}）", st.seq),
                None => {}
            }
            let seq = st.seq;
            Some((id, true, json!({ "seq": seq })))
        }
        "overlay.hide" => {
            set_overlay_visible(state, false);
            Some((id, true, json!({ "ok": true })))
        }
        "overlay.toggle" => {
            let show = args.get("show").and_then(|x| x.as_bool()).unwrap_or(true);
            set_overlay_visible(state, show);
            Some((id, true, json!({ "visible": show })))
        }
        "overlay.close" => {
            // 说明：只隐藏不销毁（窗口复用，下次 showOverlay 直接显示），因此同步 overlay_visible
            if let Some(h) = hwnd_of(state, "overlay") {
                show_window(h, false);
            }
            state.lock().unwrap_or_else(|e| e.into_inner()).overlay_visible = false;
            Some((id, true, json!({ "closed": true })))
        }
        "overlay.seq" => Some((id, true, json!(state.lock().unwrap_or_else(|e| e.into_inner()).seq))),
        "overlay.session_ready" => {
            let seq = args.get("seq").and_then(|x| x.as_i64()).unwrap_or(0);
            let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
            st.last_ready_seq = seq.max(st.last_ready_seq);
            Some((id, true, json!({ "seq": st.last_ready_seq })))
        }
        "overlay.release" => {
            let seq = args.get("seq").and_then(|x| x.as_i64()).unwrap_or(0);
            let st = state.lock().unwrap_or_else(|e| e.into_inner());
            Some((id, true, json!(st.last_ready_seq < seq)))
        }
        "stealth.state" => {
            let st = state.lock().unwrap_or_else(|e| e.into_inner());
            Some((id, true, json!({
                "contentProtection": st.wda,
                "wdaSupported": true,
                "panicHidden": st.hidden_by_panic.len(),
                "focusHook": st.focus_enabled,
                "overlaySeq": st.seq,
                "lastReadySeq": st.last_ready_seq,
                // 附加字段：浮窗当前是否可见（供 UI/验收观测，window.close 会同步置 false）
                "overlayVisible": st.overlay_visible,
            })))
        }
        "stealth.set" => {
            let kind = args.get("kind").and_then(|x| x.as_str()).unwrap_or("main");
            let enable = args.get("enable").and_then(|x| x.as_bool()).unwrap_or(true);
            let ok = set_wda(state, kind, enable);
            // 返回应用后的完整映射，前端可直接用它刷新两个勾选框（此前只回 {ok,kind,enable}，
            // 前端误当成 contentProtection 整表，导致点完立刻回退、切页才恢复）
            let map = state.lock().unwrap_or_else(|e| e.into_inner()).wda.clone();
            Some((id, true, json!({ "ok": ok, "kind": kind, "enable": enable, "contentProtection": map })))
        }
        "stealth.panic" => {
            panic_toggle(state);
            let n = state.lock().unwrap_or_else(|e| e.into_inner()).hidden_by_panic.len();
            Some((id, true, json!(n)))
        }
        "win.skip_taskbar" => {
            let enable = args.get("enable").and_then(|x| x.as_bool()).unwrap_or(true);
            let target = args.get("label").and_then(|x| x.as_str()).unwrap_or("main");
            Some((id, true, json!(set_skip_taskbar(state, target, enable))))
        }
        "win.disguise" => {
            let title = args.get("title").and_then(|x| x.as_str()).unwrap_or("");
            Some((id, true, json!(disguise_title(state, title))))
        }
        "win.disguise_process" => {
            let name = args.get("name").and_then(|x| x.as_str()).unwrap_or("App");
            let launch = args.get("launch").and_then(|x| x.as_bool()).unwrap_or(false);
            match disguise_process(name, launch) {
                Ok(v) => Some((id, true, v)),
                Err(e) => Some((id, false, json!(e))),
            }
        }
        "win.interactive" => {
            let enable = args.get("enable").and_then(|x| x.as_bool()).unwrap_or(true);
            let target = args.get("label").and_then(|x| x.as_str()).unwrap_or("overlay");
            Some((id, true, json!(set_interactive(state, target, enable))))
        }
        "win.position" => {
            let g = |k: &str, d: i32| args.get(k).and_then(|x| x.as_i64()).map(|x| x as i32).unwrap_or(d);
            let ok = position_overlay(state, g("x", 0), g("y", 0), g("w", 420), g("h", 640));
            Some((id, true, json!({ "ok": ok })))
        }
        "win.rect" => {
            let target = args.get("label").and_then(|x| x.as_str()).unwrap_or("overlay");
            let r = window_rect(state, target);
            Some((id, true, match r {
                Some((x, y, w, h)) => json!({ "x": x, "y": y, "w": w, "h": h }),
                None => json!(null),
            }))
        }
        "win.list" => {
            prune_dead_hwnds(state);
            let st = state.lock().unwrap_or_else(|e| e.into_inner());
            Some((id, true, json!(st.hwnds.keys().cloned().collect::<Vec<_>>())))
        }
        "capture.screen" => {
            let max_width = args.get("maxWidth").and_then(|x| x.as_i64()).map(|x| x as i32).unwrap_or(0);
            match capture_screen(max_width) {
                Ok(url) => Some((id, true, json!(url))),
                Err(e) => Some((id, false, json!(e))),
            }
        }
        "audio.start" => {
            let min_level = args.get("minLevel").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
            crate::audio::start(min_level);
            Some((id, true, json!({ "started": true })))
        }
        "audio.stop" => {
            crate::audio::stop();
            Some((id, true, json!({ "stopped": true })))
        }
        "audio.level" => Some((id, true, json!(state.lock().unwrap_or_else(|e| e.into_inner()).audio_level))),
        "audio.devices" => Some((id, true, crate::audio::devices())),
        "hook.focus" => {
            let enable = args.get("enable").and_then(|x| x.as_bool()).unwrap_or(true);
            state.lock().unwrap_or_else(|e| e.into_inner()).focus_enabled = enable;
            crate::hooks::set_focus_hook(enable);
            Some((id, true, json!({ "enabled": enable })))
        }
        "hotkeys.set" => {
            let list = args.get("list").cloned().unwrap_or(json!([]));
            let ok = crate::hooks::set_hotkeys(&list);
            // 返回真实注册结果（P1-4）：前端用它展示「实际生效的热键」
            let status = crate::hooks::hotkey_status();
            let items = status.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            // P1-12：registered 只回成功项；失败项单独回给前端标红
            let registered: Vec<Value> = items
                .iter()
                .filter(|i| i.get("ok").and_then(|v| v.as_bool()).unwrap_or(false))
                .cloned()
                .collect();
            Some((id, true, json!({
                "ok": ok,
                "count": list.as_array().map(|a| a.len()).unwrap_or(0),
                "registered": registered,
                "failed": status.get("failed").cloned().unwrap_or(json!([])),
            })))
        }
        "crash.recovery" => {
            let st = state.lock().unwrap_or_else(|e| e.into_inner());
            Some((id, true, json!({
                "isCrashRecovery": st.crash_recovery,
                "bootOk": st.boot_ok,
                "showSeq": st.seq,
                "lastReadySeq": st.last_ready_seq,
            })))
        }
        "crash.boot_ok" => {
            state.lock().unwrap_or_else(|e| e.into_inner()).boot_ok = true;
            let _ = std::fs::remove_file(data_dir().join(".recovery"));
            Some((id, true, json!({ "ok": true })))
        }
        "features.list" => Some((id, true, json!(state.lock().unwrap_or_else(|e| e.into_inner()).features))),
        "features.set" => {
            let key = args.get("key").and_then(|x| x.as_str()).unwrap_or("");
            let value = args.get("value").cloned().unwrap_or(Value::Bool(true));
            // 小项3：stealth.wda 真正联动 set_wda（主窗+浮窗）；stealth.panic 由 panic_toggle 读取；
            // 其余键仅存储供前端判断，不驱动原生行为
            if key == "stealth.wda" {
                let enable = value.as_bool().unwrap_or(true);
                for lbl in ["main", "overlay"] {
                    set_wda(state, lbl, enable);
                }
            }
            state.lock().unwrap_or_else(|e| e.into_inner()).features.insert(key.to_string(), value.clone());
            Some((id, true, json!({ "key": key, "value": value, "applied": key == "stealth.wda" })))
        }
        /* 浮窗分区：仅存储进 AppState（后续做点击穿透用），不假装成功执行穿透 */
        "overlay.zones" => {
            let zones = args.get("zones").cloned().unwrap_or(json!([]));
            let count = zones.as_array().map(|a| a.len()).unwrap_or(0);
            state.lock().unwrap_or_else(|e| e.into_inner()).zones = zones.as_array().cloned().unwrap_or_default();
            // P2-C：点击穿透需要 WM_NCHITTEST 返回 HTTRANSPARENT（需子类化窗口过程），当前未实现；
            // 明确回 unsupported，别让前端把「已登记」误当成「已生效」。
            Some((id, true, json!({
                "status": "unsupported",
                "stored": true,
                "count": count,
                "reason": "分区已登记，但点击穿透（WM_NCHITTEST/HTTRANSPARENT）尚未实现，不生效",
            })))
        }
        /* cmd_relaunch：真正重启（spawn 自身 + exit(0)），绝不返回假成功 */
        "native.relaunch" => {
            let exe = std::env::current_exe().map_err(|e| format!("无法定位当前 exe: {e}"));
            match exe {
                Ok(path) => match std::process::Command::new(&path).spawn() {
                    Ok(child) => {
                        println!("[relaunch] 已拉起新进程 pid={}，当前进程退出", child.id());
                        std::process::exit(0);
                    }
                    Err(e) => Some((id, false, json!(format!("重启失败: {e}")))),
                },
                Err(e) => Some((id, false, json!(e))),
            }
        }
        "window.close" => {
            let target = args.get("label").and_then(|x| x.as_str()).unwrap_or("overlay");
            // 说明：这里只隐藏不销毁（窗口可复用），因此必须同步 overlay_visible，
            // 否则后续 toggle/show 的可见性判断会被陈旧状态带偏（P2-C）
            if let Some(h) = hwnd_of(state, target) {
                show_window(h, false);
            }
            if target == "overlay" {
                state.lock().unwrap_or_else(|e| e.into_inner()).overlay_visible = false;
            }
            Some((id, true, json!({ "closed": target })))
        }
        other => Some((id, false, json!(format!("未知命令: {other}（label={label}）")))),
    }
}

/// 高危7：overlay 窗口的 IPC 白名单（内部名口径；cmd_* 别名经 map_cmd 后再校验）。
/// 注意：capture.screen / win.disguise_process / win.list / hotkeys.set / crash.* 刻意不放行——
/// 浮窗自动配色（Ctrl+Alt+P）因此退化为提示文案，属预期收窄；主窗仍可全量调用。
fn cmd_allowed_for_label(label: &str, cmd: &str, args: &Value) -> bool {
    if label != "overlay" {
        // main 与 on_new_window 新开的房间窗 web-*：房间页（#mock / #mock-exam）与主窗同级
        return true;
    }
    const OVERLAY_CMDS: &[&str] = &[
        "overlay.show", "overlay.hide", "overlay.toggle", "overlay.seq",
        "overlay.session_ready", "overlay.release", "overlay.close", "overlay.zones",
        "win.rect", "win.position", "win.interactive",
        "stealth.set", "native.info", "native.ping", "native.ok",
        "audio.start", "audio.stop", "audio.level", "audio.devices",
    ];
    if !OVERLAY_CMDS.contains(&cmd) {
        return false;
    }
    // stealth.set：浮窗只允许改自己的防截屏
    if cmd == "stealth.set" {
        return args.get("kind").and_then(|x| x.as_str()).unwrap_or("overlay") == "overlay";
    }
    true
}
