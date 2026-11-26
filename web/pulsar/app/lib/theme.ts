// Theme preference management delegating to the unified Orbit theme engine.
export {
  applyOrbitTheme as applyTheme,
  initOrbitThemeListener as initThemeListener,
  isDarkEffective,
  type ThemeMode,
} from "./orbitTheme";
import { getOrbitTheme, setOrbitTheme, type ThemeMode } from "./orbitTheme";

export function getTheme(): ThemeMode {
  return getOrbitTheme().mode;
}

export function setTheme(mode: ThemeMode) {
  setOrbitTheme({ mode });
}
