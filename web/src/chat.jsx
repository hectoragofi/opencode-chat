import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  useOpenCodePermissions,
  useOpenCodeQuestions,
  useOpenCodeRuntimeExtras,
  useOpenCodeSession,
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
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  HelpCircleIcon,
  ImageIcon,
  LayersIcon,
  PresentationIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { field, ghostButton, ShimmerLabel } from "./components/surfaces";
import {
  ComposerActions,
  ComposerAttachButton,
  ComposerAttachments,
  ComposerBar,
  ComposerContext,
  ComposerSend,
  ComposerToolbar,
} from "./components/composer";
import { ApprovalCard } from "./components/approval-card";
import { ModelPicker } from "./components/model-picker";
import {
  EmptyState,
  EmptyStateGreeting,
  EmptyStateSuggestion,
  EmptyStateSuggestions,
} from "./components/empty-state";
import { loadRecentModels, saveRecentModel } from "./models.js";

/* ---------------- thread list (sidebar, Codex-style) ---------------- */

// The runtime exposes thread items as an ARRAY of { id, remoteId, title,
// ... } (not a keyed record, despite what the .d.ts suggests). Index it by
// both ids so rows resolve titles and session ids reliably.
export function indexThreadItems(threadItems) {
  if (!threadItems || typeof threadItems !== "object") return {};
  if (!Array.isArray(threadItems)) return threadItems; // newer versions: already a record
  const out = {};
  for (const it of threadItems) {
    if (!it || typeof it !== "object") continue;
    if (it.id) out[it.id] = it;
    if (it.remoteId) out[it.remoteId] = it;
  }
  return out;
}

// One chat row. Everything flows through the runtime thread state — titles
// update live and rename / delete / switch need no remount tricks.
function ChatRow({
  title,
  isActive,
  renaming,
  draft,
  setDraft,
  saving,
  error,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onSwitch,
  onDelete,
  draggable,
  onDragStart,
  onDragEnd,
}) {
  if (renaming) {
    return (
      <div className="group flex items-center gap-1 rounded-lg bg-foreground/[0.07]">
        <span className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveRename();
              if (e.key === "Escape") onCancelRename();
            }}
            placeholder="Name this chat…"
            maxLength={120}
            className="min-w-0 flex-1 rounded-lg bg-foreground/[0.06] px-2 py-1 text-[13px] outline-none ring-1 ring-foreground/20"
          />
          <button
            onClick={onSaveRename}
            disabled={saving || !draft.trim()}
            className="shrink-0 rounded-full p-1 text-emerald-500 transition hover:bg-foreground/[0.06] disabled:opacity-40"
            title="Save name (Enter)"
          >
            {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
          </button>
          <button
            onClick={onCancelRename}
            className="shrink-0 rounded-full p-1 text-foreground/45 transition hover:bg-foreground/[0.06] hover:text-foreground"
            title="Cancel (Esc)"
          >
            <XCircleIcon className="size-3.5" />
          </button>
        </span>
      </div>
    );
  }
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title={error || undefined}
      className={cn(
        "group flex items-center gap-1 rounded-lg transition-colors hover:bg-foreground/[0.05]",
        isActive && "bg-foreground/[0.07]",
        error && "ring-1 ring-red-500/40",
      )}
    >
      <button
        onClick={onSwitch}
        className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm outline-none"
        title={title}
      >
        {title || "New chat"}
      </button>
      {error ? (
        <span className="shrink-0 pr-1 text-xs font-bold text-red-400" title={error}>!</span>
      ) : null}
      <button
        data-no-drag
        onClick={onStartRename}
        className="hidden shrink-0 rounded-full p-1.5 text-foreground/45 transition group-hover:block hover:bg-foreground/[0.06] hover:text-foreground"
        title="Rename chat — or drag it into a folder"
      >
        <PencilIcon className="size-3.5" />
      </button>
      <button
        data-no-drag
        onClick={onDelete}
        className="hidden shrink-0 rounded-full p-1.5 text-foreground/45 transition group-hover:block hover:bg-foreground/[0.06] hover:text-red-400"
        title="Delete"
      >
        <Trash2Icon className="size-3.5" />
      </button>
    </div>
  );
}

