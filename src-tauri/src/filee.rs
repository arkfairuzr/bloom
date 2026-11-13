//! Converts shelf files through Filee's command line (see the shelf in src/App.tsx).
//!
//! Filee installs `filee-cli.exe` next to `Filee.exe`, with a `filee` command
//! (`cli\filee.cmd`) that Setup can put on PATH. The CLI is found through that
//! command, the usual install folders, or the `bloom-filee-path` setting.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;

use crate::utils::get_setting_str;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CLI_EXE: &str = "filee-cli.exe";

/// `filee-cli.exe` for a folder, an executable, or the `cli\filee.cmd` shim.
fn cli_from(path: &Path) -> Option<PathBuf> {
    let mut candidates = vec![path.join(CLI_EXE)];
    if let Some(parent) = path.parent() {
        candidates.push(parent.join(CLI_EXE));
        if let Some(grand) = parent.parent() {
            candidates.push(grand.join(CLI_EXE));
        }
    }
    if path.is_file()
        && path
            .file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case(CLI_EXE))
    {
        return Some(path.to_path_buf());
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn find_cli(app: &AppHandle) -> Option<PathBuf> {
    if let Some(custom) = get_setting_str(app, "bloom-filee-path") {
        if let Some(found) = cli_from(Path::new(custom.trim())) {
            return Some(found);
        }
    }

    // The `filee` command, wherever it sits on PATH.
    if let Ok(output) = Command::new("where")
        .arg("filee")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(found) = cli_from(Path::new(line.trim())) {
                return Some(found);
            }
        }
    }

    let mut folders = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        folders.push(PathBuf::from(&local).join("Programs").join("Filee"));
        folders.push(PathBuf::from(&local).join("Filee"));
    }
    if let Ok(files) = std::env::var("ProgramFiles") {
        folders.push(PathBuf::from(files).join("Filee"));
    }
    folders.iter().find_map(|folder| cli_from(folder))
}

fn run(cli: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new(cli)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Couldn't run Filee: {e}"))
}

const NOT_FOUND: &str = "Filee isn't installed, or its `filee` command can't be found";

/// The formats Filee can turn a file of this type into, from `filee formats <ext>`.
fn parse_targets(output: &str) -> Vec<String> {
    let mut lines = output.lines();
    while let Some(line) = lines.next() {
        if line.trim_end().ends_with("converts to:") {
            let next = lines.next().unwrap_or("").trim();
            if next.starts_with('(') {
                return Vec::new();
            }
            return next
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }
    Vec::new()
}

#[tauri::command]
pub async fn filee_targets(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cli = find_cli(&app).ok_or_else(|| NOT_FOUND.to_string())?;
        let ext = Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext.is_empty() {
            return Ok(Vec::new());
        }
        let output = run(&cli, &["formats", &ext])?;
        Ok(parse_targets(&String::from_utf8_lossy(&output.stdout)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Converts one file and returns the files it wrote. With `to_temp` the results go to
/// a fresh temporary folder instead of beside the original, for the caller to save.
#[tauri::command]
pub async fn filee_convert(
    app: AppHandle,
    path: String,
    to: String,
    to_temp: Option<bool>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cli = find_cli(&app).ok_or_else(|| NOT_FOUND.to_string())?;
        let mut args = vec!["convert", path.as_str(), "--to", to.as_str(), "--json"];
        let temp_dir = if to_temp.unwrap_or(false) {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let dir = std::env::temp_dir()
                .join("bloom-filee")
                .join(stamp.to_string());
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            Some(dir.to_string_lossy().to_string())
        } else {
            None
        };
        if let Some(dir) = temp_dir.as_deref() {
            args.push("-o");
            args.push(dir);
        }
        let output = run(&cli, &args)?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(stderr.trim().to_string());
        };
        let files = json["files"].as_array().cloned().unwrap_or_default();
        let outputs: Vec<String> = files
            .iter()
            .flat_map(|f| f["outputs"].as_array().cloned().unwrap_or_default())
            .filter_map(|o| o.as_str().map(|s| s.to_string()))
            .collect();
        if outputs.is_empty() {
            let reason = files
                .iter()
                .find_map(|f| f["error"].as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| "Filee didn't produce a file".to_string());
            return Err(reason);
        }
        Ok(outputs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Moves converted files out of the temporary folder to where the user chose.
/// One file goes to the exact path chosen in a Save dialog; several go into the
/// chosen folder, numbered when a name is taken.
#[tauri::command]
pub async fn filee_save(from: Vec<String>, dest: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(dest);
        let mut saved = Vec::new();
        if from.len() == 1 && !dest.is_dir() {
            std::fs::copy(&from[0], &dest).map_err(|e| format!("Couldn't save: {e}"))?;
            let _ = std::fs::remove_file(&from[0]);
            saved.push(dest.to_string_lossy().to_string());
            return Ok(saved);
        }
        std::fs::create_dir_all(&dest).map_err(|e| format!("Couldn't save: {e}"))?;
        for source in &from {
            let source = Path::new(source);
            let name = source.file_name().ok_or("Bad file name")?;
            let mut target = dest.join(name);
            let mut n = 2;
            while target.exists() {
                let stem = source
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("file");
                let ext = source
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| format!(".{e}"))
                    .unwrap_or_default();
                target = dest.join(format!("{stem} ({n}){ext}"));
                n += 1;
            }
            std::fs::copy(source, &target).map_err(|e| format!("Couldn't save: {e}"))?;
            let _ = std::fs::remove_file(source);
            saved.push(target.to_string_lossy().to_string());
        }
        Ok(saved)
    })
    .await
    .map_err(|e| e.to_string())?
}
