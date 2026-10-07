// OpenCode Chat desktop shell: a native window around the opencode-chat
// server, which runs as a sidecar (the Node single-executable built by
// ../../build-exe.mjs). The window shows a splash until the server reports
// its URL on stdout, then navigates to it. Closing the window stops the
// server, which in turn stops opencode.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// Fixed so the UI keeps the same origin (and so its saved settings) between
// launches. The server falls back to a free port if this one is taken.
const WEB_PORT: &str = "47821";

struct Server(Mutex<Option<CommandChild>>);

fn updater_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    let mut builder = tauri_plugin_updater::Builder::new();
    if let Some(token) = option_env!("UPDATE_TOKEN") {
        builder = builder
            .header("Authorization", format!("Bearer {token}"))
            .expect("UPDATE_TOKEN contains invalid header characters");
    }
    builder.build()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        // Silent background updates from our GitHub releases feed
        // (see plugins.updater in tauri.conf.json). The frontend drives
        // check/download/install via JS so it can show progress.
        // The repo is private, so the feed needs a read-only token: it is
        // baked in at build time via the UPDATE_TOKEN env var (CI sets it
        // from secrets; local builds simply omit it and skip auth).
        .plugin(updater_plugin())
        .plugin(tauri_plugin_process::init())
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            let opener = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("OpenCode Chat")
                .inner_size(1200.0, 820.0)
                .min_inner_size(420.0, 500.0)
                // Sign-in pages and external links open in the user's browser,
                // where they are already logged in.
                .on_new_window(move |url, _features| {
                    let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    NewWindowResponse::Deny
                })
                .build()?;

            let (mut events, child) = app
                .shell()
                .sidecar("opencode-chat-server")?
                .args(["--sidecar", "--web-port", WEB_PORT])
                .spawn()?;
            *app.state::<Server>().0.lock().unwrap() = Some(child);

            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let line = String::from_utf8_lossy(&line);
                            if let Some(url) = line.trim().strip_prefix("LISTENING ") {
                                if let Ok(url) = Url::parse(url) {
                                    let _ = window.navigate(url);
                                }
                            }
                        }
                        CommandEvent::Terminated(_) => {
                            let _ = window.eval(
                                "var m=document.getElementById('msg');if(m)m.textContent='OpenCode Chat could not start. See %LOCALAPPDATA%\\\\OpenCodeChat\\\\opencode-chat.log';",
                            );
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OpenCode Chat");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let child = handle.state::<Server>().0.lock().unwrap().take();
            if let Some(mut child) = child {
                // Ask the server to stop opencode and exit; kill it if it lingers.
                let _ = child.write(b"quit\n");
                std::thread::sleep(Duration::from_millis(800));
                let _ = child.kill();
            }
        }
    });
}
