//! "Bloom Files": a glass file browser window.
//!
//! The window itself is declared in tauri.conf.json (label `files`). This module
//! lists folders, opens files, stores the window's settings, and applies the
//! acrylic "smoked glass" backdrop whose darkness is the user's opacity setting.

use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::utils::get_setting_str;

const KEY_OPACITY: &str = "bloom-files-opacity";
const KEY_MONO: &str = "bloom-files-mono-icons";
const KEY_HIDDEN: &str = "bloom-files-show-hidden";
const KEY_FAVORITES: &str = "bloom-files-favorites";
const DEFAULT_OPACITY: u32 = 60;

#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub modified: Option<i64>,
}

#[derive(Serialize)]
pub struct Place {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Favorite {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct FilesConfig {
    pub opacity: u32,
    pub mono_icons: bool,
    pub show_hidden: bool,
    pub favorites: Vec<Favorite>,
}

fn setting_bool(app: &AppHandle, key: &str, default: bool) -> bool {
    match get_setting_str(app, key).as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

pub fn config(app: &AppHandle) -> FilesConfig {
    FilesConfig {
        opacity: get_setting_str(app, KEY_OPACITY)
            .and_then(|v| v.parse::<u32>().ok())
            .map(|v| v.min(100))
            .unwrap_or(DEFAULT_OPACITY),
        mono_icons: setting_bool(app, KEY_MONO, true),
        show_hidden: setting_bool(app, KEY_HIDDEN, false),
        favorites: get_setting_str(app, KEY_FAVORITES)
            .and_then(|v| serde_json::from_str::<Vec<Favorite>>(&v).ok())
            .unwrap_or_default(),
    }
}

/// Blurred glass backdrop. On current Windows 11 the system backdrop ignores a
/// tint colour, so the smoky darkness is drawn by the page (CSS) instead and
/// follows the opacity slider live. Only Windows 10 uses the tint below.
pub fn apply_glass(app: &AppHandle) {
    let Some(win) = app.get_webview_window("files") else {
        return;
    };
    #[cfg(target_os = "windows")]
    {
        let _ = window_vibrancy::clear_acrylic(&win);
        let _ = window_vibrancy::apply_acrylic(&win, Some((12, 12, 14, 40)));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win;
    }
}

fn list_dir(path: &str, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;

    let read = std::fs::read_dir(path).map_err(|e| format!("{path}: {e}"))?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !show_hidden && meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        entries.push(FsEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified,
        });
    }
    Ok(entries)
}

#[tauri::command]
pub async fn files_list_dir(path: String, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir(&path, show_hidden))
        .await
        .map_err(|e| e.to_string())?
}

/// Well-known folders followed by the drives.
#[tauri::command]
pub async fn files_places() -> Vec<Place> {
    tauri::async_runtime::spawn_blocking(|| {
        let ids: Vec<String> = ["desktop", "downloads", "documents", "pictures", "music", "videos"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut places: Vec<Place> = crate::dock_extras::list_known_folders(&ids)
            .into_iter()
            .map(|e| Place {
                name: e.name,
                path: e.path,
                kind: "folder".into(),
            })
            .collect();
        places.extend(crate::dock_extras::list_drives().into_iter().map(|e| Place {
            name: e.name,
            path: e.path,
            kind: "drive".into(),
        }));
        places
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn files_open(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::dock_extras::shell_execute(&path, None, "open"))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn files_get_config(app: AppHandle) -> FilesConfig {
    config(&app)
}

/// Remember the glass opacity (0-100). The page applies it live by itself.
#[tauri::command]
pub fn files_set_opacity(app: AppHandle, opacity: u32) -> Result<(), String> {
    crate::commands::save_setting(
        app,
        KEY_OPACITY.into(),
        serde_json::Value::String(opacity.min(100).to_string()),
    )
}

#[tauri::command]
pub fn files_set_flag(app: AppHandle, name: String, value: bool) -> Result<(), String> {
    let key = match name.as_str() {
        "mono_icons" => KEY_MONO,
        "show_hidden" => KEY_HIDDEN,
        _ => return Err(format!("unknown flag {name}")),
    };
    crate::commands::save_setting(app, key.into(), serde_json::Value::String(value.to_string()))
}

#[tauri::command]
pub fn files_set_favorites(app: AppHandle, favorites: Vec<Favorite>) -> Result<(), String> {
    let json = serde_json::to_string(&favorites).map_err(|e| e.to_string())?;
    crate::commands::save_setting(app, KEY_FAVORITES.into(), serde_json::Value::String(json))
}

#[tauri::command]
pub fn open_files_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("files") {
        apply_glass(&app);
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
