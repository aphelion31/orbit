import { Bug, Paperclip, Settings, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api, type Message } from "~/lib/api";

export type OrbitWorkspace = { id: string; name: string; slug: string };
export type OrbitProject = { id: string; name: string; identifier: string; workspace_id: string };
export type OrbitState = {
  id: string;
  name: string;
  color: string;
  group: string;
  default: boolean;
  is_triage: boolean;
  project_id: string;
};
export type OrbitLabel = { id: string; name: string; color: string; project_id: string };

export type OrbitMeta = {
  workspaces: OrbitWorkspace[];
  projects: OrbitProject[];
  states: OrbitState[];
  labels: OrbitLabel[];
};

export type OrbitConfig = {
  workspace_id: string;
  workspace_slug: string;
  project_id: string;
  project_identifier: string;
  target_mode: "work_item" | "intake";
  state_id: string | null;
  priority: "none" | "low" | "medium" | "high" | "urgent";
  label_ids: string[];
  sync_status_notes: boolean;
};

export type OrbitIssueCreated = {
  id: string;
  link_id: string;
  identifier: string;
  name: string;
  priority: string;
  target_mode: "work_item" | "intake";
  workspace_slug: string;
  project_id: string;
  url: string;
  state?: { id: string; name: string; color: string; group: string } | null;
};

