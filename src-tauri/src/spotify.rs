//! The one piece of Spotify sign-in the webview cannot do: catching the redirect.
//!
//! Spotify's authorization-code flow ends by sending the browser to
//! `http://127.0.0.1:<port>/callback?code=...`. The notch opens the Spotify page in
//! the user's browser and then asks this listener for the query of that redirect.
//! Everything else (the token exchange, the queue request) runs in the webview.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

const PAGE: &str = "<html><head><meta charset=\"utf-8\"><title>Bloom</title></head>\
<body style=\"font-family:Segoe UI,sans-serif;background:#111;color:#eee;display:flex;\
align-items:center;justify-content:center;height:100vh;margin:0\">\
<div>Spotify is connected to Bloom. You can close this tab.</div></body></html>";

/// Waits up to three minutes for the redirect and returns its query string.
#[tauri::command]
pub async fn spotify_auth_listen(port: u16) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .map_err(|e| format!("Couldn't listen on port {port}: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let started = Instant::now();
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                    let mut buffer = [0u8; 4096];
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]);
                    let target = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("");
                    // Browsers also ask for /favicon.ico; only the callback counts.
                    let Some(query) = target.strip_prefix("/callback?") else {
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        continue;
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                        PAGE.len(),
                        PAGE
                    );
                    let _ = stream.write_all(response.as_bytes());
                    return Ok(query.to_string());
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if started.elapsed() > Duration::from_secs(180) {
                        return Err("Spotify sign-in timed out".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
