import { api, getSession } from "~/lib/api";

export type ThemeMode = "auto" | "light" | "dark";
export type ThemeRadius = "sm" | "md" | "lg";

export type OrbitThemeConfig = {
  preset: string;
  mode: ThemeMode;
  primary: string;
  surface: string;
  radius: ThemeRadius;
};

export type OrbitThemePreset = {
  id: string;
  name: string;
  primary: string;
  description: string;
};

export const ORBIT_THEME_STORAGE_KEY = "orbit.theme.v1";
export const LEGACY_PULSAR_THEME_KEY = "pulsar.theme";
export const SATURN_THEME_MODE_KEY = "theme";

export const DEFAULT_ORBIT_THEME: OrbitThemeConfig = {
  preset: "orbit-blue",
  mode: "auto",
  primary: "#2781F6",
  surface: "",
  radius: "md",
};

export const ORBIT_THEME_PRESETS: OrbitThemePreset[] = [
  { id: "orbit-blue", name: "Orbit Blue (Default)", primary: "#2781F6", description: "Signature Orbit & Pulsar blue" },
  { id: "royal-indigo", name: "Royal Indigo", primary: "#4F46E5", description: "Deep indigo editorial accent" },
  { id: "cosmic-violet", name: "Cosmic Violet", primary: "#7C3AED", description: "Vibrant violet studio tone" },
  { id: "emerald", name: "Emerald", primary: "#059669", description: "Crisp support green" },
  { id: "ocean-teal", name: "Ocean Teal", primary: "#0D9488", description: "Balanced teal contrast" },
  { id: "crimson-rose", name: "Crimson Rose", primary: "#E11D48", description: "High-visibility rose" },
  { id: "sunset-amber", name: "Sunset Amber", primary: "#D97706", description: "Warm amber accent" },
  { id: "graphite", name: "Graphite", primary: "#334155", description: "Minimal slate monochrome" },
];

type Rgb = [number, number, number];

const BRAND_VAR_KEYS = [
  "--blue-1",
  "--blue-2",
  "--blue-3",
  "--blue-4",
  "--blue-5",
  "--blue-6",
  "--blue-7",
  "--blue-8",
  "--blue-9",
  "--blue-10",
  "--blue-11",
  "--blue-12",
  "--solid-blue",
  "--solid-blue-2",
  "--text-blue",
  "--border-blue-strong",
  "--border-blue",
  "--orbit-brand-ink",
] as const;

const SURFACE_VAR_KEYS = [
  "--background-color",
  "--surface-1",
  "--surface-2",
  "--solid-1",
  "--solid-2",
  "--card-color",
  "--border-weak",
  "--border-strong",
  "--slate-1",
  "--slate-2",
  "--slate-3",
  "--slate-4",
  "--slate-5",
] as const;

export function normalizeHex(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  let clean = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return `#${clean.toUpperCase()}`;
}

