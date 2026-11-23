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
    GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, SetWindowDisplayAffinity,
    SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow, SM_CXSCREEN, SM_CYSCREEN,
    SWP_NOACTIVATE, SW_HIDE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    HWND_TOPMOST, GWL_EXSTYLE,
};

use crate::UserEvent;

const DATA_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../data");

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
const WS_EX_LAYERED: isize = 0x0008_0000 - 0x0008_0000; // 占位：不改变分层属性

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
    let marker = format!("{}/.recovery", DATA_DIR);
    let _ = std::fs::create_dir_all(DATA_DIR);
    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
    st.crash_recovery = std::path::Path::new(&marker).exists();
    let _ = std::fs::write(&marker, b"1");
}

pub fn set_hwnd(state: &Mutex<AppState>, label: &str, hwnd: isize) {
    state.lock().unwrap_or_else(|e| e.into_inner()).hwnds.insert(label.to_string(), hwnd);
}

fn hwnd_of(state: &Mutex<AppState>, label: &str) -> Option<HWND> {
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
        let _ = WS_EX_LAYERED;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
    }
    true
}

pub fn disguise_title(state: &Mutex<AppState>, title: &str) -> bool {
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
    let dir = format!("{}/disguise", DATA_DIR);
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
    if launch {
        if let Ok(mut child) = std::process::Command::new(&target).spawn() {
            let pid = child.id();
            let _ = child.wait();
            launched = true;
            println!("[disguise] 已以伪装名启动进程（pid={pid}）");
        }
    }
    println!("[disguise] 进程副本 → {target}");
    Ok(json!({ "path": target, "name": safe, "launched": launched }))
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

pub fn capture_screen() -> Result<String, String> {
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

        let file_size = 54 + pixels.len();
        let mut out = Vec::with_capacity(file_size);
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&(file_size as u32).to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&54u32.to_le_bytes());
        out.extend_from_slice(&40u32.to_le_bytes());
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&(-height).to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&24u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(pixels.len() as u32).to_le_bytes());
        out.extend_from_slice(&[0u8; 16]);
        out.extend_from_slice(&pixels);

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
        "cmd_set_session_active" => Some(("native.ok", args_c.clone())),
        "cmd_set_overlay_interactive" => Some(("win.interactive", args_c.clone())),
        "cmd_set_overlay_size" => Some(("win.position", args_c.clone())),
        "cmd_position_overlay" => Some(("win.position", args_c.clone())),
        "cmd_set_drag_active" => Some(("native.ok", args_c.clone())),
        "cmd_set_overlay_zones" => Some(("native.ok", args_c.clone())),
        "cmd_apply_overlay_styles" => Some(("native.ok", args_c.clone())),
        "cmd_capture_screen" => Some(("capture.screen", args_c.clone())),
        "cmd_capture_displays" => Some(("native.empty_array", args_c.clone())),
        "cmd_check_screen_capture_permission" => Some(("native.capture_permission", args_c.clone())),
        "cmd_request_screen_capture_permission" => Some(("native.capture_permission", args_c.clone())),
        "cmd_open_screen_recording_settings" => Some(("native.ok", args_c.clone())),
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
        "cmd_set_system_audio_excluded_outputs" => Some(("native.ok", args_c.clone())),
        "cmd_get_cursor_pos" => Some(("win.cursor", args_c.clone())),
        "cmd_set_cursor_point_feed" => Some(("native.ok", args_c.clone())),
        "cmd_is_crash_recovery" => Some(("crash.is", args_c.clone())),
        "cmd_is_recovered_boot" => Some(("crash.booted", args_c.clone())),
        "cmd_read_native_crash" | "cmd_clear_native_crash" | "cmd_pending_newer_version"
        | "cmd_get_demo_visible_mode" | "cmd_set_demo_visible_mode" | "cmd_exam_window_snapshot"
        | "cmd_update_state" => Some(("native.null", args_c.clone())),
        "cmd_take_webview_crashes" | "cmd_read_recent_logs" => Some(("native.empty_array", args_c.clone())),
        "cmd_relaunch" => Some(("native.ok", args_c.clone())),
        "cmd_update_download" | "cmd_update_install" | "cmd_update_reveal" => {
            Some(("native.unsupported", args_c.clone()))
        }
        "cmd_start_native_exam_osd" | "cmd_stop_native_exam_osd" | "cmd_start_auth_listener" => {
            Some(("native.ok", args_c.clone()))
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

    match cmd {
        /* 通用占位（供原版 cmd_* 复用） */
        "native.ok" => Some((id, true, json!(true))),
        "native.null" => Some((id, true, json!(null))),
        "native.empty_array" => Some((id, true, json!([]))),
        "native.unsupported" => Some((id, true, json!({ "status": "unsupported" }))),
        "native.ping" => Some((id, true, json!(now_millis()))),
        "native.capture_permission" => Some((id, true, json!({ "granted": true, "canAsk": true }))),
        "stealth.support" => Some((id, true, json!({ "wda": true, "platform": "win32" }))),
        "hotkeys.status" => Some((id, true, json!({ "registered": true, "hotkey": "Ctrl+Alt+Esc" }))),
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
                "base": crate::BASE,
                "wda": st.wda,
                "crashRecovery": st.crash_recovery,
            })))
        }
        "overlay.show" => {
            set_overlay_visible(state, true);
            let seq = state.lock().unwrap_or_else(|e| e.into_inner()).seq;
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
            })))
        }
        "stealth.set" => {
            let kind = args.get("kind").and_then(|x| x.as_str()).unwrap_or("main");
            let enable = args.get("enable").and_then(|x| x.as_bool()).unwrap_or(true);
            let ok = set_wda(state, kind, enable);
            Some((id, true, json!({ "ok": ok, "kind": kind, "enable": enable })))
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
            let st = state.lock().unwrap_or_else(|e| e.into_inner());
            Some((id, true, json!(st.hwnds.keys().cloned().collect::<Vec<_>>())))
        }
        "capture.screen" => match capture_screen() {
            Ok(url) => Some((id, true, json!(url))),
            Err(e) => Some((id, false, json!(e))),
        },
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
            Some((id, true, json!({ "ok": ok, "count": list.as_array().map(|a| a.len()).unwrap_or(0) })))
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
            let _ = std::fs::remove_file(format!("{}/.recovery", DATA_DIR));
            Some((id, true, json!({ "ok": true })))
        }
        "features.list" => Some((id, true, json!(state.lock().unwrap_or_else(|e| e.into_inner()).features))),
        "features.set" => {
            let key = args.get("key").and_then(|x| x.as_str()).unwrap_or("");
            let value = args.get("value").cloned().unwrap_or(Value::Bool(true));
            state.lock().unwrap_or_else(|e| e.into_inner()).features.insert(key.to_string(), value.clone());
            Some((id, true, json!({ "key": key, "value": value })))
        }
        "window.close" => {
            let target = args.get("label").and_then(|x| x.as_str()).unwrap_or("overlay");
            if let Some(h) = hwnd_of(state, target) {
                show_window(h, false);
            }
            Some((id, true, json!({ "closed": target })))
        }
        other => Some((id, false, json!(format!("未知命令: {other}（label={label}）")))),
    }
}
