// opencode-chat server — runs (or hijacks) `opencode serve` and exposes a
// ChatGPT-style web UI plus a CORS-free proxy at /api/*.
//
// Runs two ways:
//   - dev:  node server.mjs [--web-port 8787] [--opencode-port 4096] [--open] [--app]
//   - exe:  OpenCodeChat.exe (Node single-executable build, see build-exe.mjs).
//           Assets are embedded, opencode is downloaded on first run, the UI
//           opens in its own app window and the server quits when it closes.
// Env:
//   OPENCODE_SERVER_PASSWORD / OPENCODE_SERVER_USERNAME (forwarded to opencode)
//   OPENCODE_BIN (explicit path to opencode executable)

import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawn, execFile, execFileSync } from "node:child_process";

const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

let sea = null;
try {
  sea = require("node:sea");
  if (!sea.isSea()) sea = null;
} catch {
  sea = null;
}
const IS_EXE = !!sea;

// In the exe there is no source tree; in dev everything is next to this file.
// path.normalize keeps separators consistent so the startsWith() guard in
// readBundled() works on Windows (mixed / and \ never match).
const SOURCE_DIR = path.normalize(
  IS_EXE ? path.dirname(process.execPath) : path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
);
const APP_DATA = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "OpenCodeChat");
fs.mkdirSync(APP_DATA, { recursive: true });

// Read a bundled file: an embedded SEA asset in the exe, a file on disk in dev.
function readBundled(rel) {
  if (IS_EXE) {
    try {
      return Buffer.from(sea.getAsset(rel));
    } catch {
      return null;
    }
  }
  const file = path.normalize(path.join(SOURCE_DIR, rel));
  if (!file.startsWith(SOURCE_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  return fs.readFileSync(file);
}

if (IS_EXE) {
  // GUI-subsystem exe has no console; keep a log next to the app data.
  const logStream = fs.createWriteStream(path.join(APP_DATA, "opencode-chat.log"), { flags: "w" });
  const write = (...a) => logStream.write(a.map(String).join(" ") + "\n");
  console.log = write;
  console.error = write;
}

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PREFERRED_WEB_PORT = Number(opt("--web-port", process.env.OPENCODE_CHAT_PORT || 8787));
const PREFERRED_OPENCODE_PORT = Number(opt("--opencode-port", process.env.OPENCODE_PORT || 4096));
const OPENCODE_HOST = "127.0.0.1";
const SHOULD_OPEN = args.includes("--open");
// --sidecar: launched by the Tauri desktop shell, which owns the window. We
// report our URL on stdout and quit when told to (or when the shell goes away).
const SIDECAR = args.includes("--sidecar");
const APP_WINDOW = !SIDECAR && (IS_EXE || args.includes("--app"));

// opencode runs in the workspace: it holds the "chat" agent definition
// (.opencode/agent) and the files it generates (files/), served at /files/*.
const WORKSPACE_DIR = path.resolve(
  opt("--workspace", IS_EXE ? path.join(os.homedir(), "Documents", "OpenCode Chat") : path.join(SOURCE_DIR, "workspace")),
);
const FILES_DIR = path.join(WORKSPACE_DIR, "files");

function prepareWorkspace() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, "scratch"), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, ".opencode", "agent"), { recursive: true });
  const agent = readBundled("template/chat-agent.md");
  if (agent) fs.writeFileSync(path.join(WORKSPACE_DIR, ".opencode", "agent", "chat.md"), agent);
  const config = path.join(WORKSPACE_DIR, "opencode.json");
  const tpl = readBundled("template/opencode.json");
  if (tpl && !fs.existsSync(config)) fs.writeFileSync(config, tpl);
}

const SERVER_USER = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const SERVER_PASS = process.env.OPENCODE_SERVER_PASSWORD || "";
const BASIC_AUTH = SERVER_PASS
  ? "Basic " + Buffer.from(`${SERVER_USER}:${SERVER_PASS}`).toString("base64")
  : null;

let opencodePort = PREFERRED_OPENCODE_PORT;
let child = null;

// Shown by the onboarding screen while opencode is fetched / booted.
const setup = { phase: "starting", progress: 0, message: "Starting…", error: null };
const setPhase = (phase, message, progress = 0) => Object.assign(setup, { phase, message, progress });

/* ---------------- locating / installing opencode ---------------- */

const EXE_NAME = process.platform === "win32" ? "opencode.exe" : "opencode";
const MANAGED_BIN_DIR = path.join(APP_DATA, "bin");

