//! WASAPI 系统音频环回采集（对应文档 24：原版 Rust 侧 WASAPI）。
//! IAudioClient 环回共享模式 → IAudioCaptureClient → RMS 电平实时推前端。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceCollection, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};

use crate::UserEvent;

static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn devices() -> Value {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let r: Result<Value, String> = (|| {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| format!("枚举器: {}", e.message()))?;
            let list: IMMDeviceCollection = enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(|e| format!("EnumAudioEndpoints: {}", e.message()))?;
            let count = list.GetCount().map_err(|e| e.message().to_string())?;
            let mut items = Vec::new();
            for i in 0..count {
                if let Ok(dev) = list.Item(i) {
                    let id = dev
                        .GetId()
                        .map(|p| {
                            let s = p.to_string().unwrap_or_default();
                            CoTaskMemFree(Some(p.0 as *const _));
                            s
                        })
                        .unwrap_or_default();
                    items.push(json!({ "index": i, "id": id }));
                }
            }
            Ok(json!({ "count": count, "items": items }))
        })();
        match r {
            Ok(v) => v,
            Err(e) => json!({ "count": 0, "error": e }),
        }
    }
}

pub fn start(_min_level: f32) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let r = unsafe { capture_loop() };
        RUNNING.store(false, Ordering::SeqCst);
        if let Err(e) = r {
            eprintln!("[audio] 采集失败: {e}");
            crate::win::emit_event(UserEvent::AudioError(e));
        }
    });
}

pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
}

unsafe fn capture_loop() -> Result<(), String> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        .map_err(|e| format!("CoCreateInstance: {}", e.message()))?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| format!("GetDefaultAudioEndpoint: {}", e.message()))?;
    let client: IAudioClient = device
        .Activate(CLSCTX_ALL, None)
        .map_err(|e| format!("Activate: {}", e.message()))?;

    let format = client
        .GetMixFormat()
        .map_err(|e| format!("GetMixFormat: {}", e.message()))?;
    let fmt = *format;
    let init = client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
        2_000_000,
        0,
        format,
        None,
    );
    CoTaskMemFree(Some(format as *const _));
    init.map_err(|e| format!("Initialize(loopback): {}", e.message()))?;

    let capture: IAudioCaptureClient = client
        .GetService()
        .map_err(|e| format!("GetService: {}", e.message()))?;
    client.Start().map_err(|e| format!("Start: {}", e.message()))?;

    // WAVEFORMATEX 是 packed 结构，逐字段取值避免未对齐引用
    let bits = { fmt.wBitsPerSample };
    let is_float = bits == 32;
    let channels = { fmt.nChannels }.max(1) as usize;
    println!(
        "[audio] 环回采集已启动（{} ch / {} bit{}）",
        channels,
        bits,
        if is_float { " float" } else { "" }
    );

    while RUNNING.load(Ordering::SeqCst) {
        let mut packet = capture.GetNextPacketSize().unwrap_or(0);
        let mut sum = 0f64;
        let mut count = 0usize;
        while packet > 0 {
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            if capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                .is_err()
            {
                break;
            }
            if frames > 0 && !data.is_null() {
                let samples = frames as usize * channels;
                if is_float {
                    let p = data as *const f32;
                    for i in 0..samples {
                        let v = *p.add(i) as f64;
                        sum += v * v;
                    }
                } else {
                    let p = data as *const i16;
                    for i in 0..samples {
                        let v = (*p.add(i) as f64) / 32768.0;
                        sum += v * v;
                    }
                }
                count += samples;
            }
            let _ = capture.ReleaseBuffer(frames);
            packet = capture.GetNextPacketSize().unwrap_or(0);
        }
        let level = if count > 0 {
            ((sum / count as f64).sqrt() * 100.0).min(100.0) as f32
        } else {
            0.0
        };
        crate::win::emit_event(UserEvent::AudioLevel(level));
        std::thread::sleep(Duration::from_millis(60));
    }

    let _ = client.Stop();
    println!("[audio] 环回采集已停止");
    Ok(())
}
