//! 全局热键（RegisterHotKey，独立消息循环线程）与前台窗口钩子（SetWinEventHook）。

use std::sync::Mutex;

use serde_json::{json, Value};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowTextW,
    GetWindowThreadProcessId, PostMessageW, RegisterClassW, TranslateMessage, MSG, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_APP, WM_HOTKEY, WNDCLASSW, EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT,
    WS_OVERLAPPED,
};

use crate::UserEvent;

static FOCUS_ENABLED: Mutex<bool> = Mutex::new(false);
static HOOK_HANDLE: Mutex<isize> = Mutex::new(0);
/// 自定义热键：(热键 id, 动作名, 加速键文本)；id 从 100 起，避开默认的 1-4
static CUSTOM_HOTKEYS: Mutex<Vec<(i32, String, String)>> = Mutex::new(Vec::new());
/// 用户覆盖默认动作：(默认 id, 加速键文本)
static HOTKEY_OVERRIDES: Mutex<Vec<(i32, String)>> = Mutex::new(Vec::new());
/// 热键宿主窗口句柄；0 表示热键线程尚未就绪
static HOTKEY_HWND: Mutex<isize> = Mutex::new(0);
/// 当前实际注册成功的热键：(id, 动作名, 加速键文本)，供 wnd_proc 反查与 hotkeys.status 返回
static REGISTERED: Mutex<Vec<(i32, String, String)>> = Mutex::new(Vec::new());
/// register_all 完成代际：set_hotkeys 投递指令后等它 +1，同步拿到注册结果
static REGISTER_GEN: Mutex<u64> = Mutex::new(0);
/// 焦点钩子线程的消息窗口句柄；0 表示线程尚未就绪（set_focus_hook 经它投递安装/卸载指令）
static FOCUS_HWND: Mutex<isize> = Mutex::new(0);

const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
const MOD_WIN: u32 = 0x0008;

/* VK 常量（RegisterHotKey 的 vk 参数是裸 u32） */
const VK_BACK: u32 = 0x08;
const VK_TAB: u32 = 0x09;
const VK_RETURN: u32 = 0x0D;
const VK_ESCAPE: u32 = 0x1B;
const VK_SPACE: u32 = 0x20;
const VK_PRIOR: u32 = 0x21; // PageUp
const VK_NEXT: u32 = 0x22; // PageDown
const VK_END: u32 = 0x23;
const VK_HOME: u32 = 0x24;
const VK_LEFT: u32 = 0x25;
const VK_UP: u32 = 0x26;
const VK_RIGHT: u32 = 0x27;
const VK_DOWN: u32 = 0x28;
const VK_INSERT: u32 = 0x2D;
const VK_DELETE: u32 = 0x2E;
const VK_F1: u32 = 0x70;

/// 默认热键表：(id, 动作名, 修饰键, VK, 加速键文本)；id 1-4，自定义项从 100 起
fn default_hotkeys() -> Vec<(i32, &'static str, u32, u32, &'static str)> {
    vec![
        (1, "panic", MOD_CONTROL | MOD_ALT, VK_ESCAPE, "Ctrl+Alt+Esc"),
        (2, "toggle-overlay", MOD_CONTROL | MOD_ALT, 0x48, "Ctrl+Alt+H"),
        (3, "close-overlay", MOD_CONTROL | MOD_ALT | MOD_SHIFT, 0x58, "Ctrl+Alt+Shift+X"),
        (4, "quit", MOD_CONTROL | MOD_ALT | MOD_SHIFT, 0x51, "Ctrl+Alt+Shift+Q"),
    ]
}

