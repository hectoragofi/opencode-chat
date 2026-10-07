// Smoke tests for the opencode-chat server.
//
// Spawns `node server.mjs` on throwaway ports and exercises the HTTP layer:
// health, setup status, static UI, generated-file guards, and the /api gate.
// The opencode engine itself is NOT required: assertions hold whether it is
// still booting (503s), failed (error phase), or already up (hijacked).
//
// Run: npm test   (from the repo root)

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const get = (port, p) =>
  new Promise((resolve, reject) => {
    const req = httpGet(port, p);
    req.on("response", resolve);
    req.on("error", reject);
  });

function httpGet(port, p) {
  return http.get({ hostname: "127.0.0.1", port, path: p, timeout: 8000 });
}

async function body(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await get(port, "/healthz");
      const text = await body(res);
      if (res.statusCode === 200 && JSON.parse(text).app === "opencode-chat") return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error("server did not become healthy in time");
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe("server", () => {
  let child;
  let port;

  before(async () => {
    port = await freePort();
    const opencodePort = await freePort();
    child = spawn(process.execPath, ["server.mjs", "--web-port", String(port), "--opencode-port", String(opencodePort)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    await waitForHealth(port);
  });

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM");
  });

  it("reports healthy on /healthz", async () => {
    const res = await get(port, "/healthz");
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /application\/json/);
    assert.deepEqual(JSON.parse(await body(res)), { ok: true, app: "opencode-chat" });
  });

  it("exposes setup status with a known phase", async () => {
    const res = await get(port, "/setup/status");
    assert.equal(res.statusCode, 200);
    const status = JSON.parse(await body(res));
    assert.ok(
      ["starting", "downloading", "installing", "launching", "ready", "error"].includes(status.phase),
      `unexpected phase: ${status.phase}`,
    );
    assert.equal(typeof status.message, "string");
  });

  it("serves the chat UI at /", async () => {
    const res = await get(port, "/");
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(await body(res), /<div id="root"><\/div>/);
  });

  it("404s unknown routes", async () => {
    const res = await get(port, "/__no_such_route_xyz");
    assert.equal(res.statusCode, 404);
  });

  it("blocks path traversal on /files/*", async () => {
    for (const evil of ["/files/../server.mjs", "/files/%2e%2e/server.mjs", "/files/..%2f..%2fpackage.json"]) {
      const res = await get(port, evil);
      assert.equal(res.statusCode, 404, evil);
    }
  });

  it("gates /api/* until the engine is ready (503) or proxies (404 from engine)", async () => {
    const res = await get(port, "/api/__opencode_chat_smoke__");
    assert.ok([404, 503].includes(res.statusCode), `unexpected status: ${res.statusCode}`);
    assert.match(res.headers["content-type"] || "", /application\/json/);
  });
});
