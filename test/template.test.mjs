// Static checks on the workspace template: the files the server copies into
// every workspace on boot. Catches accidental breakage of the agent recipe
// or the workspace config without needing to boot anything.
//
// Run: npm test   (from the repo root)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("template", () => {
  it("chat agent forces uv script header and files/ output", () => {
    const agent = read("template/chat-agent.md");
    assert.match(agent, /# \/\/\/ script/, "must document the uv inline-script header");
    assert.match(agent, /requires-python/, "must pin a Python version for uv");
    assert.match(agent, /files\//, "must direct output into files/");
    assert.match(agent, /scratch\//, "must direct scripts into scratch/");
  });

  it("workspace config selects the chat agent", () => {
    const config = JSON.parse(read("template/opencode.json"));
    assert.equal(config.default_agent, "chat");
  });

  it("uv script header is a valid PEP 723 block", () => {
    const header = read("template/script-header.py");
    assert.match(header, /# \/\/\/ script/);
    assert.match(header, /requires-python = ">=3\.11"/);
    assert.match(header, /reportlab.*python-docx.*openpyxl.*python-pptx.*matplotlib/s);
  });

  it("ships valid opencode skill templates", () => {
    for (const name of ["document-polish", "spreadsheet-analyst"]) {
      const raw = read(`template/skills/${name}/SKILL.md`);
      const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
      assert.ok(m, `${name} must start with YAML frontmatter`);
      const front = m[1];
      assert.match(front, new RegExp(`^name: ${name}$`, "m"), "skill name must match its directory");
      assert.match(front, /^description: .{1,1024}$/m, "skill needs a 1-1024 char description");
      assert.match(m[2].trim(), /## / , "skill body must contain instructions");
    }
  });

  it("updater feed points at a release feed", () => {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "desktop/src-tauri/tauri.conf.json"), "utf8"));
    assert.equal(conf.plugins?.updater?.active, true);
    assert.match(conf.plugins.updater.pubkey, /^[A-Za-z0-9+/=]+$/, "pubkey must be set");
    // Endpoints are plain URL strings (this plugin version rejects {url, headers} maps).
    const urls = conf.plugins.updater.endpoints.map((e) => (typeof e === "string" ? e : e.url)).join("\n");
    assert.match(urls, /github\.com\/hectoragofi\/opencode-chat(-updates)?\/releases\/.*latest\.json/);
  });
});