function suggestTitle(msg: Message | null, convId: number): string {
  const raw = (msg?.content || "").trim();
  if (!raw) return `Bug report from Conversation #${convId}`;
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? raw;
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

function suggestDesc(msg: Message | null, contactName: string | null | undefined, convId: number): string {
  const raw = (msg?.content || "").trim();
  if (!raw) return `Reported from CS Conversation #${convId}`;
  const who = msg?.sender?.name || contactName || "Client";
  return `${who}: ${raw}`;
}

export function OrbitBugModal({
  open,
  accountId,
  conversationId,
  contactName,
  message,
  onClose,
  onCreated,
}: {
  open: boolean;
  accountId: number;
  conversationId: number;
  contactName?: string | null;
  message: Message | null;
  onClose: () => void;
  onCreated: (issue: OrbitIssueCreated) => void;
}) {
  const [meta, setMeta] = useState<OrbitMeta | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [targetMode, setTargetMode] = useState<"work_item" | "intake">("work_item");
  const [stateId, setStateId] = useState("");
  const [priority, setPriority] = useState<"none" | "low" | "medium" | "high" | "urgent">("medium");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    setTitle(suggestTitle(message, conversationId));
    setDescription(suggestDesc(message, contactName, conversationId));
    setIncludeAttachments(Boolean(message?.attachments && message.attachments.length > 0));
    setLoading(true);

    Promise.all([
      api<{ configured: boolean; config: OrbitConfig | null }>(`/api/v1/orbit/accounts/${accountId}/config`),
      api<OrbitMeta>(`/api/v1/orbit/accounts/${accountId}/meta`),
    ])
      .then(([cfgRes, metaRes]) => {
        if (!active) return;
        setMeta(metaRes);
        const cfg = cfgRes.config;
        const wsId = cfg?.workspace_id || metaRes.workspaces[0]?.id || "";
        const wsProjects = metaRes.projects.filter((p) => p.workspace_id === wsId);
        const projId = cfg?.project_id && wsProjects.some((p) => p.id === cfg.project_id)
          ? cfg.project_id
          : wsProjects[0]?.id || "";
        const projStates = metaRes.states.filter((s) => s.project_id === projId);
        const defaultState =
          (cfg?.state_id && projStates.some((s) => s.id === cfg.state_id) ? cfg.state_id : "") ||
          projStates.find((s) => s.group === "backlog")?.id ||
          projStates.find((s) => s.default)?.id ||
          projStates[0]?.id ||
          "";

        setWorkspaceId(wsId);
        setProjectId(projId);
        setTargetMode(cfg?.target_mode || "work_item");
        setStateId(defaultState);
        setPriority(cfg?.priority || "medium");
        setLabelIds((cfg?.label_ids || []).filter((id) => metaRes.labels.some((l) => l.id === id && l.project_id === projId)));
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Failed to load Orbit Backlog metadata");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open, accountId, conversationId, contactName, message]);

  const projects = useMemo(
    () => (meta?.projects || []).filter((p) => p.workspace_id === workspaceId),
    [meta, workspaceId]
  );
  const states = useMemo(
    () => (meta?.states || []).filter((s) => s.project_id === projectId && !s.is_triage),
    [meta, projectId]
  );
  const labels = useMemo(
    () => (meta?.labels || []).filter((l) => l.project_id === projectId),
    [meta, projectId]
  );

  function handleWorkspaceChange(nextWs: string) {
    setWorkspaceId(nextWs);
    const nextProjects = (meta?.projects || []).filter((p) => p.workspace_id === nextWs);
    const nextProj = nextProjects[0]?.id || "";
    setProjectId(nextProj);
    const nextStates = (meta?.states || []).filter((s) => s.project_id === nextProj && !s.is_triage);
    setStateId(
      nextStates.find((s) => s.group === "backlog")?.id ||
        nextStates.find((s) => s.default)?.id ||
        nextStates[0]?.id ||
        ""
    );
    setLabelIds([]);
  }

  function handleProjectChange(nextProj: string) {
    setProjectId(nextProj);
    const nextStates = (meta?.states || []).filter((s) => s.project_id === nextProj && !s.is_triage);
    setStateId(
      nextStates.find((s) => s.group === "backlog")?.id ||
        nextStates.find((s) => s.default)?.id ||
        nextStates[0]?.id ||
        ""
    );
    setLabelIds([]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !workspaceId || !projectId) return;
    setSubmitting(true);
    setError("");
    try {
      const created = await api<OrbitIssueCreated>(`/api/v1/orbit/accounts/${accountId}/issues`, {
        method: "POST",
        json: {
          conversation_id: conversationId,
          message_id: message?.id ?? null,
          title: title.trim(),
          description: description.trim(),
          workspace_id: workspaceId,
          project_id: projectId,
          target_mode: targetMode,
          state_id: targetMode === "work_item" && stateId ? stateId : null,
          priority,
          label_ids: labelIds,
          include_attachments: includeAttachments,
        },
      });
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to push bug to Saturn");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-n-weak bg-n-solid-1 text-n-slate-12 shadow-xl">
        <div className="flex items-center justify-between border-b border-n-weak px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-n-brand/15 text-n-brand">
              <Bug className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Push Bug to Orbit Backlog</h2>
              <p className="text-[11px] text-n-slate-10">
                Create a tracked Saturn item linked to Conversation #{conversationId}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="grid size-7 place-items-center rounded-lg text-n-slate-10 hover:bg-n-alpha-2 hover:text-n-slate-12"
          >
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3.5 p-4 text-xs">
          {error && (
            <p role="alert" className="rounded-lg border border-n-ruby-7 bg-n-ruby-2 px-3 py-2 text-n-ruby-11">
              {error}
            </p>
          )}

          {loading ? (
            <p className="py-6 text-center text-n-slate-10">Loading Saturn projects & todo states...</p>
          ) : (
            <>
              <div>
                <label className="mb-1 block font-medium text-n-slate-11">Title</label>
                <input
                  required
                  maxLength={255}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Short summary of the bug..."
                  className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 focus:border-n-brand focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block font-medium text-n-slate-11">Details</label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Steps, message context, client notes..."
                  className="w-full rounded-lg border border-n-weak bg-n-background p-2.5 text-sm text-n-slate-12 focus:border-n-brand focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-medium text-n-slate-11">Workspace</label>
                  <select
                    value={workspaceId}
                    onChange={(e) => handleWorkspaceChange(e.target.value)}
                    className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-2.5 text-xs text-n-slate-12 focus:border-n-brand focus:outline-none"
                  >
                    {(meta?.workspaces || []).map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block font-medium text-n-slate-11">Project</label>
                  <select
                    value={projectId}
                    onChange={(e) => handleProjectChange(e.target.value)}
                    className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-2.5 text-xs text-n-slate-12 focus:border-n-brand focus:outline-none"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.identifier} · {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block font-medium text-n-slate-11">Destination</label>
                  <select
                    value={targetMode}
                    onChange={(e) => setTargetMode(e.target.value as "work_item" | "intake")}
                    className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-2.5 text-xs text-n-slate-12 focus:border-n-brand focus:outline-none"
                  >
                    <option value="work_item">Todo / Board State</option>
                    <option value="intake">Intake (Triage Queue)</option>
                  </select>
                </div>

                {targetMode === "work_item" ? (
                  <div>
                    <label className="mb-1 block font-medium text-n-slate-11">Target List / State</label>
                    <select
                      value={stateId}
                      onChange={(e) => setStateId(e.target.value)}
                      className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-2.5 text-xs text-n-slate-12 focus:border-n-brand focus:outline-none"
                    >
                      {states.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="mb-1 block font-medium text-n-slate-11">Intake Queue</label>
                    <div className="flex h-9 items-center rounded-lg border border-n-weak bg-n-alpha-1 px-2.5 text-n-slate-11">
                      Triage (Pending Review)
                    </div>
                  </div>
                )}

                <div>
                  <label className="mb-1 block font-medium text-n-slate-11">Priority</label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as OrbitConfig["priority"])}
                    className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-2.5 text-xs text-n-slate-12 focus:border-n-brand focus:outline-none"
                  >
                    <option value="urgent">Urgent</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                    <option value="none">None</option>
                  </select>
                </div>
              </div>

              {labels.length > 0 && (
                <div>
                  <label className="mb-1.5 block font-medium text-n-slate-11">Labels</label>
                  <div className="flex flex-wrap gap-1.5">
                    {labels.map((l) => {
                      const active = labelIds.includes(l.id);
                      return (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() =>
                            setLabelIds((prev) =>
                              active ? prev.filter((x) => x !== l.id) : [...prev, l.id]
                            )
                          }
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                            active
                              ? "border-n-brand bg-n-brand/15 font-medium text-n-slate-12"
                              : "border-n-weak bg-n-background text-n-slate-11 hover:bg-n-alpha-1"
                          }`}
                        >
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: l.color || "#60646C" }}
                          />
                          {l.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {message?.attachments && message.attachments.length > 0 && (
                <label className="flex items-center gap-2 rounded-lg border border-n-weak bg-n-alpha-1 px-3 py-2 text-n-slate-12">
                  <input
                    type="checkbox"
                    checked={includeAttachments}
                    onChange={(e) => setIncludeAttachments(e.target.checked)}
                    className="size-4 accent-n-brand"
                  />
                  <Paperclip className="size-3.5 shrink-0 text-n-brand" />
                  <span>
                    Carry over {message.attachments.length} attachment
                    {message.attachments.length > 1 ? "s" : ""} to Saturn issue
                  </span>
                </label>
              )}
            </>
          )}

          <div className="flex items-center justify-between border-t border-n-weak pt-3">
            <Link
              to={`/accounts/${accountId}/settings/integrations/orbit`}
              onClick={onClose}
              className="inline-flex items-center gap-1 text-n-slate-11 hover:text-n-slate-12"
            >
              <Settings className="size-3.5" /> Default Destination
            </Link>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="h-8 rounded-lg border border-n-weak px-3 font-medium text-n-slate-11 hover:bg-n-alpha-2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || submitting || !projectId || !title.trim()}
                className="h-8 rounded-lg bg-n-brand px-3.5 font-medium text-white hover:bg-n-blue-10 disabled:opacity-50"
              >
                {submitting ? "Creating..." : "Create Backlog Item"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