function findOpencodeExe() {
  const candidates = [
    process.env.OPENCODE_BIN,
    path.join(path.dirname(process.execPath), EXE_NAME), // shipped next to the exe
    path.join(MANAGED_BIN_DIR, EXE_NAME), // downloaded on a previous run
    path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(os.homedir(), ".npm-global", "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(os.homedir(), ".opencode", "bin", EXE_NAME),
    "/usr/local/bin/opencode",
    path.join(os.homedir(), ".local", "bin", "opencode"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* ignore */ }
  }
  return whereIs(EXE_NAME);
}

function whereIs(exeName) {
  try {
    const lookup = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(lookup, [exeName], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.toLowerCase().endsWith(exeName)).shift();
    return first && fs.existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "user-agent": "opencode-chat" } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 8) {
          res.resume();
          resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`download failed: HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers["content-length"]) || 0;
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on("data", (c) => {
          got += c.length;
          if (total) onProgress(got / total);
        });
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return p;
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    }
  }
  return null;
}

// Downloads a release zip and installs the named exe from it into
// MANAGED_BIN_DIR. Windows only (uses the tar.exe that ships with Windows 10+).
async function installFromZip(url, exeName, onProgress) {
  const tmpDir = path.join(APP_DATA, "download", exeName);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const zip = path.join(tmpDir, "download.zip");
  console.log(`[opencode-chat] downloading ${url}`);
  await download(url, zip, onProgress);
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  await new Promise((resolve, reject) =>
    execFile(tar, ["-xf", zip, "-C", tmpDir], { windowsHide: true }, (err) => (err ? reject(err) : resolve())),
  );
  const extracted = findFile(tmpDir, exeName);
  if (!extracted) throw new Error(`downloaded archive did not contain ${exeName}`);
  fs.mkdirSync(MANAGED_BIN_DIR, { recursive: true });
  const target = path.join(MANAGED_BIN_DIR, exeName);
  fs.copyFileSync(extracted, target);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return target;
}

async function installOpencode() {
  if (process.platform !== "win32") {
    throw new Error("opencode not found. Install it with: npm i -g opencode-ai");
  }
  const asset = process.arch === "arm64" ? "opencode-windows-arm64.zip" : "opencode-windows-x64.zip";
  setPhase("downloading", "Downloading the AI engine (one time, ~60 MB)…", 0);
  const target = await installFromZip(
    `https://github.com/anomalyco/opencode/releases/latest/download/${asset}`,
    EXE_NAME,
    (p) => (setup.progress = p),
  );
  setPhase("installing", "Installing…", 1);
  return target;
}

// The chat agent makes documents with Python scripts run through `uv`, which
// fetches Python and the libraries itself, so users need nothing installed.
const UV_NAME = process.platform === "win32" ? "uv.exe" : "uv";
async function ensureUv() {
  const managed = path.join(MANAGED_BIN_DIR, UV_NAME);
  const found = fs.existsSync(managed) ? managed : whereIs(UV_NAME);
  if (found) return found;
  if (process.platform !== "win32") return null;
  const asset = process.arch === "arm64" ? "uv-aarch64-pc-windows-msvc.zip" : "uv-x86_64-pc-windows-msvc.zip";
  return installFromZip(`https://github.com/astral-sh/uv/releases/latest/download/${asset}`, UV_NAME, () => {});
}

// Runs a tiny script once so Python and the document libraries are cached
// before the first real request (otherwise the first PDF takes a minute).
function warmUpDocumentTools(uv) {
  const script = path.join(WORKSPACE_DIR, "scratch", "_warmup.py");
  const header = (readBundled("template/script-header.py") || "").toString();
  fs.writeFileSync(script, `${header}\nimport reportlab, docx, openpyxl, pptx, matplotlib\nprint("ok")\n`);
  const started = Date.now();
  execFile(uv, ["run", script], { cwd: WORKSPACE_DIR, windowsHide: true, env: toolEnv() }, (err, _out, stderr) => {
    const secs = Math.round((Date.now() - started) / 1000);
    if (err) console.error(`[opencode-chat] document tools warm-up failed after ${secs}s:`, String(stderr || err.message).slice(-500));
    else console.log(`[opencode-chat] document tools ready (${secs}s)`);
  });
}

// PATH for opencode and its tools, with our downloaded binaries (uv) first.
function toolEnv() {
  const sep = process.platform === "win32" ? ";" : ":";
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  return { ...process.env, [key]: `${MANAGED_BIN_DIR}${sep}${process.env[key] || ""}` };
}

