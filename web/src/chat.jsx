import { useEffect, useState } from "react";
import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  useOpenCodePermissions,
  useOpenCodeQuestions,
  useOpenCodeRuntimeExtras,
  useOpenCodeThreadState,
} from "@assistant-ui/react-opencode";
import { MarkdownTextPrimitive, normalizeMathDelimiters } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  HelpCircleIcon,
  ImageIcon,
  PresentationIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { field, ghostButton, ShimmerLabel } from "./components/surfaces";
import {
  ComposerActions,
  ComposerAttachButton,
  ComposerAttachments,
  ComposerBar,
  ComposerSend,
  ComposerToolbar,
} from "./components/composer";
import { ApprovalCard } from "./components/approval-card";
import { ModelPicker } from "./components/model-picker";

/* ---------------- thread list (sidebar) ---------------- */

export function ChatSidebar() {
  return (
    <ThreadListPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 flex gap-2 p-3">
        <ThreadListPrimitive.New className="flex flex-1 items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-foreground/[0.05]">
          <PlusIcon className="size-4" />
          New chat
        </ThreadListPrimitive.New>
      </div>
      <div className="shrink-0 px-5 pb-1.5 font-mono text-[11px] tracking-tight text-foreground/35">
        Chats
      </div>
      <div className="min-h-0 flex-1 scroll-pane overflow-y-auto px-2 pb-2">
        <ThreadListPrimitive.Items className="flex flex-col gap-px">
          {() => (
            <ThreadListItemPrimitive.Root className="group flex items-center gap-1 rounded-lg transition-colors hover:bg-foreground/[0.05] data-active:bg-foreground/[0.07]">
              <ThreadListItemPrimitive.Trigger className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm outline-none">
                <ThreadListItemPrimitive.Title fallback="New chat" />
              </ThreadListItemPrimitive.Trigger>
              <ThreadListItemPrimitive.Delete
                className="hidden shrink-0 rounded-full p-1.5 text-foreground/45 transition group-hover:block hover:bg-foreground/[0.06] hover:text-red-400"
                title="Delete"
              >
                <Trash2Icon className="size-3.5" />
              </ThreadListItemPrimitive.Delete>
            </ThreadListItemPrimitive.Root>
          )}
        </ThreadListPrimitive.Items>
      </div>
    </ThreadListPrimitive.Root>
  );
}

/* ---------------- messages ---------------- */

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [[rehypeKatex, { strict: false, throwOnError: false }]];

// remark-math parses a line-starting $$ as a math *flow* fence, where the rest
// of the line becomes fence "meta" instead of math content. Models emit
// single-line $$...$$ and adjacent $$..$$ / $$..$$ pairs constantly, so without
// isolation the flow fence swallows the rest of the message into one giant
// math node and KaTeX fails with "Can't use function '$' in math mode".
// Rewriting every $$...$$ span into canonical block form ($$ on their own
// lines) makes each parse as its own display-math block. Code spans/blocks
// are left untouched.
const PROTECTED_SEGMENT =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;
function isolateDisplayMath(text) {
  return text
    .split(PROTECTED_SEGMENT)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(/\$\$([\s\S]+?)\$\$/g, (m, body) => {
            const t = body.trim();
            if (!t || t.includes("$$")) return m;
            return `\n$$\n${t}\n$$\n`;
          }),
    )
    .join("");
}

function preprocessMath(text) {
  return isolateDisplayMath(normalizeMathDelimiters(text));
}

