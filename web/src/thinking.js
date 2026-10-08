// Thinking / reasoning effort selector. Maps 1:1 to opencode model
// variants (see https://opencode.ai/docs/models/#variants): "off" sends no
// variant (opencode default), anything else is passed as `variant` on every
// session prompt. The picker filters to the current model's variants from
// GET /api/model; a stale pick (after switching models) is skipped on send
// instead of hard-erroring the message.

export const THINKING_LEVELS = [
  { id: "off", label: "Off", hint: "Model default" },
  { id: "none", label: "None", hint: "No reasoning" },
  { id: "minimal", label: "Minimal", hint: "Fastest" },
  { id: "low", label: "Low", hint: "Quick" },
  { id: "medium", label: "Medium", hint: "Balanced" },
  { id: "high", label: "High", hint: "Thorough" },
  { id: "xhigh", label: "XHigh", hint: "Deep" },
  { id: "max", label: "Max", hint: "Deepest" },
];

export const THINKING_IDS = new Set(THINKING_LEVELS.map((l) => l.id));

const KEY = "oc-chat:thinking";

export function loadThinking() {
  try {
    const v = localStorage.getItem(KEY);
    if (v && THINKING_IDS.has(JSON.parse(v))) return JSON.parse(v);
    if (v && THINKING_IDS.has(v)) return v;
  } catch {
    /* ignore */
  }
  return "off";
}

export function saveThinking(id) {
  try {
    localStorage.setItem(KEY, JSON.stringify(THINKING_IDS.has(id) ? id : "off"));
  } catch {
    /* ignore */
  }
}

/**
 * Query opencode for per-model variants (GET /api/model via the /api proxy,
 * so the SDK path is /api/api/model). Returns a map of
 * "providerID/modelID" -> string[] of variant ids. Empty object on failure
 * (caller treats missing entries as unknown, not as "no variants").
 */
export async function fetchModelVariants() {
  const res = await fetch("/api/api/model");
  if (!res.ok) throw new Error(`model list: HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data?.data || [];
  const map = {};
  for (const m of list) {
    const pid = m?.providerID;
    const mid = m?.id || m?.modelID;
    if (!pid || !mid) continue;
    const ids = (m?.variants || []).map((v) => (typeof v === "string" ? v : v?.id)).filter(Boolean);
    map[`${pid}/${mid}`] = [...new Set(ids)];
  }
  return map;
}

/**
 * Variant ids the current model reports, or null when unknown. Empty arrays
 * count as unknown: opencode only lists user-defined custom variants here,
 * never the engine-derived reasoning levels, so [] carries no information.
 */
export function supportedVariants(model, variantsMap) {
  if (!model || !variantsMap) return null;
  const hit = variantsMap[`${model.providerID}/${model.modelID}`];
  return hit === undefined || !hit.length ? null : hit;
}

/**
 * Lowercased variant ids offered for a model, or null when unknown (treat
 * everything as offered). Rules:
 * - "off" (send nothing) is always offered.
 * - If the endpoint names any fixed effort level, it is authoritative for the
 *   fixed set: only those are offered (future engines may report derived
 *   reasoning variants here).
 * - Otherwise (customs only — customs extend built-ins per the opencode
 *   docs) all fixed levels stay offered, plus the custom ids.
 */
export function offeredVariantSet(supported) {
  if (!supported) return null;
  const lower = new Set(supported.map((v) => String(v).toLowerCase()));
  const fixedHit = THINKING_LEVELS.filter((l) => l.id !== "off" && lower.has(l.id));
  const ids = new Set(["off"]);
  const fixed = fixedHit.length ? fixedHit : THINKING_LEVELS.filter((l) => l.id !== "off");
  for (const l of fixed) ids.add(l.id);
  for (const v of lower) ids.add(v);
  return ids;
}

/** Custom variant ids (not in the fixed effort set) for a model. */
export function customVariants(supported) {
  if (!supported) return [];
  const known = new Set([...THINKING_IDS].map((s) => s.toLowerCase()));
  return [...new Set(supported.filter((v) => !known.has(String(v).toLowerCase())))];
}

const labelFor = (id) => (id ? id.charAt(0).toUpperCase() + id.slice(1) : id);

/** Extra picker entries for custom variants, same shape as THINKING_LEVELS. */
export function customLevelEntries(supported) {
  return customVariants(supported).map((id) => ({ id, label: labelFor(id), hint: "Custom" }));
}
