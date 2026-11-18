//! Remaps the mouse's side buttons (Back and Forward).
//!
//! A low-level mouse hook watches XBUTTON presses. Each side button can keep its
//! normal job, send a key combination or a short macro, click the left button
//! automatically while it is held, or do nothing. The settings page is the notch's
//! Mouse panel (src/MousePanel.tsx). The hook lives on its own thread with its own
//! message loop and only does quick work; macros run on separate threads.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, SetWindowsHookExW,
    TranslateMessage, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, WH_MOUSE_LL, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct ButtonConfig {
    /// `default`, `copy`, `paste`, `cut`, `undo`, `macro`, `autoclick` or `disable`.
    pub mode: String,
    /// The macro steps (`macro`) or the click interval in milliseconds (`autoclick`).
    #[serde(default)]
    pub steps: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct MapperConfig {
    pub enabled: bool,
    pub back: ButtonConfig,
    pub forward: ButtonConfig,
}

static CONFIG: OnceLock<Mutex<MapperConfig>> = OnceLock::new();
static HOOK_STARTED: AtomicBool = AtomicBool::new(false);
static LAST_BUTTON: AtomicU32 = AtomicU32::new(0);
static CLICK_BACK: AtomicBool = AtomicBool::new(false);
static CLICK_FORWARD: AtomicBool = AtomicBool::new(false);

fn config() -> &'static Mutex<MapperConfig> {
    CONFIG.get_or_init(|| Mutex::new(MapperConfig::default()))
}

/// Applies new settings and starts the hook the first time the mapper is enabled.
#[tauri::command]
pub fn mouse_mapper_apply(config_in: MapperConfig) {
    let enabled = config_in.enabled;
    if let Ok(mut current) = config().lock() {
        *current = config_in;
    }
    if !enabled {
        CLICK_BACK.store(false, Ordering::Relaxed);
        CLICK_FORWARD.store(false, Ordering::Relaxed);
    } else if !HOOK_STARTED.swap(true, Ordering::Relaxed) {
        std::thread::spawn(run_hook_thread);
    }
}

/// The side button pressed last: 1 Back, 2 Forward, 0 none yet.
#[tauri::command]
pub fn mouse_mapper_last_button() -> u32 {
    LAST_BUTTON.load(Ordering::Relaxed)
}

