// Free / connected models pinned to the top of the picker.
export const FREE_MODELS = [
  { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
  { providerID: "opencode", modelID: "big-pickle" },
  { providerID: "opencode", modelID: "ling-3.0-flash-fin-free" },
  { providerID: "opencode", modelID: "longcat-2.5-preview-free" },
  { providerID: "opencode", modelID: "space-bunny-free" },
  { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
  { providerID: "opencode", modelID: "nemotron-3-ultra-free" },
  { providerID: "opencode", modelID: "nemotron-3.5-lightning-free" },
  { providerID: "deepseek", modelID: "deepseek-flash" },
  { providerID: "deepseek", modelID: "deepseek-v4-pro" },
];

export const DEFAULT_MODEL = FREE_MODELS[0];

function formatContext(limit) {
  if (!limit || !limit.context) return "";
  const n = limit.context;
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function formatPrice(cost) {
  if (!cost || (!cost.input && !cost.output)) return "";
  // opencode costs are per-token; show per 1M for readability.
  const inPerM = (cost.input || 0) * 1000000;
  const outPerM = (cost.output || 0) * 1000000;
  if (!inPerM && !outPerM) return "free";
  const fmt = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  return `$${fmt(inPerM)}/$${fmt(outPerM)}/M`;
}

function capabilityBadges(model) {
  const caps = [];
  const c = model.capabilities;
  if (!c) return caps;
  if (c.input?.image) caps.push("vision");
  if (c.input?.pdf) caps.push("pdf");
  if (c.input?.audio) caps.push("audio");
  if (c.input?.video) caps.push("video");
  if (c.reasoning) caps.push("reasons");
  return caps.slice(0, 3);
}

export async function fetchAllModels() {
  const res = await fetch("/api/provider");
  if (!res.ok) throw new Error(`provider list: HTTP ${res.status}`);
  const data = await res.json();
  const models = [];
  for (const prov of data.all || []) {
    for (const [mid, m] of Object.entries(prov.models || {})) {
      models.push({
        providerID: prov.id,
        modelID: mid,
        name: m?.name || mid,
        family: m?.family || prov.name || prov.id,
        context: formatContext(m?.limit),
        contextTokens: m?.limit?.context || 0,
        price: formatPrice(m?.cost),
        inputCost: m?.cost?.input || 0,
        capabilities: capabilityBadges(m || {}),
        status: m?.status || "active",
      });
    }
  }
  return { models, connected: data.connected || [] };
}

const RECENT_KEY = "oc-chat:recent-models";
const MAX_RECENT = 5;

export function loadRecentModels() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((m) => m?.providerID && m?.modelID).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function saveRecentModel(model) {
  try {
    const cur = loadRecentModels().filter(
      (m) => !(m.providerID === model.providerID && m.modelID === model.modelID)
    );
    cur.unshift({ providerID: model.providerID, modelID: model.modelID });
    localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, MAX_RECENT)));
  } catch {
    /* ignore */
  }
}

export function load(key, fallback) {
  try {
    const v = localStorage.getItem("oc-chat:" + key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem("oc-chat:" + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