/// 键名 → VK 码；覆盖 Esc / F1-F24 / 方向键 / 编辑键 / 空格 Tab Enter Backspace / 数字 / 字母
fn vk_of(name: &str) -> Option<u32> {
    Some(match name {
        "escape" | "esc" => VK_ESCAPE,
        "f1" => VK_F1,
        "f2" => VK_F1 + 1,
        "f3" => VK_F1 + 2,
        "f4" => VK_F1 + 3,
        "f5" => VK_F1 + 4,
        "f6" => VK_F1 + 5,
        "f7" => VK_F1 + 6,
        "f8" => VK_F1 + 7,
        "f9" => VK_F1 + 8,
        "f10" => VK_F1 + 9,
        "f11" => VK_F1 + 10,
        "f12" => VK_F1 + 11,
        "f13" => VK_F1 + 12,
        "f14" => VK_F1 + 13,
        "f15" => VK_F1 + 14,
        "f16" => VK_F1 + 15,
        "f17" => VK_F1 + 16,
        "f18" => VK_F1 + 17,
        "f19" => VK_F1 + 18,
        "f20" => VK_F1 + 19,
        "f21" => VK_F1 + 20,
        "f22" => VK_F1 + 21,
        "f23" => VK_F1 + 22,
        "f24" => VK_F1 + 23,
        "up" | "arrowup" => VK_UP,
        "down" | "arrowdown" => VK_DOWN,
        "left" | "arrowleft" => VK_LEFT,
        "right" | "arrowright" => VK_RIGHT,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" | "pgup" | "prior" => VK_PRIOR,
        "pagedown" | "pgdn" | "next" => VK_NEXT,
        "insert" | "ins" => VK_INSERT,
        "delete" | "del" => VK_DELETE,
        "space" | "spc" => VK_SPACE,
        "tab" => VK_TAB,
        "enter" | "return" => VK_RETURN,
        "backspace" | "bs" => VK_BACK,
        other if other.len() == 1 && other.as_bytes()[0].is_ascii_digit() => 0x30u32 + (other.as_bytes()[0] - b'0') as u32,
        other if other.len() == 1 && other.as_bytes()[0].is_ascii_alphabetic() => 0x41u32 + ((other.as_bytes()[0] | 0x20) - b'a') as u32,
        _ => return None,
    })
}

/// 解析 "Ctrl+Alt+P" 形加速键 → (修饰键位图, VK)。键名不认识、或出现多个非修饰键时返回 vk=0。
/// 无修饰键的组合是合法解析结果（vk 非 0），但是否全局注册由调用方按「必须含修饰键」规则决定。
fn parse_accel(accel: &str) -> (u32, u32) {
    let mut mods = 0u32;
    let mut vk = 0u32;
    let mut keys = 0u32;
    for part in accel.split('+') {
        let p = part.trim().to_ascii_lowercase();
        match p.as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "alt" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "win" | "meta" | "super" | "cmd" => mods |= MOD_WIN,
            _ => match vk_of(&p) {
                Some(v) => {
                    vk = v;
                    keys += 1;
                }
                None => return (mods, 0), // 不认识的键名：整条无效
            },
        }
    }
    if keys != 1 {
        return (mods, 0); // 0 个或多个主键（如 "Esc+Esc"）：无效
    }
    (mods, vk)
}

/// 按当前配置重注册全部热键：先注销旧表 → 默认 1-4（应用覆盖）→ 自定义 id>=100。
/// 返回实际注册成功的 (id, 动作名, 加速键文本) 列表，并存进 REGISTERED。
unsafe fn register_all(hwnd: HWND) -> Vec<(i32, String, String)> {
    // 逐个注销旧表（不能只注销 id 0）
    let old = REGISTERED.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default();
    for (id, _, _) in &old {
        let _ = UnregisterHotKey(hwnd, *id);
    }
    let overrides = HOTKEY_OVERRIDES.lock().map(|g| g.clone()).unwrap_or_default();
    let mut ok_list: Vec<(i32, String, String)> = Vec::new();
    for (id, action, _mods, _vk, default_accel) in default_hotkeys() {
        // 用户覆盖默认动作：换加速键，动作名与 id 不变
        let accel = overrides
            .iter()
            .find(|(oid, _)| *oid == id)
            .map(|(_, a)| a.clone())
            .unwrap_or_else(|| default_accel.to_string());
        let (m, v) = parse_accel(&accel);
        // 规则：无修饰键的组合不全局注册（会吞掉系统单键），留给页面级处理
        if v == 0 || m == 0 {
            println!("[hotkey] {action} (id={id}) 加速键「{accel}」不注册：{}", if m == 0 { "缺少修饰键（Ctrl/Alt/Shift/Win）" } else { "无法解析" });
            continue;
        }
        match RegisterHotKey(hwnd, id, HOT_KEY_MODIFIERS(m), v) {
            Ok(()) => {
                println!("[hotkey] {action} (id={id}) 「{accel}」已注册");
                ok_list.push((id, action.to_string(), accel));
            }
            Err(_) => println!("[hotkey] {action} (id={id}) 「{accel}」注册失败（可能被占用）"),
        }
    }
    for (id, action, accel) in CUSTOM_HOTKEYS.lock().map(|g| g.clone()).unwrap_or_default() {
        let (m, v) = parse_accel(&accel);
        if v == 0 || m == 0 {
            println!("[hotkey] 自定义 {action} (id={id}) 加速键「{accel}」不注册：{}", if m == 0 { "缺少修饰键" } else { "无法解析" });
            continue;
        }
        if ok_list.iter().any(|(i, _, _)| *i == id) {
            println!("[hotkey] 自定义 id={id} 冲突，跳过");
            continue;
        }
        match RegisterHotKey(hwnd, id, HOT_KEY_MODIFIERS(m), v) {
            Ok(()) => {
                println!("[hotkey] 自定义 {action} (id={id}) 「{accel}」已注册");
                ok_list.push((id, action, accel));
            }
            Err(_) => println!("[hotkey] 自定义 {action} (id={id}) 「{accel}」注册失败（可能被占用）"),
        }
    }
    if let Ok(mut g) = REGISTERED.lock() {
        *g = ok_list.clone();
    }
    if let Ok(mut g) = REGISTER_GEN.lock() {
        *g += 1;
    }
    ok_list
}

