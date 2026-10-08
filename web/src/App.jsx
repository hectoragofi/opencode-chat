import React, { useEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react";
import { useOpenCodeRuntime, useOpenCodeSession, useOpenCodeThreadState } from "@assistant-ui/react-opencode";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  MessageCircleIcon,
  PanelLeftIcon,
  ShareIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { field } from "./components/surfaces";
import { ChatSidebar, ChatThread, ModelMenu, indexThreadItems } from "./chat.jsx";
import { chatAttachmentAdapter } from "./attachments.jsx";
import { DEFAULT_MODEL, FREE_MODELS, fetchAllModels, load, save } from "./models.js";
import { SettingsIcon } from "lucide-react";
import { AccountButton, AccountsDialog } from "./accounts.jsx";
import { Onboarding, useSetupStatus } from "./onboarding.jsx";
import { SettingsDialog } from "./settings.jsx";
import { UpdateBanner, VersionFooter } from "./updater.jsx";
import {
  fetchProjects,
  fetchSessionMap,
  loadActiveProject,
  projectAgentId,
  saveActiveProject,
  tagSession,
} from "./projects.js";
import {
  ProjectDialog,
  ProjectSettingsDialog,
} from "./components/projects.jsx";
import { SkillsDialog } from "./components/skills-dialog.jsx";

const isFree = (m) =>
  FREE_MODELS.some((f) => f.providerID === m.providerID && f.modelID === m.modelID);

class ChatErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="m-auto flex max-w-md flex-col items-center gap-3 px-6 text-center">
          <p className="text-sm text-red-400">
            Chat crashed: {String(this.state.error?.message || this.state.error)}
          </p>
          <button
            className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function ShareButton() {
  const session = useOpenCodeSession();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const share = async () => {
    if (!session || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/session/${session.id}/share`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUrl(data?.share?.url || data?.url || null);
    } catch {
      setUrl(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        className="flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1.5 text-sm transition hover:bg-foreground/[0.05] disabled:opacity-40"
        disabled={!session}
        title={session ? "Share this chat" : "Open a chat to share it"}
        onClick={() => {
          setOpen((o) => !o);
          setCopied(false);
          if (!url) share();
        }}
      >
        <ShareIcon className="size-3.5" />
        Share
      </button>
      {!open ? null : (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="fade-in zoom-in-95 animate-in absolute right-0 top-full z-20 mt-2 w-80 rounded-2xl border border-border/60 bg-popover p-3 shadow-xl duration-150">
            {busy ? (
              <p className="text-sm text-foreground/55">Creating link…</p>
            ) : url ? (
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={url}
                  onFocus={(e) => e.target.select()}
                  className="min-w-0 flex-1 truncate rounded-lg bg-foreground/[0.05] px-2.5 py-1.5 text-xs outline-none"
                />
                <button
                  className="flex items-center gap-1 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(url);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            ) : (
              <p className="text-sm text-foreground/55">
                Couldn&apos;t create a share link for this session.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ExportButton() {
  let count = 0;
  try {
    count = useOpenCodeThreadState((s) => (s.messageOrder || []).length);
  } catch {
    return null; // thread not backed by a session yet
  }
  const disabled = !count;
  const run = () => {
    try {
      // Read the live thread snapshot from the DOM-independent store via a
      // temporary hook-free path: use the runtime extras session messages.
      // Fallback: export from rendered markdown nodes.
      const nodes = document.querySelectorAll(".aui-md");
      const parts = [...nodes].map((n, i) => `### Message ${i + 1}\n\n${n.innerText || ""}`);
      const md = `# OpenCode Chat export\n\n${parts.join("\n\n---\n\n")}\n`;
      const blob = new Blob([md], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `opencode-chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      className="flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1.5 text-sm transition hover:bg-foreground/[0.05] disabled:opacity-40"
      disabled={disabled}
      title={disabled ? "Nothing to export yet" : "Download this chat as Markdown"}
      onClick={run}
    >
      <DownloadIcon className="size-3.5" />
      <span className="max-sm:hidden">Export</span>
    </button>
  );
}

// Tags sessions to projects — but ONLY on explicit creation intent. Every
// new thread announces its target up front (window.__ocPendingProject, set
// by the sidebar's New buttons); when that session arrives it gets filed.
// Navigating to an existing chat never moves it. Ever.
function SessionTagger({ onTagged }) {
  let session = null;
  try {
    session = useOpenCodeSession();
  } catch {
    session = null;
  }
  let threadsState = null;
  try {
    threadsState = useAuiState((s) => s.optional.threads);
  } catch {
    threadsState = null;
  }
  const seenRef = useRef(new Set());
  // Remember every thread id ever listed, so arrivals can be told apart
  // from plain navigation.
  const ids = threadsState?.threadIds;
  const index = indexThreadItems(threadsState?.threadItems);
  useEffect(() => {
    if (ids) {
      for (const id of ids) {
        seenRef.current.add(id);
        const r = index[id]?.remoteId;
        if (r) seenRef.current.add(r);
      }
    }
  });
  const sid = session?.id || null;
  useEffect(() => {
    if (!sid) return;
    if (seenRef.current.has(sid)) {
      window.__ocPendingProject = undefined; // navigated, intent abandoned
      return;
    }
    seenRef.current.add(sid);
    const pending = window.__ocPendingProject;
    window.__ocPendingProject = undefined;
    if (!pending) return; // no creation intent — never steal
    (async () => {
      try {
        await tagSession(sid, pending);
        onTagged?.(sid, pending);
      } catch {
        /* best-effort */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);
  return null;
}

// Shows onboarding on first run, and a short splash while the AI engine boots
// on later runs; the chat (and its opencode runtime) mounts once it is ready.
export function App() {
  const status = useSetupStatus();
  const [onboarded, setOnboarded] = useState(() => load("onboarded", false));
  if (!onboarded || status.phase !== "ready") {
    return (
      <Onboarding
        status={status}
        firstRun={!onboarded}
        onFinish={() => {
          save("onboarded", true);
          setOnboarded(true);
        }}
      />
    );
  }
  return <ChatApp />;
}

function ChatApp() {
  const [model, setModel] = useState(() => load("model", DEFAULT_MODEL));
  // "chat" = ChatGPT-style agent defined in workspace/.opencode/agent/chat.md
  // (can create PDFs/Office files); older saves stored "plan".
  const [agent, setAgent] = useState(() => {
    const a = load("agent", "chat");
    return a === "plan" ? "chat" : a;
  });
  const [allModels, setAllModels] = useState(FREE_MODELS.map((f) => ({ ...f, free: true })));
  const [connected, setConnected] = useState([]);
  const [error, setError] = useState(null);
  const [sideOpen, setSideOpen] = useState(true);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Projects (Claude-style) + Skills dialog state.
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(() => loadActiveProject());
  const [sessionMap, setSessionMap] = useState({});
  const [projectDialog, setProjectDialog] = useState(null); // null | { initial?: project }
  const [projectSettings, setProjectSettings] = useState(null); // project object
  const [skillsOpen, setSkillsOpen] = useState(false);

  const activeProject = projects.find((p) => p.id === activeProjectId) || null;
  const effectiveAgent = activeProject ? projectAgentId(activeProject.id) : agent;

  const refreshProjects = async () => {
    try {
      const [list, map] = await Promise.all([fetchProjects(), fetchSessionMap()]);
      setProjects(list);
      setSessionMap(map);
      // Active project may have been deleted elsewhere.
      setActiveProjectId((cur) => {
        if (cur && !list.some((p) => p.id === cur)) {
          saveActiveProject(null);
          return null;
        }
        return cur;
      });
    } catch {
      /* projects are optional — chat still works */
    }
  };
  useEffect(() => {
    refreshProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectProject = (id) => {
    saveActiveProject(id);
    setActiveProjectId(id);
  };

  // Drag-and-drop filing: update instantly, persist in the background.
  const moveSession = async (sid, pid) => {
    if (!sid) return;
    setSessionMap((m) => {
      const next = { ...(m || {}) };
      if (pid) next[sid] = pid;
      else delete next[sid];
      return next;
    });
    try {
      await tagSession(sid, pid);
    } catch {
      /* map reconciles on next refresh */
    }
    refreshProjects();
  };

  useEffect(() => save("model", model), [model]);
  useEffect(() => save("agent", agent), [agent]);
  // Exposed for the composer's context ring (session tokens vs model limit).
  useEffect(() => {
    try {
      const m = allModels.find((x) => x.providerID === model.providerID && x.modelID === model.modelID);
      if (m?.contextTokens) window.__ocModelLimit = m.contextTokens;
    } catch {
      /* ignore */
    }
  }, [model, allModels]);

  const refreshModels = () =>
    fetchAllModels()
      .then(({ models, connected }) => {
        setConnected(connected);
        setAllModels(models.map((m) => ({ ...m, free: isFree(m) })));
        if (!models.some((m) => m.providerID === model.providerID && m.modelID === model.modelID)) {
          const fb = FREE_MODELS.find((f) =>
            models.some((m) => m.providerID === f.providerID && m.modelID === f.modelID),
          );
          if (fb) setModel({ ...fb });
        }
      })
      .catch(() => {});
  useEffect(() => {
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options = useMemo(
    () => ({
      baseUrl: window.location.origin + "/api",
      defaultModel: model,
      // Inside a project, chats run on the generated `project-<id>` agent
      // (base chat behaviour + project instructions + knowledge files).
      defaultAgent: effectiveAgent,
      adapters: { attachments: chatAttachmentAdapter },
      onError: (e) => setError(String(e?.message || e)),
    }),
    [model, effectiveAgent],
  );
  const runtime = useOpenCodeRuntime(options);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionTagger
        onTagged={(sid, pid) => {
          // Filed on arrival — reflect instantly, then reconcile.
          setSessionMap((m) => ({ ...(m || {}), [sid]: pid }));
          refreshProjects();
        }}
      />
      <div className="bg-background text-foreground flex h-screen overflow-hidden">
        {!sideOpen ? null : (
          <aside className="bg-sidebar text-sidebar-foreground flex h-full min-h-0 w-[260px] min-w-[260px] shrink-0 flex-col overflow-hidden border-r border-sidebar-border max-md:fixed max-md:z-50 max-md:h-screen">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex min-h-0 flex-1 flex-col">
                <ChatSidebar
                  projects={projects}
                  onSelectProject={selectProject}
                  onNewProject={() => setProjectDialog({})}
                  onEditProject={(p) => setProjectSettings(p)}
                  onOpenSkills={() => setSkillsOpen(true)}
                  onMoveSession={moveSession}
                  sessionMap={sessionMap}
                  activeProjectId={activeProjectId}
                  onNavigate={() => { if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 768px)").matches) setSideOpen(false); }}
                />
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-2 border-t border-sidebar-border p-3">
              {!activeProject ? (
              <div
                className={cn(field, "flex overflow-hidden rounded-xl")}
                title="Chat = assistant that can create files (PDF, Word, Excel…). Agent = full build agent."
              >
                <button
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-[13px] transition-colors",
                    agent === "chat"
                      ? "bg-foreground/[0.08] text-foreground"
                      : "text-foreground/45 hover:text-foreground/75",
                  )}
                  onClick={() => setAgent("chat")}
                >
                  <MessageCircleIcon className="size-3.5" />
                  Chat
                </button>
                <button
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-[13px] transition-colors",
                    agent === "build"
                      ? "bg-foreground/[0.08] text-foreground"
                      : "text-foreground/45 hover:text-foreground/75",
                  )}
                  onClick={() => setAgent("build")}
                >
                  <BotIcon className="size-3.5" />
                  Agent
                </button>
              </div>
              ) : (
              <div
                className={cn(field, "flex items-center gap-2 overflow-hidden rounded-xl px-3 py-1.5")}
                title={`Chatting inside project "${activeProject.name}" — new chats use its instructions and knowledge files.`}
              >
                <FolderIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{activeProject.name}</span>
                <button
                  onClick={() => selectProject(null)}
                  className="shrink-0 rounded-full p-0.5 text-foreground/45 transition hover:text-foreground"
                  title="Leave project (back to all chats)"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
              )}
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1 [&>button]:w-full">
                  <AccountButton
                    connectedCount={connected.filter((id) => id !== "opencode").length}
                    onClick={() => setAccountsOpen(true)}
                  />
                </div>
                <button
                  className="flex size-9 shrink-0 items-center justify-center rounded-xl text-foreground/55 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                  onClick={() => setSettingsOpen(true)}
                  title="Settings"
                >
                  <SettingsIcon className="size-[18px]" />
                </button>
              </div>
              <VersionFooter />
            </div>
          </aside>
        )}
        {!accountsOpen ? null : (
          <AccountsDialog onClose={() => setAccountsOpen(false)} onChanged={refreshModels} />
        )}
        {!settingsOpen ? null : (
          <SettingsDialog onClose={() => setSettingsOpen(false)} onChanged={refreshModels} />
        )}
        {!skillsOpen ? null : <SkillsDialog onClose={() => setSkillsOpen(false)} />}
        {!projectDialog ? null : (
          <ProjectDialog
            initial={projectDialog.initial}
            onClose={() => setProjectDialog(null)}
            onSaved={(saved) => {
              setProjectDialog(null);
              if (saved?.id) {
                // Show instantly from the server response — no waiting on refetch.
                setProjects((prev) => {
                  const i = prev.findIndex((p) => p.id === saved.id);
                  return i >= 0 ? prev.map((p) => (p.id === saved.id ? saved : p)) : [...prev, saved];
                });
                // New projects open immediately, like Claude.
                if (!projectDialog.initial) selectProject(saved.id);
              }
              refreshProjects(); // reconcile in the background
            }}
          />
        )}
        {!projectSettings ? null : (
          <ProjectSettingsDialog
            project={projects.find((p) => p.id === projectSettings.id) || projectSettings}
            onClose={() => setProjectSettings(null)}
            onChanged={(saved) => {
              // Rename/description apply instantly; reconcile in background.
              setProjects((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
              setProjectSettings(saved);
              refreshProjects();
            }}
            onDeleted={(id) => {
              setProjectSettings(null);
              setProjects((prev) => prev.filter((p) => p.id !== id));
              if (activeProjectId === id) selectProject(null);
              refreshProjects();
            }}
            onOpenChat={(p) => {
              setProjectSettings(null);
              selectProject(p.id);
            }}
          />
        )}
        <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col">
          <UpdateBanner />
          <header className="flex items-center gap-1 px-3 py-2">
            <button
              className="rounded-lg p-2 text-foreground/55 transition hover:bg-foreground/[0.05] hover:text-foreground"
              onClick={() => setSideOpen((v) => !v)}
              title="Toggle sidebar"
            >
              <PanelLeftIcon className="size-5" />
            </button>
            <ModelMenu
              model={model}
              onPick={setModel}
              allModels={allModels}
              connected={connected}
            />
            <div className="flex-1" />
            <ExportButton />
            <ShareButton />
          </header>
          {!error ? null : (
            <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-[13px] text-red-400">
              <span className="min-w-0 flex-1 truncate">⚠ {error}</span>
              <button
                className="rounded-md p-1 transition hover:bg-foreground/[0.06]"
                onClick={() => setError(null)}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          )}
          <ChatErrorBoundary>
            <ChatThread />
          </ChatErrorBoundary>
          <div className="px-2 pb-2.5 pt-1 text-center text-xs text-foreground/30">
            Opencode can make mistakes. Check important info.
          </div>
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
}