fn run_hook_thread() {
    unsafe {
        let mut message = MSG::default();
        // Make sure the thread has a message queue before the hook goes in.
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        if SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0).is_err() {
            crate::diagnostics::record("mouse_mapper", "hook install failed");
            HOOK_STARTED.store(false, Ordering::Relaxed);
            return;
        }
        crate::diagnostics::record("mouse_mapper", "installed");
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && (wparam.0 == WM_XBUTTONDOWN as usize || wparam.0 == WM_XBUTTONUP as usize) {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let injected = info.flags & 1 != 0;
        let button = (info.mouseData >> 16) & 0xFFFF;
        if !injected && (button == 1 || button == 2) {
            let down = wparam.0 == WM_XBUTTONDOWN as usize;
            if down {
                LAST_BUTTON.store(button, Ordering::Relaxed);
            }
            if handle_button(button, down) {
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Returns true when the press or release was taken over (it must not reach the app).
fn handle_button(button: u32, down: bool) -> bool {
    let Ok(current) = config().lock() else {
        return false;
    };
    if !current.enabled {
        return false;
    }
    let mapping = if button == 1 {
        current.back.clone()
    } else {
        current.forward.clone()
    };
    drop(current);

    match mapping.mode.as_str() {
        "copy" | "paste" | "cut" | "undo" | "macro" => {
            if down {
                let steps = match mapping.mode.as_str() {
                    "copy" => "ctrl+c".to_string(),
                    "paste" => "ctrl+v".to_string(),
                    "cut" => "ctrl+x".to_string(),
                    "undo" => "ctrl+z".to_string(),
                    _ => mapping.steps,
                };
                std::thread::spawn(move || run_steps(&steps));
            }
            true
        }
        "autoclick" => {
            let flag = if button == 1 {
                &CLICK_BACK
            } else {
                &CLICK_FORWARD
            };
            if down {
                if !flag.swap(true, Ordering::Relaxed) {
                    let interval = mapping.steps.trim().parse::<u64>().unwrap_or(50).max(10);
                    std::thread::spawn(move || {
                        while flag.load(Ordering::Relaxed) {
                            click(false);
                            std::thread::sleep(Duration::from_millis(interval));
                        }
                    });
                }
            } else {
                flag.store(false, Ordering::Relaxed);
            }
            true
        }
        "disable" => true,
        _ => false,
    }
}

// ---------- macros ----------

fn run_steps(steps: &str) {
    for raw in steps.split(';') {
        let step = raw.trim();
        if step.is_empty() {
            continue;
        }
        let low = step.to_lowercase();
        if low.starts_with("text:") {
            type_text(&step[5..]);
        } else if low.starts_with("wait") {
            let ms = step[4..]
                .trim_matches(|c| c == ' ' || c == ':')
                .parse::<u64>()
                .unwrap_or(0);
            if ms > 0 {
                std::thread::sleep(Duration::from_millis(ms.min(60_000)));
            }
        } else if low == "click" || low == "klik" {
            click(false);
        } else if low == "rclick" {
            click(true);
        } else {
            press_combo(step);
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

fn send(inputs: &[INPUT]) {
    unsafe {
        SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

fn click(right: bool) {
    let (down, up) = if right {
        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
    } else {
        (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    };
    let make = |flags| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send(&[make(down), make(up)]);
}

fn key_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn is_extended(vk: u16) -> bool {
    matches!(
        vk,
        0x2D | 0x2E | 0x24 | 0x23 | 0x21 | 0x22 | 0x26 | 0x28 | 0x25 | 0x27 | 0x5B | 0x5C | 0x2C
    )
}

fn key_event(vk: u16, up: bool) {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if is_extended(vk) {
        flags = flags | KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags = flags | KEYEVENTF_KEYUP;
    }
    send(&[key_input(vk, 0, flags)]);
}

fn type_text(text: &str) {
    for unit in text.encode_utf16() {
        send(&[
            key_input(0, unit, KEYEVENTF_UNICODE),
            key_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
        ]);
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// A virtual-key code for a key name such as `f`, `f5`, `esc` or `pgdn`.
fn parse_vk(name: &str) -> Option<u16> {
    let t = name.trim().to_lowercase();
    let alias = match t.as_str() {
        "ctrl" | "control" => Some(0x11),
        "alt" => Some(0x12),
        "shift" => Some(0x10),
        "win" => Some(0x5B),
        "esc" | "escape" => Some(0x1B),
        "enter" | "return" => Some(0x0D),
        "del" | "delete" => Some(0x2E),
        "ins" | "insert" => Some(0x2D),
        "pgup" | "pageup" => Some(0x21),
        "pgdn" | "pagedown" => Some(0x22),
        "space" | "spasi" => Some(0x20),
        "backspace" => Some(0x08),
        "tab" => Some(0x09),
        "up" => Some(0x26),
        "down" => Some(0x28),
        "left" => Some(0x25),
        "right" => Some(0x27),
        "home" => Some(0x24),
        "end" => Some(0x23),
        "plus" => Some(0xBB),
        "minus" => Some(0xBD),
        "comma" => Some(0xBC),
        "period" => Some(0xBE),
        "printscreen" => Some(0x2C),
        "capslock" => Some(0x14),
        "volumeup" => Some(0xAF),
        "volumedown" => Some(0xAE),
        "mute" => Some(0xAD),
        "playpause" => Some(0xB3),
        "nexttrack" => Some(0xB0),
        "prevtrack" => Some(0xB1),
        _ => None,
    };
    if alias.is_some() {
        return alias;
    }
    let mut chars = t.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_digit() || c.is_ascii_lowercase() {
            return Some(c.to_ascii_uppercase() as u16);
        }
    }
    if let Some(number) = t.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&number) {
            return Some(0x70 + number - 1);
        }
    }
    None
}

/// Presses `ctrl+shift+esc`-style combinations: every part but the last is held.
fn press_combo(combo: &str) {
    let parts: Vec<&str> = combo.split('+').collect();
    let Some((main_name, modifier_names)) = parts.split_last() else {
        return;
    };
    let Some(main) = parse_vk(main_name) else {
        return;
    };
    let modifiers: Vec<u16> = modifier_names.iter().filter_map(|n| parse_vk(n)).collect();
    for m in &modifiers {
        key_event(*m, false);
        std::thread::sleep(Duration::from_millis(5));
    }
    key_event(main, false);
    std::thread::sleep(Duration::from_millis(15));
    key_event(main, true);
    for m in modifiers.iter().rev() {
        std::thread::sleep(Duration::from_millis(5));
        key_event(*m, true);
    }
}
