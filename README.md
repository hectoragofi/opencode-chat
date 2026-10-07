# OpenCode Chat 💬

A ChatGPT-style desktop chat app powered by **[opencode](https://opencode.ai)**.
Free models work out of the box — or connect your OpenCode Zen account, ChatGPT
Plus/Pro, GitHub Copilot, or any API key. The assistant can also **create real
files**: PDFs, Word docs, Excel sheets, PowerPoint decks, and charts.

> **Private project** — this repo is the full source for the OpenCode Chat
> Windows app (web UI + Node server + Tauri desktop shell).

---

## ✨ Features

- **ChatGPT-like UI** — sidebar with chat history, model picker, streaming
  Markdown answers with GFM tables, LaTeX math (KaTeX), and code blocks.
- **Free models by default** — onboarding walks you through connecting an
  account, or skip and just chat.
- **Two personas** — `Chat` (friendly assistant that also builds documents)
  and `Agent` (full opencode build agent).
- **Document creation** — ask for a PDF, `.docx`, `.xlsx`, `.pptx`, or chart
  and get a download link right in the chat. Python tooling (`uv`) is fetched
  automatically; the user installs nothing.
- **Share links** — share any session via opencode's share endpoint.
- **Zero-config backend** — the server downloads/starts `opencode serve` on
  first run, hijacks an already-running instance if there is one, and proxies
  it CORS-free at `/api/*`.
- **Desktop app** — a Tauri shell (native window, no browser chrome) running a
  Node single-executable server as a sidecar. Single-instance, splash screen,
  quits cleanly when the window closes.

## 🏗️ How it works

```
┌─────────────────────────┐      ┌──────────────────────┐      ┌───────────────┐
│  Web UI (React + Vite)  │─────▶│  server.mjs (Node)   │─────▶│ opencode serve │
│  assistant-ui + Tailwind│◀─────│  /api/* proxy        │◀─────│  AI engine     │
└─────────────────────────┘      │  /files/* documents │      └───────────────┘
                                 │  /setup/* onboarding │
                                 └──────────────────────┘
                                            ▲
                                            │ runs as sidecar of
                                 ┌──────────────────────┐
                                 │  Tauri desktop shell │
                                 └──────────────────────┘
```

- `server.mjs` serves the UI, proxies `/api/*` to `opencode serve` (pinning
  every request to the workspace), serves generated files at `/files/*`, and
  exposes first-run setup at `/setup/*`.
- On first run it downloads the opencode engine (~60 MB) and `uv` into
  `%LOCALAPPDATA%\OpenCodeChat`, then warms up the Python document libraries
  in the background so the first PDF doesn't take a minute.
- `template/` is copied into the workspace on start: the `chat` agent
  definition and the `uv` script header it uses.
- `build-exe.mjs` bundles server + UI into a Node single-executable (SEA);
  `desktop/` is the Tauri shell that runs it as a sidecar.

## 🚀 Quick start (development)

**Prerequisites:** Node.js ≥ 18 (22 recommended for the exe build), npm.
Rust toolchain only needed for the desktop installer.

```sh
# 1. Build the web UI (output goes to public/)
cd web && npm install && npm run build && cd ..

# 2. Install the server's build tooling
npm install

# 3. Run it
node server.mjs --open        # browser tab, uses ./workspace
node server.mjs --app         # chromeless app window instead
```

Or on Windows just double-click **`start-chat.ps1`** (or `start-chat.bat`).

Then open `http://127.0.0.1:8787` — onboarding appears on first run.

Useful flags / env vars:

| Flag / env | Default | What it does |
|---|---|---|
| `--web-port` / `OPENCODE_CHAT_PORT` | `8787` | Port for the chat UI |
| `--opencode-port` / `OPENCODE_PORT` | `4096` | Port for `opencode serve` (auto-falls back if taken) |
| `--workspace` | `./workspace` (dev) / `Documents\OpenCode Chat` (exe) | Where chats, agent def, and generated files live |
| `--open` / `--app` / `--sidecar` | — | Open browser tab / app window / Tauri sidecar mode |
| `OPENCODE_BIN` | auto-detected | Explicit path to the opencode executable |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | — | Forwarded to `opencode serve` as basic auth |

## 📦 Building the distributables

```sh
npm run build:exe       # -> dist/OpenCodeChat.exe (server + UI, Node SEA)
npm run build:desktop   # -> desktop installer (Tauri NSIS, per-user, no admin)
```

`npm run build:desktop` rebuilds the exe, copies it in as the Tauri sidecar,
and produces `desktop/src-tauri/target/release/bundle/nsis/*-setup.exe`.

> The committed `dist/` and Tauri `target/` folders are **not** in git
> (see `.gitignore`) — build them locally. `dist/` exes are ~90 MB each.

## 📁 Project structure

```
opencode-chat/
├── server.mjs            # Node server: UI + /api proxy + /files + /setup
├── build-exe.mjs         # Bundles server+UI into dist/OpenCodeChat.exe (SEA)
├── web/                  # React UI (Vite, assistant-ui, Tailwind)
│   ├── src/              # App, chat thread, model picker, accounts, onboarding
│   └── public/           # Static sources (favicon) — copied to public/ on build
├── public/               # Built UI (generated — `cd web && npm run build`)
├── template/             # Copied into the workspace on start
│   ├── chat-agent.md     # The "chat" agent: persona + file-creation recipe
│   ├── opencode.json     # Workspace config (default_agent: chat)
│   └── script-header.py  # uv header every generated Python script must use
├── desktop/              # Tauri shell (splash + Rust sidecar launcher)
│   └── src-tauri/
├── start-chat.ps1 / .bat # Dev launchers (Windows)
└── workspace/            # Dev runtime dir (git-ignored, auto-created)
```

## 🤖 The chat agent & file creation

The magic for "make me a PDF" lives in `template/chat-agent.md`. When the user
asks for a document, the agent writes a Python script to `scratch/` (starting
with the `uv` header from `template/script-header.py`), runs it with
`uv run` (which fetches Python + libs automatically), saves output to
`files/`, and replies with a Markdown link like
`[budget-2026.xlsx](/files/budget-2026.xlsx)` (images are embedded).

Supported outputs: **PDF** (`reportlab`), **Word** (`python-docx`),
**Excel** (`openpyxl`), **PowerPoint** (`python-pptx`), **charts** (`matplotlib`).

To change the assistant's behavior, edit `template/chat-agent.md` and restart —
it's copied into the workspace on every start.

## 🔧 Troubleshooting

| Symptom | Fix |
|---|---|
| Windows SmartScreen warns on the installer | Expected — the exe isn't code-signed. "More info" → "Run anyway". |
| Stuck on "Downloading the AI engine" | Needs internet to github.com once (~60 MB). Retry via the on-screen button; check `%LOCALAPPDATA%\OpenCodeChat\opencode-chat.log`. |
| Port already in use | The server falls back to a free port automatically; the Tauri shell uses fixed port `47821` with the same fallback. |
| First PDF is slow | Normal — Python + libs download on first use. The server warms this up in the background after boot. |
| Blank window in the desktop app | The sidecar failed to start — see the log path above. |
| `node server.mjs` shows 404s | Rebuild the UI: `cd web && npm install && npm run build`. |

## 📝 License

MIT — see [LICENSE](LICENSE). Private repo; do what you like with it internally.
Built on [opencode](https://opencode.ai) and
[assistant-ui](https://github.com/Yonomitt/assistant-ui) ❤️
