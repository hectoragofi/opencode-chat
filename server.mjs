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
  const logStream = fs.createWriteStream(path.join(APP_DATA, "opencode-chat.log"), { flags: "a" });
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

// Idle shutdown: stop the opencode engine after N minutes without /api
// traffic (its ~500 MB goes back to the OS) and wake it on the next request.
// 0 disables (engine stays resident, the old behaviour).
const _rawIdle = opt("--opencode-idle-mins", process.env.OPENCODE_IDLE_MINS ?? "15");
let IDLE_MINS = Number(_rawIdle);
if (!Number.isFinite(IDLE_MINS) || IDLE_MINS < 0) IDLE_MINS = 15;
const NO_WARMUP = args.includes("--no-warmup") || process.env.OPENCODE_NO_WARMUP === "1";

// opencode runs in the workspace: it holds the "chat" agent definition
// (.opencode/agent) and the files it generates (files/), served at /files/*.
const WORKSPACE_DIR = path.resolve(
  opt("--workspace", IS_EXE ? path.join(os.homedir(), "Documents", "OpenCode Chat") : path.join(SOURCE_DIR, "workspace")),
);
const FILES_DIR = path.join(WORKSPACE_DIR, "files");
const PROJECTS_DIR = path.join(WORKSPACE_DIR, "projects");
const SKILLS_DIR = path.join(WORKSPACE_DIR, ".opencode", "skills");
const SESSIONS_MAP_FILE = path.join(PROJECTS_DIR, "sessions.json");
const MAX_SKILL_BYTES = 64 * 1024;
// Knowledge-file uploads ride in as JSON base64 (no extra deps). The body
// cap is generous on purpose — project files have no size limit; localhost
// uploads of even hundreds of MB are quick.
const MAX_UPLOAD_BODY_BYTES = 768 * 1024 * 1024;

const slugify = (s, fallback = "item") => {
  const slug = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
  return slug || fallback;
};

const safeFileName = (s) => {
  const base = path.basename(String(s || ""));
  const clean = base.replace(/[^\w.\-()+\[\] ]/g, "_").slice(0, 120);
  return clean && clean !== "." && clean !== ".." ? clean : "file";
};

function readJsonBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/* ---------------- projects (Claude-style) ---------------- */

function projectDir(id) {
  return path.join(PROJECTS_DIR, id);
}

function readSessionsMap() {
  try {
    const raw = fs.readFileSync(SESSIONS_MAP_FILE, "utf8");
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeSessionsMap(map) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_MAP_FILE, JSON.stringify(map, null, 2));
}