// Files the chat agent generates land in workspace/files and are served back
// at /files/<name>. Anything pointing there — relative links, absolute links
// to this machine on any port (the UI and the engine don't share one), or
// bare paths the model forgot to linkify — renders as a rich card.
function toFilesPath(href) {
  if (typeof href !== "string") return null;
  if (href.startsWith("/files/")) return href;
  // Same machine, any port: the desktop shell and `node server.mjs` disagree
  // on ports, and models copy whichever URL they saw. Never rewrite the
  // open web this way — only loopback hosts can be our own file server.
  const m = href.match(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/files\/[^?#]*)(\?[^#]*)?/i);
  return m ? m[3] + (m[4] || "") : null;
}

// Models often emit bare `/files/report.pdf` paths instead of Markdown links.
// Linkify them (outside code spans/blocks and existing link targets) so they
// still become cards instead of dead text.
function linkifyBareFilePaths(text) {
  return text
    .split(PROTECTED_SEGMENT)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(/(^|[\s>])(\/files\/[^\s)>\]\"']+)/g, "$1[$2]($2)"),
    )
    .join("");
}

const FILE_KINDS = {
  pdf: { Icon: FileTextIcon, label: "PDF", tint: "text-red-400" },
  docx: { Icon: FileTextIcon, label: "Word", tint: "text-blue-400" },
  xlsx: { Icon: FileSpreadsheetIcon, label: "Excel", tint: "text-emerald-400" },
  csv: { Icon: FileSpreadsheetIcon, label: "CSV", tint: "text-emerald-400" },
  pptx: { Icon: PresentationIcon, label: "PowerPoint", tint: "text-orange-400" },
  png: { Icon: ImageIcon, label: "Image", tint: "text-purple-400" },
  jpg: { Icon: ImageIcon, label: "Image", tint: "text-purple-400" },
  jpeg: { Icon: ImageIcon, label: "Image", tint: "text-purple-400" },
  svg: { Icon: ImageIcon, label: "Image", tint: "text-purple-400" },
};

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

function CardActions({ path, name }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <a href={path} target="_blank" rel="noreferrer" className={cn(ghostButton, "size-8")} title="Open">
        <ExternalLinkIcon className="size-4" />
      </a>
      <a href={`${path}${path.includes("?") ? "&" : "?"}download=1`} download={name} className={cn(ghostButton, "size-8")} title="Download">
        <DownloadIcon className="size-4" />
      </a>
    </span>
  );
}

// Generated images render inline, ChatGPT-style, with open/download actions.
function FileImage({ path, name, alt }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <FileCard path={path} name={name} ext="png" />;
  return (
    <span className="not-prose my-2 block max-w-full no-underline">
      <a href={path} target="_blank" rel="noreferrer" className="block w-max max-w-full overflow-hidden rounded-xl border border-border/60">
        <img
          src={path}
          alt={alt || name}
          onError={() => setFailed(true)}
          className="block max-h-[420px] w-auto max-w-full object-contain"
        />
      </a>
      <span className="mt-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/45">{name}</span>
        <CardActions path={path} name={name} />
      </span>
    </span>
  );
}

function FileCard({ path, name, ext }) {
  const [preview, setPreview] = useState(false);
  const kind = FILE_KINDS[ext] || { Icon: FileIcon, label: ext.toUpperCase() || "File", tint: "text-foreground/60" };
  const canPreview = ext === "pdf";
  return (
    <span className={cn(field, "not-prose my-2 block max-w-full rounded-2xl p-2 no-underline")}>
      <span className="flex items-center gap-3 pl-1">
        <kind.Icon className={cn("size-6 shrink-0", kind.tint)} />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="font-mono text-[11px] text-foreground/45">{kind.label}</span>
        </span>
        {!canPreview ? null : (
          <button
            className={cn(ghostButton, "size-8")}
            title={preview ? "Hide preview" : "Preview"}
            onClick={() => setPreview((v) => !v)}
          >
            <ChevronDownIcon className={cn("size-4 transition-transform", preview && "rotate-180")} />
          </button>
        )}
        <CardActions path={path} name={name} />
      </span>
      {!preview || !canPreview ? null : (
        <iframe src={path} title={name} className="mt-2 h-96 w-full rounded-xl border border-border/60 bg-white" />
      )}
    </span>
  );
}

function FileLink({ href, children, node: _node, ...rest }) {
  const path = toFilesPath(href);
  if (!path) {
    return <a href={href} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
  }
  const name = decodeURIComponent(path.split("?")[0].split("/").pop() || "file");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (IMAGE_EXTS.includes(ext)) return <FileImage path={path} name={name} alt={typeof children === "string" ? children : undefined} />;
  return <FileCard path={path} name={name} ext={ext} />;
}

const markdownComponents = {
  a: FileLink,
  img: ({ node: _node, src, ...props }) => (
    <img
      {...props}
      src={toFilesPath(src) || src}
      className="my-2 max-h-[480px] max-w-full rounded-xl border border-border/60"
    />
  ),
};

function MarkdownWithMath(props) {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      preprocess={(text) => linkifyBareFilePaths(preprocessMath(text))}
      components={markdownComponents}
      {...props}
    />
  );
}

