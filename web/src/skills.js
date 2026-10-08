// Skills client: reusable SKILL.md capabilities (Claude format, executed by
// opencode's native `skill` tool from workspace/.opencode/skills/).

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
    /* ignore */
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchSkills() {
  const data = await req("/skills");
  return data.skills || [];
}

export async function createSkill({ name, description, body }) {
  const data = await req("/skills", { method: "POST", body: { name, description, body } });
  return data.skills || [];
}

export async function updateSkill(name, { description, body }) {
  const data = await req(`/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: { description, body },
  });
  return data.skills || [];
}

export async function deleteSkill(name) {
  const data = await req(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
  return data.skills || [];
}

export async function toggleSkill(name, enabled) {
  const data = await req(`/skills/${encodeURIComponent(name)}/toggle`, {
    method: "POST",
    body: { enabled },
  });
  return data.skills || [];
}

export const SKILL_TEMPLATE = `## What I do

- Describe the task this skill handles in 2-4 bullets.

## When to use me

Use this when the user asks about <topic>. Ask clarifying questions if the request is ambiguous.

## How to do it

1. Step one.
2. Step two.
3. Verify the result before replying.
`;
