# OpenCode Chat

**A polished, ChatGPT-style desktop client for [opencode](https://opencode.ai) — with free models out of the box and real document generation.**

Chat with frontier models through your OpenCode Zen account, ChatGPT Plus/Pro, GitHub Copilot, or any API key — and ask the assistant to produce production-ready **PDFs, Word documents, Excel workbooks, PowerPoint decks, and charts**, delivered as download links directly in the conversation.

> This repository contains the complete source for the OpenCode Chat Windows application: React web UI, Node.js backend server, and Tauri desktop shell.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?logo=windows&logoColor=white)](desktop/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-FFC131?logo=tauri&logoColor=black)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](web/)
[![Built on opencode](https://img.shields.io/badge/built%20on-opencode-black)](https://opencode.ai)

---

## Table of Contents

- [Overview](#overview)
- [Key Capabilities](#key-capabilities)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Document Generation](#document-generation)
- [Desktop Application](#desktop-application)
- [Building Distributables](#building-distributables)
- [Releasing](#releasing)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Security Notes](#security-notes)
- [License and Acknowledgements](#license-and-acknowledgements)

---

## Overview

OpenCode Chat pairs a modern chat interface with the full power of the opencode execution engine. It is designed for users who want:

1. **A familiar chat experience** — threaded conversations, streaming responses, Markdown with GitHub Flavored Markdown tables, KaTeX mathematics, and syntax-highlighted code blocks.
2. **Model freedom** — start with free models, then connect an OpenCode Zen account or bring existing subscriptions and API keys. Switch models at any time, including mid-conversation.
3. **Actionable output** — go beyond text answers. The assistant writes and executes Python to generate binary documents (PDF, DOCX, XLSX, PPTX, PNG charts) and returns verified download links.
4. **Native desktop integration** — a Tauri shell provides a focused, chromeless window, single-instance behavior, splash screen, and signature-verified automatic updates.

The backend requires zero manual configuration: on first launch it provisions the opencode engine and Python document toolchain automatically.

---

## Key Capabilities

### Conversational Interface

| Capability | Description |
|---|---|
| Threaded chat UI | Sidebar with persistent history, streaming responses, and session sharing via opencode share links. |
| Rich message rendering | GFM tables, KaTeX math, fenced code blocks, and embedded generated images. |
| Two personas | **Chat** — general-purpose assistant with document-building skills. **Agent** — full opencode build agent for engineering tasks. |
| Model picker | Browse and switch models on demand. Supports free-tier models, OpenCode Zen, and custom provider/model identifiers. |
| Guided onboarding | First-run setup flow for connecting accounts; fully skippable for immediate use with free models. |

### Document Generation

| Capability | Description |
|---|---|
| Native file output | PDF (`reportlab`), Word (`python-docx`), Excel (`openpyxl`), PowerPoint (`python-pptx`), charts (`matplotlib`). |
| Zero-install toolchain | Python and all document libraries are provisioned automatically via [`uv`](https://github.com/astral-sh/uv); no user-side Python setup required. |
| Verified delivery | The agent executes the generation script, confirms the artifact exists, then replies with a summary and a `/files/...` download link. |
| Background warm-up | The document environment is pre-warmed after boot so the first document request is fast. |

### Backend and Platform

| Capability | Description |
|---|---|
| Zero-config server | `server.mjs` serves the UI, proxies `/api/*` to `opencode serve` CORS-free, serves artifacts at `/files/*`, and exposes setup at `/setup/*`. |
| Engine lifecycle management | Downloads the opencode binary on first run (~60 MB), reuses an already-running `opencode serve` instance when present, and pins every request to the active workspace. |
| Workspace isolation | Each workspace carries its own agent definition, configuration, generated `files/`, and `scratch/` working area. Stale artifacts (>30 days) are pruned automatically. |
| Desktop shell | Tauri 2 native window with sidecar Node server, single-instance guard, splash screen, and clean shutdown when the window closes. |
| Automatic updates | Signature-verified, one-click in-app updates with progress reporting (desktop builds only). |

---

## Architecture

```text
+---------------------------+      +----------------------+      +---------------+
| Web UI (React + Vite)     | ---> | server.mjs (Node.js) | ---> | opencode      |
| assistant-ui + Tailwind   | <--- |  /api/* proxy        | <--- | serve engine  |
+---------------------------+      |  /files/* artifacts|      +---------------+
                                   |  /setup/* onboarding|
                                   +----------+----------+
                                              |
                                     sidecar process of
                                   +----------+----------+
                                   | Tauri desktop shell |
                                   +---------------------+
```

**Component responsibilities:**

| Component | Role |
|---|---|
| `server.mjs` | Static UI hosting, CORS-free proxy to `opencode serve`, generated-file serving, first-run provisioning, workspace preparation. |
| `web/` | React 19 + Vite frontend built on `assistant-ui`. Compiled output is served from `public/`. |
| `template/` | Workspace seed: `chat-agent.md` persona definition, default `opencode.json`, and the `uv` Python script header. Copied into the workspace on every start. |
| `build-exe.mjs` | Bundles the server and compiled UI into a Node Single-Executable Application (`dist/OpenCodeChat.exe`). |
| `desktop/` | Tauri 2 shell. Launches the server executable as a sidecar, owns the application window, and handles updates. |
| `workspace/` | Development runtime directory (git-ignored). In production builds this resolves to `Documents\OpenCode Chat`. |

---

## Quick Start

### Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18 or later (22 recommended) | Required for development and for `build-exe.mjs` SEA output. |
| npm | Installs server and web dependencies. |
| Rust toolchain | Required only for building the Tauri desktop installer. |
| Windows 10/11 | Primary supported platform for the desktop build and launch scripts. |
| Internet access (first run only) | Downloads the opencode engine (~60 MB) plus Python/document libraries. |

### Run in Development

```sh
# 1. Build the web UI (emits to public/)
cd web && npm install && npm run build && cd ..

# 2. Install server build tooling
npm install

# 3. Start the server
node server.mjs --open        # open in the default browser, uses ./workspace
node server.mjs --app         # open in a chromeless app window instead
```

On Windows, you can also double-click **`start-chat.ps1`** (or `start-chat.bat`).

Then navigate to `http://127.0.0.1:8787`. The onboarding flow appears automatically on first run.

---

## Configuration Reference

Command-line flags and environment variables. Flags take precedence where both are provided.

| Flag / Variable | Default | Description |
|---|---|---|
| `--web-port` / `OPENCODE_CHAT_PORT` | `8787` | Port serving the chat UI. Falls back to a free port if occupied. |
| `--opencode-port` / `OPENCODE_PORT` | `4096` | Port for the managed `opencode serve` instance. Falls back to a free port if occupied. |
| `--workspace` | `./workspace` (dev) · `Documents\OpenCode Chat` (packaged exe) | Workspace root: agent definition, configuration, and generated files. |
| `--open` | — | Open the UI in the default browser after boot. |
| `--app` | — | Open the UI in a chromeless app window with an isolated browser profile. Implied for packaged builds. |
| `--sidecar` | — | Tauri sidecar mode. Reports the URL on stdout and exits on parent shutdown. |
| `OPENCODE_BIN` | Auto-detected | Explicit path to the opencode executable. |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | `opencode` / unset | Forwarded to `opencode serve` as HTTP Basic authentication. |

**Runtime locations (Windows):**

| Path | Purpose |
|---|---|
| `%LOCALAPPDATA%\OpenCodeChat\bin` | Managed opencode and `uv` binaries. |
| `%LOCALAPPDATA%\OpenCodeChat\opencode-chat.log` | Server log (packaged builds). |
| `Documents\OpenCode Chat\files` | Generated documents served at `/files/*`. |
| `Documents\OpenCode Chat\scratch` | Agent working directory for generation scripts. |

---

## Document Generation

Document skills are defined by `template/chat-agent.md`. The workflow is fully autonomous:

1. The user requests a document (e.g., *"Create a quarterly budget spreadsheet"*).
2. The agent writes a Python script to `scratch/<name>.py`, beginning with the mandatory `uv` header from `template/script-header.py` so dependencies resolve automatically.
3. The script is executed with `uv run` (falling back to system Python only if `uv` is unavailable) and must write its output under `files/` with a short, space-free filename.
4. On success, the agent verifies the artifact and replies with a summary plus a Markdown download link, e.g. `[budget-2026.xlsx](/files/budget-2026.xlsx)`. Images are embedded inline.

**Supported output formats:**

| Format | Extension | Library |
|---|---|---|
| Portable Document Format | `.pdf` | `reportlab` (Platypus) |
| Word document | `.docx` | `python-docx` |
| Excel workbook | `.xlsx` | `openpyxl` |
| PowerPoint presentation | `.pptx` | `python-pptx` |
| Charts and figures | `.png` | `matplotlib` (Agg backend, 150 DPI) |
| Plain data | `.csv`, `.txt`, `.md` | Standard library |

To customize assistant behavior, edit `template/chat-agent.md` and restart. The template is re-applied to the workspace on every launch.

---

## Desktop Application

The Tauri shell (`desktop/`) delivers the native Windows experience:

- Native window without browser chrome, with splash screen during engine boot.
- Single-instance enforcement — relaunching focuses the existing window.
- Fixed-port coordination with automatic fallback when the preferred port is in use.
- Clean process teardown: closing the window terminates the sidecar server.

### Automatic Updates

Shortly after launch, desktop builds poll `releases/latest/download/latest.json`. When a newer release is published, the UI presents a one-click **Install & relaunch** banner with progress indication.

All update artifacts are signature-verified against the public key embedded in `tauri.conf.json`. Only releases produced with the matching private key are accepted. Browser-tab sessions never check for updates.

---

## Building Distributables

```sh
npm run build:exe       # Produces dist/OpenCodeChat.exe (server + UI, Node SEA, ~90 MB)
npm run build:desktop   # Rebuilds the exe, stages it as the Tauri sidecar, and
                        # emits the NSIS installer to desktop/src-tauri/target/release/bundle/nsis/
```

Notes:

- `dist/` and Tauri `target/` directories are build outputs and are excluded from version control (see `.gitignore`).
- The desktop build is a per-user NSIS installer and does not require administrator privileges.
- Unsigned binaries will trigger Windows SmartScreen on first launch. Select **More info → Run anyway**.

---

## Releasing

Releases are produced from a local machine to benefit from a warm build cache. The `.github/workflows/release.yml` workflow is retained as a documented manual fallback.

```sh
# 1. Stamp the version consistently
node -e "for (const f of ['package.json','desktop/src-tauri/tauri.conf.json']) { const j=require('./'+f); j.version='1.1.3'; require('fs').writeFileSync(f, JSON.stringify(j,null,2)+'\n'); }"
#    Also update `version` in desktop/src-tauri/Cargo.toml to match.

# 2. Build the web UI, server exe, and desktop installer
cd web && npm run build && cd ..
npm run build:exe
cp dist/OpenCodeChat.exe desktop/src-tauri/binaries/opencode-chat-server-x86_64-pc-windows-msvc.exe
cd desktop && UPDATE_TOKEN="<pat>" npx tauri build && cd ..

# 3. Launch the installed application and complete a smoke test before shipping.

# 4. Package, sign, and generate the update feed (signing key in ~/.tauri, never in git).
#    Refer to .github/workflows/release.yml for the exact signing commands.

# 5. Publish
git commit -am "v1.1.3" && git tag v1.1.3 && git push origin main v1.1.3
gh release create v1.1.3 --title v1.1.3 --notes "..." --draft <assets>
#    Review the draft release, then publish: gh release edit v1.1.3 --draft=false
```

Publishing is what activates the update feed — installed applications poll `releases/latest/download/latest.json`.

**One-time repository setup** (Settings → Secrets → Actions; required only if the CI fallback is revived):

| Secret | Contents |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of the updater private key. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater private key. |

Signing keys reside outside the repository in `~/.tauri/` and must never be committed. If the keys are lost, generate a new pair (`npx tauri signer generate`), update the public key in `tauri.conf.json`, and rotate the secrets. Note that previously installed applications will reject updates signed with a different key.

---

## Testing

```sh
npm test   # node:test smoke suite covering the server HTTP layer and workspace templates
```

Coverage includes health and setup endpoints, static UI serving, `/files/` path-traversal guards, the `/api/*` boot gate, and workspace template integrity. Tests boot a real server instance on ephemeral ports; the opencode engine itself is not required.

---

## Project Structure

```text
opencode-chat/
├── server.mjs             # Backend: UI hosting, /api proxy, /files, /setup
├── build-exe.mjs          # SEA bundler: server + UI -> dist/OpenCodeChat.exe
├── web/                   # React frontend (Vite, assistant-ui, Tailwind CSS)
│   ├── src/               # Application shell, chat thread, model picker, accounts, onboarding
│   └── public/            # Static sources (e.g. favicon)
├── public/                # Compiled UI output (generated via web build)
├── template/              # Workspace seed files
│   ├── chat-agent.md      # "chat" persona definition and file-creation recipe
│   ├── opencode.json      # Default workspace configuration
│   └── script-header.py   # Required uv header for generated Python scripts
├── desktop/               # Tauri shell (splash screen, Rust sidecar launcher)
│   └── src-tauri/
├── test/                  # node:test suites (server, templates)
├── start-chat.ps1/.bat    # Windows development launchers
└── workspace/             # Development runtime directory (git-ignored, auto-created)
```

---

## Troubleshooting

| Symptom | Resolution |
|---|---|
| Windows SmartScreen warning on install | Expected for unsigned builds. Choose **More info → Run anyway**. |
| Stuck on "Downloading the AI engine" | Requires one-time internet access to github.com (~60 MB). Use the on-screen retry control, then inspect `%LOCALAPPDATA%\OpenCodeChat\opencode-chat.log`. |
| Port already in use | The server selects a free port automatically. Tauri coordination uses fixed port `47821` with identical fallback behavior. |
| First document request is slow | Expected. Python and document libraries download on first use; the server pre-warms them in the background after boot. |
| Blank window in the desktop app | The sidecar failed to start. Review the log path above for the underlying error. |
| `node server.mjs` returns 404s | The UI has not been built. Run `cd web && npm install && npm run build`. |

---

## Security Notes

- Packaged applications expose no remote attack surface by default: both the UI and engine bind to loopback (`127.0.0.1`) only.
- Optional HTTP Basic authentication can be forwarded to `opencode serve` via `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`.
- Generated-file serving enforces strict path containment; traversal outside `files/` is rejected.
- Auto-update bundles are Ed25519-signed (Minisign) and verified before installation.
- Signing keys and release tokens are stored outside the repository and must never be committed.

---

## License and Acknowledgements

Distributed under the **MIT License** — see [LICENSE](LICENSE) for the full text.

Built with and upon outstanding open-source software, including [opencode](https://opencode.ai) and [assistant-ui](https://github.com/Yonomitt/assistant-ui). This project is an independent client and is not affiliated with or endorsed by those projects.