/* ───────────── 热键宿主线程 ───────────── */

/// 经宿主窗口投递重注册指令：RegisterHotKey/UnregisterHotKey 有线程亲和性，
/// 必须由注册它的同一线程（泵消息的热键线程）执行，IPC 线程只发消息
const WM_HOTKEY_CTL: u32 = WM_APP + 2;

pub fn spawn_hotkey_thread() {
    std::thread::spawn(|| unsafe {
        let class_name: Vec<u16> = "Interview OrangeHotkeyHost\0".encode_utf16().collect();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        RegisterClassW(&wc);
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(class_name.as_ptr()),
            WINDOW_STYLE(WS_OVERLAPPED.0),
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[hotkey] 宿主窗口创建失败: {}", e.message());
                return;
            }
        };
        if let Ok(mut g) = HOTKEY_HWND.lock() {
            *g = hwnd.0 as isize;
        }
        // 线程就绪后读同一份 static 配置注册（set_hotkeys 在线程未就绪时只存不注册）
        register_all(hwnd);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        // 线程退出：按实际注册的 id 逐个注销
        for (id, _, _) in REGISTERED.lock().map(|g| g.clone()).unwrap_or_default() {
            let _ = UnregisterHotKey(hwnd, id);
        }
    });
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_HOTKEY {
        let id = w.0 as i32;
        // 从注册表反查动作名（默认 id 与自定义 id 统一路径），未知 id 忽略
        let name = REGISTERED
            .lock()
            .map(|g| g.iter().find(|(i, _, _)| *i == id).map(|(_, a, _)| a.clone()))
            .unwrap_or(None);
        if let Some(action) = name {
            crate::win::emit_event(UserEvent::Hotkey(action));
        }
        return LRESULT(0);
    }
    if msg == WM_HOTKEY_CTL {
        // set_hotkeys 的热更新：在本线程里重注册（注销旧表 + 按新配置注册）
        register_all(hwnd);
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, w, l)
}

