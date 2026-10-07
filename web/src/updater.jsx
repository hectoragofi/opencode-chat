import { useEffect, useState } from "react";
import { ArrowDownToLineIcon, Loader2Icon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Only the Tauri desktop shell has an updater; the browser tab
// (node server.mjs --open) renders nothing here. The Tauri JS bindings are
// imported lazily so a missing/broken native bridge never breaks the web UI.
const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// One found update shared between the auto-check banner and the manual
// version-footer check, so either entry point surfaces the same banner.
let sharedUpdate = null;
const sharedListeners = new Set();
function announceUpdate(u) {
  sharedUpdate = u;
  sharedListeners.forEach((fn) => fn(u));
}
export function useSharedUpdate() {
  const [u, setU] = useState(sharedUpdate);
  useEffect(() => {
    sharedListeners.add(setU);
    return () => sharedListeners.delete(setU);
  }, []);
  return [u, announceUpdate];
}

export async function checkForUpdates() {
  const { check } = await import("@tauri-apps/plugin-updater");
  return check();
}

// Checks for an app update shortly after launch and offers a one-click
// install (download with progress, then relaunch into the new version).
export function UpdateBanner() {
  const [update, setUpdate] = useSharedUpdate();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const [error, setError] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    // Wait for boot to settle before hitting the network.
    const timer = setTimeout(async () => {
      try {
        const u = await checkForUpdates();
        if (!cancelled && u) setUpdate(u);
      } catch {
        /* offline, no release feed, or dev build without a token — stay silent */
      }
    }, 8000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [setUpdate]);

  if (!isTauri() || dismissed || !update) return null;

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") setProgress({ done: 0, total: e.data.contentLength || 0 });
        else if (e.event === "Progress") setProgress((p) => ({ done: (p?.done || 0) + e.data.chunkLength, total: p?.total || 0 }));
        else if (e.event === "Finished") setProgress(null);
      });
      await relaunch();
    } catch (e) {
      setError(String(e?.message || e));
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-border/60 bg-foreground/[0.04] px-4 py-2">
      <div className="flex items-center gap-2 text-[13px]">
        {busy ? (
          <Loader2Icon className="size-4 shrink-0 animate-spin text-foreground/60" />
        ) : (
          <ArrowDownToLineIcon className="size-4 shrink-0 text-foreground/60" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {busy ? (
            pct !== null ? (
              <>Installing update… {pct}%</>
            ) : (
              <>Installing update…</>
            )
          ) : (
            <>Update available: v{update.version}</>
          )}
        </span>
        {!busy && !error && (
          <button
            className="shrink-0 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background transition hover:opacity-90"
            onClick={install}
          >
            Install &amp; relaunch
          </button>
        )}
        {!busy && (
          <button
            className="shrink-0 rounded-md p-1 text-foreground/50 transition hover:bg-foreground/[0.06] hover:text-foreground"
            title="Dismiss"
            onClick={() => setDismissed(true)}
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      {busy && pct !== null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className="h-full rounded-full bg-foreground/70 transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {!error ? null : (
        <p className="mt-1 flex items-center gap-1 text-xs text-red-400">
          <XIcon className="size-3" /> Couldn&apos;t install the update: {error}
        </p>
      )}
      {!busy && !error && update.body ? (
        <p className={cn("mt-0.5 truncate text-xs text-foreground/45")}>{stripMarkdown(update.body).slice(0, 160)}</p>
      ) : null}
    </div>
  );
}

function stripMarkdown(s) {
  return String(s || "")
    .replace(/[#*_`>\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Sidebar version footer. Clicking re-checks on demand (the banner only
// appears when an update actually exists); a quiet note confirms the rest.
export function VersionFooter() {
  const [, announce] = useSharedUpdate();
  const [state, setState] = useState("idle"); // idle | checking | current | failed
  const [detail, setDetail] = useState("");
  const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
  const buildId = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";
  const recheck = async () => {
    if (!isTauri() || state === "checking") return;
    setState("checking");
    setDetail("");
    try {
      const u = await checkForUpdates();
      if (u) announce(u);
      else setState("current");
    } catch (e) {
      const msg = String(e?.message || e);
      console.error("[updater] check failed:", msg);
      setDetail(msg.slice(0, 220));
      setState("failed");
    }
  };
  useEffect(() => {
    if (state === "current") {
      const t = setTimeout(() => setState("idle"), 2500);
      return () => clearTimeout(t);
    }
  }, [state]);
  return (
    <span className="flex flex-col items-center gap-0.5 px-1">
      <button
        className="text-center text-[11px] text-foreground/30 transition hover:text-foreground/60"
        title={`Build ${buildId} · ${isTauri() ? "click to check for updates" : "Desktop app checks for updates on launch"}`}
        onClick={recheck}
      >
        v{appVersion} · {String(buildId).slice(-9)}
        {state === "checking"
          ? " · checking…"
          : state === "current"
            ? " · up to date ✓"
            : state === "failed"
              ? " · check failed"
              : ""}
      </button>
      {!detail || state !== "failed" ? null : (
        <span className="max-w-56 break-words text-center font-mono text-[10px] leading-snug text-red-400/80">
          {detail}
        </span>
      )}
    </span>
  );
}