function listProjectFiles(id) {
  const dir = path.join(projectDir(id), "files");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const p = path.join(dir, e.name);
        try {
          const st = fs.statSync(p);
          return { name: e.name, size: st.size, mtime: st.mtimeMs };
        } catch {
          return { name: e.name, size: 0, mtime: 0 };
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function readProject(id) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return null;
  const file = path.join(projectDir(id), "project.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || data.id !== id) return null;
    if (!data.icon) data.icon = "📁"; // projects created before icons existed
    return { ...data, files: listProjectFiles(id), fileCount: listProjectFiles(id).length };
  } catch {
    return null;
  }
}

function listProjects() {
  try {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readProject(e.name))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch {
    return [];
  }
}

// Dedicated opencode agent per project: base chat behaviour plus the
// project's custom instructions and a pointer at its knowledge files.
// Switching defaultAgent to `project-<id>` is what puts a chat "inside"
// the project (same mechanism as the Chat/Agent toggle).
function syncProjectAgent(project) {
  try {
    const base = (readBundled("template/chat-agent.md") || fs.readFileSync(path.join(WORKSPACE_DIR, ".opencode", "agent", "chat.md"), "utf8")).toString();
    const files = listProjectFiles(project.id);
    const fileLines = files.length
      ? files.map((f) => `- \`projects/${project.id}/files/${f.name}\``).join("\n")
      : "(no knowledge files yet — the user can add some in the project settings)";
    const extra = `\n\n---\n\n## Project context: ${project.name}\n\nYou are chatting inside the project "${project.name}".${project.description ? ` Project description: ${project.description}` : ""}\n${project.instructions ? `\n### Project instructions (always follow these)\n\n${project.instructions}\n` : "\n(No extra project instructions.)\n"}\n### Project knowledge files\n\nThe user attached these reference files to the project. Consult them when relevant — read the ones that look useful before answering, and cite them when you use them:\n\n${fileLines}\n\nKnowledge files live under \`projects/${project.id}/files/\` (relative to the workspace root). Read them with the read tool; never write there — generated output still goes to \`files/\` as usual.\n`;
    fs.mkdirSync(path.join(WORKSPACE_DIR, ".opencode", "agent"), { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, ".opencode", "agent", `project-${project.id}.md`), base + extra);
  } catch (err) {
    console.error(`[opencode-chat] could not sync agent for project ${project.id}:`, err.message);
  }
}

function removeProjectAgent(id) {
  try {
    fs.rmSync(path.join(WORKSPACE_DIR, ".opencode", "agent", `project-${id}.md`), { force: true });
  } catch { /* ignore */ }
}

/* ---------------- skills (Claude / opencode SKILL.md) ---------------- */

function parseSkillFile(filePath, enabled) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    let name = path.basename(path.dirname(filePath));
    let description = "";
    let body = raw;
    if (m) {
      body = (m[2] || "").trim();
      for (const line of m[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        if (k === "name") name = v;
        if (k === "description") description = v;
      }
    }
    return { name, description, body, enabled, dir: path.basename(path.dirname(filePath)) };
  } catch {
    return null;
  }
}