function hexToRgb(hex: string): Rgb {
  const norm = normalizeHex(hex) ?? DEFAULT_ORBIT_THEME.primary;
  return [
    parseInt(norm.slice(1, 3), 16),
    parseInt(norm.slice(3, 5), 16),
    parseInt(norm.slice(5, 7), 16),
  ];
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function rgbStr(c: Rgb): string {
  return `${c[0]} ${c[1]} ${c[2]}`;
}

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastInk(hex: string): "#FFFFFF" | "#0F172A" {
  return luminance(hexToRgb(hex)) > 0.42 ? "#0F172A" : "#FFFFFF";
}

export function computeBrandPalette(hex: string, isDark: boolean): Record<string, string> {
  const norm = normalizeHex(hex) ?? DEFAULT_ORBIT_THEME.primary;
  const ink = contrastInk(norm);

  if (norm === DEFAULT_ORBIT_THEME.primary) {
    return isDark
      ? {
          "--blue-1": "10 17 28",
          "--blue-2": "15 24 38",
          "--blue-3": "15 39 72",
          "--blue-4": "10 49 99",
          "--blue-5": "18 61 117",
          "--blue-6": "29 84 134",
          "--blue-7": "40 89 156",
          "--blue-8": "48 106 186",
          "--blue-9": "39 129 246",
          "--blue-10": "21 116 231",
          "--blue-11": "126 182 255",
          "--blue-12": "205 227 255",
          "--solid-blue": "15 57 102",
          "--solid-blue-2": "26 29 35",
          "--text-blue": "213 234 255",
          "--border-blue-strong": "201 226 255",
          "--border-blue": "39, 129, 246, 0.5",
          "--orbit-brand-ink": "#FFFFFF",
        }
      : {
          "--blue-1": "251 253 255",
          "--blue-2": "245 249 255",
          "--blue-3": "233 243 255",
          "--blue-4": "218 236 255",
          "--blue-5": "201 226 255",
          "--blue-6": "181 213 255",
          "--blue-7": "155 195 252",
          "--blue-8": "117 171 247",
          "--blue-9": "39 129 246",
          "--blue-10": "16 115 233",
          "--blue-11": "8 109 224",
          "--blue-12": "11 50 101",
          "--solid-blue": "218 236 255",
          "--solid-blue-2": "251 253 255",
          "--text-blue": "1 22 44",
          "--border-blue-strong": "18 61 117",
          "--border-blue": "39, 129, 246, 0.5",
          "--orbit-brand-ink": "#FFFFFF",
        };
  }

  const p = hexToRgb(norm);
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [8, 12, 22];
  const darkBase: Rgb = [12, 16, 26];

  if (isDark) {
    const b3 = mixRgb(p, darkBase, 0.76);
    const b12 = mixRgb(p, white, 0.74);
    return {
      "--blue-1": rgbStr(mixRgb(p, darkBase, 0.91)),
      "--blue-2": rgbStr(mixRgb(p, darkBase, 0.85)),
      "--blue-3": rgbStr(b3),
      "--blue-4": rgbStr(mixRgb(p, darkBase, 0.66)),
      "--blue-5": rgbStr(mixRgb(p, darkBase, 0.54)),
      "--blue-6": rgbStr(mixRgb(p, darkBase, 0.42)),
      "--blue-7": rgbStr(mixRgb(p, darkBase, 0.29)),
      "--blue-8": rgbStr(mixRgb(p, darkBase, 0.15)),
      "--blue-9": rgbStr(p),
      "--blue-10": rgbStr(mixRgb(p, white, 0.14)),
      "--blue-11": rgbStr(mixRgb(p, white, 0.44)),
      "--blue-12": rgbStr(b12),
      "--solid-blue": rgbStr(b3),
      "--solid-blue-2": rgbStr(mixRgb(p, [26, 29, 35], 0.88)),
      "--text-blue": rgbStr(b12),
      "--border-blue-strong": rgbStr(mixRgb(p, white, 0.68)),
      "--border-blue": `${p[0]}, ${p[1]}, ${p[2]}, 0.5`,
      "--orbit-brand-ink": ink,
    };
  }

  const b1 = mixRgb(p, white, 0.97);
  const b4 = mixRgb(p, white, 0.78);
  const b12 = mixRgb(p, black, 0.58);
  return {
    "--blue-1": rgbStr(b1),
    "--blue-2": rgbStr(mixRgb(p, white, 0.94)),
    "--blue-3": rgbStr(mixRgb(p, white, 0.88)),
    "--blue-4": rgbStr(b4),
    "--blue-5": rgbStr(mixRgb(p, white, 0.67)),
    "--blue-6": rgbStr(mixRgb(p, white, 0.54)),
    "--blue-7": rgbStr(mixRgb(p, white, 0.39)),
    "--blue-8": rgbStr(mixRgb(p, white, 0.22)),
    "--blue-9": rgbStr(p),
    "--blue-10": rgbStr(mixRgb(p, black, 0.14)),
    "--blue-11": rgbStr(mixRgb(p, black, 0.28)),
    "--blue-12": rgbStr(b12),
    "--solid-blue": rgbStr(b4),
    "--solid-blue-2": rgbStr(b1),
    "--text-blue": rgbStr(b12),
    "--border-blue-strong": rgbStr(mixRgb(p, black, 0.45)),
    "--border-blue": `${p[0]}, ${p[1]}, ${p[2]}, 0.5`,
    "--orbit-brand-ink": ink,
  };
}

export function computeSurfacePalette(surfaceHex: string, isDark: boolean): Record<string, string> {
  const s = hexToRgb(surfaceHex);
  if (isDark) {
    return {
      "--background-color": rgbStr(mixRgb([24, 25, 29], s, 0.1)),
      "--surface-1": rgbStr(mixRgb([18, 19, 23], s, 0.08)),
      "--surface-2": rgbStr(mixRgb([22, 23, 28], s, 0.09)),
      "--solid-1": rgbStr(mixRgb([23, 24, 29], s, 0.08)),
      "--solid-2": rgbStr(mixRgb([30, 32, 39], s, 0.11)),
      "--card-color": rgbStr(mixRgb([27, 29, 35], s, 0.1)),
      "--border-weak": rgbStr(mixRgb([34, 36, 44], s, 0.12)),
      "--border-strong": rgbStr(mixRgb([50, 52, 62], s, 0.14)),
      "--slate-1": rgbStr(mixRgb([17, 17, 20], s, 0.08)),
      "--slate-2": rgbStr(mixRgb([24, 25, 29], s, 0.09)),
      "--slate-3": rgbStr(mixRgb([33, 35, 41], s, 0.11)),
      "--slate-4": rgbStr(mixRgb([40, 43, 50], s, 0.12)),
      "--slate-5": rgbStr(mixRgb([48, 52, 60], s, 0.12)),
    };
  }
  return {
    "--background-color": rgbStr(mixRgb([247, 248, 250], s, 0.12)),
    "--surface-1": rgbStr(mixRgb([254, 254, 255], s, 0.06)),
    "--surface-2": rgbStr(mixRgb([255, 255, 255], s, 0.04)),
    "--solid-1": rgbStr(mixRgb([255, 255, 255], s, 0.05)),
    "--solid-2": rgbStr(mixRgb([255, 255, 255], s, 0.08)),
    "--card-color": rgbStr(mixRgb([255, 255, 255], s, 0.05)),
    "--border-weak": rgbStr(mixRgb([234, 235, 238], s, 0.14)),
    "--border-strong": rgbStr(mixRgb([224, 226, 231], s, 0.16)),
    "--slate-1": rgbStr(mixRgb([252, 252, 253], s, 0.06)),
    "--slate-2": rgbStr(mixRgb([248, 249, 251], s, 0.09)),
    "--slate-3": rgbStr(mixRgb([239, 241, 245], s, 0.13)),
    "--slate-4": rgbStr(mixRgb([231, 233, 238], s, 0.14)),
    "--slate-5": rgbStr(mixRgb([223, 226, 232], s, 0.14)),
  };
}

export function normalizeOrbitTheme(raw: unknown): OrbitThemeConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const primary = normalizeHex(typeof obj.primary === "string" ? obj.primary : "") ?? DEFAULT_ORBIT_THEME.primary;
  const surface = typeof obj.surface === "string" ? normalizeHex(obj.surface) ?? "" : "";
  const mode: ThemeMode = obj.mode === "light" || obj.mode === "dark" || obj.mode === "auto" ? obj.mode : "auto";
  const radius: ThemeRadius = obj.radius === "sm" || obj.radius === "lg" || obj.radius === "md" ? obj.radius : "md";
  const rawPreset = typeof obj.preset === "string" ? obj.preset.trim().slice(0, 32) : "";
  const preset = rawPreset || (primary === DEFAULT_ORBIT_THEME.primary ? "orbit-blue" : "custom");
  return { preset, mode, primary, surface, radius };
}

