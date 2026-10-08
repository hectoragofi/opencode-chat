// Projects client (Claude-style): named containers with custom instructions
// + knowledge files. Chats run "inside" a project via a dedicated opencode
// agent (`project-<id>`) generated server-side from the base chat agent.

async function req(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON (shouldn't happen) */
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchProjects() {
  const data = await req("/projects");
  return data.projects || [];
}

export async function createProject({ name, description, instructions, icon }) {
  const data = await req("/projects", { method: "POST", body: { name, description, instructions, icon } });
  return data.project;
}

export async function updateProject(id, patch) {
  const data = await req(`/projects/${encodeURIComponent(id)}`, { method: "PUT", body: patch });
  return data.project;
}

export async function deleteProject(id) {
  await req(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function uploadProjectFile(id, file) {
  const contentBase64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("could not read file"));
    r.readAsDataURL(file);
  });
  const data = await req(`/projects/${encodeURIComponent(id)}/files`, {
    method: "POST",
    body: { filename: file.name, contentBase64 },
  });
  return data.files || [];
}

export async function deleteProjectFile(id, filename) {
  const data = await req(`/projects/${encodeURIComponent(id)}/files/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  });
  return data.files || [];
}

export function projectFileUrl(id, filename, download = false) {
  const u = `/projects/${encodeURIComponent(id)}/files/content/${encodeURIComponent(filename)}`;
  return download ? `${u}?download=1` : u;
}

// ---- active project (which context new chats belong to) ----

const ACTIVE_KEY = "oc-chat:active-project";

export function loadActiveProject() {
  try {
    return localStorage.getItem(ACTIVE_KEY) || null;
  } catch {
    return null;
  }
}

export function saveActiveProject(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

// ---- session <-> project tagging (sidecar map, server-persisted) ----

let sessionMapCache = null;

export async function fetchSessionMap() {
  try {
    const data = await req("/project-sessions");
    sessionMapCache = data.map || {};
  } catch {
    sessionMapCache = sessionMapCache || {};
  }
  return sessionMapCache;
}

export function getSessionMapSync() {
  return sessionMapCache || {};
}

export async function tagSession(sessionId, projectId) {
  if (!sessionId) return;
  try {
    await req("/project-sessions", { method: "POST", body: { sessionId, projectId } });
    sessionMapCache = { ...(sessionMapCache || {}), ...(projectId ? { [sessionId]: projectId } : {}) };
    if (!projectId && sessionMapCache) delete sessionMapCache[sessionId];
  } catch {
    /* tagging is best-effort */
  }
}

export function projectAgentId(projectId) {
  return projectId ? `project-${projectId}` : "chat";
}