/// 设置热键（热更新）。list 形如 [{accel:"Ctrl+Alt+P", action:"panic"}] 或 ["Ctrl+Alt+K"]：
///   - action 命中默认动作（panic / toggle-overlay / close-overlay / quit）→ 记为默认项覆盖；
///   - 其余（含缺 action）→ 自定义项，id 从 100 递增，action 缺省为 "custom-<id>"。
/// 线程未就绪（HOTKEY_HWND=0）时只存 static，线程启动时统一注册。
pub fn set_hotkeys(list: &Value) -> bool {
    let mut customs: Vec<(i32, String, String)> = Vec::new();
    let mut overrides: Vec<(i32, String)> = Vec::new();
    let mut next_id = 100i32;
    if let Some(arr) = list.as_array() {
        for item in arr {
            let accel = item
                .get("accel")
                .and_then(|x| x.as_str())
                .or_else(|| item.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if accel.is_empty() {
                continue;
            }
            let action = item
                .get("action")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            // 命中默认动作 → 覆盖默认项的加速键（保留默认 id 与动作名）
            let default_id = default_hotkeys()
                .into_iter()
                .find(|(_, n, _, _, _)| !action.is_empty() && *n == action)
                .map(|(id, _, _, _, _)| id);
            if let Some(id) = default_id {
                overrides.retain(|(oid, _)| *oid != id);
                overrides.push((id, accel));
                continue;
            }
            let action = if action.is_empty() { format!("custom-{next_id}") } else { action };
            customs.push((next_id, action, accel));
            next_id += 1;
        }
    }
    if let Ok(mut g) = CUSTOM_HOTKEYS.lock() {
        *g = customs;
    }
    if let Ok(mut g) = HOTKEY_OVERRIDES.lock() {
        *g = overrides;
    }
    // 热更新必须在热键线程里执行（RegisterHotKey 线程亲和）：只投递指令，
    // 注册结果经 REGISTERED 反映；用代际计数等线程完成，保证返回值带真实结果
    let hwnd = HOTKEY_HWND.lock().map(|g| *g).unwrap_or(0);
    if hwnd != 0 {
        let gen_before = REGISTER_GEN.lock().map(|g| *g).unwrap_or(0);
        unsafe {
            let _ = PostMessageW(
                HWND(hwnd as *mut core::ffi::c_void),
                WM_HOTKEY_CTL,
                WPARAM(0),
                LPARAM(0),
            );
        }
        for _ in 0..100 {
            let gen = REGISTER_GEN.lock().map(|g| *g).unwrap_or(0);
            if gen > gen_before {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    } else {
        println!("[hotkey] 热键线程未就绪，配置已暂存（线程启动后生效）");
    }
    true
}

/// hotkeys.status：返回真实注册结果（不写死）
pub fn hotkey_status() -> Value {
    let registered = REGISTERED.lock().map(|g| g.clone()).unwrap_or_default();
    let panic = registered
        .iter()
        .find(|(_, a, _)| a == "panic")
        .map(|(_, _, accel)| accel.clone());
    json!({
        "registered": !registered.is_empty(),
        "hotkey": panic.unwrap_or_default(),
        "items": registered.iter().map(|(id, a, accel)| json!({
            "id": id, "action": a, "accel": accel,
        })).collect::<Vec<_>>(),
    })
}

/* ───────────── 前台窗口钩子 ───────────── */

/// 经消息窗口投递安装/卸载指令：SetWinEventHook 必须由泵消息的线程自己调用
const WM_HOOK_CTL: u32 = WM_APP + 1;

pub fn spawn_focus_hook() {
    std::thread::spawn(|| unsafe {
        let class_name: Vec<u16> = "Interview OrangeFocusHost\0".encode_utf16().collect();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(focus_ctl_proc),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        RegisterClassW(&wc);
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(class_name.as_ptr()),
            WINDOW_STYLE(WS_OVERLAPPED.0),
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[hook] 指令窗口创建失败: {}", e.message());
                return;
            }
        };
        if let Ok(mut g) = FOCUS_HWND.lock() {
            *g = hwnd.0 as isize;
        }
        // 线程就绪时若开关已打开（例如 ML_FOCUS=1 先于线程设置），补装一次
        if FOCUS_ENABLED.lock().map(|g| *g).unwrap_or(false) {
            let _ = PostMessageW(hwnd, WM_HOOK_CTL, WPARAM(1), LPARAM(0));
        }
        println!("[hook] 前台窗口钩子线程就绪（默认关闭，hook.focus 开启推送）");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

/// 指令窗口过程：wParam=1 安装钩子，wParam=0 卸载并清句柄
unsafe extern "system" fn focus_ctl_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_HOOK_CTL {
        let enable = w.0 != 0;
        let current = HOOK_HANDLE.lock().map(|g| *g).unwrap_or(0);
        if enable && current == 0 {
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(focus_cb),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if hook.0.is_null() {
                eprintln!("[hook] SetWinEventHook 失败");
            } else {
                if let Ok(mut g) = HOOK_HANDLE.lock() {
                    *g = hook.0 as isize;
                }
                println!("[hook] 前台窗口钩子已安装");
            }
        } else if !enable && current != 0 {
            let _ = UnhookWinEvent(HWINEVENTHOOK(current as *mut core::ffi::c_void));
            if let Ok(mut g) = HOOK_HANDLE.lock() {
                *g = 0;
            }
            println!("[hook] 前台窗口钩子已卸载");
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, w, l)
}

unsafe extern "system" fn focus_cb(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    let enabled = FOCUS_ENABLED.lock().map(|g| *g).unwrap_or(false);
    if !enabled || hwnd.0.is_null() {
        return;
    }
    let mut buf = [0u16; 256];
    let len = GetWindowTextW(hwnd, &mut buf);
    let title = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
    let mut pid = 0u32;
    let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    crate::win::emit_event(UserEvent::Focus { title, pid });
}

/// 开关焦点推送：置位后向钩子线程投递安装/卸载指令（真正 UnhookWinEvent，重新开启时重装）
pub fn set_focus_hook(enable: bool) {
    if let Ok(mut g) = FOCUS_ENABLED.lock() {
        *g = enable;
    }
    let hwnd = FOCUS_HWND.lock().map(|g| *g).unwrap_or(0);
    if hwnd != 0 {
        unsafe {
            let _ = PostMessageW(
                HWND(hwnd as *mut core::ffi::c_void),
                WM_HOOK_CTL,
                WPARAM(if enable { 1 } else { 0 }),
                LPARAM(0),
            );
        }
    }
    println!("[hook] 焦点监听 {}", if enable { "开" } else { "关" });
}
