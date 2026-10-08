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

function request(port, method, p, data) {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? null : Buffer.from(JSON.stringify(data));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        timeout: 8000,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
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

  it("supports project CRUD with instructions and knowledge files", async () => {
    const created = await request(port, "POST", "/projects", {
      name: "smoke test project",
      description: "created by npm test",
      instructions: "Always answer in haiku.",
    });
    assert.equal(created.status, 201);
    const project = JSON.parse(created.text).project;
    assert.match(project.id, /^[a-z0-9-]+$/);
    const id = project.id;
    try {
      const listed = JSON.parse((await request(port, "GET", "/projects")).text);
      assert.ok(listed.projects.some((p) => p.id === id));

      const updated = await request(port, "PUT", `/projects/${id}`, { instructions: "Always be brief." });
      assert.equal(updated.status, 200);
      assert.equal(JSON.parse(updated.text).project.instructions, "Always be brief.");

      const content = Buffer.from("smoke knowledge").toString("base64");
      const uploaded = await request(port, "POST", `/projects/${id}/files`, {
        filename: "notes.txt",
        contentBase64: content,
      });
      assert.equal(uploaded.status, 201);

      const fileRes = await get(port, `/projects/${id}/files/content/notes.txt`);
      assert.equal(fileRes.statusCode, 200);
      assert.equal(await body(fileRes), "smoke knowledge");

      // Traversal outside the project files dir is rejected.
      const evil = await get(port, `/projects/${id}/files/content/../project.json`);
      assert.equal(evil.statusCode, 404);
      await body(evil);

      const untagged = await request(port, "POST", "/project-sessions", {
        sessionId: "ses_smoke_test",
        projectId: id,
      });
      assert.equal(untagged.status, 200);
      const map = JSON.parse((await request(port, "GET", "/project-sessions")).text).map;
      assert.equal(map.ses_smoke_test, id);
      await request(port, "POST", "/project-sessions", { sessionId: "ses_smoke_test", projectId: null });
    } finally {
      const deleted = await request(port, "DELETE", `/projects/${id}`);
      assert.equal(deleted.status, 200);
      const gone = await request(port, "GET", `/projects/${id}`);
      assert.equal(gone.status, 404);
    }
  });

  it("rejects project creation without a name", async () => {
    const res = await request(port, "POST", "/projects", { name: "  " });
    assert.equal(res.status, 400);
  });

  it("supports project icons and files larger than the old 15 MB cap", async () => {
    const created = await request(port, "POST", "/projects", { name: "icon smoke", icon: "🚀" });
    assert.equal(created.status, 201);
    const id = JSON.parse(created.text).project.id;
    try {
      assert.equal(JSON.parse(created.text).project.icon, "🚀");
      const renamed = await request(port, "PUT", `/projects/${id}`, { icon: "🎓", name: "icon smoke v2" });
      assert.equal(renamed.status, 200);
      assert.equal(JSON.parse(renamed.text).project.icon, "🎓");
      assert.equal(JSON.parse(renamed.text).project.name, "icon smoke v2");

      // 20 MB — rejected under the old 15 MB per-file cap.
      const big = Buffer.alloc(20 * 1024 * 1024, "a").toString("base64");
      const uploaded = await request(port, "POST", `/projects/${id}/files`, {
        filename: "big.bin",
        contentBase64: big,
      });
      assert.equal(uploaded.status, 201);
      const files = JSON.parse(uploaded.text).files;
      assert.ok(files.some((f) => f.name === "big.bin" && f.size === 20 * 1024 * 1024));
    } finally {
      await request(port, "DELETE", `/projects/${id}`);
    }
  });

  it("supports skill CRUD and enable/disable", async () => {
    const listed = JSON.parse((await request(port, "GET", "/skills")).text);
    assert.ok(Array.isArray(listed.skills));
    assert.ok(listed.skills.some((s) => s.skill === "document-polish" && s.enabled));

    const bad = await request(port, "POST", "/skills", { name: "", description: "x", body: "y" });
    assert.equal(bad.status, 400);

    const name = `smoke-skill-${Date.now().toString(36)}`;
    try {
      const made = await request(port, "POST", "/skills", {
        name,
        description: "smoke test skill",
        body: "## Do it\n- test",
      });
      assert.equal(made.status, 201);
      assert.ok(JSON.parse(made.text).skills.some((s) => s.skill === name && s.enabled));

      const off = await request(port, "POST", `/skills/${name}/toggle`, { enabled: false });
      assert.equal(off.status, 200);
      assert.ok(JSON.parse(off.text).skills.some((s) => s.skill === name && !s.enabled));
    } finally {
      const gone = await request(port, "DELETE", `/skills/${name}`);
      assert.equal(gone.status, 200);
      assert.ok(!JSON.parse(gone.text).skills.some((s) => s.skill === name));
    }
  });
});
