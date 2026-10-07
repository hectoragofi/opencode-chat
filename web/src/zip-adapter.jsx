import JSZip from "jszip";

const MAX_BYTES = 15 * 1024 * 1024;
const TEXT_EXT =
  /\.(txt|md|markdown|json|js|jsx|ts|tsx|mjs|cjs|py|java|c|cc|cpp|h|hpp|cs|css|scss|html|htm|xml|yaml|yml|toml|ini|cfg|conf|csv|log|sql|sh|bash|zsh|rs|go|rb|php|swift|kt|scala|r|vue|svelte|env|gitignore|dockerfile|toml|lock|gradle|properties|tex|bib|bbl|sty|cls|bst|rmd|qmd|ipynb|rst|adoc|org)$/i;

const pending = new Map();
let counter = 0;

/** Unpacks .zip archives in the browser and inlines readable files as text. */
class ZipAttachmentAdapter {
  accept = ".zip,application/zip,application/x-zip-compressed";

  async add({ file }) {
    if (file.size > MAX_BYTES) throw new Error(`${file.name}: zip too large (max 15 MB)`);
    const id = `zip-${Date.now().toString(36)}-${counter++}`;
    pending.set(id, file);
    return {
      id,
      type: "file",
      name: file.name,
      contentType: file.type || "application/zip",
      file,
      status: { type: "running", reason: "uploading", progress: 1 },
    };
  }

  async remove(attachment) {
    pending.delete(attachment.id);
  }

  async send(attachment) {
    const file = pending.get(attachment.id);
    pending.delete(attachment.id);
    if (!file) throw new Error("attachment data lost — please re-attach");
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter((f) => !f.dir);
    if (!entries.length) throw new Error("zip is empty");
    let out = `Attached ZIP "${attachment.name}" (${entries.length} files):\n`;
    let chars = 0;
    for (const entry of entries.slice(0, 80)) {
      if (chars > 200_000) {
        out += "\n…(truncated: too much text, remaining files skipped)";
        break;
      }
      if (TEXT_EXT.test(entry.name)) {
        const text = await entry.async("string");
        const chunk = `\n===== ${entry.name} =====\n${text.slice(0, 20_000)}`;
        out += chunk;
        chars += chunk.length;
      } else {
        out += `\n[skipped non-text file: ${entry.name}]`;
      }
    }
    return {
      id: attachment.id,
      type: "file",
      name: attachment.name,
      contentType: attachment.contentType,
      status: { type: "complete" },
      content: [{ type: "text", text: out }],
    };
  }
}

export const zipAttachmentAdapter = new ZipAttachmentAdapter();