function UserText({ text }) {
  if (
    typeof text === "string" &&
    (text.startsWith("Attached ZIP") || text.startsWith("Attached file"))
  ) {
    const title = text.split("\n")[0];
    return (
      <details className="group/att mt-2 max-w-full rounded-xl border border-border/60 bg-background/60">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[13px] [&::-webkit-details-marker]:hidden">
          <span className="shrink-0">📦</span>
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-foreground/40 transition-transform group-open/att:rotate-180" />
        </summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/70">
          {text}
        </pre>
      </details>
    );
  }
  return (
    <div
      className={cn(
        field,
        "fade-in slide-in-from-bottom-1 animate-in rounded-2xl rounded-br-lg px-3.5 py-2 text-[14.5px] duration-300",
      )}
    >
      <span className="whitespace-pre-wrap">{text}</span>
    </div>
  );
}

// Attached photos/files on the user's own messages. The text bubble stays in
// UserText; images and files render as their own right-aligned blocks above
// or below it, ChatGPT-style.
function UserImage({ image, filename }) {
  if (!image) return null;
  return (
    <a
      href={image}
      target="_blank"
      rel="noreferrer"
      title={filename || "Open image"}
      className="block max-w-60 overflow-hidden rounded-xl border border-border/60"
    >
      <img src={image} alt={filename || "Attached image"} className="block max-h-60 w-auto object-cover" />
    </a>
  );
}

function UserFile({ filename, data, mimeType }) {
  const name = filename || "Attached file";
  const looksImage =
    (mimeType || "").startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
  if (looksImage && data) return <UserImage image={data} filename={name} />;
  if (!data) {
    return (
      <span className={cn(field, "flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs")}>
        <FileIcon className="size-3.5 shrink-0 text-foreground/55" />
        <span className="max-w-48 truncate font-medium">{name}</span>
      </span>
    );
  }
  return (
    <a
      href={data}
      download={name}
      className={cn(field, "flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs transition hover:bg-foreground/[0.06]")}
    >
      <FileIcon className="size-3.5 shrink-0 text-foreground/55" />
      <span className="max-w-48 truncate font-medium">{name}</span>
    </a>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="group mx-auto flex w-full max-w-3xl justify-end px-4 py-2.5">
      <div className="flex min-w-0 max-w-[85%] flex-col items-end gap-1.5">
        <MessagePrimitive.Parts components={{ Text: UserText, Image: UserImage, File: UserFile }} />
        <ActionBarPrimitive.Root className="mt-0.5 flex gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
          <ActionBarPrimitive.Edit
            className={cn(ghostButton, "size-7")}
            title="Edit"
          >
            <PencilIcon className="size-3.5" />
          </ActionBarPrimitive.Edit>
          <ActionBarPrimitive.Copy className={cn(ghostButton, "size-7")} title="Copy">
            <CopyIcon className="size-3.5" />
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="group fade-in animate-in mx-auto w-full max-w-3xl px-4 py-2.5 duration-300">
        <div className="aui-md text-[15px] leading-relaxed">
          <MessagePrimitive.Parts components={{ Text: MarkdownWithMath }} />
        </div>
      <MessagePrimitive.Error />
      <ActionBarPrimitive.Root className="mt-1 flex gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
        <ActionBarPrimitive.Copy className={cn(ghostButton, "size-7")} title="Copy">
          <CopyIcon className="size-3.5" />
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload className={cn(ghostButton, "size-7")} title="Retry">
          <RotateCcwIcon className="size-3.5" />
        </ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function EditComposer() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-2.5">
      <ComposerPrimitive.Root className={cn(field, "rounded-3xl p-3")}>
        <ComposerPrimitive.Input
          autoFocus
          className="w-full resize-none bg-transparent text-[15px] outline-none"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <ComposerPrimitive.Cancel className="h-8 rounded-full px-3.5 text-xs font-medium text-foreground/55 transition hover:bg-foreground/[0.06]">
            Cancel
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send className="flex size-8 items-center justify-center rounded-full bg-foreground text-background text-sm transition disabled:opacity-30">
            ↑
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}

/* ---------------- thinking trace (live activity) ---------------- */

function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ["command", "filePath", "path", "file", "url", "pattern", "query"]) {
    if (typeof input[k] === "string" && input[k]) return String(input[k]).slice(0, 80);
  }
  const first = Object.values(input).find((v) => typeof v === "string" && v);
  return first ? String(first).slice(0, 80) : "";
}

