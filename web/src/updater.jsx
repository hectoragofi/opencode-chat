import { useEffect, useState } from "react";
import { ArrowDownToLineIcon, Loader2Icon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Only the Tauri desktop shell has an updater; the browser tab
// (node server.mjs --open) renders nothing here. The Tauri JS bindings are
// imported lazily so a missing/broken native bridge never breaks the web UI.
const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Checks for an app update shortly after launch and offers a one-click
// install (download with progress, then relaunch into the new version).
export function UpdateBanner() {
  const [update, setUpdate] = useState(null);
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
        const { check } = await import("@tauri-apps/plugin-updater");
        const u = await check();
        if (!cancelled && u) setUpdate(u);
      } catch {
        /* offline, no release feed, or dev build without a token — stay silent */
      }
    }, 8000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

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