export function ChatSidebar({
  onNavigate,
  sessionMap,
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onEditProject,
  onOpenSkills,
  onMoveSession,
} = {}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState({}); // projectId -> true
  const [renamingId, setRenamingId] = useState(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState(null); // { threadId, message }
  const [dragId, setDragId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // projectId | "__general" | null

  const aui = useAui();
  let threadsState = null;
  try {
    threadsState = useAuiState((s) => s.optional.threads);
  } catch {
    threadsState = null;
  }
  const threadIds = threadsState?.threadIds || [];
  const threadIndex = useMemo(
    () => indexThreadItems(threadsState?.threadItems),
    [threadsState],
  );
  const mainThreadId = threadsState?.mainThreadId;
  const isLoading = !!threadsState?.isLoading;
  const loadError = threadsState?.loadError;
  const q = query.trim().toLowerCase();

  const projectById = useMemo(
    () => Object.fromEntries((projects || []).map((p) => [p.id, p])),
    [projects],
  );

  // Partition threads into folders, preserving runtime order. Chats in
  // unknown or deleted projects fall back to general.
  const groups = useMemo(() => {
    const out = { __general: [] };
    for (const tid of threadIds) {
      const item = threadIndex[tid] || {};
      const sid = item.remoteId || tid;
      const pid = sessionMap?.[sid];
      const key = pid && projectById[pid] ? pid : "__general";
      const title = item.title || "New chat";
      if (q && !title.toLowerCase().includes(q)) continue;
      (out[key] || (out[key] = [])).push({
        threadId: tid,
        sessionId: sid,
        title,
        hasRemote: !!item.remoteId,
      });
    }
    return out;
  }, [threadIds, threadIndex, sessionMap, projectById, q]);

  const mainItem = mainThreadId ? threadIndex[mainThreadId] : null;
  const openSid = mainItem?.remoteId || mainThreadId || null;
  const openProjectId = openSid ? sessionMap?.[openSid] : null;
  const totalVisible = Object.values(groups).reduce((a, l) => a + l.length, 0);

  // Every new thread announces its intent up front (window.__ocPendingProject);
  // SessionTagger files it into that project on arrival — and only then.
  // Clicking an existing chat never moves it.
  const startNewChat = (projectId) => {
    const target = projectId !== undefined ? projectId : activeProjectId;
    window.__ocPendingProject = target || null;
    try {
      aui.threads.switchToNewThread()?.catch?.(() => {});
    } catch {
      /* engine down — the main view surfaces the error */
    }
  };

  // Ctrl+Shift+O starts a new chat from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleCollapse = (id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const newChatHere = (id) => {
    onSelectProject?.(id);
    setCollapsed((c) => ({ ...c, [id]: false }));
    startNewChat(id);
  };

  const switchTo = (threadId) => {
    try {
      aui.threads.switchToThread(threadId)?.catch?.(() => {});
    } catch {
      /* ignore */
    }
    onNavigate?.();
  };

  const startRename = (threadId, title) => {
    setRenamingId(threadId);
    setDraft(title === "New chat" ? "" : title);
    setRowError(null);
  };
  const saveRename = async (threadId, current) => {
    const name = draft.trim();
    if (!name || name === current) {
      setRenamingId(null);
      return;
    }
    setSaving(true);
    setRowError(null);
    try {
      await aui.threads.getItemById(threadId).rename(name);
      setRenamingId(null);
    } catch (e) {
      setRowError({ threadId, message: String(e?.message || e) });
    } finally {
      setSaving(false);
    }
  };
  const removeChat = async (threadId) => {
    try {
      await aui.threads.getItemById(threadId).delete();
    } catch (e) {
      setRowError({ threadId, message: String(e?.message || e) });
    }
  };
  const retryLoad = async () => {
    try {
      await aui.threads.reload();
    } catch {
      /* still down — error persists */
    }
  };

  /* ----- drag chats between folders ----- */
  const rowDragStart = (sid) => (e) => {
    if (e.target.closest("input,textarea,[data-no-drag]")) {
      e.preventDefault();
      return;
    }
    try {
      e.dataTransfer.setData("text/plain", sid);
      e.dataTransfer.effectAllowed = "move";
    } catch {
      /* ignore */
    }
    setDragId(sid);
    setDropTarget(null);
  };
  const endDrag = () => {
    setDragId(null);
    setDropTarget(null);
  };
  const groupDragOver = (key) => (e) => {
    if (!dragId) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {
      /* ignore */
    }
    setDropTarget((t) => (t === key ? t : key));
  };
  const groupDrop = (projectIdOrNull) => (e) => {
    e.preventDefault();
    let sid = dragId;
    try {
      sid = e.dataTransfer.getData("text/plain") || dragId;
    } catch {
      /* ignore */
    }
    endDrag();
    if (sid) onMoveSession?.(sid, projectIdOrNull);
  };

  const renderRow = (c) => (
    <ChatRow
      key={c.threadId}
      title={c.title}
      isActive={c.threadId === mainThreadId}
      renaming={renamingId === c.threadId}
      draft={draft}
      setDraft={setDraft}
      saving={saving}
      error={rowError?.threadId === c.threadId ? rowError.message : null}
      onStartRename={() => startRename(c.threadId, c.title)}
      onSaveRename={() => saveRename(c.threadId, c.title)}
      onCancelRename={() => setRenamingId(null)}
      onSwitch={() => switchTo(c.threadId)}
      onDelete={() => removeChat(c.threadId)}
      draggable={!!c.hasRemote}
      onDragStart={rowDragStart(c.sessionId)}
      onDragEnd={endDrag}
    />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-px p-3 pb-1">
        <button
          onClick={() => startNewChat()}
          className="flex flex-1 items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-foreground/[0.05]"
          title="New chat (Ctrl+Shift+O)"
        >
          <PlusIcon className="size-4" />
          New chat
        </button>
        <button
          onClick={() => onOpenSkills?.()}
          className="flex flex-1 items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-foreground/[0.05]"
          title="Skills — reusable assistant capabilities"
        >
          <LayersIcon className="size-4" />
          Skills
        </button>
      </div>
      <div className="shrink-0 px-3 pb-2 pt-1">
        <label className="flex items-center gap-2 rounded-xl bg-foreground/[0.04] px-3 py-1.5 dark:bg-foreground/[0.06]">
          <SearchIcon className="size-3.5 shrink-0 text-foreground/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-foreground/35"
          />
          {!q ? null : (
            <button onClick={() => setQuery("")} className="text-foreground/40 hover:text-foreground" title="Clear">
              <XCircleIcon className="size-3.5" />
            </button>
          )}
        </label>
      </div>
      <div className="min-h-0 flex-1 scroll-pane overflow-y-auto px-2 pb-2">
        <div className="flex items-center px-3 pb-1 pt-1">
          <span className="font-mono text-[11px] tracking-tight text-foreground/35">Projects</span>
          <span className="flex-1" />
          <button
            onClick={() => onNewProject?.()}
            className="rounded-full p-1 text-foreground/45 transition hover:bg-foreground/[0.06] hover:text-foreground"
            title="New project"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>
        <div className="flex flex-col gap-px">
          {(projects || []).map((p) => {
            const active = p.id === activeProjectId;
            const shut = !!collapsed[p.id] && !q && openProjectId !== p.id;
            const chats = groups[p.id] || [];
            const dropping = dragId && dropTarget === p.id;
            if (q && !chats.length) return null;
            return (
              <div key={p.id}>
                <div
                  onDragOver={groupDragOver(p.id)}
                  onDrop={groupDrop(p.id)}
                  className={cn(
                    "group flex items-center gap-0.5 rounded-lg transition-colors hover:bg-foreground/[0.05]",
                    active && "bg-foreground/[0.07]",
                    dropping && "bg-foreground/[0.08] ring-1 ring-foreground/25",
                  )}
                >
                  <button
                    onClick={() => toggleCollapse(p.id)}
                    className="shrink-0 rounded-md p-1.5 text-foreground/40 transition hover:text-foreground"
                    title={shut ? "Expand" : "Collapse"}
                  >
                    <ChevronDownIcon className={cn("size-3.5 transition-transform", shut && "-rotate-90")} />
                  </button>
                  <button
                    onClick={() => {
                      onSelectProject?.(active ? null : p.id);
                      if (!active) setCollapsed((c) => ({ ...c, [p.id]: false }));
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 truncate px-1 py-2 text-left text-sm outline-none"
                    title={p.description ? `${p.name}\n${p.description}` : `${p.name} — drag chats here to file them`}
                  >
                    <FolderIcon className={cn("size-3.5 shrink-0", active ? "text-foreground" : "text-foreground/45")} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </button>
                  <button
                    onClick={() => newChatHere(p.id)}
                    className="hidden shrink-0 rounded-full p-1.5 text-foreground/45 transition group-hover:block hover:bg-foreground/[0.06] hover:text-foreground"
                    title={`New chat in ${p.name}`}
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                  <button
                    onClick={() => onEditProject?.(p)}
                    className="hidden shrink-0 rounded-full p-1.5 text-foreground/45 transition group-hover:block hover:bg-foreground/[0.06] hover:text-foreground"
                    title="Project settings"
                  >
                    <PencilIcon className="size-3.5" />
                  </button>
                </div>
                <div className={cn("flex flex-col gap-px pl-[26px]", shut && "hidden")}>
                  {chats.map(renderRow)}
                  {!q && !chats.length ? (
                    <p className="px-3 py-1.5 text-[13px] text-foreground/35">
                      {dragId ? "Drop chats here" : "No chats yet"}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
          {!(projects || []).length ? (
            <button
              onClick={() => onNewProject?.()}
              className="mx-1 rounded-lg px-3 py-2 text-left text-[13px] text-foreground/45 transition hover:bg-foreground/[0.05] hover:text-foreground"
            >
              New project
            </button>
          ) : null}
        </div>
        <div
          onDragOver={groupDragOver("__general")}
          onDrop={groupDrop(null)}
          className={cn(
            "rounded-xl",
            dragId && "mt-1 min-h-16 border border-dashed border-foreground/25",
            dragId && dropTarget === "__general" && "bg-foreground/[0.06]",
          )}
        >
          <div className="px-3 pb-1 pt-3 font-mono text-[11px] tracking-tight text-foreground/35">
            {dragId ? "Chats — drop here to remove from project" : "Chats"}
          </div>
          <div className="flex flex-col gap-px">
            {(groups.__general || []).map(renderRow)}
          </div>
        </div>
        {isLoading && !threadIds.length ? (
          <p className="px-5 py-4 text-[13px] text-foreground/40">Loading chats…</p>
        ) : null}
        {!isLoading && loadError && !threadIds.length ? (
          <div className="flex flex-col items-start gap-2 px-5 py-4">
            <p className="text-[13px] text-red-400">Couldn&apos;t load chats — is the AI engine running?</p>
            <button
              onClick={retryLoad}
              className="rounded-full border border-border/60 px-3 py-1 text-xs transition hover:bg-foreground/[0.05]"
            >
              Retry
            </button>
          </div>
        ) : null}
        {!isLoading && q && !totalVisible ? (
          <p className="px-3 py-4 text-center text-[13px] text-foreground/40">
            No chats match “{query.trim()}”.
          </p>
        ) : null}
      </div>
    </div>
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

function codeText(children) {
  let out = "";
  const walk = (n) => {
    if (typeof n === "string") out += n;
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object" && "props" in n) walk(n.props.children);
  };
  walk(children);
  return out;
}

function CodeBlock({ node: _node, children, ...props }) {
  const [copied, setCopied] = useState(false);
  const boxRef = useRef(null);
  // Fences with nothing (or only whitespace) inside render as a big empty
  // dark box — collapse them instead of showing a dead block.
  if (!codeText(children).trim()) return null;
  const copy = async () => {
    try {
      const text = boxRef.current?.querySelector("code")?.innerText ?? "";
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <span className="group/code relative my-2 block max-w-full" ref={boxRef}>
      <pre className="!m-0 max-w-full pr-11" {...props}>
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        title={copied ? "Copied" : "Copy code"}
        className="absolute right-2 top-2 rounded-lg border border-border/60 bg-background p-1.5 text-foreground/55 opacity-0 shadow-sm transition group-hover/code:opacity-100 hover:text-foreground focus:opacity-100"
      >
        {copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />}
      </button>
    </span>
  );
}

// Wide GFM tables otherwise blow out the message column: rows stretch past
// the viewport and smear into full-width lines. The scroll wrapper keeps
// the table intact with horizontal scroll instead.
function MdTable({ node: _node, ...props }) {
  return (
    <div className="md-table-wrap not-prose my-2 max-w-full scroll-pane overflow-x-auto rounded-xl border border-border/60">
      <table className="w-max min-w-full border-collapse text-[13.5px]" {...props} />
    </div>
  );
}

const markdownComponents = {
  a: FileLink,
  table: MdTable,
  pre: CodeBlock,
  img: ({ node: _node, src, ...props }) => (
    <img
      {...props}
      src={toFilesPath(src) || src}
      loading="lazy"
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

const USER_COLLAPSE_LINES = 12;
const USER_COLLAPSE_CHARS = 1200;

function CollapseToggle({ open, label, onClick, className }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 text-xs text-foreground/45 transition hover:text-foreground",
        className,
      )}
    >
      <ChevronDownIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      {open ? "Show less" : label}
    </button>
  );
}

function UserText({ text }) {
  const [open, setOpen] = useState(false);
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
  const lineCount = text.split("\n").length;
  const collapsible = lineCount > USER_COLLAPSE_LINES || text.length > USER_COLLAPSE_CHARS;
  const collapsed = collapsible && !open;
  return (
    <>
      <div
        className={cn(
          field,
          "fade-in slide-in-from-bottom-1 animate-in relative min-w-0 max-w-full rounded-2xl rounded-br-lg px-3.5 py-2 text-[14.5px] duration-300",
          collapsed && "max-h-60 overflow-hidden",
        )}
      >
        <span className="whitespace-pre-wrap break-words">{text}</span>
        {!collapsed ? null : (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-14 rounded-b-2xl bg-gradient-to-t from-background/95 to-transparent" />
        )}
      </div>
      {!collapsible ? null : (
        <CollapseToggle open={open} label={`Show more · ${lineCount} lines`} onClick={() => setOpen((o) => !o)} />
      )}
    </>
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

// The opencode runtime splits image/file parts OUT of message content into
// message.attachments, so they only render through this primitive — the
// Image/File part slots alone never fire. Thumbnails first, text below.
function SentAttachment({ attachment }) {
  const [objUrl, setObjUrl] = useState(null);
  const part = (attachment.content || []).find((p) => p.type === "image" || p.type === "file");
  const file = attachment.file;
  useEffect(() => {
    if (part || !file) return;
    const u = URL.createObjectURL(file);
    setObjUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [part, file]);
  const name = attachment.name || part?.filename || "Attached file";
  const mime = part?.mimeType || part?.mime || attachment.contentType || "";
  const src =
    part?.type === "image"
      ? part.image
      : part?.type === "file" && (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(name))
        ? part.data
        : objUrl;
  if (src) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        title={name}
        className="block max-w-60 overflow-hidden rounded-xl border border-border/60"
      >
        <img src={src} alt={name} className="block max-h-60 w-auto object-cover" />
      </a>
    );
  }
  const href = part?.type === "file" && part?.data ? part.data : objUrl;
  const inner = (
    <span className={cn(field, "flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs")}>
      <FileIcon className="size-3.5 shrink-0 text-foreground/55" />
      <span className="max-w-48 truncate font-medium">{name}</span>
    </span>
  );
  return href ? (
    <a href={href} download={name} title={name}>
      {inner}
    </a>
  ) : (
    inner
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="group mx-auto flex w-full max-w-3xl justify-end px-4 py-2.5">
      <div className="flex min-w-0 max-w-[85%] flex-col items-end gap-1.5">
        <MessagePrimitive.Attachments>
          {({ attachment }) => <SentAttachment key={attachment.id} attachment={attachment} />}
        </MessagePrimitive.Attachments>
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

// Answers always render in full — only the owner's own oversized messages
// collapse (their huge pastes stay compact, replies stay complete).
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

// Live reasoning text of the current assistant turn, as one string.
// Same primitive-return rule as useToolTrace (see #185): a string that
// changes identity per chunk is fine — it settles when streaming stops.
// Capped so over-long thoughts can't blow up snapshot comparisons.
const MAX_THOUGHT_CHARS = 6000;
function useReasoningText() {
  try {
    return useOpenCodeThreadState((s) => {
      try {
        const ids = s.messageOrder || [];
        for (let i = ids.length - 1; i >= 0; i--) {
          const m = s.messagesById?.[ids[i]];
          if (!m || m.info?.role !== "assistant") continue;
          const texts = (m.parts || [])
            .filter((p) => p.type === "reasoning" && typeof p.text === "string" && p.text.trim())
            .map((p) => p.text.trim());
          if (!texts.length) return "";
          const joined = texts.join("\n\n");
          return joined.length > MAX_THOUGHT_CHARS
            ? "…" + joined.slice(-MAX_THOUGHT_CHARS)
            : joined;
        }
        return "";
      } catch {
        return "";
      }
    });
  } catch {
    return ""; // thread not backed by a session yet
  }
}

function toolElapsed(p) {
  const t = p.state?.time;
  if (!t?.start) return "";
  const end = t.end || Date.now();
  const s = Math.max(0, Math.round((end - t.start) / 1000));
  return s < 1 ? "" : `${s}s`;
}

function toolLabel(p) {
  const detail = p.state?.title || summarizeInput(p.state?.input);
  return `${p.tool}${detail ? ` · ${detail}` : ""}`;
}

// Completed + running tool calls of the current assistant turn, so Agent
// mode shows its work instead of only the final answer.
// NOTE: the selector must return a primitive (string) — returning an array
// gives a fresh reference on every snapshot and React loops forever (#185).
function useToolTrace() {
  let key = "[]";
  try {
    key = useOpenCodeThreadState((s) => {
      try {
        const ids = s.messageOrder || [];
        for (let i = ids.length - 1; i >= 0; i--) {
          const m = s.messagesById?.[ids[i]];
          if (!m || m.info?.role !== "assistant") continue;
          const parts = (m.parts || []).filter((p) => p.type === "tool");
          if (parts.length || (m.parts || []).some((p) => p.type === "text" && p.text)) {
            return JSON.stringify(parts.map((p) => ({
              id: p.id,
              tool: p.tool,
              status: p.state?.status || "pending",
              label: toolLabel(p),
              elapsed: toolElapsed(p),
              error: p.state?.status === "error" ? String(p.state?.error || "failed").slice(0, 160) : "",
            })));
          }
        }
        return "[]";
      } catch {
        return "[]";
      }
    });
  } catch {
    return []; // thread not backed by a session yet
  }
  return useMemo(() => {
    try {
      const v = JSON.parse(key);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }, [key]);
}

function RunStatus() {
  const activity = useActivity();
  const trace = useToolTrace();
  const reasoning = useReasoningText();
  const [open, setOpen] = useState(false);
  const [thoughtOpen, setThoughtOpen] = useState(false);
  const thoughtRef = useRef(null);
  const hadThought = useRef(false);
  // Open automatically the first time thoughts stream in; if the user
  // closes it, it stays closed for the rest of the run.
  useEffect(() => {
    if (reasoning && !hadThought.current) {
      hadThought.current = true;
      setThoughtOpen(true);
    }
  }, [reasoning]);
  // Stick to the bottom while new thought streams in.
  useEffect(() => {
    const el = thoughtRef.current;
    if (el && thoughtOpen) el.scrollTop = el.scrollHeight;
  }, [reasoning, thoughtOpen]);
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
  const done = (trace || []).filter((t) => t.status === "completed" || t.status === "error");
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1 px-4 py-2">
      <div className="flex items-center gap-2 text-[13px]">
        {Icon ? (
          <span className="flex min-w-0 items-center gap-1.5 text-foreground/55">
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
          </span>
        ) : kind === "writing" ? (
          <span className="flex min-w-0 items-center gap-1.5 text-foreground/55">
            <ShimmerLabel>writing answer…</ShimmerLabel>
          </span>
        ) : (
          <ShimmerLabel className="text-foreground/55">thinking…</ShimmerLabel>
        )}
        <span className="font-mono text-[11px] tracking-tight text-foreground/35 tabular-nums">
          {secs}s
        </span>
        {!reasoning ? null : (
          <button
            type="button"
            onClick={() => setThoughtOpen((o) => !o)}
            className="ml-1 flex items-center gap-0.5 rounded-full px-2 py-0.5 font-mono text-[11px] text-foreground/45 transition hover:bg-foreground/[0.06] hover:text-foreground"
            title={thoughtOpen ? "Hide thoughts" : "Show what it's thinking"}
          >
            <BrainIcon className="size-3" />
            Thoughts
            <ChevronDownIcon className={cn("size-3 transition-transform", thoughtOpen && "rotate-180")} />
          </button>
        )}
        {!done.length ? null : (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="ml-1 flex items-center gap-0.5 rounded-full px-2 py-0.5 font-mono text-[11px] text-foreground/45 transition hover:bg-foreground/[0.06] hover:text-foreground"
            title={open ? "Hide steps" : "Show steps"}
          >
            <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
            {done.length} step{done.length === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {!thoughtOpen || !reasoning ? null : (
        <div
          ref={thoughtRef}
          className="scroll-pane max-h-64 overflow-y-auto rounded-xl border border-border/60 bg-foreground/[0.02] px-3 py-2"
        >
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/70">{reasoning}</p>
        </div>
      )}
      {!open || !done.length ? null : (
        <div className="flex flex-col gap-0.5 rounded-xl border border-border/60 bg-foreground/[0.02] p-1.5">
          {done.slice(-8).map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-1.5 py-1 text-xs" title={t.error || t.label}>
              {t.status === "error" ? (
                <XCircleIcon className="size-3.5 shrink-0 text-red-400" />
              ) : (
                <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
              )}
              <span className="min-w-0 flex-1 truncate text-foreground/65">{t.label}</span>
              {!t.elapsed ? null : (
                <span className="shrink-0 font-mono text-[10px] text-foreground/35 tabular-nums">{t.elapsed}</span>
              )}
            </div>
          ))}
        </div>
      )}
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
  const [recent, setRecent] = useState(() => loadRecentModels());
  const q = query.trim().toLowerCase();
  const match = (m) =>
    !q ||
    m.modelID.toLowerCase().includes(q) ||
    m.providerID.toLowerCase().includes(q) ||
    (m.name || "").toLowerCase().includes(q) ||
    (m.family || "").toLowerCase().includes(q);
  const byId = new Map(allModels.map((m) => [`${m.providerID}/${m.modelID}`, m]));
  const recentItems = recent
    .map((r) => byId.get(`${r.providerID}/${r.modelID}`))
    .filter(Boolean)
    .filter(match)
    .slice(0, 5);
  const free = allModels.filter((m) => m.free && match(m));
  const rest = allModels
    .filter((m) => !m.free && match(m))
    .sort((a, b) => {
      const ac = connected.includes(a.providerID) ? 0 : 1;
      const bc = connected.includes(b.providerID) ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return (a.modelID || "").localeCompare(b.modelID || "");
    })
    .slice(0, 300);
  const toItem = (m, familyOverride, star) => ({
    id: `${m.providerID}/${m.modelID}`,
    name: star ? `★ ${m.name || m.modelID}` : m.name || m.modelID,
    family: familyOverride || m.family || m.providerID,
    context: m.context || "",
    price: m.price || "",
    capabilities: (m.capabilities || []).slice(0, 3),
  });
  const items = [
    ...(!q ? recentItems.map((m) => toItem(m, "Recent")) : []),
    ...free.map((m) => toItem(m, "Free", true)),
    ...rest.map((m) =>
      toItem(m, connected.includes(m.providerID) ? `● ${m.family || m.providerID}` : m.family || m.providerID)
    ),
  ];
  const pick = (id) => {
    const [providerID, ...restId] = id.split("/");
    const next = { providerID, modelID: restId.join("/") };
    saveRecentModel(next);
    setRecent(loadRecentModels());
    onPick(next);
    setOpen(false);
    setQuery("");
  };
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
              {!items.length ? (
                <p className="px-3 py-6 text-center text-sm text-foreground/45">No models match “{query.trim()}”.</p>
              ) : (
                <ModelPicker
                  models={items}
                  selectedId={`${model.providerID}/${model.modelID}`}
                  onSelect={pick}
                />
              )}
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
  const coreRunning = useAuiState((s) => s.thread.isRunning);
  // The core flag can lag the engine (busy/retry phases between steps, long
  // tool calls) — union it with the opencode session state so the button is
  // in stop mode for the whole run, not just while tokens stream.
  let ocBusy = null;
  try {
    ocBusy = useOpenCodeThreadState((s) => {
      const rs = s.runState?.type;
      const ss = s.sessionStatus?.type;
      return (
        rs === "streaming" ||
        rs === "cancelling" ||
        rs === "reverting" ||
        ss === "busy" ||
        ss === "retry"
      );
    });
  } catch {
    ocBusy = null; // thread not backed by a session yet
  }
  const isRunning = ocBusy ?? coreRunning;
  const canSend = useAuiState((s) => s.composer.canSend);
  // Sticky stopping: one abort doesn't always take (mid-tool execution,
  // state transitions). Keep the stop/Square state and re-fire abort every
  // 2.5s until the run actually dies (max 3 retries), then release.
  const [stopping, setStopping] = useState(false);
  const attempts = useRef(0);
  useEffect(() => {
    if (!isRunning) {
      setStopping(false);
      attempts.current = 0;
      return;
    }
    if (!stopping || attempts.current >= 3) return;
    const t = setTimeout(() => {
      attempts.current += 1;
      try {
        aui.thread.cancelRun();
      } catch {
        /* run failed locally — nothing more to abort */
      }
    }, 2500);
    return () => clearTimeout(t);
  }, [isRunning, stopping, aui]);
  if (isRunning) {
    return (
      <ComposerSend
        streaming
        idle={false}
        title={stopping ? "Stopping… (click to force again)" : "Stop generating"}
        className={stopping ? "animate-pulse" : undefined}
        onClick={() => {
          setStopping(true);
          try {
            aui.thread.cancelRun();
          } catch {
            /* ignore */
          }
        }}
      />
    );
  }
  return (
    <ComposerPrimitive.Send asChild>
      <ComposerSend streaming={false} idle={!canSend} />
    </ComposerPrimitive.Send>
  );
}

function useContextUsage() {
  let session = null;
  let limit = 0;
  try {
    session = useOpenCodeSession();
    limit = useOpenCodeThreadState((s) => {
      try {
        const model = s.session?.model;
        if (!model) return 0;
        return 0; // resolved below via window model metadata
      } catch {
        return 0;
      }
    });
  } catch {
    return null; // thread not backed by a session yet
  }
  void limit;
  const tokens = session?.tokens;
  if (!tokens) return null;
  const used = (tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0);
  if (!used) return null;
  // Model limit comes from the picker metadata cached on window by App.
  const total = (typeof window !== "undefined" && window.__ocModelLimit) || 200000;
  return {
    system: 0,
    tools: Math.round(((tokens.cache?.read || 0) + (tokens.cache?.write || 0)) / 1000),
    messages: Math.max(0, Math.round(used / 1000) - Math.round(((tokens.cache?.read || 0) + (tokens.cache?.write || 0)) / 1000)),
    total: Math.max(1, Math.round(total / 1000)),
  };
}

export function Composer() {
  const usage = useContextUsage();
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
          className="max-h-48 min-h-11 w-full resize-none bg-transparent px-3 text-[15px] outline-none placeholder:text-foreground/35"
          rows={1}
        />
        <ComposerToolbar className="px-1 pb-1">
          <ComposerActions>
            <ComposerPrimitive.AddAttachment asChild>
              <ComposerAttachButton title="Attach any file" />
            </ComposerPrimitive.AddAttachment>
            {!usage ? null : <ComposerContext usage={usage} />}
          </ComposerActions>
          <span className="hidden text-[11px] text-foreground/30 sm:block">Enter to send · Shift+Enter for a new line</span>
          <SendButton />
        </ComposerToolbar>
        </ComposerBar>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.AttachmentDropzone>
  );
}

const SUGGESTIONS = [
  "Make me a one-page PDF summary of…",
  "Turn this spreadsheet into a chart…",
  "Draft a Word doc for…",
  "Build a slide deck about…",
];

function fillComposer(text) {
  const el = document.querySelector("[data-composer-input], textarea[placeholder*='Ask anything']");
  if (el) {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(el.__proto__, "value")?.set
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("change", { bubbles: true }));
  }
}

export function EmptyHome() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-10">
      <EmptyState>
        <EmptyStateGreeting>What can I help with?</EmptyStateGreeting>
        <EmptyStateSuggestions>
          {SUGGESTIONS.map((s, i) => (
            <EmptyStateSuggestion key={s} index={i} onClick={() => fillComposer(s)}>
              {s}
            </EmptyStateSuggestion>
          ))}
        </EmptyStateSuggestions>
      </EmptyState>
      <p className="mt-6 max-w-sm text-center text-xs leading-relaxed text-foreground/35">
        Tip: ask for a PDF, Word, Excel or PowerPoint file and it appears right in the chat.
      </p>
    </div>
  );
}

/* ---------------- thread ---------------- */

export function ChatThread() {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 min-w-0 flex-col">
      {/* overflow-x-clip: one over-wide message (huge table/code) can never
          stretch the column again — inner scrollers (tables, pre) still work. */}
      <ThreadPrimitive.Viewport className="flex min-h-0 min-w-0 flex-1 scroll-pane flex-col overflow-y-auto overflow-x-clip">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <EmptyHome />
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
