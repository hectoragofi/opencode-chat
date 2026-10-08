import { useEffect, useState } from "react";
import {
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { field, ghostButton } from "./surfaces";
import {
  SKILL_TEMPLATE,
  createSkill,
  deleteSkill,
  fetchSkills,
  toggleSkill,
  updateSkill,
} from "../skills.js";

const input =
  "w-full rounded-xl border border-border/60 bg-background px-3 py-2 text-sm outline-none placeholder:text-foreground/35 focus:border-foreground/30";

function slugHint(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "my-skill";
}

export function SkillsDialog({ onClose }) {
  const [skills, setSkills] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null); // skill key being edited
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(SKILL_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = async () => {
    try {
      setSkills(await fetchSkills());
    } catch (e) {
      setError(String(e?.message || e));
      setSkills([]);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setConfirmDelete(false);
  }, [selected]);

  const openCreate = () => {
    setSelected(null);
    setCreating(true);
    setName("");
    setDescription("");
    setBody(SKILL_TEMPLATE);
    setError(null);
  };

  const openEdit = (s) => {
    setCreating(false);
    setSelected(s.skill);
    setName(s.skill);
    setDescription(s.description || "");
    setBody(s.body || "");
    setError(null);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = creating
        ? await createSkill({ name: slugHint(name), description: description.trim(), body })
        : await updateSkill(selected, { description: description.trim(), body });
      setSkills(next);
      setCreating(false);
      setSelected(creating ? slugHint(name) : selected);
      if (creating) {
        const created = next.find((s) => s.skill === slugHint(name));
        if (created) openEdit(created);
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      setSkills(await deleteSkill(selected));
      setSelected(null);
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  const toggle = async (s) => {
    try {
      setSkills(await toggleSkill(s.skill, !s.enabled));
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  const editing = creating || selected;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="fade-in zoom-in-95 animate-in flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-border/60 bg-popover shadow-2xl duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <SparklesIcon className="size-4" /> Skills
            </h2>
            <p className="text-xs text-foreground/50">
              Reusable instructions the assistant loads on demand — same SKILL.md format as Claude &amp; opencode.
            </p>
          </div>
          <button className={cn(ghostButton, "size-8")} onClick={onClose} title="Close">
            <XIcon className="size-4" />
          </button>
        </div>

        <div className="scroll-pane min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {!skills ? (
            <p className="flex items-center gap-2 py-8 text-sm text-foreground/50">
              <Loader2Icon className="size-4 animate-spin" /> Loading skills…
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] uppercase tracking-wider text-foreground/40">
                  {skills.length} skill{skills.length === 1 ? "" : "s"}
                </span>
                <span className="flex-1" />
                <button
                  onClick={openCreate}
                  className="flex h-8 items-center gap-1.5 rounded-full bg-foreground px-3.5 text-xs font-medium text-background transition hover:opacity-90"
                >
                  <PlusIcon className="size-3.5" /> New skill
                </button>
              </div>

              {!skills.length ? (
                <p className="rounded-2xl border border-border/60 px-4 py-6 text-center text-[13px] text-foreground/45">
                  No skills yet. Create one — e.g. a “meeting-notes” skill that formats notes the way you like.
                </p>
              ) : (
                skills.map((s) => (
                  <div
                    key={s.skill}
                    className={cn(
                      "flex items-center gap-2 rounded-xl border px-3 py-2 transition",
                      selected === s.skill && !creating
                        ? "border-foreground/30 bg-foreground/[0.04]"
                        : "border-border/60",
                      !s.enabled && "opacity-55",
                    )}
                  >
                    <button onClick={() => openEdit(s)} className="min-w-0 flex-1 text-left" title="Edit skill">
                      <p className="truncate font-mono text-[13px] font-medium">
                        {s.skill}
                        {!s.enabled ? <span className="ml-2 text-[11px] text-foreground/40">off</span> : null}
                      </p>
                      <p className="truncate text-xs text-foreground/50">{s.description}</p>
                    </button>
                    <button
                      onClick={() => toggle(s)}
                      title={s.enabled ? "Disable skill" : "Enable skill"}
                      className={cn(
                        "relative h-5.5 flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition",
                        s.enabled ? "justify-end bg-emerald-500/70" : "justify-start bg-foreground/15",
                      )}
                    >
                      <span className="size-5 rounded-full bg-white shadow" />
                    </button>
                  </div>
                ))
              )}

              {!editing ? null : (
                <div className={cn(field, "mt-1 flex flex-col gap-3 rounded-2xl p-4")}>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{creating ? "New skill" : `Edit ${selected}`}</p>
                    <span className="flex-1" />
                    {!selected || creating ? null : (
                      <button
                        onClick={remove}
                        className={cn(
                          "flex h-7 items-center gap-1 rounded-full px-2.5 text-xs transition",
                          confirmDelete
                            ? "bg-red-500/15 font-medium text-red-400"
                            : "text-foreground/45 hover:bg-foreground/[0.06] hover:text-red-400",
                        )}
                      >
                        <Trash2Icon className="size-3.5" />
                        {confirmDelete ? "Confirm" : "Delete"}
                      </button>
                    )}
                  </div>
                  {creating ? (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] font-medium">Name</span>
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. meeting notes"
                        className={input}
                      />
                      <span className="font-mono text-[11px] text-foreground/40">saved as “{slugHint(name)}”</span>
                    </label>
                  ) : null}
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">Description</span>
                    <input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="When should the assistant use this skill?"
                      className={input}
                    />
                    <span className="text-[11px] text-foreground/40">
                      This is what the assistant sees when deciding — be specific.
                    </span>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">Instructions</span>
                    <textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={10}
                      className={cn(input, "resize-y font-mono text-[13px] leading-relaxed")}
                    />
                  </label>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => {
                        setCreating(false);
                        setSelected(null);
                      }}
                      className="h-8 rounded-full px-3.5 text-xs font-medium text-foreground/55 transition hover:bg-foreground/[0.06]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={save}
                      disabled={busy || (!creating && !selected) || !description.trim() || (creating && !slugHint(name))}
                      className="flex h-8 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
                    >
                      {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
                      {busy ? "Saving…" : creating ? "Create skill" : "Save skill"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {error ? <p className="pt-2 text-xs text-red-400">{error}</p> : null}
          <p className="pt-3 text-[11px] leading-relaxed text-foreground/40">
            Skills live in the workspace at <span className="font-mono">.opencode/skills/&lt;name&gt;/SKILL.md</span> —
            the same format Claude Code uses, so you can copy skill folders back and forth. Disabled skills are kept
            as <span className="font-mono">.disabled</span> folders and hidden from the assistant.
          </p>
        </div>
      </div>
    </div>
  );
}
