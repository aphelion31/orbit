import { ArrowLeft, Check, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router";
import Button from "~/components/next/Button";
import type { OrbitConfig, OrbitMeta } from "~/components/next/conversation/OrbitBugModal";
import { api } from "~/lib/api";
import type { ShellCtx } from "../../shell";

export default function OrbitIntegrationPage() {
  const { accountId } = useOutletContext<ShellCtx>();
  const [meta, setMeta] = useState<OrbitMeta | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [targetMode, setTargetMode] = useState<"work_item" | "intake">("work_item");
  const [stateId, setStateId] = useState("");
  const [priority, setPriority] = useState<OrbitConfig["priority"]>("medium");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [syncNotes, setSyncNotes] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [cfgRes, metaRes] = await Promise.all([
      api<{ configured: boolean; config: OrbitConfig | null }>(`/api/v1/orbit/accounts/${accountId}/config`),
      api<OrbitMeta>(`/api/v1/orbit/accounts/${accountId}/meta`),
    ]);
    setMeta(metaRes);
    setConfigured(cfgRes.configured);
    const cfg = cfgRes.config;
    const wsId = cfg?.workspace_id || metaRes.workspaces[0]?.id || "";
    const wsProjects = metaRes.projects.filter((p) => p.workspace_id === wsId);
    const projId = cfg?.project_id && wsProjects.some((p) => p.id === cfg.project_id)
      ? cfg.project_id
      : wsProjects[0]?.id || "";
    const projStates = metaRes.states.filter((s) => s.project_id === projId && !s.is_triage);
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
    setSyncNotes(cfg?.sync_status_notes ?? true);
  }, [accountId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load()
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Failed to load Orbit configuration");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

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
    setSaved(false);
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
    setSaved(false);
    const nextStates = (meta?.states || []).filter((s) => s.project_id === nextProj && !s.is_triage);
    setStateId(
      nextStates.find((s) => s.group === "backlog")?.id ||
        nextStates.find((s) => s.default)?.id ||
        nextStates[0]?.id ||
        ""
    );
    setLabelIds([]);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !projectId) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await api(`/api/v1/orbit/accounts/${accountId}/config`, {
        method: "PUT",
        json: {
          workspace_id: workspaceId,
          project_id: projectId,
          target_mode: targetMode,
          state_id: targetMode === "work_item" && stateId ? stateId : null,
          priority,
          label_ids: labelIds,
          sync_status_notes: syncNotes,
        },
      });
      setConfigured(true);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Orbit configuration");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 sm:p-8 text-n-slate-12">
      <Link
        to={`/accounts/${accountId}/settings/integrations`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-n-slate-11 hover:text-n-slate-12"
      >
        <ArrowLeft className="size-4" /> Integrations
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium">Orbit Backlog (Saturn)</h1>
          <p className="mt-1 text-sm text-n-slate-11">
            Set the default Saturn workspace, project, and todo/backlog list used when right-clicking a message in CS Inbox.
          </p>
        </div>
        <a
          href="/"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-n-weak bg-n-solid-1 px-3 text-xs font-medium text-n-slate-12 hover:bg-n-alpha-2"
        >
          Open Saturn Backlog <ExternalLink className="size-3.5" />
        </a>
      </div>

      {error && (
        <p role="alert" className="mb-4 max-w-2xl rounded-lg border border-n-ruby-7 bg-n-ruby-2 p-3 text-sm text-n-ruby-11">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-n-slate-11">Loading Saturn workspaces and projects...</p>
      ) : !meta || meta.workspaces.length === 0 ? (
        <div className="max-w-xl rounded-xl border border-n-weak bg-n-solid-1 p-6 text-sm text-n-slate-11">
          No Saturn workspace found yet. Open{" "}
          <a href="/" className="font-medium text-n-brand underline">
            Saturn
          </a>{" "}
          to create a workspace and project first.
        </div>
      ) : (
        <form onSubmit={handleSave} className="max-w-2xl space-y-5 rounded-xl border border-n-weak bg-n-solid-1 p-6">
          <div className="flex items-center justify-between border-b border-n-weak pb-3">
            <span className="text-sm font-medium">Default Destination</span>
            <span className={`text-xs font-medium ${configured ? "text-n-teal-11" : "text-n-amber-11"}`}>
              {configured ? "Saved for this account" : "Using auto-detected defaults"}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-n-slate-11">Workspace</label>
              <select
                value={workspaceId}
                onChange={(e) => handleWorkspaceChange(e.target.value)}
                className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 focus:border-n-brand focus:outline-none"
              >
                {meta.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.slug})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-n-slate-11">Project</label>
              <select
                value={projectId}
                onChange={(e) => handleProjectChange(e.target.value)}
                className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 focus:border-n-brand focus:outline-none"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.identifier} · {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-n-slate-11">Push Mode</label>
              <select
                value={targetMode}
                onChange={(e) => {
                  setTargetMode(e.target.value as "work_item" | "intake");
                  setSaved(false);
                }}
                className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 focus:border-n-brand focus:outline-none"
              >
                <option value="work_item">Direct to Todo / Backlog State</option>
                <option value="intake">Send to Intake (Triage Queue)</option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-n-slate-11">
                Default State / Todo List
              </label>
              <select
                disabled={targetMode === "intake"}
                value={stateId}
                onChange={(e) => {
                  setStateId(e.target.value);
                  setSaved(false);
                }}
                className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 focus:border-n-brand focus:outline-none disabled:opacity-50"
              >
                {states.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.group})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-n-slate-11">Default Priority</label>
              <select
                value={priority}
                onChange={(e) => {
                  setPriority(e.target.value as OrbitConfig["priority"]);
                  setSaved(false);
                }}
                className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-3 text-sm text-n-slate-12 focus:border-n-brand focus:outline-none"
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
              <label className="mb-1.5 block text-xs font-medium text-n-slate-11">Default Labels</label>
              <div className="flex flex-wrap gap-1.5">
                {labels.map((l) => {
                  const active = labelIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => {
                        setLabelIds((prev) =>
                          active ? prev.filter((x) => x !== l.id) : [...prev, l.id]
                        );
                        setSaved(false);
                      }}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        active
                          ? "border-n-brand bg-n-brand/15 font-medium text-n-slate-12"
                          : "border-n-weak bg-n-background text-n-slate-11 hover:bg-n-alpha-1"
                      }`}
                    >
                      <span className="size-2 rounded-full" style={{ backgroundColor: l.color || "#60646C" }} />
                      {l.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={syncNotes}
              onChange={(e) => {
                setSyncNotes(e.target.checked);
                setSaved(false);
              }}
              className="size-4 accent-n-brand"
            />
            <span>Auto-post private note in CS chat when a linked Saturn issue changes status</span>
          </label>

          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" solid blue isLoading={saving} label="Save Destination Settings" />
            {saved && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-n-teal-11">
                <Check className="size-3.5" /> Saved
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
