import { CompositeAttachmentAdapter } from "@assistant-ui/react";
import { OpenCodeAttachmentAdapter } from "@assistant-ui/react-opencode";
import { zipAttachmentAdapter } from "./zip-adapter.jsx";
import { catchAllFileAdapter } from "./catchall-adapter.jsx";

// Official adapter: photos, PDFs, text/code files -> inline data: URLs.
// ZipAdapter: unpacks .zip archives in-browser, inlines readable files.
// Catch-all ("*"): every other filetype — text-like files inline as text,
// true binaries as data: URLs. Last, so specific adapters win.
export const chatAttachmentAdapter = new CompositeAttachmentAdapter([
  new OpenCodeAttachmentAdapter(),
  zipAttachmentAdapter,
  catchAllFileAdapter,
]);