/* ---------------- talking to opencode ---------------- */

function ocFetch(p, { method = "GET", timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (BASIC_AUTH) headers["authorization"] = BASIC_AUTH;
    const req = http.request(
      { hostname: OPENCODE_HOST, port: opencodePort, path: p, method, headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function isOpencodeUp() {
  try {
    const r = await ocFetch("/global/health", { timeoutMs: 2500 });
    return r.status === 200 && JSON.parse(r.body.toString()).healthy === true;
  } catch {
    return false;
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function ensureOpencode() {
  setPhase("starting", "Looking for the AI engine…");
  if (await isOpencodeUp()) {
    console.log(`[opencode-chat] hijacked existing opencode server on port ${opencodePort}`);
    return;
  }
  if (!(await isPortFree(opencodePort))) opencodePort = await freePort();
  const exe = findOpencodeExe() || (await installOpencode());
  setPhase("launching", "Starting the AI engine…", 1);
  console.log(`[opencode-chat] starting: ${exe} serve --port ${opencodePort} --hostname ${OPENCODE_HOST}`);
  child = spawn(exe, ["serve", "--port", String(opencodePort), "--hostname", OPENCODE_HOST], {
    cwd: WORKSPACE_DIR,
    env: toolEnv(),
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  child.on("error", (err) => console.error("[opencode-chat] failed to spawn opencode:", err.message));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[opencode-chat] opencode exited with code ${code}`);
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await isOpencodeUp()) {
      console.log(`[opencode-chat] opencode server is up on port ${opencodePort}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("The AI engine did not start within 60 seconds.");
}

/* ---------------- http ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname === "/") pathname = "/index.html";
  const rel = path.posix.normalize("public" + pathname);
  const body = rel.startsWith("public/") ? readBundled(rel) : null;
  if (!body) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(rel)] || "application/octet-stream",
    "cache-control": rel.startsWith("public/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(body);
}

// Generated files. ?download=1 forces a save dialog; otherwise the browser
// previews what it can (PDF, images, text).
function serveFile(req, res) {
  const url = new URL(req.url, "http://x");
  const rel = decodeURIComponent(url.pathname.replace(/^\/files\//, ""));
  const file = path.normalize(path.join(FILES_DIR, rel));
  if (!file.startsWith(FILES_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("file not found");
    return;
  }
  const name = path.basename(file);
  const disposition = url.searchParams.has("download") ? "attachment" : "inline";
  res.writeHead(200, {
    "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "content-length": fs.statSync(file).size,
    "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
}

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function proxyApi(req, res) {
  if (setup.phase !== "ready") return json(res, 503, { error: "opencode is still starting", setup });
  const target = req.url.replace(/^\/api/, "") || "/";
  const url = new URL(target, `http://${OPENCODE_HOST}:${opencodePort}`);
  const headers = { ...req.headers };
  delete headers["host"];
  delete headers["connection"];
  if (BASIC_AUTH && !headers["authorization"]) headers["authorization"] = BASIC_AUTH;
  // Pin every request to the workspace, also when hijacking an opencode
  // server that was started elsewhere.
  if (!headers["x-opencode-directory"]) headers["x-opencode-directory"] = encodeURIComponent(WORKSPACE_DIR);
  const proxy = http.request(
    { hostname: OPENCODE_HOST, port: opencodePort, path: url.pathname + url.search, method: req.method, headers },
    (upstream) => {
      // SSE streams pass through untouched (no buffering)
      const outHeaders = { ...upstream.headers };
      delete outHeaders["content-length"]; // let node use chunked
      res.writeHead(upstream.statusCode, outHeaders);
      upstream.pipe(res);
    },
  );
  proxy.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "opencode server unreachable", detail: err.message }));
  });
  req.pipe(proxy);
}

function handle(req, res) {
  if (req.url.startsWith("/api/") || req.url === "/api") return proxyApi(req, res);
  if (req.url.startsWith("/files/")) return serveFile(req, res);
  if (req.url === "/setup/alive") return trackAlive(req, res);
  if (req.url === "/healthz") return json(res, 200, { ok: true, app: "opencode-chat" });
  if (req.url === "/setup/status") return json(res, 200, { ...setup, workspace: WORKSPACE_DIR, filesDir: FILES_DIR });
  if (req.url === "/setup/retry" && req.method === "POST") {
    if (setup.phase === "error") bootOpencode();
    return json(res, 200, { ok: true });
  }
  if (req.url === "/setup/open-files" && req.method === "POST") {
    if (process.platform === "win32") spawn("explorer.exe", [FILES_DIR], { detached: true, stdio: "ignore" }).unref();
    return json(res, 200, { ok: true });
  }
  return serveStatic(req, res);
}

/* ---------------- app window ---------------- */

function findBrowser() {
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  return [
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ].find((p) => p && fs.existsSync(p));
}

function openDefaultBrowser(url) {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const a = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, a, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

// Opens the UI in a chromeless window with its own browser profile (so it
// keeps its own storage and does not join the user's normal browser session).
function openAppWindow(url) {
  const browser = findBrowser();
  if (!browser) {
    openDefaultBrowser(url);
    return;
  }
  spawn(
    browser,
    [`--app=${url}`, `--user-data-dir=${path.join(APP_DATA, "window")}`, "--no-first-run", "--no-default-browser-check", "--window-size=1200,820"],
    { stdio: "ignore", detached: true },
  ).unref();
}

// Each open page holds a /setup/alive event stream. Browser launcher processes
// exit right away, so this is how the exe knows its windows are gone: quit
// once none have been connected for a while (long enough to survive reloads).
const alive = new Set();
let idleSince = Date.now();
function trackAlive(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": hi\n\n");
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  alive.add(res);
  req.on("close", () => {
    clearInterval(ping);
    alive.delete(res);
    if (!alive.size) idleSince = Date.now();
  });
}
function quitWhenWindowsClosed() {
  const STARTUP_GRACE = 120000; // first window may take a while to appear
  const CLOSE_GRACE = 15000;
  const started = Date.now();
  let seen = false;
  setInterval(() => {
    if (alive.size) {
      seen = true;
      return;
    }
    const limit = seen ? CLOSE_GRACE : STARTUP_GRACE;
    if (Date.now() - (seen ? idleSince : started) > limit) {
      console.log("[opencode-chat] all windows closed, quitting");
      shutdown();
    }
  }, 2000).unref();
}

/* ---------------- boot ---------------- */

function bootOpencode() {
  setup.error = null;
  ensureOpencode()
    .then(() => {
      setPhase("ready", "Ready", 1);
      ensureUv()
        .then((uv) => uv && warmUpDocumentTools(uv))
        .catch((err) => console.error("[opencode-chat] could not set up uv:", err.message));
    })
    .catch((err) => {
      console.error("[opencode-chat] setup failed:", err.message);
      setPhase("error", "Setup failed");
      setup.error = err.message;
    });
}

async function isOurServer(port) {
  return new Promise((resolve) => {
    http
      .get({ hostname: "127.0.0.1", port, path: "/healthz", timeout: 1500 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body).app === "opencode-chat");
          } catch {
            resolve(false);
          }
        });
      })
      .on("error", () => resolve(false))
      .on("timeout", function () {
        this.destroy();
        resolve(false);
      });
  });
}

async function start() {
  // Already running (e.g. double-clicked twice): just open another window.
  if (!SIDECAR && (await isOurServer(PREFERRED_WEB_PORT))) {
    const url = `http://127.0.0.1:${PREFERRED_WEB_PORT}`;
    if (APP_WINDOW) openAppWindow(url);
    else if (SHOULD_OPEN) openDefaultBrowser(url);
    console.log(`[opencode-chat] already running at ${url}`);
    process.exit(0);
  }
  prepareWorkspace();
  const webPort = (await isPortFree(PREFERRED_WEB_PORT)) ? PREFERRED_WEB_PORT : await freePort();
  const server = http.createServer(handle);
  server.listen(webPort, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${webPort}`;
    console.log(`[opencode-chat] chat UI: ${url}`);
    console.log(`[opencode-chat] workspace: ${WORKSPACE_DIR}`);
    if (SIDECAR) process.stdout.write(`LISTENING ${url}\n`);
    else if (APP_WINDOW) openAppWindow(url);
    if (IS_EXE && !SIDECAR) quitWhenWindowsClosed();
    else if (SHOULD_OPEN) openDefaultBrowser(url);
  });
  bootOpencode();
}

function shutdown() {
  if (child) {
    try {
      child.kill();
    } catch { /* ignore */ }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (SIDECAR) {
  // Windows has no catchable kill signal, so the shell writes "quit" (or just
  // exits, closing the pipe) and we stop opencode before leaving.
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => d.includes("quit") && shutdown());
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.resume();
}

start().catch((err) => {
  console.error("[opencode-chat] fatal:", err.message);
  shutdown();
});
