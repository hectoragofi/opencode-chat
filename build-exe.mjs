// Builds dist/OpenCodeChat.exe: a Node single-executable app with the server,
// the built web UI and the agent template embedded. opencode itself is not
// bundled; the exe downloads it on first run (see installOpencode in server.mjs).
//
// Usage: node build-exe.mjs [--skip-web]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const EXE = path.join(DIST, "OpenCodeChat.exe");
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// npm/npx are .cmd shims on Windows and need a shell; node itself does not
// (and its "Program Files" path breaks unquoted under cmd).
const run = (cmd, args, cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && cmd !== process.execPath });

if (!process.argv.includes("--skip-web")) {
  console.log("> building web UI");
  run("npm", ["run", "build"], path.join(ROOT, "web"));
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

console.log("> bundling server");
await esbuild.build({
  entryPoints: [path.join(ROOT, "server.mjs")],
  outfile: path.join(DIST, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "warning",
  // import.meta.url is only read in dev mode; silence esbuild's cjs warning.
  define: { "import.meta.url": "undefined" },
});

const assets = {};
const addDir = (dir) => {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) addDir(rel);
    else assets[rel] = path.join(ROOT, rel);
  }
};
addDir("public");
addDir("template");

const seaConfig = path.join(DIST, "sea-config.json");
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: path.join(DIST, "server.cjs"),
      output: path.join(DIST, "sea-prep.blob"),
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      assets,
    },
    null,
    2,
  ),
);

console.log(`> creating SEA blob (${Object.keys(assets).length} assets)`);
run(process.execPath, ["--experimental-sea-config", seaConfig]);

fs.copyFileSync(process.execPath, EXE);

console.log("> setting icon and version info");
const { rcedit } = await import("rcedit");
await rcedit(EXE, {
  icon: path.join(ROOT, "template", "icon.ico"),
  "version-string": {
    ProductName: "OpenCode Chat",
    FileDescription: "OpenCode Chat",
    CompanyName: "",
    OriginalFilename: "OpenCodeChat.exe",
  },
  "file-version": "1.0.0",
  "product-version": "1.0.0",
});

console.log("> injecting blob");
run("npx", ["postject", EXE, "NODE_SEA_BLOB", path.join(DIST, "sea-prep.blob"), "--sentinel-fuse", SEA_FUSE, "--overwrite"]);

// Flip the PE subsystem from console (3) to GUI (2) so double-clicking the exe
// does not open a terminal window. The server logs to %LOCALAPPDATA%\OpenCodeChat.
const buf = fs.readFileSync(EXE);
const peOffset = buf.readUInt32LE(0x3c);
const subsystemOffset = peOffset + 4 + 20 + 68; // PE sig + COFF header + optional header field
if (buf.readUInt16LE(subsystemOffset) !== 3) throw new Error("unexpected PE subsystem; not patching");
buf.writeUInt16LE(2, subsystemOffset);
fs.writeFileSync(EXE, buf);

for (const f of ["server.cjs", "sea-prep.blob", "sea-config.json"]) fs.rmSync(path.join(DIST, f));
console.log(`> done: ${EXE} (${(fs.statSync(EXE).size / 1e6).toFixed(0)} MB)`);
