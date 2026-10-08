import { useRef, useState } from "react";
import {
  CheckIcon,
  FileIcon,
  Loader2Icon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { field, ghostButton } from "./surfaces";
import {
  createProject,
  deleteProject,
  deleteProjectFile,
  projectFileUrl,
  updateProject,
  uploadProjectFile,
} from "../projects.js";

function Modal({ onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className={cn(
          "fade-in zoom-in-95 animate-in flex max-h-[85vh] w-full flex-col rounded-2xl border border-border/60 bg-popover shadow-2xl duration-150",
          wide ? "max-w-2xl" : "max-w-lg",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ModalHeader({ title, subtitle, onClose }) {
  return (
    <div className="flex items-start gap-3 px-5 pb-3 pt-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle ? <p className="text-xs text-foreground/50">{subtitle}</p> : null}
      </div>
      <button className={cn(ghostButton, "size-8")} onClick={onClose} title="Close">
        <XIcon className="size-4" />
      </button>
    </div>
  );
}

const input =
  "w-full rounded-xl border border-border/60 bg-background px-3 py-2 text-sm outline-none placeholder:text-foreground/35 focus:border-foreground/30";

/* ---------------- create dialog ---------------- */

export function ProjectDialog({ initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [instructions, setInstructions] = useState(initial?.instructions || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = initial
        ? await updateProject(initial.id, { name: name.trim(), description, instructions })
        : await createProject({ name: name.trim(), description, instructions });
      onSaved(saved);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <ModalHeader
        title={initial ? "Rename project" : "New project"}
        subtitle="Chats in a project share these instructions and knowledge files."
        onClose={onClose}
      />
      <div className="scroll-pane min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="e.g. Q3 board deck"
              maxLength={80}
              className={input}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Description <span className="font-normal text-foreground/40">(optional)</span></span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
              maxLength={500}
              className={input}
            />
          </label>
          {!initial ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Custom instructions <span className="font-normal text-foreground/40">(optional)</span></span>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={"e.g. Always answer in Spanish. Cite the knowledge files. Prefer tables over prose."}
                rows={4}
                className={cn(input, "resize-y leading-relaxed")}
              />
              <span className="text-xs text-foreground/40">
                Added to the assistant&apos;s system prompt for every chat in this project.
              </span>
            </label>
          ) : null}
          {error ? <p className="text-xs text-red-400">{error}</p> : null}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
        <button
          onClick={onClose}
          className="h-8 rounded-full px-3.5 text-xs font-medium text-foreground/55 transition hover:bg-foreground/[0.06]"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={!name.trim() || busy}
          className="flex h-8 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {busy ? "Saving…" : initial ? "Save" : "Create project"}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- project settings: general + files + instructions ---------------- */

function formatSize(n) {
  if (!n) return "0 B";
  if (n > 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function ProjectSettingsDialog({ project, onClose, onChanged, onDeleted, onOpenChat }) {
  const [tab, setTab] = useState("files");
  const [name, setName] = useState(project.name || "");
  const [description, setDescription] = useState(project.description || "");
  const [instructions, setInstructions] = useState(project.instructions || "");
  const [savedTick, setSavedTick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState(null); // { done, total, current } while uploading
  const [uploadErrors, setUploadErrors] = useState([]);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmingFile, setConfirmingFile] = useState(null);
  const fileInput = useRef(null);

  const files = project.files || [];
  const dirtyGeneral =
    name.trim() !== (project.name || "") ||
    description !== (project.description || "");
  const dirtyInstructions = instructions !== (project.instructions || "");

  const flashSaved = () => {
    setSavedTick(true);
    setTimeout(() => setSavedTick(false), 1500);
  };

  const saveGeneral = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await updateProject(project.id, { name: name.trim(), description });
      onChanged(saved);
      flashSaved();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const saveInstructions = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await updateProject(project.id, { instructions });
      onChanged(saved);
      flashSaved();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const onFilesPicked = async (list) => {
    const picked = [...(list || [])];
    if (!picked.length || upload) return;
    setUploadErrors([]);
    setError(null);
    const errors = [];
    try {
      for (let i = 0; i < picked.length; i++) {
        setUpload({ done: i, total: picked.length, current: picked[i].name });
        try {
          // Sequential: one file per request keeps memory flat for big files.
          const next = await uploadProjectFile(project.id, picked[i]);
          // Refresh the visible list as we go.
          onChanged({ ...project, files: next, fileCount: next.length });
        } catch (e) {
          errors.push(`${picked[i].name}: ${e?.message || e}`);
        }
      }
    } finally {
      setUpload(null);
      setUploadErrors(errors);
    }
  };

  const removeFile = async (filename) => {
    if (confirmingFile !== filename) {
      setConfirmingFile(filename);
      setTimeout(() => setConfirmingFile((c) => (c === filename ? null : c)), 3000);
      return;
    }
    setConfirmingFile(null);
    try {
      const next = await deleteProjectFile(project.id, filename);
      onChanged({ ...project, files: next, fileCount: next.length });
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  const destroy = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    try {
      await deleteProject(project.id);
      onDeleted(project.id);
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);

  return (
    <Modal wide onClose={onClose}>
      <ModalHeader
        title={project.name}
        subtitle={project.description || "Project knowledge and instructions."}
        onClose={onClose}
      />
      <div className="flex items-center gap-1 px-5 pb-1">
        {[
          ["files", `Knowledge (${files.length})`],
          ["general", "General"],
          ["instructions", "Instructions"],
        ].map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-[13px] transition",
              tab === t ? "bg-foreground/[0.08] text-foreground" : "text-foreground/45 hover:text-foreground/75",
            )}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <button
          onClick={() => onOpenChat?.(project)}
          className="rounded-full bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background transition hover:opacity-90"
        >
          Open chat
        </button>
      </div>
      <div className="scroll-pane max-h-[50vh] min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {tab === "general" ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={input} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Description</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this project about?"
                maxLength={500}
                className={input}
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={saveGeneral}
                disabled={busy || !name.trim() || !dirtyGeneral}
                className="flex h-8 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
              >
                {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : savedTick && !dirtyGeneral ? <CheckIcon className="size-3.5" /> : null}
                {savedTick && !dirtyGeneral ? "Saved" : busy ? "Saving…" : "Save changes"}
              </button>
              {!dirtyGeneral ? <span className="text-xs text-foreground/40">Renaming updates the sidebar instantly.</span> : null}
            </div>
          </div>
        ) : null}
        {tab === "files" ? (
          <div className="flex flex-col gap-2">
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                onFilesPicked(e.dataTransfer?.files);
              }}
              className={cn(
                field,
                "flex cursor-pointer items-center justify-center gap-2 rounded-2xl border-dashed px-4 py-6 text-sm text-foreground/55 transition hover:bg-foreground/[0.04]",
                upload && "pointer-events-none opacity-60",
              )}
            >
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  onFilesPicked(e.target.files);
                  e.target.value = "";
                }}
              />
              {upload ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
              {upload
                ? `Uploading ${upload.done + 1} of ${upload.total} — ${upload.current}`
                : "Add files — click, or drag & drop (select as many as you like, any size)"}
            </div>
            {upload ? (
              <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]">
                <div
                  className="h-full rounded-full bg-foreground/60 transition-all"
                  style={{ width: `${Math.round((upload.done / Math.max(1, upload.total)) * 100)}%` }}
                />
              </div>
            ) : null}
            {!uploadErrors.length ? null : (
              <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] px-3 py-2">
                {uploadErrors.map((msg, i) => (
                  <p key={i} className="text-xs text-red-400">⚠ {msg}</p>
                ))}
              </div>
            )}
            {!files.length && !upload ? (
              <p className="py-4 text-center text-[13px] text-foreground/40">
                Attach reference docs — specs, notes, spreadsheets. The assistant reads them when they&apos;re relevant.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <p className="px-1 font-mono text-[11px] text-foreground/40">
                  {files.length} file{files.length === 1 ? "" : "s"} · {formatSize(totalBytes)} total
                </p>
                {files.map((f) => (
                  <div key={f.name} className="group flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2">
                    <FileIcon className="size-4 shrink-0 text-foreground/45" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{f.name}</p>
                      <p className="font-mono text-[11px] text-foreground/40">{formatSize(f.size)}</p>
                    </div>
                    <a
                      href={projectFileUrl(project.id, f.name)}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(ghostButton, "h-7 px-2.5 text-xs")}
                    >
                      Open
                    </a>
                    <button
                      onClick={() => removeFile(f.name)}
                      className={cn(
                        ghostButton,
                        "h-7 gap-1 px-2.5 text-xs",
                        confirmingFile === f.name && "text-red-400",
                      )}
                      title={confirmingFile === f.name ? "Click again to confirm" : "Remove file"}
                    >
                      <Trash2Icon className="size-3.5" />
                      {confirmingFile === f.name ? "Sure?" : ""}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
        {tab === "instructions" ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={8}
              placeholder={"e.g. Always answer in Spanish. Cite the knowledge files. Prefer tables over prose."}
              className={cn(input, "resize-y leading-relaxed")}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={saveInstructions}
                disabled={busy || !dirtyInstructions}
                className="flex h-8 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
              >
                {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : savedTick && !dirtyInstructions ? <CheckIcon className="size-3.5" /> : null}
                {savedTick && !dirtyInstructions ? "Saved" : busy ? "Saving…" : "Save instructions"}
              </button>
              <span className="text-xs text-foreground/40">Applies to every chat in this project.</span>
            </div>
          </div>
        ) : null}
        {error ? <p className="pt-2 text-xs text-red-400">{error}</p> : null}
      </div>
      <div className="flex items-center justify-between border-t border-border/60 px-5 py-3">
        <button
          onClick={destroy}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs transition",
            confirmDelete
              ? "bg-red-500/15 font-medium text-red-400 hover:bg-red-500/25"
              : "text-foreground/45 hover:bg-foreground/[0.06] hover:text-red-400",
          )}
        >
          <Trash2Icon className="size-3.5" />
          {confirmDelete ? "Click again to confirm delete" : "Delete project"}
        </button>
        <button
          onClick={onClose}
          className="h-8 rounded-full px-3.5 text-xs font-medium text-foreground/55 transition hover:bg-foreground/[0.06]"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}
