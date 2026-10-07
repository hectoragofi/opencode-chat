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

export async function fetchAllModels() {
  const res = await fetch("/api/provider");
  if (!res.ok) throw new Error(`provider list: HTTP ${res.status}`);
  const data = await res.json();
  const models = [];
  for (const prov of data.all || []) {
    for (const mid of Object.keys(prov.models || {})) {
      models.push({ providerID: prov.id, modelID: mid });
    }
  }
  return { models, connected: data.connected || [] };
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