function listSkills() {
  const out = [];
  try {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      const disabled = dirName.endsWith(".disabled");
      const realName = disabled ? dirName.slice(0, -9) : dirName;
      const file = path.join(SKILLS_DIR, dirName, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const parsed = parseSkillFile(file, !disabled);
      if (parsed) out.push({ ...parsed, dir: dirName, skill: realName });
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => a.skill.localeCompare(b.skill));
}

function skillDirFor(name, enabled = true) {
  return path.join(SKILLS_DIR, enabled ? name : `${name}.disabled`);
}

function findSkillDir(name) {
  for (const suffix of ["", ".disabled"]) {
    const d = path.join(SKILLS_DIR, name + suffix);
    if (fs.existsSync(path.join(d, "SKILL.md"))) return d;
  }
  return null;
}

function buildSkillMarkdown(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${String(body || "").trim()}\n`;
}

function prepareWorkspace() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  // Generated files accumulate forever; prune anything older than 30 days
  // on boot (best effort, never blocks startup).
  try {
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    let pruned = 0;
    for (const entry of fs.readdirSync(FILES_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        const p = path.join(FILES_DIR, entry.name);
        if (fs.statSync(p).mtimeMs < cutoff) {
          fs.rmSync(p);
          pruned++;
        }
      } catch { /* ignore one bad file */ }
    }
    if (pruned) console.log(`[opencode-chat] pruned ${pruned} file(s) older than 30 days`);
  } catch { /* ignore */ }
  fs.mkdirSync(path.join(WORKSPACE_DIR, "scratch"), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, ".opencode", "agent"), { recursive: true });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, ".opencode", "skills"), { recursive: true });
  const agent = readBundled("template/chat-agent.md");
  if (agent) fs.writeFileSync(path.join(WORKSPACE_DIR, ".opencode", "agent", "chat.md"), agent);
  // Seed bundled skills (template/skills/<name>/SKILL.md) on first run;
  // never overwrite a skill the user edited.
  const seedSkills = (rel) => {
    const buf = readBundled(rel);
    if (!buf) return null;
    return buf.toString();
  };
  for (const rel of ["template/skills/document-polish/SKILL.md", "template/skills/spreadsheet-analyst/SKILL.md"]) {
    const content = seedSkills(rel);
    if (!content) continue;
    const m = content.match(/^---\s*\n[\s\S]*?\nname:\s*([^\s\n]+)/);
    const skillName = m ? m[1].trim() : slugify(path.basename(path.dirname(rel)), "skill");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) continue;
    if (!fs.existsSync(path.join(SKILLS_DIR, skillName, "SKILL.md")) && !fs.existsSync(path.join(SKILLS_DIR, `${skillName}.disabled`, "SKILL.md"))) {
      fs.mkdirSync(path.join(SKILLS_DIR, skillName), { recursive: true });
      fs.writeFileSync(path.join(SKILLS_DIR, skillName, "SKILL.md"), content);
    }
  }
  // Rebuild per-project agents (base template may have changed).
  try {
    for (const p of listProjects()) syncProjectAgent(p);
    // Drop stale project agents left by deleted projects.
    const live = new Set(listProjects().map((p) => `project-${p.id}.md`));
    for (const entry of fs.readdirSync(path.join(WORKSPACE_DIR, ".opencode", "agent"))) {
      if (entry.startsWith("project-") && entry.endsWith(".md") && !live.has(entry)) {
        try { fs.rmSync(path.join(WORKSPACE_DIR, ".opencode", "agent", entry)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
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

// Idle bookkeeping. engineSleeping means WE stopped our engine to save RAM
// (phase stays "ready" so the UI keeps the chat mounted; the next /api call
// wakes it and waits). Only ever set when child != null, i.e. we own it.
let lastApiAt = Date.now();
let engineSleeping = false;
let warmupScheduled = false;

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
  child.on("exit", (code, signal) => {
    // Idle shutdown and app quit stop the engine on purpose — not an error.
    if (engineSleeping || shuttingDown) return;
    if (code !== 0 && code !== null) {
      console.error(`[opencode-chat] opencode exited unexpectedly with code ${code}`);
      // The UI only proxies while phase === "ready"; flip to error so the
      // setup screen offers a retry instead of serving endless 502s.
      if (setup.phase === "ready") {
        setPhase("error", "The AI engine stopped unexpectedly");
        setup.error = `opencode exited with code ${code}. Press Retry to restart it — your chats are stored on disk and will reappear.`;
      }
    } else if (setup.phase === "ready") {
      // Killed by signal (or code 0) while we were serving: same handling.
      console.error(`[opencode-chat] opencode process ended (${signal || "code 0"}) while serving`);
      setPhase("error", "The AI engine stopped unexpectedly");
      setup.error = "The opencode process ended. Press Retry to restart it — your chats are stored on disk and will reappear.";
    }
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
  proxyApiAsync(req, res).catch((err) => {
    console.error(`[opencode-chat] proxy failure: ${err.message}`);
    if (!res.headersSent && !req.destroyed) {
      try {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request failed", detail: err.message }));
      } catch { /* client gone */ }
    }
  });
}

async function proxyApiAsync(req, res) {
  lastApiAt = Date.now();
  scheduleWarmup();
  // Wake-from-sleep only: the engine was up before, so hold the request
  // until it answers — the first message after idle takes a few seconds
  // instead of 503ing and forcing a resend. First boot keeps the instant
  // 503 (the setup screen is polling /setup/status anyway).
  const woken = engineSleeping;
  if (engineSleeping) {
    console.log("[opencode-chat] waking engine for incoming request\u2026");
    engineSleeping = false;
    bootOpencode();
  }
  if (setup.phase !== "ready") {
    if (woken) {
      const woke = await waitForEngineReady(75000, req, res);
      if (!woke || setup.phase !== "ready") {
        if (!res.headersSent && !req.destroyed) return json(res, 503, { error: "opencode is still starting", setup });
        return;
      }
    } else {
      return json(res, 503, { error: "opencode is still starting", setup });
    }
  }
  const target = req.url.replace(/^\/api/, "") || "/";
  const url = new URL(target, `http://${OPENCODE_HOST}:${opencodePort}`);
  const headers = { ...req.headers };
  delete headers["host"];
  delete headers["connection"];
  if (BASIC_AUTH && !headers["authorization"]) headers["authorization"] = BASIC_AUTH;
  // Pin every request to the workspace, also when hijacking an opencode
  // server that was started elsewhere.
  if (!headers["x-opencode-directory"]) headers["x-opencode-directory"] = encodeURIComponent(WORKSPACE_DIR);
  const isSSE = (req.headers.accept || "").includes("text/event-stream");
  // Stop requests must fail fast: a hung abort wedges the UI in
  // "cancelling" for the full 120s. Abort should answer in ms; 15s means
  // the engine is wedged and the client should surface that, not hang.
  const isAbort = req.method === "POST" && /\/session\/[^/]+\/abort$/.test(url.pathname);
  const startedAt = Date.now();
  const proxy = http.request(
    { hostname: OPENCODE_HOST, port: opencodePort, path: url.pathname + url.search, method: req.method, headers, timeout: isSSE ? 0 : isAbort ? 15000 : 120000 },
    (upstream) => {
      // SSE streams pass through untouched (no buffering)
      const outHeaders = { ...upstream.headers };
      delete outHeaders["content-length"]; // let node use chunked
      if (isAbort || upstream.statusCode >= 400) {
        console.log(`[opencode-chat] ${req.method} ${url.pathname} -> ${upstream.statusCode} (${Date.now() - startedAt}ms)`);
      }
      res.writeHead(upstream.statusCode, outHeaders);
      upstream.pipe(res);
    },
  );
  proxy.on("timeout", () => {
    console.error(`[opencode-chat] ${req.method} ${url.pathname} timed out after ${isAbort ? 15 : 120}s`);
    proxy.destroy(new Error(`opencode request timed out after ${isAbort ? 15 : 120}s`));
  });
  proxy.on("error", (err) => {
    console.error(`[opencode-chat] ${req.method} ${url.pathname} proxy error: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    try {
      res.end(JSON.stringify({ error: "opencode server unreachable", detail: err.message }));
    } catch { /* client already gone */ }
  });
  req.pipe(proxy);
}

/* ---------------- projects + skills http handlers ---------------- */

async function handleProjects(req, res) {
  const url = new URL(req.url, "http://x");
  const pathname = decodeURIComponent(url.pathname);

  // Session <-> project tagging. The opencode runtime owns sessions, so
  // this is a sidecar map: { sessionId: projectId }.
  if (pathname === "/project-sessions" && req.method === "GET") {
    return json(res, 200, { map: readSessionsMap() });
  }
  if (pathname === "/project-sessions" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const sessionId = String(body.sessionId || "").slice(0, 128);
      if (!sessionId) return json(res, 400, { error: "sessionId is required" });
      const projectId = body.projectId == null ? null : String(body.projectId);
      if (projectId !== null && !readProject(projectId)) return json(res, 404, { error: "project not found" });
      const map = readSessionsMap();
      if (projectId === null) delete map[sessionId];
      else map[sessionId] = projectId;
      // Bound the map so it cannot grow forever.
      const keys = Object.keys(map);
      if (keys.length > 2000) {
        for (const k of keys.slice(0, keys.length - 2000)) delete map[k];
      }
      writeSessionsMap(map);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (pathname === "/projects" && req.method === "GET") {
    return json(res, 200, { projects: listProjects() });
  }
  if (pathname === "/projects" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || "").trim().slice(0, 80);
      if (!name) return json(res, 400, { error: "name is required" });
      const id = `${slugify(name, "project")}-${Date.now().toString(36)}`;
      const now = Date.now();
      const project = {
        id,
        name,
        description: String(body.description || "").slice(0, 500),
        instructions: String(body.instructions || "").slice(0, 12000),
        icon: String(body.icon || "📁").slice(0, 8),
        createdAt: now,
        updatedAt: now,
      };
      fs.mkdirSync(path.join(projectDir(id), "files"), { recursive: true });
      fs.writeFileSync(path.join(projectDir(id), "project.json"), JSON.stringify(project, null, 2));
      syncProjectAgent(project);
      return json(res, 201, { project: readProject(id) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  const projectMatch = pathname.match(/^\/projects\/([^/]+)(\/.*)?$/);
  if (projectMatch) {
    const id = projectMatch[1];
    const rest = projectMatch[2] || "";
    const existing = readProject(id);
    if (!existing && req.method !== "DELETE") {
      // DELETE is idempotent; everything else needs the project.
      if (rest === "" || rest === "/files") return json(res, 404, { error: "project not found" });
    }
    if ((rest === "" || rest === "/") && req.method === "GET") {
      if (!existing) return json(res, 404, { error: "project not found" });
      return json(res, 200, { project: existing });
    }
    if ((rest === "" || rest === "/") && (req.method === "PUT" || req.method === "PATCH")) {
      if (!existing) return json(res, 404, { error: "project not found" });
      try {
        const body = await readJsonBody(req);
        const next = {
          ...existing,
          name: body.name !== undefined ? String(body.name).trim().slice(0, 80) || existing.name : existing.name,
          description: body.description !== undefined ? String(body.description).slice(0, 500) : existing.description,
          instructions: body.instructions !== undefined ? String(body.instructions).slice(0, 12000) : existing.instructions,
          icon: body.icon !== undefined ? String(body.icon).slice(0, 8) || "📁" : (existing.icon || "📁"),
          updatedAt: Date.now(),
        };
        delete next.files;
        delete next.fileCount;
        fs.writeFileSync(path.join(projectDir(id), "project.json"), JSON.stringify(next, null, 2));
        syncProjectAgent(next);
        return json(res, 200, { project: readProject(id) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if ((rest === "" || rest === "/") && req.method === "DELETE") {
      fs.rmSync(projectDir(id), { recursive: true, force: true });
      removeProjectAgent(id);
      const map = readSessionsMap();
      let touched = false;
      for (const [sid, pid] of Object.entries(map)) {
        if (pid === id) { delete map[sid]; touched = true; }
      }
      if (touched) writeSessionsMap(map);
      return json(res, 200, { ok: true });
    }
    if ((rest === "/files" || rest === "/files/") && req.method === "GET") {
      if (!existing) return json(res, 404, { error: "project not found" });
      return json(res, 200, { files: listProjectFiles(id) });
    }
    if ((rest === "/files" || rest === "/files/") && req.method === "POST") {
      if (!existing) return json(res, 404, { error: "project not found" });
      try {
        const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES);
        const filename = safeFileName(body.filename || body.name);
        if (!body.contentBase64 || typeof body.contentBase64 !== "string") {
          return json(res, 400, { error: "contentBase64 is required" });
        }
        const buf = Buffer.from(body.contentBase64, "base64");
        if (!buf.length) return json(res, 400, { error: "empty file" });
        fs.mkdirSync(path.join(projectDir(id), "files"), { recursive: true });
        fs.writeFileSync(path.join(projectDir(id), "files", filename), buf);
        const st = { ...existing };
        delete st.files; delete st.fileCount;
        st.updatedAt = Date.now();
        fs.writeFileSync(path.join(projectDir(id), "project.json"), JSON.stringify(st, null, 2));
        syncProjectAgent({ ...st, id });
        return json(res, 201, { ok: true, files: listProjectFiles(id) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    const contentMatch = rest.match(/^\/files\/content\/(.+)$/);
    if (contentMatch && req.method === "GET") {
      const filename = safeFileName(contentMatch[1]);
      const file = path.normalize(path.join(projectDir(id), "files", filename));
      const base = path.join(projectDir(id), "files") + path.sep;
      if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return json(res, 404, { error: "file not found" });
      }
      const dl = url.searchParams.has("download");
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "content-length": fs.statSync(file).size,
        "content-disposition": `${dl ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const fileMatch = rest.match(/^\/files\/(.+)$/);
    if (fileMatch && req.method === "DELETE") {
      const filename = safeFileName(fileMatch[1]);
      try { fs.rmSync(path.join(projectDir(id), "files", filename), { force: true }); } catch { /* ignore */ }
      return json(res, 200, { ok: true, files: listProjectFiles(id) });
    }
    return json(res, 404, { error: "not found" });
  }

  // ---- skills ----
  if (pathname === "/skills" && req.method === "GET") {
    return json(res, 200, { skills: listSkills() });
  }
  if (pathname === "/skills" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const name = slugify(body.name || "", "");
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        return json(res, 400, { error: "name must be lowercase alphanumeric with single hyphens (e.g. my-skill)" });
      }
      const description = String(body.description || "").trim().slice(0, 1024);
      if (!description) return json(res, 400, { error: "description is required (1-1024 chars)" });
      const content = String(body.body ?? body.content ?? "").slice(0, MAX_SKILL_BYTES);
      if (findSkillDir(name)) return json(res, 409, { error: `skill "${name}" already exists` });
      const dir = skillDirFor(name, true);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), buildSkillMarkdown(name, description, content || `# ${name}\n\nDescribe when and how to use this skill.`));
      return json(res, 201, { ok: true, skills: listSkills() });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  const skillMatch = pathname.match(/^\/skills\/([^/]+)(\/.*)?$/);
  if (skillMatch) {
    const name = skillMatch[1];
    const rest = skillMatch[2] || "";
    if (!/^[a-z0-9]+(-[a-z0-9]+)*(\.disabled)?$/.test(name)) return json(res, 400, { error: "invalid skill name" });
    const canonical = name.endsWith(".disabled") ? name.slice(0, -9) : name;
    if ((rest === "" || rest === "/") && (req.method === "PUT" || req.method === "PATCH")) {
      const dir = findSkillDir(canonical);
      if (!dir) return json(res, 404, { error: "skill not found" });
      try {
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        const current = parseSkillFile(path.join(dir, "SKILL.md"), !dir.endsWith(".disabled"));
        const description = body.description !== undefined ? String(body.description).trim().slice(0, 1024) : current.description;
        if (!description) return json(res, 400, { error: "description must not be empty" });
        const content = body.body !== undefined ? String(body.body) : (body.content !== undefined ? String(body.content) : current.body);
        fs.writeFileSync(path.join(dir, "SKILL.md"), buildSkillMarkdown(canonical, description, content));
        return json(res, 200, { ok: true, skills: listSkills() });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if ((rest === "" || rest === "/") && req.method === "DELETE") {
      const dir = findSkillDir(canonical);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      return json(res, 200, { ok: true, skills: listSkills() });
    }
    if (rest === "/toggle" && req.method === "POST") {
      const dir = findSkillDir(canonical);
      if (!dir) return json(res, 404, { error: "skill not found" });
      try {
        const body = await readJsonBody(req);
        const wantEnabled = body.enabled !== undefined ? !!body.enabled : dir.endsWith(".disabled");
        const isEnabled = !dir.endsWith(".disabled");
        if (wantEnabled !== isEnabled) {
          fs.renameSync(dir, skillDirFor(canonical, wantEnabled));
        }
        return json(res, 200, { ok: true, skills: listSkills() });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    return json(res, 404, { error: "not found" });
  }

  return false;
}

function handle(req, res) {
  if (req.url.startsWith("/api/") || req.url === "/api") return proxyApi(req, res);
  if (req.url.startsWith("/files/")) return serveFile(req, res);
  if (req.url === "/setup/alive") return trackAlive(req, res);
  if (req.url === "/healthz") return json(res, 200, { ok: true, app: "opencode-chat" });
  if (req.url === "/setup/status") return json(res, 200, { ...setup, workspace: WORKSPACE_DIR, filesDir: FILES_DIR, engine: engineSleeping ? "sleeping" : setup.phase === "ready" ? "up" : "starting", idleMins: IDLE_MINS });
  if (req.url === "/setup/retry" && req.method === "POST") {
    if (setup.phase === "error") bootOpencode();
    return json(res, 200, { ok: true });
  }
  if (req.url === "/setup/open-files" && req.method === "POST") {
    if (process.platform === "win32") spawn("explorer.exe", [FILES_DIR], { detached: true, stdio: "ignore" }).unref();
    return json(res, 200, { ok: true });
  }
  if (req.url === "/setup/open-workspace" && req.method === "POST") {
    if (process.platform === "win32") spawn("explorer.exe", [WORKSPACE_DIR], { detached: true, stdio: "ignore" }).unref();
    return json(res, 200, { ok: true });
  }
  if (req.url.startsWith("/projects") || req.url.startsWith("/project-sessions") || req.url.startsWith("/skills")) {
    Promise.resolve(handleProjects(req, res)).then((handled) => {
      if (handled === false) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    }).catch((e) => {
      if (!res.headersSent) json(res, 500, { error: String(e?.message || e) });
    });
    return;
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

let shuttingDown = false;
let healthMisses = 0;

// The engine can die after boot (crash, OOM, killed externally). Without
// this, phase stays "ready" forever and every /api call 502s with no
// recovery path. Three consecutive missed health checks flip to error so
// the UI offers a retry; transient blips (account reconnects) ride through.
function watchEngineHealth() {
  setInterval(async () => {
    if (shuttingDown || setup.phase !== "ready" || engineSleeping) {
      healthMisses = 0;
      return;
    }
    try {
      if (await isOpencodeUp()) {
        healthMisses = 0;
        return;
      }
    } catch {
      /* count as a miss below */
    }
    if (++healthMisses >= 3) {
      console.error("[opencode-chat] lost contact with the AI engine (3 missed health checks)");
      setPhase("error", "Lost connection to the AI engine");
      setup.error = "The opencode process stopped responding. Press Retry to restart it — your chats are stored on disk and will reappear.";
      healthMisses = 0;
    }
  }, 15000).unref();
}

/* ---------------- engine idle shutdown + lazy warmup ---------------- */

// Doc toolchain (uv + Python libs) spikes ~200 MB at boot; defer it until
// the first real chat request lands, when the user is already busy reading.
function scheduleWarmup() {
  if (NO_WARMUP || warmupScheduled) return;
  warmupScheduled = true;
  ensureUv()
    .then((uv) => uv && warmUpDocumentTools(uv))
    .catch((err) => console.error("[opencode-chat] could not set up uv:", err.message));
}

// Holds an /api request while the engine boots (first run or wake-from-sleep)
// so the first message after idle takes a few seconds instead of 503ing and
// forcing the user to resend. False on client hangup, engine error, timeout.
function waitForEngineReady(timeoutMs, req, res) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (req.destroyed || res.writableEnded) { clearInterval(timer); resolve(false); return; }
      if (engineSleeping) return; // wake claimed elsewhere; keep waiting
      if (setup.phase === "ready") { clearInterval(timer); resolve(true); return; }
      if (setup.phase === "error" || Date.now() > deadline) { clearInterval(timer); resolve(false); return; }
    }, 400);
    if (timer.unref) timer.unref();
  });
}

// The engine holds ~500 MB even when nobody chats. Stop our own child after
// IDLE_MINS without /api traffic; phase stays "ready" so the UI keeps the
// chat mounted, and the next request transparently wakes it (see proxyApi).
// A hijacked engine (started elsewhere, child == null) is never touched.
function watchIdleShutdown() {
  if (IDLE_MINS <= 0) return;
  setInterval(() => {
    if (shuttingDown || engineSleeping || setup.phase !== "ready" || !child) return;
    if (Date.now() - lastApiAt <= IDLE_MINS * 60_000) return;
    engineSleeping = true; // set before kill: the exit handler must see it
    try { child.kill(); } catch { /* already gone */ }
    child = null;
    healthMisses = 0;
    console.log(`[opencode-chat] engine idle for ${IDLE_MINS}m \u2014 stopped to save RAM (wakes on next request)`);
  }, 30_000).unref();
}

function bootOpencode() {
  setup.error = null;
  healthMisses = 0;
  ensureOpencode()
    .then(() => {
      lastApiAt = Date.now();
      setPhase("ready", "Ready", 1);
      // Doc toolchain warms lazily on first chat traffic (see scheduleWarmup),
      // not at boot, so quiet starts skip the ~200 MB uv spike entirely.
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
  console.log(`[opencode-chat] engine idle shutdown: ${IDLE_MINS > 0 ? `after ${IDLE_MINS} idle min` : "disabled"}; doc warmup: ${NO_WARMUP ? "off" : "lazy (first request)"}`);
  bootOpencode();
  watchEngineHealth();
  watchIdleShutdown();
}

function shutdown() {
  shuttingDown = true;
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