function useActivity() {
  let raw = null;
  try {
    raw = useOpenCodeThreadState((s) => {
    try {
      const ids = s.messageOrder || [];
      for (let i = ids.length - 1; i >= 0; i--) {
        const m = s.messagesById?.[ids[i]];
        if (!m || m.info?.role !== "assistant") continue;
        const parts = m.parts || [];
        for (let j = parts.length - 1; j >= 0; j--) {
          const p = parts[j];
          if (
            p.type === "tool" &&
            (p.state?.status === "running" || p.state?.status === "pending")
          ) {
            if (p.tool === "question") return "question|needs your input ↓";
            const detail = p.state?.title || summarizeInput(p.state?.input);
            return `tool|${p.tool}${detail ? ` · ${detail}` : ""}`;
          }
        }
        for (let j = parts.length - 1; j >= 0; j--) {
          const p = parts[j];
          if (p.type === "reasoning" && p.text) return "reasoning|reasoning through it";
        }
        if (parts.some((p) => p.type === "text" && p.text)) return "writing|writing answer";
        return "thinking|thinking";
      }
      return "thinking|thinking";
    } catch {
      return "thinking|thinking";
    }
  });
  } catch {
    return "thinking|thinking"; // thread not backed by a session yet
  }
  return raw || "thinking|thinking";
}

function RunStatus() {
  const activity = useActivity();
  const sep = (activity || "thinking|thinking").indexOf("|");
  const kind = sep < 0 ? "thinking" : activity.slice(0, sep);
  const label = sep < 0 ? activity : activity.slice(sep + 1);
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const t = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(t);
  }, []);
  const Icon =
    kind === "tool" ? WrenchIcon : kind === "reasoning" ? BrainIcon : kind === "question" ? HelpCircleIcon : null;
  if (kind === "writing") return null; // text streams with typing effect instead
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-2 text-[13px]">
      {Icon ? (
        <span className="flex min-w-0 items-center gap-1.5 text-foreground/55">
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
      ) : (
        <ShimmerLabel className="text-foreground/55">thinking…</ShimmerLabel>
      )}
      <span className="font-mono text-[11px] tracking-tight text-foreground/35 tabular-nums">
        {secs}s
      </span>
    </div>
  );
}

/* ---------------- interactive questions ---------------- */