export function isDarkEffective(mode: ThemeMode = getOrbitTheme().mode): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getOrbitTheme(): OrbitThemeConfig {
  if (typeof window === "undefined") return { ...DEFAULT_ORBIT_THEME };
  try {
    const raw = localStorage.getItem(ORBIT_THEME_STORAGE_KEY);
    if (raw) return normalizeOrbitTheme(JSON.parse(raw));
    const legacy = localStorage.getItem(LEGACY_PULSAR_THEME_KEY);
    if (legacy === "light" || legacy === "dark" || legacy === "auto") {
      return { ...DEFAULT_ORBIT_THEME, mode: legacy };
    }
  } catch {
    // ignore malformed local cache
  }
  return { ...DEFAULT_ORBIT_THEME };
}

function writeLocalOrbitTheme(cfg: OrbitThemeConfig): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ORBIT_THEME_STORAGE_KEY, JSON.stringify(cfg));
    localStorage.setItem(LEGACY_PULSAR_THEME_KEY, cfg.mode);
    localStorage.setItem(SATURN_THEME_MODE_KEY, cfg.mode === "auto" ? "system" : cfg.mode);
  } catch {
    // ignore storage quota errors
  }
}

export function applyOrbitTheme(cfg: OrbitThemeConfig = getOrbitTheme()): OrbitThemeConfig {
  const norm = normalizeOrbitTheme(cfg);
  if (typeof document === "undefined") return norm;

  const root = document.documentElement;
  const dark = isDarkEffective(norm.mode);
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";

  const brandVars = computeBrandPalette(norm.primary, dark);
  for (const key of BRAND_VAR_KEYS) {
    const val = brandVars[key];
    if (val !== undefined) root.style.setProperty(key, val);
  }

  if (norm.surface) {
    const surfVars = computeSurfacePalette(norm.surface, dark);
    for (const key of SURFACE_VAR_KEYS) {
      const val = surfVars[key];
      if (val !== undefined) root.style.setProperty(key, val);
    }
  } else {
    for (const key of SURFACE_VAR_KEYS) {
      root.style.removeProperty(key);
    }
  }

  if (norm.radius === "sm" || norm.radius === "lg") {
    root.setAttribute("data-orbit-radius", norm.radius);
  } else {
    root.removeAttribute("data-orbit-radius");
  }

  return norm;
}

