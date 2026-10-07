const MAX_BYTES = 15 * 1024 * 1024;
const MAX_TEXT = 100_000;

const pending = new Map();
let counter = 0;

const readAsDataURL = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });

function sniffText(buffer) {
  const bytes = new Uint8Array(buffer);
  const head = bytes.slice(0, 8192);
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return null; // binary
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/** Catch-all: text-like files inline as text, everything else as data: URL. */
class CatchAllFileAdapter {
  accept = "*";

  async add({ file }) {
    if (file.size > MAX_BYTES) throw new Error(`${file.name}: file too large (max 15 MB)`);
    const id = `all-${Date.now().toString(36)}-${counter++}`;
    const buffer = await file.arrayBuffer();
    const text = sniffText(buffer);
    const dataUrl = text === null ? await readAsDataURL(file) : null;
    pending.set(id, { text, dataUrl, name: file.name, type: file.type });
    return {
      id,
      type: "file",
      name: file.name,
      contentType: file.type || "application/octet-stream",
      file,
      status: { type: "running", reason: "uploading", progress: 1 },
    };
  }

  async remove(attachment) {
    pending.delete(attachment.id);
  }

  async send(attachment) {
    const stored = pending.get(attachment.id);
    pending.delete(attachment.id);
    if (!stored) throw new Error("attachment data lost — please re-attach");
    const content =
      stored.text !== null
        ? [
            {
              type: "text",
              text:
                `Attached file "${stored.name}":\n\n` +
                stored.text.slice(0, MAX_TEXT) +
                (stored.text.length > MAX_TEXT ? "\n…(truncated)" : ""),
            },
          ]
        : [
            {
              type: "file",
              filename: stored.name,
              mimeType: stored.type || "application/octet-stream",
              data: stored.dataUrl,
            },
          ];
    return {
      id: attachment.id,
      type: "file",
      name: attachment.name,
      contentType: attachment.contentType,
      status: { type: "complete" },
      content,
    };
  }
}

export const catchAllFileAdapter = new CatchAllFileAdapter();
