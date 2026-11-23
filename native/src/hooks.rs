//! 全局热键（RegisterHotKey，独立消息循环线程）与前台窗口钩子（SetWinEventHook）。

use std::sync::Mutex;

use serde_json::Value;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowTextW,
    GetWindowThreadProcessId, RegisterClassW, TranslateMessage, MSG, WINDOW_EX_STYLE, WINDOW_STYLE,
    WM_HOTKEY, WNDCLASSW, EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT, WS_OVERLAPPED,
};

use crate::UserEvent;

static FOCUS_ENABLED: Mutex<bool> = Mutex::new(false);
static HOOK_HANDLE: Mutex<isize> = Mutex::new(0);
static CUSTOM_HOTKEYS: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());

const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
const VK_ESCAPE: u32 = 0x1B;
const VK_H: u32 = 0x48;
const VK_X: u32 = 0x58;
const VK_Q: u32 = 0x51;

fn default_hotkeys() -> Vec<(i32, &'static str, u32, u32)> {
    vec![
        (1, "panic", MOD_CONTROL | MOD_ALT, VK_ESCAPE),
        (2, "toggle-overlay", MOD_CONTROL | MOD_ALT, VK_H),
        (3, "close-overlay", MOD_CONTROL | MOD_ALT | MOD_SHIFT, VK_X),
        (4, "quit", MOD_CONTROL | MOD_ALT | MOD_SHIFT, VK_Q),
    ]
}

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
        for (id, name, mods, vk) in default_hotkeys() {
            let ok = RegisterHotKey(hwnd, id, HOT_KEY_MODIFIERS(mods), vk).is_ok();
            println!(
                "[hotkey] {name} (id={id}): {}",
                if ok { "已注册" } else { "注册失败（可能被占用）" }
            );
        }
        for (id, accel) in CUSTOM_HOTKEYS.lock().map(|v| v.clone()).unwrap_or_default() {
            let (mods, vk) = parse_accel(&accel);
            let _ = RegisterHotKey(hwnd, id as i32, HOT_KEY_MODIFIERS(mods), vk);
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnregisterHotKey(hwnd, 0);
    });
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_HOTKEY {
        let id = w.0 as i32;
        let name = default_hotkeys()
            .into_iter()
            .find(|(i, _, _, _)| *i == id)
            .map(|(_, n, _, _)| n.to_string())
            .unwrap_or_else(|| format!("custom#{id}"));
        crate::win::emit_event(UserEvent::Hotkey(name));
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, w, l)
}

fn parse_accel(accel: &str) -> (u32, u32) {
    let mut mods = 0u32;
    let mut vk = 0u32;
    for part in accel.split('+') {
        match part.trim().to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "alt" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            other if other.len() == 1 => vk = other.to_ascii_uppercase().as_bytes()[0] as u32,
            _ => (),
        }
    }
    (mods, vk)
}

pub fn set_hotkeys(list: &Value) -> bool {
    let mut out = Vec::new();
    let mut next_id = 100u32;
    if let Some(arr) = list.as_array() {
        for item in arr {
            let name = item
                .get("accel")
                .and_then(|x| x.as_str())
                .or_else(|| item.as_str())
                .unwrap_or("");
            if name.is_empty() {
                continue;
            }
            out.push((next_id, name.to_string()));
            next_id += 1;
        }
    }
    if let Ok(mut g) = CUSTOM_HOTKEYS.lock() {
        *g = out.clone();
    }
    println!("[hotkey] 自定义热键记录 {} 条（下次启动生效）", out.len());
    true
}

/* ───────────── 前台窗口钩子 ───────────── */

pub fn spawn_focus_hook() {
    std::thread::spawn(|| unsafe {
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
            return;
        }
        if let Ok(mut g) = HOOK_HANDLE.lock() {
            *g = hook.0 as isize;
        }
        println!("[hook] 前台窗口钩子已安装（默认关闭，hook.focus 开启推送）");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
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

pub fn set_focus_hook(enable: bool) {
    if let Ok(mut g) = FOCUS_ENABLED.lock() {
        *g = enable;
    }
    println!("[hook] 焦点监听 {}", if enable { "开" } else { "关" });
}
