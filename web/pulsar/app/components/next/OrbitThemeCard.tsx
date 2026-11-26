import { Check, Monitor, Moon, Palette, RotateCcw, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import Button from "~/components/next/Button";
import Switch from "~/components/next/Switch";
import {
  DEFAULT_ORBIT_THEME,
  ORBIT_THEME_PRESETS,
  getOrbitTheme,
  normalizeHex,
  resetOrbitTheme,
  saveOrbitThemeToServer,
  setOrbitTheme,
  type OrbitThemeConfig,
  type ThemeMode,
  type ThemeRadius,
} from "~/lib/orbitTheme";

const SURFACE_PRESETS = [
  { id: "", label: "Clean Neutral", hex: "" },
  { id: "cool", label: "Cool Blue", hex: "#2781F6" },
  { id: "slate", label: "Soft Slate", hex: "#64748B" },
  { id: "warm", label: "Warm Sand", hex: "#D97706" },
] as const;

export default function OrbitThemeCard() {
  const [theme, setThemeState] = useState<OrbitThemeConfig>(getOrbitTheme);
  const [hexDraft, setHexDraft] = useState<string>(() => getOrbitTheme().primary);
  const [previewSwitch, setPreviewSwitch] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const sync = () => {
      const next = getOrbitTheme();
      setThemeState(next);
      setHexDraft(next.primary);
    };
    window.addEventListener("orbit:theme-changed", sync);
    window.addEventListener("pulsar:theme-changed", sync);
    return () => {
      window.removeEventListener("orbit:theme-changed", sync);
      window.removeEventListener("pulsar:theme-changed", sync);
    };
  }, []);

  const updatePreview = (patch: Partial<OrbitThemeConfig>) => {
    setSavedMsg("");
    setError("");
    const next = setOrbitTheme(patch);
    setThemeState(next);
    setHexDraft(next.primary);
  };

  const handleSave = async () => {
    setSaving(true);
    setSavedMsg("");
    setError("");
    try {
      const saved = await saveOrbitThemeToServer(theme);
      setThemeState(saved);
      setHexDraft(saved.primary);
      setSavedMsg("Saved — synced to Pulsar CS Desk & Saturn Backlog");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save workspace theme");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setSavedMsg("");
    setError("");
    try {
      const reset = await resetOrbitTheme(true);
      setThemeState(reset);
      setHexDraft(reset.primary);
      setSavedMsg("Reset to Orbit Blue default");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset theme");
    } finally {
      setSaving(false);
    }
  };

  const activePreset = ORBIT_THEME_PRESETS.find(
    (p) => p.id === theme.preset && p.primary === theme.primary
  );

  return (
    <section
      id="orbit-theme-card"
      className="max-w-2xl space-y-5 rounded-xl border border-n-weak bg-n-solid-1 p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-n-weak pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Palette className="size-4 text-n-brand" />
            <h2 className="text-sm font-medium text-n-slate-12">
              Orbit Appearance & Custom Theme
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-n-blue-3 px-2 py-0.5 font-mono text-[11px] font-medium text-n-blue-11">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: theme.primary }}
              />
              {activePreset ? activePreset.name : theme.primary}
            </span>
          </div>
          <p className="mt-1 text-xs text-n-slate-11">
            Default is Orbit Blue ({DEFAULT_ORBIT_THEME.primary}). Custom themes update Pulsar CS Desk and Saturn Backlog together.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleReset()}
          disabled={saving}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-n-weak bg-n-background px-2.5 text-xs font-medium text-n-slate-11 hover:bg-n-alpha-2 hover:text-n-slate-12 disabled:opacity-50"
        >
          <RotateCcw className="size-3.5" />
          Reset to Orbit Blue
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-n-ruby-7 bg-n-ruby-2 p-2.5 text-xs text-n-ruby-11">
          {error}
        </p>
      )}

      {/* Mode & Corner Radius */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-n-slate-11">
            Appearance Mode
          </label>
          <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-n-weak bg-n-background p-1">
            {(
              [
                { id: "light", label: "Light", icon: Sun },
                { id: "dark", label: "Dark", icon: Moon },
                { id: "auto", label: "System", icon: Monitor },
              ] as const
            ).map((m) => {
              const Icon = m.icon;
              const active = theme.mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => updatePreview({ mode: m.id as ThemeMode })}
                  className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "bg-n-brand text-accent-ink shadow-xs"
                      : "text-n-slate-11 hover:bg-n-alpha-1 hover:text-n-slate-12"
                  }`}
                >
                  <Icon className="size-3.5" />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-n-slate-11">
            Corner Radius
          </label>
          <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-n-weak bg-n-background p-1">
            {(
              [
                { id: "sm", label: "Sharp" },
                { id: "md", label: "Default" },
                { id: "lg", label: "Rounded" },
              ] as const
            ).map((r) => {
              const active = theme.radius === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => updatePreview({ radius: r.id as ThemeRadius })}
                  className={`rounded-md py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "bg-n-brand text-accent-ink shadow-xs"
                      : "text-n-slate-11 hover:bg-n-alpha-1 hover:text-n-slate-12"
                  }`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Presets */}
      <div>
        <label className="mb-2 block text-xs font-medium text-n-slate-11">
          Theme Presets
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ORBIT_THEME_PRESETS.map((preset) => {
            const active = theme.primary === preset.primary && theme.preset === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                data-orbit-theme-preset={preset.id}
                onClick={() => updatePreview({ preset: preset.id, primary: preset.primary })}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-all ${
                  active
                    ? "border-n-brand bg-n-blue-3/60 font-medium text-n-slate-12 ring-1 ring-n-brand"
                    : "border-n-weak bg-n-background text-n-slate-11 hover:border-n-strong hover:text-n-slate-12"
                }`}
              >
                <span
                  className="grid size-4 shrink-0 place-items-center rounded-full border border-black/10"
                  style={{ backgroundColor: preset.primary }}
                >
                  {active && <Check className="size-2.5 text-white" />}
                </span>
                <span className="truncate">{preset.name.replace(" (Default)", "")}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom Color + Surface Tint */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="orbit-custom-primary-hex"
            className="mb-1.5 block text-xs font-medium text-n-slate-11"
          >
            Custom Accent Color
          </label>
          <div className="flex items-center gap-2">
            <input
              aria-label="Custom accent color picker"
              type="color"
              value={theme.primary}
              onChange={(e) =>
                updatePreview({ preset: "custom", primary: e.target.value.toUpperCase() })
              }
              className="h-9 w-11 shrink-0 cursor-pointer rounded-lg border border-n-weak bg-n-background p-0.5"
            />
            <input
              id="orbit-custom-primary-hex"
              type="text"
              maxLength={7}
              value={hexDraft}
              onChange={(e) => {
                const raw = e.target.value.toUpperCase();
                setHexDraft(raw);
                const valid = normalizeHex(raw);
                if (valid) updatePreview({ preset: "custom", primary: valid });
              }}
              onBlur={() => setHexDraft(theme.primary)}
              placeholder="#2781F6"
              className="h-9 w-full rounded-lg border border-n-weak bg-n-background px-3 font-mono text-xs text-n-slate-12 focus:border-n-brand focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-n-slate-11">
            Surface Tint (Optional)
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            {SURFACE_PRESETS.map((sp) => {
              const active = theme.surface === sp.hex;
              return (
                <button
                  key={sp.label}
                  type="button"
                  onClick={() => updatePreview({ surface: sp.hex })}
                  className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "border-n-brand bg-n-blue-3/60 text-n-blue-11"
                      : "border-n-weak bg-n-background text-n-slate-11 hover:bg-n-alpha-1"
                  }`}
                >
                  {sp.label}
                </button>
              );
            })}
            <input
              aria-label="Custom surface color picker"
              type="color"
              value={theme.surface || "#FFFFFF"}
              onChange={(e) => updatePreview({ surface: e.target.value.toUpperCase() })}
              className="h-7 w-7 cursor-pointer rounded border border-n-weak bg-n-background p-0.5"
            />
          </div>
        </div>
      </div>

      {/* Live Component Preview Strip */}
      <div className="rounded-lg border border-n-weak bg-n-background p-3.5">
        <div className="mb-2.5 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-n-slate-10">
          <span>Live Component Preview</span>
          <span className="rounded-full bg-n-blue-3 px-2 py-0.5 normal-case text-n-blue-11">
            Active Badge
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button type="button" solid blue sm label="Primary Button" />
          <Button type="button" faded blue sm label="Faded" />
          <Button type="button" outline blue sm label="Outline" />
          <div className="flex items-center gap-1.5 text-xs text-n-slate-11">
            <Switch modelValue={previewSwitch} onModelValueChange={setPreviewSwitch} />
            <span>Toggle</span>
          </div>
          <input
            type="text"
            readOnly
            value="Focus border preview"
            className="h-8 w-40 rounded-lg border border-n-brand bg-n-solid-1 px-2.5 text-xs text-n-slate-12 outline-none"
          />
          <span className="rounded-xl rounded-br-xs bg-n-brand px-3 py-1.5 text-xs font-medium text-accent-ink">
            Outgoing chat bubble
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          type="button"
          id="orbit-save-theme-btn"
          solid
          blue
          isLoading={saving}
          onClick={() => void handleSave()}
          label="Save Workspace Theme"
        />
        {savedMsg && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-n-teal-11">
            <Check className="size-3.5" />
            {savedMsg}
          </span>
        )}
      </div>
    </section>
  );
}
