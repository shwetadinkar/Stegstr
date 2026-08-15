pub mod stego;
pub mod stego_crypto;
pub mod stego_dot;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Normalize path: strip file:// prefix if present (e.g. from some dialogs)
fn normalize_path(s: &str) -> &str {
    s.trim_start_matches("file://")
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StegoDecodeResult {
    pub ok: bool,
    pub payload: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StegoEncodeResult {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
fn decode_stego_image(path: String) -> Result<StegoDecodeResult, String> {
    let p = normalize_path(&path);
    match stego::decode(std::path::Path::new(p)) {
        Ok(payload) => {
            let payload_str = match String::from_utf8(payload.clone()) {
                Ok(s) if s.trim_start().starts_with('{') => s,
                _ => format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(&payload)),
            };
            Ok(StegoDecodeResult {
                ok: true,
                payload: Some(payload_str),
                error: None,
            })
        }
        Err(e) => Ok(StegoDecodeResult {
            ok: false,
            payload: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn decode_stego_dot(path: String) -> Result<StegoDecodeResult, String> {
    let p = normalize_path(&path);
    match stego_dot::decode(std::path::Path::new(p)) {
        Ok(payload) => {
            let payload_str = match String::from_utf8(payload.clone()) {
                Ok(s) if s.trim_start().starts_with('{') => s,
                _ => format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(&payload)),
            };
            Ok(StegoDecodeResult {
                ok: true,
                payload: Some(payload_str),
                error: None,
            })
        }
        Err(e) => Ok(StegoDecodeResult {
            ok: false,
            payload: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn encode_stego_image(cover_path: String, output_path: String, payload: String) -> Result<StegoEncodeResult, String> {
    let cover = normalize_path(&cover_path);
    let output = normalize_path(&output_path);
    let payload_bytes: Vec<u8> = if payload.starts_with("base64:") {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim_start_matches("base64:").as_bytes())
            .map_err(|e| e.to_string())?
    } else {
        payload.into_bytes()
    };
    let encode_result = stego::encode(std::path::Path::new(cover), &payload_bytes);
    match encode_result {
        Ok(png_bytes) => {
            std::fs::write(output, png_bytes).map_err(|e| e.to_string())?;
            Ok(StegoEncodeResult {
                ok: true,
                path: Some(output.to_string()),
                error: None,
            })
        }
        Err(e) => Ok(StegoEncodeResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn encode_stego_dot(cover_path: String, output_path: String, payload: String) -> Result<StegoEncodeResult, String> {
    let cover = normalize_path(&cover_path);
    let output_raw = normalize_path(&output_path);
    let output_path_buf = std::path::Path::new(output_raw).with_extension("png");
    let output = output_path_buf.to_string_lossy().to_string();
    let payload_bytes: Vec<u8> = if payload.starts_with("base64:") {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim_start_matches("base64:").as_bytes())
            .map_err(|e| e.to_string())?
    } else {
        payload.into_bytes()
    };
    let encode_result = stego_dot::encode(std::path::Path::new(cover), &payload_bytes);
    match encode_result {
        Ok(png_bytes) => {
            std::fs::write(output.clone(), png_bytes).map_err(|e| e.to_string())?;
            let sig = std::fs::read(&output).map_err(|e| e.to_string())?;
            if sig.len() < 8 || sig[..8] != [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
                return Ok(StegoEncodeResult {
                    ok: false,
                    path: None,
                    error: Some("Dot encoder output is not PNG".to_string()),
                });
            }
            Ok(StegoEncodeResult {
                ok: true,
                path: Some(output.to_string()),
                error: None,
            })
        }
        Err(e) => Ok(StegoEncodeResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn check_png_signature(path: String) -> Result<bool, String> {
    let p = normalize_path(&path);
    let sig = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(sig.len() >= 8 && sig[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

#[tauri::command]
fn get_dot_capacity(path: String) -> Result<usize, String> {
    let p = normalize_path(&path);
    stego_dot::max_payload_bytes(std::path::Path::new(p))
}
#[tauri::command]
fn stegstr_log(
    level: String,
    action: String,
    message: String,
    details: Option<String>,
    error: Option<String>,
    stack: Option<String>,
) -> Result<(), String> {
    use std::io::Write;
    let log_dir = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .ok_or("no log dir")?
        .join("Stegstr");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("stegstr.log");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let line = serde_json::json!({
        "ts": ts,
        "level": level,
        "action": action,
        "message": message,
        "details": details,
        "error": error,
        "stack": stack,
    });
    writeln!(file, "{}", line).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_exchange_path() -> Result<String, String> {
    let dir = std::env::temp_dir().join("stegstr-test-exchange");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("exchange.png").to_string_lossy().to_string())
}

#[tauri::command]
fn get_exchange_path_qim() -> Result<String, String> {
    let dir = std::env::temp_dir().join("stegstr-test-exchange");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("exchange.jpg").to_string_lossy().to_string())
}

#[tauri::command]
fn get_test_profile() -> Option<String> {
    std::env::var("STEGSTR_TEST_PROFILE").ok().filter(|s| !s.is_empty())
}

#[tauri::command]
fn get_desktop_path() -> Result<String, String> {
    dirs::desktop_dir()
        .and_then(|p| p.into_os_string().into_string().ok())
        .ok_or_else(|| "Could not get Desktop path".to_string())
}

// The QIM Python shim used to live here and has been removed.
//
// `encode_stego_qim` / `decode_stego_qim` shelled out to
// channel_simulator/qim_cli.py, resolved through env!("CARGO_MANIFEST_DIR") --
// the BUILD machine's directory. Every installed copy therefore looked for the
// script under the CI runner's path and failed, and it also required Python
// with jpeglib, reedsolo and numpy on the user's machine. No distributed build
// could ever have worked.
//
// QIM now runs in TypeScript in the webview, which is the same code path the
// browser build and the tests use, so there is one implementation rather than
// two and no Python dependency. Deleted rather than left unused so it cannot
// be revived by accident, and so the misleading "QIM script not found" string
// no longer ships.

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = path;
    }
    Ok(())
}

/// Read a file as base64.
///
/// The desktop build now runs the SAME TypeScript QIM encoder as the browser,
/// rather than shelling out to a Python script. The old path could never work
/// in a distributed build: it resolved `qim_cli.py` through
/// `env!("CARGO_MANIFEST_DIR")`, which bakes in the BUILD machine's directory,
/// so every installed copy looked for the script under the CI runner's
/// `D:\a\Stegstr\Stegstr\` and failed. It also required Python with jpeglib,
/// reedsolo and numpy on the user's machine.
///
/// Base64 rather than raw bytes because it crosses the JS bridge as JSON.
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(normalize_path(&path)).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Write base64 data to a path. Counterpart to read_file_base64.
#[tauri::command]
fn write_file_base64(path: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("bad base64: {}", e))?;
    std::fs::write(normalize_path(&path), bytes).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            decode_stego_image,
            encode_stego_image,
            decode_stego_dot,
            encode_stego_dot,
            get_dot_capacity,
            check_png_signature,
            get_desktop_path,
            get_test_profile,
            get_exchange_path,
            get_exchange_path_qim,
            reveal_in_finder,
            read_file_base64,
            write_file_base64,
            stegstr_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
