import { useEffect, useMemo, useState } from "react";
import { CheckIcon, ExternalLinkIcon, Loader2Icon, PlugIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { field, ghostButton } from "./components/surfaces";

export const ZEN_KEY_URL = "https://opencode.ai/auth";

// Providers surfaced at the top of the accounts dialog, in this order.
// Anything else opencode knows about is reachable through the search box.
const FEATURED = {
  opencode: {
    name: "OpenCode Zen",
    blurb: "Free models work without an account. Connect to use your Zen balance and paid models.",
    keyUrl: ZEN_KEY_URL,
  },
  openai: { name: "ChatGPT Plus / Pro", blurb: "Sign in with your ChatGPT subscription, or use an OpenAI API key." },
  "github-copilot": { name: "GitHub Copilot", blurb: "Use the models included in your Copilot plan." },
  anthropic: { name: "Anthropic", blurb: "Claude models with your Anthropic API key.", keyUrl: "https://console.anthropic.com/settings/keys" },
  google: { name: "Google Gemini", blurb: "Gemini models with a Google AI Studio key.", keyUrl: "https://aistudio.google.com/apikey" },
  openrouter: { name: "OpenRouter", blurb: "Hundreds of models, many free, with one key.", keyUrl: "https://openrouter.ai/keys" },
  deepseek: { name: "DeepSeek", blurb: "DeepSeek models with your API key.", keyUrl: "https://platform.deepseek.com/api_keys" },
};

const API_METHOD = { type: "api", label: "API key" };

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

// Provider list and model availability are computed when an opencode instance
// boots, so credential changes only show up after the instance is reloaded.
export async function reloadProviders() {
  try {
    await api("/instance/dispose", { method: "POST" });
  } catch {
    /* ignore: next request re-initialises anyway */
  }
}

export async function saveApiKey(providerID, key, metadata) {
  await api(`/auth/${providerID}`, {
    method: "PUT",
    body: { type: "api", key: key.trim(), ...(metadata && Object.keys(metadata).length ? { metadata } : {}) },
  });
  await reloadProviders();
}

function visiblePrompts(prompts, inputs) {
  return (prompts || []).filter((p) => {
    if (!p.when) return true;
    const v = inputs[p.when.key];
    return p.when.op === "neq" ? v !== p.when.value : v === p.when.value;
  });
}

function ConnectForm({ providerID, methods, keyUrl, onDone }) {
  const [methodIdx, setMethodIdx] = useState(0);
  const [inputs, setInputs] = useState({});
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(null); // oauth authorization in progress
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const method = methods[methodIdx];
  const prompts = visiblePrompts(method.prompts, inputs);

  useEffect(() => {
    // Select prompts start on their first option.
    const init = {};
    for (const p of method.prompts || []) {
      if (p.type === "select" && p.options?.length) init[p.key] = p.options[0].value;
    }
    setInputs(init);
    setPending(null);
    setError(null);
  }, [methodIdx, method]);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const callback = async (codeValue) => {
    const ok = await api(`/provider/${providerID}/oauth/callback`, {
      method: "POST",
      body: codeValue ? { method: methodIdx, code: codeValue } : { method: methodIdx },
    });
    if (ok === false) throw new Error("Sign-in was not completed.");
    await reloadProviders();
    await onDone();
  };

  const submit = () => {
    if (method.type === "api") {
      return run(async () => {
        const metadata = Object.fromEntries(prompts.map((p) => [p.key, inputs[p.key] || ""]));
        await saveApiKey(providerID, key, metadata);
        await onDone();
      });
    }
    return run(async () => {
      const auth = await api(`/provider/${providerID}/oauth/authorize`, {
        method: "POST",
        body: { method: methodIdx, inputs },
      });
      setPending(auth);
      if (auth?.url) window.open(auth.url, "_blank", "noopener");
      // "auto" flows complete on their own (local callback / device code);
      // the callback request resolves once the user finishes in the browser.
      if (auth?.method === "auto") await callback();
    });
  };

  const input = cn(field, "w-full rounded-lg px-2.5 py-1.5 text-sm outline-none placeholder:text-foreground/35");
  const canSubmit =
    !busy &&
    prompts.every((p) => p.type === "select" || (inputs[p.key] || "").trim()) &&
    (method.type !== "api" || key.trim());

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {methods.length < 2 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {methods.map((m, i) => (
            <button
              key={m.label}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition",
                i === methodIdx
                  ? "border-foreground/30 bg-foreground/[0.08]"
                  : "border-border/60 text-foreground/55 hover:text-foreground",
              )}
              onClick={() => setMethodIdx(i)}
              disabled={busy}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
      {prompts.map((p) => (
        <label key={p.key} className="flex flex-col gap-1 text-xs text-foreground/55">
          {p.message}
          {p.type === "select" ? (
            <select
              className={input}
              value={inputs[p.key] || ""}
              onChange={(e) => setInputs((s) => ({ ...s, [p.key]: e.target.value }))}
            >
              {p.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={input}
              placeholder={p.placeholder}
              value={inputs[p.key] || ""}
              onChange={(e) => setInputs((s) => ({ ...s, [p.key]: e.target.value }))}
            />
          )}
        </label>
      ))}
      {method.type !== "api" ? null : (
        <div className="flex flex-col gap-1">
          <input
            type="password"
            autoComplete="off"
            className={input}
            placeholder="Paste API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canSubmit && submit()}
          />
          {!keyUrl ? null : (
            <a
              href={keyUrl}
              target="_blank"
              rel="noreferrer"
              className="flex w-max items-center gap-1 text-xs text-foreground/50 hover:text-foreground"
            >
              Get a key <ExternalLinkIcon className="size-3" />
            </a>
          )}
        </div>
      )}
      {!pending ? null : (
        <div className="rounded-lg border border-border/60 px-2.5 py-2 text-xs leading-relaxed text-foreground/70">
          {pending.instructions ? <p className="whitespace-pre-wrap">{pending.instructions}</p> : null}
          {pending.url ? (
            <a href={pending.url} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 underline">
              Open sign-in page <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
          {pending.method !== "code" ? (
            <p className="mt-1 flex items-center gap-1.5 text-foreground/45">
              <Loader2Icon className="size-3 animate-spin" /> Waiting for you to finish signing in…
            </p>
          ) : (
            <div className="mt-2 flex gap-1.5">
              <input
                className={input}
                placeholder="Paste the code you were given"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button
                className="shrink-0 rounded-lg bg-foreground px-3 text-xs font-medium text-background disabled:opacity-40"
                disabled={busy || !code.trim()}
                onClick={() => run(() => callback(code.trim()))}
              >
                Finish
              </button>
            </div>
          )}
        </div>
      )}
      {!error ? null : <p className="text-xs text-red-400">{error}</p>}
      {pending ? null : (
        <button
          className="flex h-8 w-max items-center gap-1.5 rounded-full bg-foreground px-3.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
          disabled={!canSubmit}
          onClick={submit}
        >
          {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {method.type === "api" ? "Save key" : "Sign in"}
        </button>
      )}
    </div>
  );
}

function ProviderRow({ id, name, blurb, keyUrl, connected, source, env, methods, open, onToggle, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // opencode reports source as "env" | "config" | "custom" | "api".
  // Only "custom"/"api" creds can be removed via DELETE /auth/{id};
  // env/config keys stay active until unset outside the app.
  const managedSource = connected && (source === "env" || source === "config");
  const managedLabel = source === "config" ? "via config file" : "via env var";
  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      try {
        await api(`/auth/${id}`, { method: "DELETE" });
      } catch (e) {
        // Already gone server-side still counts as disconnected.
        const msg = String(e?.message || e);
        if (!/HTTP (400|404)/.test(msg)) throw e;
      }
      // The engine can keep reporting a removed provider as connected for a
      // while (stale state cache), so poll until it drops out of the list.
      let stillThere = true;
      for (let i = 0; i < 6 && stillThere; i++) {
        await reloadProviders().catch(() => {});
        await onChanged();
        await new Promise((r) => setTimeout(r, 700));
        const prov = await api("/provider").catch(() => null);
        stillThere = !!prov?.connected?.includes(id);
        // Zen free tier is always "connected" with no key — not a failure.
        if (id === "opencode" && prov) {
          const entry = (prov.all || []).find((p) => p.id === "opencode");
          if (entry && entry.source === "custom") stillThere = false;
        }
      }
      if (stillThere) {
        // Re-check where the key comes from before blaming stale state.
        const prov = await api("/provider").catch(() => null);
        const entry = prov ? (prov.all || []).find((p) => p.id === id) : null;
        if (entry && (entry.source === "env" || entry.source === "config")) {
          setError(
            `This key comes from ${entry.source === "env" ? "an environment variable" : "your opencode config file"}, so deleting stored credentials can't remove it. Unset ${entry.source === "env" ? (entry.env || []).join(", ") || "the env var" : "it in opencode.json"} to fully disconnect.`
          );
        } else {
          setError(
            "Credentials were deleted, but the engine still lists this provider as connected. It usually clears after a restart — if it persists, the key comes from an environment variable, which can only be removed by unsetting it."
          );
        }
      }
    } catch (e) {
      setError(`Couldn't disconnect: ${String(e?.message || e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("rounded-xl border px-3 py-2.5", open ? "border-foreground/20" : "border-border/60")}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{name}</span>
            {!connected ? null : (
              <span className="flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] text-emerald-400">
                <CheckIcon className="size-2.5" /> connected
              </span>
            )}
          </div>
          {!blurb ? null : <p className="text-xs text-foreground/50">{blurb}</p>}
        </div>
        {managedSource ? (
          <span
            className="shrink-0 rounded-full bg-foreground/[0.05] px-2.5 py-1 text-xs text-foreground/45"
            title={source === "config" ? "This credential comes from your opencode config file. Remove it there to disconnect." : `This credential comes from an environment variable (${(env || []).join(", ") || "see opencode docs"}). Unset it (user + system variables), then restart the app.`}
          >
            {managedLabel}
          </span>
        ) : connected ? (
          <button
            className="shrink-0 rounded-full px-2.5 py-1 text-xs text-foreground/55 transition hover:bg-foreground/[0.06] hover:text-red-400 disabled:opacity-40"
            disabled={busy}
            onClick={disconnect}
            title="Removes credentials saved by opencode. Keys set as environment variables stay active."
          >
            {busy ? "Working…" : "Disconnect"}
          </button>
        ) : (
          <button
            className="shrink-0 rounded-full border border-border/60 px-3 py-1 text-xs transition hover:bg-foreground/[0.05]"
            onClick={onToggle}
          >
            {open ? "Cancel" : "Connect"}
          </button>
        )}
      </div>
      {!error ? null : <p className="mt-1.5 text-xs text-red-400">{error}</p>}
      {!open || connected ? null : (
        <ConnectForm
          providerID={id}
          methods={methods}
          keyUrl={keyUrl}
          onDone={async () => {
            await onChanged();
            onToggle();
          }}
        />
      )}
    </div>
  );
}

// The provider list, usable inline (onboarding) or inside the dialog.
export function ProviderList({ onChanged, exclude = [] }) {
  const [providers, setProviders] = useState([]);
  const [connected, setConnected] = useState([]);
  const [authMethods, setAuthMethods] = useState({});
  const [openID, setOpenID] = useState(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const [prov, methods] = await Promise.all([api("/provider"), api("/provider/auth").catch(() => ({}))]);
    setProviders(prov.all || []);
    setConnected(prov.connected || []);
    setAuthMethods(methods || {});
    setLoading(false);
  };

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
    const featured = Object.keys(FEATURED).filter((id) => byId[id] && !exclude.includes(id));
    const q = query.trim().toLowerCase();
    const others = q
      ? providers
          .filter((p) => !FEATURED[p.id] && `${p.id} ${p.name || ""}`.toLowerCase().includes(q))
          .slice(0, 30)
          .map((p) => p.id)
      : providers.filter((p) => !FEATURED[p.id] && connected.includes(p.id)).map((p) => p.id);
    return [...featured, ...others].map((id) => ({
      id,
      source: byId[id]?.source,
      env: byId[id]?.env || [],
      name: FEATURED[id]?.name || byId[id]?.name || id,
      blurb: FEATURED[id]?.blurb,
      keyUrl: FEATURED[id]?.keyUrl,
      // opencode reports Zen as connected even without a key (free tier).
      connected: connected.includes(id) && !(id === "opencode" && byId[id]?.source === "custom"),
      methods: authMethods[id]?.length ? authMethods[id] : [API_METHOD],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, connected, authMethods, query]);

  if (loading) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-foreground/50">
        <Loader2Icon className="size-4 animate-spin" /> Loading providers…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <ProviderRow
          key={r.id}
          {...r}
          open={openID === r.id}
          onToggle={() => setOpenID((cur) => (cur === r.id ? null : r.id))}
          onChanged={async () => {
            await refresh();
            await onChanged?.();
          }}
        />
      ))}
      <label className={cn(field, "mt-1 flex items-center gap-2 rounded-xl px-3 py-2")}>
        <SearchIcon className="size-4 shrink-0 text-foreground/40" />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-foreground/35"
          placeholder={`Search ${providers.length || ""} other providers…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
    </div>
  );
}

export function AccountsDialog({ onClose, onChanged }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="fade-in zoom-in-95 animate-in flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border/60 bg-popover shadow-2xl duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Connect accounts</h2>
            <p className="text-xs text-foreground/50">Credentials are stored by opencode on this computer only.</p>
          </div>
          <button className={cn(ghostButton, "size-8")} onClick={onClose} title="Close">
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 scroll-pane overflow-y-auto px-5 pb-5">
          <ProviderList onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
}

export function AccountButton({ connectedCount, onClick }) {
  return (
    <button
      className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.05]"
      onClick={onClick}
      title="Connect your OpenCode, ChatGPT, Copilot or other accounts"
    >
      <span className="bg-foreground text-background flex size-7 shrink-0 items-center justify-center rounded-full">
        <PlugIcon className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px]">Accounts</span>
        <span className="font-mono text-[11px] tracking-tight text-foreground/40">
          {connectedCount ? `${connectedCount} connected` : "free models · connect"}
        </span>
      </span>
    </button>
  );
}