export function setOrbitTheme(
  partial: Partial<OrbitThemeConfig>,
  opts?: { persistServer?: boolean }
): OrbitThemeConfig {
  const current = getOrbitTheme();
  const next = normalizeOrbitTheme({ ...current, ...partial });
  writeLocalOrbitTheme(next);
  applyOrbitTheme(next);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pulsar:theme-changed", { detail: next.mode }));
    window.dispatchEvent(new CustomEvent("orbit:theme-changed", { detail: next }));
  }
  if (opts?.persistServer && getSession()) {
    void saveOrbitThemeToServer(next).catch(() => {});
  }
  return next;
}

export async function saveOrbitThemeToServer(cfg: OrbitThemeConfig = getOrbitTheme()): Promise<OrbitThemeConfig> {
  const norm = normalizeOrbitTheme(cfg);
  const saved = await api<OrbitThemeConfig>("/api/v1/orbit/theme", {
    method: "PUT",
    json: norm,
  });
  const normalized = normalizeOrbitTheme(saved);
  writeLocalOrbitTheme(normalized);
  applyOrbitTheme(normalized);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pulsar:theme-changed", { detail: normalized.mode }));
    window.dispatchEvent(new CustomEvent("orbit:theme-changed", { detail: normalized }));
  }
  return normalized;
}

export async function syncOrbitThemeFromServer(): Promise<OrbitThemeConfig | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetch("/api/v1/orbit/theme", { cache: "no-store" });
    if (!res.ok) return null;
    const raw = await res.json();
    const serverCfg = normalizeOrbitTheme(raw);
    const localCfg = getOrbitTheme();
    if (JSON.stringify(serverCfg) !== JSON.stringify(localCfg)) {
      writeLocalOrbitTheme(serverCfg);
      applyOrbitTheme(serverCfg);
      window.dispatchEvent(new CustomEvent("pulsar:theme-changed", { detail: serverCfg.mode }));
      window.dispatchEvent(new CustomEvent("orbit:theme-changed", { detail: serverCfg }));
    }
    return serverCfg;
  } catch {
    return null;
  }
}

export async function resetOrbitTheme(persistServer = true): Promise<OrbitThemeConfig> {
  const next = setOrbitTheme({ ...DEFAULT_ORBIT_THEME }, { persistServer: false });
  if (persistServer && getSession()) {
    return await saveOrbitThemeToServer(next);
  }
  return next;
}

export function initOrbitThemeListener(): () => void {
  if (typeof window === "undefined") return () => {};
  applyOrbitTheme();
  void syncOrbitThemeFromServer();

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onMedia = () => {
    if (getOrbitTheme().mode === "auto") applyOrbitTheme();
  };
  const onStorage = (ev: StorageEvent) => {
    if (ev.key === ORBIT_THEME_STORAGE_KEY || ev.key === LEGACY_PULSAR_THEME_KEY) {
      const next = applyOrbitTheme();
      window.dispatchEvent(new CustomEvent("pulsar:theme-changed", { detail: next.mode }));
      window.dispatchEvent(new CustomEvent("orbit:theme-changed", { detail: next }));
    }
  };
  mq.addEventListener("change", onMedia);
  window.addEventListener("storage", onStorage);
  return () => {
    mq.removeEventListener("change", onMedia);
    window.removeEventListener("storage", onStorage);
  };
}
