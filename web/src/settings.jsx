import { useEffect, useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { field, ghostButton } from "./components/surfaces";
import { ProviderList } from "./accounts.jsx";
import { useSetupStatus } from "./onboarding.jsx";
import { THEMES, useTheme } from "./theme.jsx";
import { checkForUpdates, useSharedUpdate } from "./updater.jsx";

const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
const RELEASES_URL = "https://github.com/hectoragofi/opencode-chat/releases";
const REPO_URL = "https://github.com/hectoragofi/opencode-chat";

function Section({ title, children }) {
  return (
    <section className="flex flex-col gap-2.5 border-b border-border/60 px-5 py-4 last:border-0">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-foreground/40">{title}</h3>
      {children}
    </section>
  );
}

function ThemePicker() {
  const [mode, setMode] = useTheme();
  const labels = { dark: "Dark", light: "Light", system: "System" };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">Theme</p>
      <div className={cn(field, "flex w-max overflow-hidden rounded-xl")}>
        {THEMES.map((t) => (
          <button
            key={t}
            className={cn(
              "px-4 py-1.5 text-[13px] transition-colors",
              mode === t ? "bg-foreground/[0.08] text-foreground" : "text-foreground/45 hover:text-foreground/75",
            )}
            onClick={() => setMode(t)}
          >
            {labels[t]}
          </button>
        ))}
      </div>
    </div>
  );
}

function WorkspaceSettings({ status }) {
  const open = (which) => fetch(`/setup/${which}`, { method: "POST" }).catch(() => {});
  const Row = ({ label, path, action }) => (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="truncate font-mono text-[11px] text-foreground/45" title={path || ""}>
          {path || "…"}
        </p>
      </div>
      <button
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 px-3 py-1.5 text-xs transition hover:bg-foreground/[0.05]"
        onClick={() => open(action)}
      >
        <FolderOpenIcon className="size-3.5" /> Open
      </button>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <Row label="Generated files" path={status.filesDir} action="open-files" />
      <Row label="Workspace" path={status.workspace} action="open-workspace" />
    </div>
  );
}

function UpdateSettings() {
  const [update, announce] = useSharedUpdate();
  const [state, setState] = useState("idle"); // idle | checking | current | failed
  const recheck = async () => {
    if (state === "checking") return;
    setState("checking");
    try {
      const u = await checkForUpdates();
      if (u) announce(u);
      else setState("current");
    } catch {
      setState("failed");
    }
  };
  useEffect(() => {
    if (state === "current" || state === "failed") {
      const t = setTimeout(() => setState("idle"), 3000);
      return () => clearTimeout(t);
    }
  }, [state]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">Version {APP_VERSION}</p>
        {update ? (
          <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11px] text-foreground/70">
            v{update.version} ready — see the banner up top
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="flex h-8 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
          disabled={state === "checking"}
          onClick={recheck}
        >
          {state === "checking" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {state === "checking" ? "Checking…" : "Check for updates"}
        </button>
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 items-center gap-1 rounded-full border border-border/60 px-4 text-xs transition hover:bg-foreground/[0.05]"
        >
          Release notes <ExternalLinkIcon className="size-3" />
        </a>
        {state === "current" ? (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <CheckIcon className="size-3.5" /> Up to date
          </span>
        ) : state === "failed" ? (
          <span className="text-xs text-red-400">Check failed — are you online?</span>
        ) : null}
      </div>
      <p className="text-xs text-foreground/45">The desktop app also checks automatically shortly after launch.</p>
    </div>
  );
}

function Diagnostics({ status }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const info = {
      app: `opencode-chat ${APP_VERSION}`,
      theme: (() => {
        try {
          return JSON.parse(localStorage.getItem("oc-chat:theme") || '"dark"');
        } catch {
          return "dark";
        }
      })(),
      platform: navigator.platform,
      language: navigator.language,
      userAgent: navigator.userAgent,
      setup: {
        phase: status.phase,
        message: status.message,
        workspace: status.workspace,
      },
      time: new Date().toISOString(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-foreground/50">
        If something breaks, paste this into your bug report — it captures the app state without any keys or
        personal data.
      </p>
      <button
        className="flex h-8 w-max items-center gap-1.5 rounded-full border border-border/60 px-4 text-xs transition hover:bg-foreground/[0.05]"
        onClick={copy}
      >
        {copied ? <CheckIcon className="size-3.5 text-emerald-400" /> : <CopyIcon className="size-3.5" />}
        {copied ? "Copied" : "Copy diagnostics"}
      </button>
    </div>
  );
}

export function SettingsDialog({ onClose, onChanged }) {
  const status = useSetupStatus();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="fade-in zoom-in-95 animate-in flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border/60 bg-popover shadow-2xl duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Settings</h2>
            <p className="text-xs text-foreground/50">Appearance, accounts, files, updates.</p>
          </div>
          <button className={cn(ghostButton, "size-8")} onClick={onClose} title="Close">
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="scroll-pane min-h-0 flex-1 overflow-y-auto">
          <Section title="Appearance">
            <ThemePicker />
          </Section>
          <Section title="Accounts">
            <ProviderList onChanged={onChanged} />
          </Section>
          <Section title="Workspace & files">
            <WorkspaceSettings status={status} />
          </Section>
          <Section title="Updates">
            <UpdateSettings />
          </Section>
          <Section title="Diagnostics">
            <Diagnostics status={status} />
          </Section>
          <Section title="About">
            <p className="text-xs leading-relaxed text-foreground/50">
              OpenCode Chat {APP_VERSION} — a ChatGPT-style desktop chat on top of{" "}
              <a href="https://opencode.ai" target="_blank" rel="noreferrer" className="underline">
                opencode
              </a>
              . Source on{" "}
              <a href={REPO_URL} target="_blank" rel="noreferrer" className="underline">
                GitHub
              </a>
              .
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
