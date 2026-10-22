//! Position of the floating clock window (see src/Clock.tsx).

use tauri::{AppHandle, Manager};

/// Flush with the right edge of the primary monitor, vertically centred, the
/// spot the brightness HUD used to occupy.
#[tauri::command]
pub fn position_clock_window(app: AppHandle) {
    let Some(win) = app.get_webview_window("clock") else {
        return;
    };
    let (Ok(Some(monitor)), Ok(size)) = (win.primary_monitor(), win.outer_size()) else {
        return;
    };
    let origin = monitor.position();
    let screen = monitor.size();
    let x = origin.x + screen.width as i32 - size.width as i32;
    let y = origin.y + (screen.height as i32 - size.height as i32) / 2;
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}
