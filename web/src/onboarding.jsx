import { useEffect, useState } from "react";
import {
  ArrowRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderOpenIcon,
  Loader2Icon,
  MessageCircleIcon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { field } from "./components/surfaces";
import { ProviderList, ZEN_KEY_URL, saveApiKey } from "./accounts.jsx";

// Polls the local server's setup status (opencode download / boot).
export function useSetupStatus() {
  const [status, setStatus] = useState({ phase: "starting", progress: 0, message: "Starting…" });
  useEffect(() => {
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const res = await fetch("/setup/status", { cache: "no-store" });
        const s = await res.json();
        if (!alive) return;
        setStatus(s);
        if (s.phase === "ready") return;
      } catch {
        /* server restarting */
      }
      timer = setTimeout(tick, 600);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return status;
}

const primary =
  "flex h-10 items-center justify-center gap-2 rounded-full bg-foreground px-5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40";
const secondary =
  "flex h-10 items-center justify-center gap-2 rounded-full border border-border/60 px-5 text-sm transition hover:bg-foreground/[0.05] disabled:opacity-40";

function Shell({ step, total, children }) {
  return (
    <div className="bg-background text-foreground h-screen overflow-y-auto">
      <div className="flex min-h-full items-center justify-center p-6">
      <div className="fade-in slide-in-from-bottom-2 animate-in flex w-full max-w-md flex-col gap-6 duration-500">
        {total ? (
          <div className="flex gap-1.5">
            {Array.from({ length: total }, (_, i) => (
              <span
                key={i}
                className={cn("h-1 flex-1 rounded-full transition-colors", i <= step ? "bg-foreground/70" : "bg-foreground/10")}
              />
            ))}
          </div>
        ) : null}
        {children}
      </div>
      </div>
    </div>
  );
}

function Feature({ Icon, title, text }) {
  return (
    <div className="flex gap-3">
      <span className={cn(field, "flex size-9 shrink-0 items-center justify-center rounded-xl")}>
        <Icon className="size-4" />
      </span>
      <div className="leading-snug">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-[13px] text-foreground/50">{text}</p>
      </div>
    </div>
  );
}

function SetupProgress({ status }) {
  const pct = Math.round((status.progress || 0) * 100);
  if (status.phase === "error") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-red-400">{status.error || "Setup failed."}</p>
        <p className="text-[13px] text-foreground/50">Check your internet connection and try again.</p>
        <button className={cn(secondary, "w-max")} onClick={() => fetch("/setup/retry", { method: "POST" })}>
          <RotateCcwIcon className="size-4" /> Try again
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm text-foreground/70">
        {status.phase === "ready" ? (
          <CheckIcon className="size-4 text-emerald-400" />
        ) : (
          <Loader2Icon className="size-4 animate-spin" />
        )}
        <span className="flex-1">{status.phase === "ready" ? "All set" : status.message}</span>
        {status.phase === "downloading" ? <span className="font-mono text-xs tabular-nums text-foreground/45">{pct}%</span> : null}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
        <div
          className={cn(
            "h-full rounded-full bg-foreground/70 transition-[width] duration-300",
            status.phase !== "downloading" && status.phase !== "ready" && "animate-pulse",
          )}
          style={{ width: `${status.phase === "ready" ? 100 : status.phase === "downloading" ? pct : 35}%` }}
        />
      </div>
    </div>
  );
}

function ZenConnect({ onConnected, onSkip }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [more, setMore] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveApiKey("opencode", key);
      onConnected();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Connect your OpenCode account</h1>
        <p className="text-sm text-foreground/55">
          Free models work right away, no account needed. Connecting your OpenCode Zen account gives you higher
          limits and paid models on your own balance.
        </p>
      </div>
      <ol className="flex flex-col gap-3 text-sm">
        <li className="flex gap-3">
          <span className={cn(field, "flex size-6 shrink-0 items-center justify-center rounded-full text-xs")}>1</span>
          <span>
            Sign in at{" "}
            <a href={ZEN_KEY_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
              opencode.ai/auth <ExternalLinkIcon className="size-3" />
            </a>{" "}
            and create an API key.
          </span>
        </li>
        <li className="flex gap-3">
          <span className={cn(field, "flex size-6 shrink-0 items-center justify-center rounded-full text-xs")}>2</span>
          <span className="flex-1">
            Paste it here:
            <input
              type="password"
              autoComplete="off"
              className={cn(field, "mt-1.5 w-full rounded-xl px-3 py-2 text-sm outline-none placeholder:text-foreground/35")}
              placeholder="sk-…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && key.trim() && !busy && save()}
            />
          </span>
        </li>
      </ol>
      {!error ? null : <p className="text-xs text-red-400">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button className={primary} disabled={!key.trim() || busy} onClick={save}>
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Connect
        </button>
        <button className={secondary} onClick={onSkip} disabled={busy}>
          Skip, use free models
        </button>
      </div>
      <div className="border-t border-border/60 pt-4">
        <button className="text-[13px] text-foreground/55 underline-offset-2 hover:underline" onClick={() => setMore((v) => !v)}>
          {more ? "Hide other accounts" : "Have ChatGPT Plus, Copilot or another API key?"}
        </button>
        {!more ? null : (
          <div className="mt-3">
            <ProviderList exclude={["opencode"]} />
          </div>
        )}
      </div>
    </div>
  );
}

// First-run flow. Also doubles as the splash screen on later launches while
// the AI engine boots (then it only shows the progress and gets out of the way).
export function Onboarding({ status, firstRun, onFinish }) {
  const [step, setStep] = useState(0);
  const ready = status.phase === "ready";

  if (!firstRun) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-lg font-medium">
          <SparklesIcon className="size-5" /> OpenCode Chat
        </div>
        <SetupProgress status={status} />
      </Shell>
    );
  }

  if (step === 0) {
    return (
      <Shell step={0} total={4}>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-3xl font-semibold tracking-tight">Welcome to OpenCode Chat</h1>
          <p className="text-sm text-foreground/55">A private AI assistant on your computer, with free models included.</p>
        </div>
        <div className="flex flex-col gap-4">
          <Feature Icon={MessageCircleIcon} title="Chat like ChatGPT" text="Ask anything, attach files, get answers with math and code." />
          <Feature Icon={FileTextIcon} title="Make real files" text="PDFs, Word docs, Excel sheets, slides and charts you can download." />
          <Feature Icon={SparklesIcon} title="Free to start" text="Free models need no account. Connect yours any time for more." />
        </div>
        <button className={cn(primary, "w-max")} onClick={() => setStep(1)}>
          Get started <ArrowRightIcon className="size-4" />
        </button>
      </Shell>
    );
  }

  if (step === 1 || !ready) {
    return (
      <Shell step={1} total={4}>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Setting things up</h1>
          <p className="text-sm text-foreground/55">
            {status.phase === "downloading"
              ? "Downloading the AI engine. This only happens once."
              : "Getting the AI engine ready."}
          </p>
        </div>
        <SetupProgress status={status} />
        <button className={cn(primary, "w-max")} disabled={!ready} onClick={() => setStep(2)}>
          Continue <ArrowRightIcon className="size-4" />
        </button>
      </Shell>
    );
  }

  if (step === 2) {
    return (
      <Shell step={2} total={4}>
        <ZenConnect onConnected={() => setStep(3)} onSkip={() => setStep(3)} />
      </Shell>
    );
  }

  return (
    <Shell step={3} total={4}>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">You&apos;re ready</h1>
        <p className="text-sm text-foreground/55">Some things to try:</p>
      </div>
      <ul className="flex flex-col gap-2 text-sm">
        {[
          "Make me a PDF cheat sheet for the 10 most common Spanish verbs",
          "Create an Excel budget for a student living on €900 a month",
          "Explain how compound interest works, with a chart",
        ].map((t) => (
          <li key={t} className={cn(field, "rounded-xl px-3 py-2 text-foreground/75")}>
            {t}
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-foreground/50">
        Files you create are saved in{" "}
        <button
          className="inline-flex items-center gap-1 underline underline-offset-2"
          onClick={() => fetch("/setup/open-files", { method: "POST" })}
        >
          <FolderOpenIcon className="size-3.5" /> {status.filesDir || "your OpenCode Chat folder"}
        </button>
        . Switch models and accounts any time from the sidebar.
      </p>
      <button className={cn(primary, "w-max")} onClick={onFinish}>
        Start chatting <ArrowRightIcon className="size-4" />
      </button>
    </Shell>
  );
}