function QuestionCards() {
  let questions = [];
  let extras = null;
  try {
    questions = useOpenCodeQuestions();
    extras = useOpenCodeRuntimeExtras();
  } catch {
    return null; // thread not backed by a session yet
  }
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState({});
  if (!questions.length || !extras) return null;

  const toggle = (qid, qi, label, multiple) => {
    const key = `${qid}:${qi}`;
    setSel((s) => {
      const cur = s[key] || [];
      const next = multiple
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      return { ...s, [key]: next };
    });
  };

  const submit = async (q) => {
    setBusy((b) => ({ ...b, [q.id]: true }));
    try {
      const answers = (q.questions || []).map((_, qi) => sel[`${q.id}:${qi}`] || []);
      await extras.replyToQuestion(q.id, answers);
      setSel((s) => {
        const next = { ...s };
        Object.keys(next)
          .filter((k) => k.startsWith(q.id + ":"))
          .forEach((k) => delete next[k]);
        return next;
      });
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[q.id];
        return next;
      });
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-2">
      {questions.map((q) => (
        <div
          key={q.id}
          className="fade-in slide-in-from-bottom-1 animate-in rounded-[20px] border border-border/60 bg-popover p-4 duration-300"
        >
          <p className="mb-3 flex items-center gap-2 text-[13.5px] font-medium">
            <span>❓</span> needs your input
          </p>
          {(q.questions || []).map((item, qi) => (
            <div key={qi} className="mb-3 last:mb-0">
              <p className="mb-1.5 text-sm text-foreground/80">{item.question}</p>
              <div className="flex flex-wrap gap-1.5">
                {(item.options || []).map((opt) => {
                  const label = opt.label || String(opt);
                  const active = (sel[`${q.id}:${qi}`] || []).includes(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => toggle(q.id, qi, label, item.multiple)}
                      title={opt.description || ""}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[13px] transition",
                        active
                          ? "border-foreground/40 bg-foreground/[0.08]"
                          : "border-border/60 hover:bg-foreground/[0.05]",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={!!busy[q.id]}
              onClick={() => extras.rejectQuestion(q.id)}
              className="h-8 rounded-full px-3.5 text-xs font-medium text-foreground/55 transition hover:bg-foreground/[0.06] disabled:opacity-40"
            >
              Dismiss
            </button>
            <button
              type="button"
              disabled={!!busy[q.id]}
              onClick={() => submit(q)}
              className="h-8 rounded-full bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
            >
              {busy[q.id] ? "Sending…" : "Answer"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- permission approvals ---------------- */

function PermissionApprovals() {
  let permApi = { pending: [], reply: async () => {} };
  try {
    permApi = useOpenCodePermissions();
  } catch {
    return null; // thread not backed by a session yet
  }
  const { pending, reply } = permApi;
  const [busy, setBusy] = useState({});
  if (!pending.length) return null;
  const respond = async (id, response) => {
    setBusy((b) => ({ ...b, [id]: response === "reject" ? "denied" : "running" }));
    try {
      await reply(id, response);
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-2">
      {pending.map((p) => (
        <ApprovalCard
          key={p.id}
          state={busy[p.id] ?? "request"}
          title={p.title || p.toolName || "Permission requested"}
          subtitle={(p.patterns || []).join(", ") || p.sessionId}
          command={
            typeof p.toolInput === "string"
              ? p.toolInput
              : JSON.stringify(p.toolInput ?? {}, null, 2)
          }
          onAllowOnce={() => respond(p.id, "once")}
          onAlwaysAllow={() => respond(p.id, "always")}
          onDeny={() => respond(p.id, "reject")}
        />
      ))}
    </div>
  );
}

/* ---------------- model menu (top bar, ChatGPT style) ---------------- */

export function ModelMenu({ model, onPick, allModels, connected }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const match = (m) =>
    !q || m.modelID.toLowerCase().includes(q) || m.providerID.toLowerCase().includes(q);
  const free = allModels.filter((m) => m.free && match(m));
  const rest = allModels.filter((m) => !m.free && match(m)).slice(0, 300);
  const items = [
    ...free.map((m) => ({
      id: `${m.providerID}/${m.modelID}`,
      name: `★ ${m.modelID}`,
      family: "Free",
      context: "",
      price: "",
      capabilities: [m.providerID],
    })),
    ...rest.map((m) => ({
      id: `${m.providerID}/${m.modelID}`,
      name: m.modelID,
      family: connected.includes(m.providerID) ? `● ${m.providerID}` : m.providerID,
      context: "",
      price: "",
      capabilities: [],
    })),
  ];
  return (
    <div className="relative">
      <button
        className="flex max-w-72 items-center gap-1 rounded-lg px-2 py-1.5 text-[15px] font-medium text-foreground/80 transition hover:bg-foreground/[0.05] hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
        title="Pick model"
      >
        <span className="truncate">
          {model.providerID}/{model.modelID}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-foreground/40" />
      </button>
      {!open ? null : (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="fade-in zoom-in-95 animate-in absolute left-0 top-full z-20 mt-1 w-[380px] max-w-[84vw] duration-150">
            <div className="mb-1.5">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                className="w-full rounded-xl border border-border/60 bg-background px-3 py-1.5 text-sm outline-none placeholder:text-foreground/35"
              />
            </div>
            <div className="max-h-[50vh] scroll-pane overflow-y-auto">
              <ModelPicker
                models={items}
                selectedId={`${model.providerID}/${model.modelID}`}
                onSelect={(id) => {
                  const [providerID, ...restId] = id.split("/");
                  onPick({ providerID, modelID: restId.join("/") });
                  setOpen(false);
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- composer ---------------- */

function AttachChip({ attachment }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (attachment.type === "image" && attachment.file) {
      const u = URL.createObjectURL(attachment.file);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }
  }, [attachment]);
  const size = attachment.file
    ? attachment.file.size > 1024 * 1024
      ? `${(attachment.file.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(attachment.file.size / 1024))} KB`
    : "";
  return (
    <AttachmentPrimitive.Root
      className={cn(field, "flex items-center gap-2 rounded-xl py-1.5 ps-1.5 pe-2")}
    >
      {url ? (
        <img src={url} alt={attachment.name} className="size-8 rounded-lg object-cover" />
      ) : (
        <span className="flex size-8 items-center justify-center rounded-lg bg-background text-[11px] text-foreground/45">
          {attachment.type === "image" ? "img" : "file"}
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="max-w-36 truncate text-xs font-medium">
          <AttachmentPrimitive.Name />
        </span>
        <span className="text-[11px] text-foreground/40">{size || attachment.type}</span>
      </span>
      <AttachmentPrimitive.Remove
        className={cn(ghostButton, "size-5 [&_svg]:size-3")}
        title="Remove"
      >
        ×
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function SendButton() {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const canSend = useAuiState((s) => s.composer.canSend);
  if (isRunning) {
    return <ComposerSend streaming idle={false} onClick={() => aui.thread.cancelRun()} />;
  }
  return (
    <ComposerPrimitive.Send asChild>
      <ComposerSend streaming={false} idle={!canSend} />
    </ComposerPrimitive.Send>
  );
}

export function Composer() {
  return (
    <ComposerPrimitive.AttachmentDropzone className="w-full rounded-[28px] data-[dragging]:outline-2 data-[dragging]:outline-blue-500 data-[dragging]:outline-offset-4">
      <ComposerPrimitive.Root>
        <ComposerBar className="rounded-[28px]">
        <div className="px-1 pt-1 empty:hidden">
          <ComposerAttachments>
            <ComposerPrimitive.Attachments>
              {({ attachment }) => <AttachChip attachment={attachment} />}
            </ComposerPrimitive.Attachments>
          </ComposerAttachments>
        </div>
        <ComposerPrimitive.Input
          placeholder="Ask anything (attach any file)"
          className="min-h-11 w-full resize-none bg-transparent px-3 text-[15px] outline-none placeholder:text-foreground/35"
          rows={1}
        />
        <ComposerToolbar className="px-1 pb-1">
          <ComposerActions>
            <ComposerPrimitive.AddAttachment asChild>
              <ComposerAttachButton title="Attach any file" />
            </ComposerPrimitive.AddAttachment>
          </ComposerActions>
          <SendButton />
        </ComposerToolbar>
        </ComposerBar>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.AttachmentDropzone>
  );
}

/* ---------------- thread ---------------- */

export function ChatThread() {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 scroll-pane flex-col overflow-y-auto">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <div className="flex min-h-full flex-col items-center justify-center px-4">
            <h1 className="fade-in slide-in-from-bottom-2 animate-in fill-mode-both text-center text-[28px] font-medium tracking-tight duration-500">
              What can I help with?
            </h1>
          </div>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isEmpty}>
          <div className="flex flex-col pb-2 pt-4">
            <ThreadPrimitive.Messages>
              {({ message }) => {
                if (message.composer.isEditing) return <EditComposer />;
                return message.role === "user" ? <UserMessage /> : <AssistantMessage />;
              }}
            </ThreadPrimitive.Messages>
            <AuiIf condition={(s) => s.thread.isRunning}>
              <RunStatus />
            </AuiIf>
            <PermissionApprovals />
            <QuestionCards />
          </div>
        </AuiIf>
        <div className="sticky bottom-0 z-10 flex justify-center pb-1">
          <ThreadPrimitive.ScrollToBottom
            behavior="smooth"
            className="fade-in animate-in pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-popover px-3 py-1.5 text-xs text-foreground/70 shadow-xl transition duration-200 hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
          >
            ↓ Latest
          </ThreadPrimitive.ScrollToBottom>
        </div>
      </ThreadPrimitive.Viewport>
      <div className="shrink-0 bg-gradient-to-t from-background via-background to-transparent px-4 pb-1 pt-4">
        <div className="mx-auto w-full max-w-3xl">
          <Composer />
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}
